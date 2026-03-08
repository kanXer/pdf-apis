import express from "express";
import multer from "multer";
import fs from "fs";
import sharp from "sharp";
import { execSync } from "child_process";
import { PDFDocument } from "pdf-lib";
import path from "path";
import crypto from "crypto";

const app = express();
const upload = multer({ dest: "uploads/" });

// Folders Setup
["uploads", "outputs", "temp_images"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

async function smartCompress(inputPath, targetKB) {
    const sessionID = crypto.randomUUID();
    const sessionDir = path.join("temp_images", sessionID);
    fs.mkdirSync(sessionDir);

    try {
        // Step 1: Dynamic DPI selection based on target
        // Agar target bada hai toh high quality images extract karo
        const extractDPI = targetKB > 150 ? 300 : 150;
        execSync(`pdftoppm -jpeg -r ${extractDPI} "${inputPath}" "${sessionDir}/page"`);
        
        const files = fs.readdirSync(sessionDir)
            .filter(f => f.endsWith(".jpg"))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        let minQ = 5;
        let maxQ = 100;
        let currentWidth = targetKB > 150 ? 1800 : 1100; // Starting width based on target
        let bestBytes = null;
        let bestDiff = Infinity;

        // Loop for 10 iterations to find the exact sweet spot
        for (let i = 0; i < 10; i++) {
            const q = Math.floor((minQ + maxQ) / 2);
            const pdf = await PDFDocument.create();

            // Parallel Image Processing for Speed
            const pageBuffers = await Promise.all(files.map(async (f) => {
                const imgBuffer = fs.readFileSync(path.join(sessionDir, f));
                return await sharp(imgBuffer)
                    .resize({ width: Math.floor(currentWidth) })
                    .jpeg({ quality: q, mozjpeg: true })
                    .toBuffer();
            }));

            for (const imgBuf of pageBuffers) {
                const img = await pdf.embedJpg(imgBuf);
                const page = pdf.addPage([img.width, img.height]);
                page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
            }

            const pdfBytes = await pdf.save();
            const currentSize = pdfBytes.length / 1024;
            const diff = Math.abs(currentSize - targetKB);

            // Record best result
            if (diff < bestDiff) {
                bestDiff = diff;
                bestBytes = pdfBytes;
            }

            // Stop if we hit 3% tolerance
            if (diff < (targetKB * 0.03)) break;

            if (currentSize > targetKB) {
                maxQ = q - 1;
                // If even at low quality size is big, reduce resolution
                if (q < 10) {
                    currentWidth *= 0.8;
                    minQ = 10; maxQ = 90; // Reset search
                }
            } else {
                minQ = q + 1;
                // If even at max quality size is small, increase resolution
                if (q > 95) {
                    currentWidth *= 1.2;
                    minQ = 10; maxQ = 90; // Reset search
                }
            }
        }

        const finalPath = path.join("outputs", `final_${sessionID}.pdf`);
        fs.writeFileSync(finalPath, bestBytes);
        return finalPath;

    } finally {
        // Cleanup all temporary images for this session
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

app.post("/compress", upload.single("file"), async (req, res) => {
    try {
        const target = parseInt(req.body.target);
        if (!target || !req.file) return res.status(400).send("Target KB and File required");

        console.log(`Starting compression for target: ${target}KB`);
        const result = await smartCompress(req.file.path, target);
        
        res.download(result, (err) => {
            // Cleanup after download
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            if (fs.existsSync(result)) fs.unlinkSync(result);
        });
    } catch (e) {
        console.error("Critical Error:", e);
        res.status(500).send("Logic Error: " + e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smart Engine active on port ${PORT}`));
