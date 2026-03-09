import express from "express";
import multer from "multer";
import sharp from "sharp";
import { exec } from "child_process";
import { PDFDocument } from "pdf-lib";
import { promisify } from "util";
import cors from "cors";
import fs from "fs";

const execPromise = promisify(exec);
const app = express();
app.use(cors());
const upload = multer({ dest: "uploads/" }); // Input file disk par, baaki sab RAM mein

// 10,000 Users ke liye Fast Cleanup logic
const cleanup = (files) => files.forEach(f => fs.existsSync(f) && fs.unlinkSync(f));

async function highAccuracyCompress(inputPath, targetKB) {
    const sessionID = Math.random().toString(36).substring(7);
    const tempPrefix = `temp_${sessionID}`;

    try {
        // 1. Ghostscript eBook (Quick check for easy targets)
        const gsPath = `outputs/gs_${sessionID}.pdf`;
        await execPromise(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${gsPath} "${inputPath}"`);
        let s = fs.statSync(gsPath).size / 1024;
        
        if (s <= targetKB && s >= targetKB * 0.9) return gsPath;

        // 2. Binary Search Rasterization (The logic you like)
        const dpi = targetKB > 150 ? 200 : 120;
        await execPromise(`pdftoppm -jpeg -r ${dpi} "${inputPath}" "${tempPrefix}"`);
        const files = fs.readdirSync('.').filter(f => f.startsWith(tempPrefix)).sort();

        let minQ = 5, maxQ = 95, currentWidth = targetKB > 150 ? 1500 : 1000;
        let finalBuffer = null;

        // Accuracy Loop (5-7 iterations are enough with RAM processing)
        for (let i = 0; i < 7; i++) {
            const q = Math.floor((minQ + maxQ) / 2);
            const pdf = await PDFDocument.create();
            
            // Speed Trick: Parallel processing for images
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

            if (Math.abs(currentSize - targetKB) < targetKB * 0.03) break; // 3% Accuracy!
            
            if (currentSize > targetKB) {
                maxQ = q - 1;
                if (q < 20) currentWidth = Math.floor(currentWidth * 0.85);
            } else {
                minQ = q + 1;
            }
        }

        const finalPath = `outputs/acc_${sessionID}.pdf`;
        fs.writeFileSync(finalPath, finalBuffer);
        cleanup(files); // Instant cleanup for 10k users
        return finalPath;

    } catch (e) {
        throw e;
    }
}

app.post("/compress-pdf", upload.single("file"), async (req, res) => {
    try {
        const target = parseInt(req.body.target);
        const resultPath = await highAccuracyCompress(req.file.path, target);
        res.download(resultPath, () => {
            cleanup([req.file.path, resultPath]); // Disk space management
        });
    } catch (e) {
        res.status(500).send("Error: " + e.message);
    }
});

app.listen(3000, () => console.log("High-Accuracy Engine Live..."));
