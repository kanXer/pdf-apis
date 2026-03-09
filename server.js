import express from "express";
import multer from "multer";
import sharp from "sharp";
import { exec } from "child_process";
import { PDFDocument } from "pdf-lib";
import { promisify } from "util";
import cors from "cors";
import fs from "fs";
import archiver from "archiver";
import path from "path";

const execPromise = promisify(exec);
const app = express();
app.use(cors());
const upload = multer({ dest: "uploads/" });

// Output folder check
if (!fs.existsSync("outputs")) fs.mkdirSync("outputs");

const cleanup = (files) => files.forEach(f => fs.existsSync(f) && fs.unlinkSync(f));

// --- 1. COMPRESSION LOGIC (As per your original code) ---
async function highAccuracyCompress(inputPath, targetKB) {
    const sessionID = Math.random().toString(36).substring(7);
    const tempPrefix = `temp_${sessionID}`;

    try {
        const gsPath = `outputs/gs_${sessionID}.pdf`;
        await execPromise(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${gsPath} "${inputPath}"`);
        let s = fs.statSync(gsPath).size / 1024;
        
        if (s <= targetKB && s >= targetKB * 0.9) return gsPath;

        const dpi = targetKB > 150 ? 200 : 120;
        await execPromise(`pdftoppm -jpeg -r ${dpi} "${inputPath}" "${tempPrefix}"`);
        const files = fs.readdirSync('.').filter(f => f.startsWith(tempPrefix)).sort();

        let minQ = 5, maxQ = 95, currentWidth = targetKB > 150 ? 1500 : 1000;
        let finalBuffer = null;

        for (let i = 0; i < 7; i++) {
            const q = Math.floor((minQ + maxQ) / 2);
            const pdf = await PDFDocument.create();
            
            const pageBuffers = await Promise.all(files.map(f => 
                sharp(f).resize({ width: currentWidth }).jpeg({ quality: q, mozjpeg: true }).toBuffer()
            ));

            for (const b of pageBuffers) {
                const img = await pdf.embedJpg(b);
                pdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
            }

            const bytes = await pdf.save();
            const currentSize = bytes.length / 1024;
            finalBuffer = bytes;

            if (Math.abs(currentSize - targetKB) < targetKB * 0.03) break;
            
            if (currentSize > targetKB) {
                maxQ = q - 1;
                if (q < 20) currentWidth = Math.floor(currentWidth * 0.85);
            } else {
                minQ = q + 1;
            }
        }

        const finalPath = `outputs/acc_${sessionID}.pdf`;
        fs.writeFileSync(finalPath, finalBuffer);
        cleanup(files); 
        return finalPath;
    } catch (e) { throw e; }
}

// --- 2. SPLIT LOGIC (Individual PDFs in Zip) ---
async function splitToZip(inputPath, originalName) {
    const sessionID = Math.random().toString(36).substring(7);
    const splitPrefix = `split_tmp_${sessionID}`;
    const toolFolder = `fastpdftool_${sessionID}`;
    const zipPath = `outputs/split_${sessionID}.zip`;

    if (!fs.existsSync(toolFolder)) fs.mkdirSync(toolFolder);

    try {
        await execPromise(`pdftoppm -jpeg -r 150 "${inputPath}" "${splitPrefix}"`);
        const imageFiles = fs.readdirSync('.').filter(f => f.startsWith(splitPrefix)).sort();
        const baseName = path.parse(originalName).name;

        await Promise.all(imageFiles.map(async (imgFile, index) => {
            const pdfDoc = await PDFDocument.create();
            const imgBytes = fs.readFileSync(imgFile);
            const image = await pdfDoc.embedJpg(imgBytes);
            pdfDoc.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
            
            const pdfBytes = await pdfDoc.save();
            fs.writeFileSync(`${toolFolder}/${baseName}_page-${index + 1}.pdf`, pdfBytes);
        }));

        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip');

        return new Promise((resolve, reject) => {
            output.on('close', () => {
                cleanup(imageFiles);
                fs.rmSync(toolFolder, { recursive: true, force: true });
                resolve(zipPath);
            });
            archive.pipe(output);
            archive.directory(toolFolder, false);
            archive.finalize();
        });
    } catch (e) { throw e; }
}

// --- ENDPOINTS ---
app.post("/compress-pdf", upload.single("file"), async (req, res) => {
    try {
        const target = parseInt(req.body.target);
        const resultPath = await highAccuracyCompress(req.file.path, target);
        res.download(resultPath, () => cleanup([req.file.path, resultPath]));
    } catch (e) { res.status(500).send("Error: " + e.message); }
});

app.post("/split-pdf", upload.single("file"), async (req, res) => {
    try {
        const zipPath = await splitToZip(req.file.path, req.file.originalname);
        res.download(zipPath, "fastpdftool.zip", () => cleanup([req.file.path, zipPath]));
    } catch (e) { res.status(500).send("Error: " + e.message); }
});

app.listen(3000, () => console.log("Engine Live..."));
