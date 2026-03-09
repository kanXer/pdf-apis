import express from "express";
import multer from "multer";
import fs from "fs";
import sharp from "sharp";
import { exec } from "child_process";
import { PDFDocument } from "pdf-lib";
import path from "path";
import crypto from "crypto";
import cors from "cors";
import { promisify } from "util";

const execPromise = promisify(exec);
const app = express();
app.use(cors());
const upload = multer({ dest: "uploads/" });

// Zaroori folders banayein
["uploads", "outputs", "temp_images"].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d));

/**
 * Ek single image par binary search karke sahi Quality (Q) dhoondna
 */
async function getOptimalQuality(sampleImagePath, targetPerPage) {
    let low = 5, high = 95, bestQ = 60;
    for (let i = 0; i < 6; i++) { 
        let q = Math.floor((low + high) / 2);
        const buffer = await sharp(sampleImagePath)
            .jpeg({ quality: q, mozjpeg: true })
            .withMetadata(false)
            .toBuffer();
        const size = buffer.length / 1024;
        
        if (size > targetPerPage) {
            high = q - 1;
        } else {
            low = q + 1;
            bestQ = q;
        }
    }
    return bestQ;
}

/**
 * Main Compression Engine
 */
async function fastExtremeCompress(inputPath, targetKB) {
    const sessionID = crypto.randomUUID();
    const sessionDir = path.join("temp_images", sessionID);
    fs.mkdirSync(sessionDir);

    try {
        // 1. PDF to JPEG (150 DPI balanced hai speed aur quality ke liye)
        await execPromise(`pdftoppm -jpeg -r 150 "${inputPath}" "${sessionDir}/page"`);
        const files = fs.readdirSync(sessionDir)
            .filter(f => f.endsWith(".jpg"))
            .sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
        
        const totalPages = files.length;

        // 2. Overhead Calculation: Metadata aur Page structure ka wazan minus karo
        // Har page approx 1.2KB se 2KB overhead leta hai
        const estimatedOverhead = (totalPages * 1.5) + 10; 
        const targetForImages = targetKB - estimatedOverhead;
        const targetPerPage = targetForImages / totalPages;

        // 3. Pehle page par test karke "Best Quality" nikalo
        let currentQuality = await getOptimalQuality(path.join(sessionDir, files[0]), targetPerPage);

        let finalBytes;
        let finalSize;
        let attempts = 0;

        // 4. Construction & Auto-Correction Loop
        while (attempts < 2) {
            const pdf = await PDFDocument.create();
            
            // Parallel processing for speed
            const pageBuffers = await Promise.all(files.map(f => 
                sharp(path.join(sessionDir, f))
                    .rotate()
                    .jpeg({ quality: currentQuality, mozjpeg: true })
                    .withMetadata(false)
                    .toBuffer()
            ));

            for (const b of pageBuffers) {
                const img = await pdf.embedJpg(b);
                const page = pdf.addPage([img.width, img.height]);
                page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
            }

            finalBytes = await pdf.save();
            finalSize = finalBytes.length / 1024;

            // Agar size target se chhota hai toh exit, warna quality kam karke dubara
            if (finalSize <= targetKB) break;
            
            currentQuality -= 7; // Quality drop if overshoot
            attempts++;
        }

        const finalPath = `outputs/compressed_${sessionID}.pdf`;
        fs.writeFileSync(finalPath, finalBytes);
        return { path: finalPath, size: finalSize };

    } finally {
        // Cleanup: Temporary images delete karein
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

// API Endpoint
app.post("/compress-pdf", upload.single("file"), async (req, res) => {
    try {
        if (!req.file || !req.body.target) {
            return res.status(400).send("File aur Target size (KB) dono chahiye.");
        }

        const target = parseInt(req.body.target);
        const result = await fastExtremeCompress(req.file.path, target);
        
        res.download(result.path, (err) => {
            // Download ke baad input aur output cleanup
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            // Result file delete karne se pehle delay ya cron job behtar hai
        });

    } catch (e) {
        console.error(e);
        res.status(500).send("Server Error: " + e.message);
    }
});

app.listen(3000, () => console.log("PDF Engine is running on port 3000..."));
