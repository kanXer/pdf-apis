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

["uploads", "outputs", "temp_images"].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d));

const sizeKB = (p) => fs.statSync(p).size / 1024;
const safeDelete = (files) => files.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });

// --- COMMON CONVERTER HELPER (Stable for Word/Excel) ---
async function libreOfficeConvert(inputPath, type) {
    const sessionID = crypto.randomUUID();
    const outputDir = path.join("outputs", `${type}_${sessionID}`);
    const userProfileDir = path.join("/tmp", `profile_${sessionID}`); // Unique profile for stability
    
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(userProfileDir, { recursive: true });

    try {
        // Render/Linux environment fixes: 
        // 1. HOME=/tmp prevents permission errors.
        // 2. UserInstallation=file:// prevents blank PDFs by using a fresh profile.
        const command = `export HOME=/tmp && libreoffice --headless "-env:UserInstallation=file://${userProfileDir}" --convert-to pdf "${inputPath}" --outdir "${outputDir}"`;
        
        await execPromise(command);

        // Give the file system a moment to finish writing (prevents dummy/empty files)
        await new Promise(r => setTimeout(r, 1500));

        const files = fs.readdirSync(outputDir).filter(f => f.endsWith(".pdf"));
        if (!files.length) throw new Error(`${type} conversion failed - No output file produced`);

        return path.join(outputDir, files[0]);
    } catch (e) {
        console.error(`LibreOffice Error (${type}):`, e);
        throw e;
    } finally {
        // Cleanup profile to save space on Render
        if (fs.existsSync(userProfileDir)) fs.rmSync(userProfileDir, { recursive: true, force: true });
    }
}

// --- 1. ASYNC COMPRESSION (GS + EXTREME) ---
async function tryGhostAsync(input, target, profile) {
    const out = `outputs/gs_${profile}_${Date.now()}.pdf`;
    try {
        await execPromise(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/${profile} -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${out}" "${input}"`);
        const s = sizeKB(out);
        if (s <= target && s >= target * 0.85) return { path: out, size: s, success: true };
        return { path: out, size: s, success: false, tempPath: out };
    } catch (e) { return { success: false }; }
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
            const pageBuffers = await Promise.all(files.map(async f => await sharp(path.join(sessionDir, f)).resize({ width: Math.floor(currentWidth) }).jpeg({ quality: q, mozjpeg: true }).toBuffer()));
            for (const b of pageBuffers) {
                const img = await pdf.embedJpg(b);
                pdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
            }
            const bytes = await pdf.save();
            bestBytes = bytes;
            const s = bytes.length / 1024;
            if (Math.abs(s - targetKB) < targetKB * 0.05) break;
            if (s > targetKB) { maxQ = q - 1; if (q < 15) currentWidth *= 0.8; } else { minQ = q + 1; if (q > 90) currentWidth *= 1.2; }
        }
        const finalPath = `outputs/extreme_${sessionID}.pdf`;
        fs.writeFileSync(finalPath, bestBytes);
        return finalPath;
    } finally { fs.rmSync(sessionDir, { recursive: true, force: true }); }
}

// --- 2. ASYNC SPLIT ---
async function splitToZipAsync(inputPath, originalName) {
    const sessionID = crypto.randomUUID();
    const splitDir = path.join("temp_images", `split_${sessionID}`);
    const toolFolder = path.join(splitDir, "fastpdftool");
    const zipPath = `outputs/split_${sessionID}.zip`;
    fs.mkdirSync(toolFolder, { recursive: true });

    try {
        await execPromise(`pdftoppm -jpeg -r 150 "${inputPath}" "${splitDir}/page"`);
        const imageFiles = fs.readdirSync(splitDir).filter(f => f.endsWith(".jpg")).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
        const baseName = path.parse(originalName).name;

        for (let i = 0; i < imageFiles.length; i++) {
            const pdfDoc = await PDFDocument.create();
            const imgBytes = fs.readFileSync(path.join(splitDir, imageFiles[i]));
            const image = await pdfDoc.embedJpg(imgBytes);
            pdfDoc.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
            const pdfBytes = await pdfDoc.save();
            fs.writeFileSync(path.join(toolFolder, `${baseName}_page-${i + 1}.pdf`), pdfBytes);
        }

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip');

        return new Promise((resolve, reject) => {
            output.on('close', () => {
                fs.rmSync(splitDir, { recursive: true, force: true });
                resolve(zipPath);
            });
            archive.on('error', (err) => reject(err));
            archive.pipe(output);
            archive.directory(toolFolder, 'fastpdftool'); 
            archive.finalize();
        });
    } catch (e) { throw e; }
}

// --- 3. MERGE PDF ---
async function mergePDFAsync(files) {
    const sessionID = crypto.randomUUID();
    const sessionDir = path.join("temp_images", `merge_${sessionID}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    const finalPDF = await PDFDocument.create();

    try {
        for (let i = 0; i < files.length; i++) {
            const pdfPath = files[i].path;
            const prefix = path.join(sessionDir, `file_${i}`);
            await execPromise(`pdftoppm -jpeg -r 200 "${pdfPath}" "${prefix}"`);
            const images = fs.readdirSync(sessionDir)
                .filter(f => f.startsWith(`file_${i}`) && f.endsWith(".jpg"))
                .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));

            for (const imgFile of images) {
                const imgBytes = fs.readFileSync(path.join(sessionDir, imgFile));
                const img = await finalPDF.embedJpg(imgBytes);
                finalPDF.addPage([img.width, img.height]).drawImage(img,{ x:0, y:0, width:img.width, height:img.height });
            }
        }
        const pdfBytes = await finalPDF.save();
        const outputPath = `outputs/merged_${sessionID}.pdf`;
        fs.writeFileSync(outputPath, pdfBytes);
        return outputPath;
    } finally { fs.rmSync(sessionDir, { recursive: true, force: true }); }
}

// --- 4 & 6. WORD & EXCEL (Refactored to use helper) ---
async function wordToPDFAsync(inputPath) { return await libreOfficeConvert(inputPath, "word"); }
async function excelToPDFAsync(inputPath) { return await libreOfficeConvert(inputPath, "excel"); }

// --- 5. IMAGE TO PDF ---
async function imagesToPDFAsync(files) {
    const sessionID = crypto.randomUUID();
    const outputPath = `outputs/images_${sessionID}.pdf`;
    const pdf = await PDFDocument.create();

    for (const file of files) {
        const imgBuffer = fs.readFileSync(file.path);
        let image = file.mimetype === "image/png" ? await pdf.embedPng(imgBuffer) : await pdf.embedJpg(imgBuffer);
        pdf.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }
    fs.writeFileSync(outputPath, await pdf.save());
    return outputPath;
}

// --- ENDPOINTS ---
app.post("/compress-pdf", upload.single("file"), async (req, res) => {
    try {
        const target = parseInt(req.body.target) || 500;
        const input = req.file.path;
        const profiles = ['printer', 'ebook', 'screen'];
        for (const p of profiles) {
            const resGS = await tryGhostAsync(input, target, p);
            if (resGS.success) return res.download(resGS.path, () => safeDelete([input, resGS.path]));
            if (resGS.tempPath) safeDelete([resGS.tempPath]);
        }
        const finalResult = await extremeCompressAsync(input, target);
        res.download(finalResult, () => safeDelete([input, finalResult]));
    } catch (e) { if (req.file) safeDelete([req.file.path]); res.status(500).send("Error: " + e.message); }
});

app.post("/split-pdf", upload.single("file"), async (req, res) => {
    try {
        const zipPath = await splitToZipAsync(req.file.path, req.file.originalname);
        res.download(zipPath, "fastpdftool.zip", () => safeDelete([req.file.path, zipPath]));
    } catch (e) { if (req.file) safeDelete([req.file.path]); res.status(500).send("Error: " + e.message); }
});

app.post("/merge-pdf", upload.array("files", 20), async (req, res) => {
    try {
        if (!req.files?.length) return res.status(400).send("No files uploaded");
        const mergedPath = await mergePDFAsync(req.files);
        res.download(mergedPath, "merged.pdf", () => { safeDelete(req.files.map(f => f.path)); safeDelete([mergedPath]); });
    } catch (e) { if (req.files) safeDelete(req.files.map(f => f.path)); res.status(500).send("Error: " + e.message); }
});

app.post("/word-to-pdf", upload.single("file"), async (req, res) => {
    try {
        const pdfPath = await wordToPDFAsync(req.file.path);
        res.download(pdfPath, "converted.pdf", () => { safeDelete([req.file.path, pdfPath]); });
    } catch (e) { if (req.file) safeDelete([req.file.path]); res.status(500).send("Error: " + e.message); }
});

app.post("/image-to-pdf", upload.array("files", 20), async (req, res) => {
    try {
        if (!req.files?.length) return res.status(400).send("No images uploaded");
        const pdfPath = await imagesToPDFAsync(req.files);
        res.download(pdfPath, "images.pdf", () => { safeDelete(req.files.map(f => f.path)); safeDelete([pdfPath]); });
    } catch (e) { if (req.files) safeDelete(req.files.map(f => f.path)); res.status(500).send("Error: " + e.message); }
});

app.post("/excel-to-pdf", upload.single("file"), async (req, res) => {
    try {
        const pdfPath = await excelToPDFAsync(req.file.path);
        res.download(pdfPath, "excel.pdf", () => { safeDelete([req.file.path, pdfPath]); });
    } catch (e) { if (req.file) safeDelete([req.file.path]); res.status(500).send("Error: " + e.message); }
});

app.listen(3000, () => console.log("Engine running on 3000..."));
