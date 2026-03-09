import express from "express";
import multer from "multer";
import sharp from "sharp";
import { exec } from "child_process";
import { PDFDocument } from "pdf-lib";
import { promisify } from "util";
import cors from "cors";
import fs from "fs";
import path from "path";
import archiver from "archiver";
import crypto from "crypto";

const execPromise = promisify(exec);
const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
const upload = multer({ dest: "uploads/" });

// Folders ensure karein
["uploads", "outputs", "temp_images"].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d));

const sizeKB = (p) => fs.statSync(p).size / 1024;

const safeDelete = (files) => {
    files.forEach(f => {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    });
};

// ==========================================
// 1. ASYNC COMPRESSION STRATEGY
// ==========================================

async function tryGhostAsync(input, target, profile) {
    const out = `outputs/gs_${profile}_${Date.now()}.pdf`;
    try {
        // Non-blocking Ghostscript call
        await execPromise(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/${profile} -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${out}" "${input}"`);
        const s = sizeKB(out);
        if (s <= target && s >= target * 0.85) return { path: out, size: s, success: true };
        return { path: out, size: s, success: false, tempPath: out };
    } catch (e) {
        return { success: false };
    }
}

async function extremeCompressAsync(inputPath, targetKB) {
    const sessionID = crypto.randomUUID();
    const sessionDir = path.join("temp_images", sessionID);
    fs.mkdirSync(sessionDir);

    try {
        const dpi = targetKB > 150 ? 300 : 150;
        await execPromise(`pdftoppm -jpeg -r ${dpi} "${inputPath}" "${sessionDir}/page"`);
        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jpg")).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));

        let minQ = 5, maxQ = 100, currentWidth = targetKB > 150 ? 1600 : 1000;
        let bestBytes = null;

        for (let i = 0; i < 10; i++) {
            const q = Math.floor((minQ + maxQ) / 2);
            const pdf = await PDFDocument.create();
            
            const pageBuffers = await Promise.all(files.map(async f => {
                return await sharp(path.join(sessionDir, f))
                    .resize({ width: Math.floor(currentWidth) })
                    .jpeg({ quality: q, mozjpeg: true }).toBuffer();
            }));

            for (const b of pageBuffers) {
                const img = await pdf.embedJpg(b);
                pdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
            }

            const bytes = await pdf.save();
            const s = bytes.length / 1024;
            bestBytes = bytes;

            if (Math.abs(s - targetKB) < targetKB * 0.05) break;
            if (s > targetKB) { 
                maxQ = q - 1; 
                if (q < 15) currentWidth *= 0.8; 
            } else { 
                minQ = q + 1; 
                if (q > 90) currentWidth *= 1.2;
            }
        }
        const finalPath = `outputs/extreme_${sessionID}.pdf`;
        fs.writeFileSync(finalPath, bestBytes);
        return finalPath;
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

// ==========================================
// 2. ASYNC SPLIT LOGIC
// ==========================================

async function splitToZipAsync(inputPath, originalName) {
    const sessionID = crypto.randomUUID();
    const splitDir = path.join("temp_images", `split_${sessionID}`);
    const toolFolder = path.join(splitDir, `fastpdftool`);
    const zipPath = `outputs/split_${sessionID}.zip`;

    fs.mkdirSync(toolFolder, { recursive: true });

    try {
        await execPromise(`pdftoppm -jpeg -r 150 "${inputPath}" "${splitDir}/page"`);
        const imageFiles = fs.readdirSync(splitDir).filter(f => f.endsWith(".jpg")).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
        const baseName = path.parse(originalName).name;

        await Promise.all(imageFiles.map(async (imgFile, index) => {
            const pdfDoc = await PDFDocument.create();
            const imgBytes = fs.readFileSync(path.join(splitDir, imgFile));
            const image = await pdfDoc.embedJpg(imgBytes);
            pdfDoc.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: img.width, height: img.height });
            const pdfBytes = await pdfDoc.save();
            fs.writeFileSync(path.join(toolFolder, `${baseName}_page-${index + 1}.pdf`), pdfBytes);
        }));

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip');

        return new Promise((resolve, reject) => {
            output.on('close', () => {
                fs.rmSync(splitDir, { recursive: true, force: true });
                resolve(zipPath);
            });
            archive.on('error', (err) => reject(err));
            archive.pipe(output);
            archive.directory(toolFolder, false);
            archive.finalize();
        });
    } catch (e) { throw e; }
}

// ==========================================
// ENDPOINTS
// ==========================================

app.post("/compress-pdf", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) throw new Error("File upload failed");
        const target = parseInt(req.body.target) || 500;
        const input = req.file.path;

        const profiles = ['printer', 'ebook', 'screen'];
        for (const p of profiles) {
            const resGS = await tryGhostAsync(input, target, p);
            if (resGS.success) {
                return res.download(resGS.path, () => safeDelete([input, resGS.path]));
            }
            if (resGS.tempPath) safeDelete([resGS.tempPath]);
        }

        const finalResult = await extremeCompressAsync(input, target);
        res.download(finalResult, () => safeDelete([input, finalResult]));

    } catch (e) {
        if (req.file) safeDelete([req.file.path]);
        res.status(500).send("Compression Error: " + e.message);
    }
});

app.post("/split-pdf", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) throw new Error("File upload failed");
        const zipPath = await splitToZipAsync(req.file.path, req.file.originalname);
        res.download(zipPath, "fastpdftool.zip", () => safeDelete([req.file.path, zipPath]));
    } catch (e) {
        if (req.file) safeDelete([req.file.path]);
        res.status(500).send("Split Error: " + e.message);
    }
});

app.listen(3000, () => console.log("Turbo Async Engine running on port 3000..."));
