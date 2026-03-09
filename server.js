import express from "express";
import multer from "multer";
import fs from "fs";
import sharp from "sharp";
import { execSync } from "child_process";
import { PDFDocument } from "pdf-lib";
import path from "path";
import crypto from "crypto";
import  cors from "cors";

const app = express();
app.use(cors({
  origin: '*', // Sabhi domains ko allow karne ke liye (Development ke liye theek hai)
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
const upload = multer({ dest: "uploads/" });

["uploads", "outputs", "temp_images"].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d));

const sizeKB = (p) => fs.statSync(p).size / 1024;

// -------- Ghostscript Strategy --------
function tryGhost(input, target, profile) {
    const out = `outputs/gs_${profile}_${Date.now()}.pdf`;
    try {
        execSync(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/${profile} -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${out} "${input}"`);
        const s = sizeKB(out);
        // Agar size target ke 10% range mein hai, toh ye best hai
        if (s <= target && s >= target * 0.85) return { path: out, size: s, success: true };
        return { path: out, size: s, success: false };
    } catch (e) {
        return { success: false };
    }
}

// -------- Sharp Extreme Strategy --------
async function extremeCompress(inputPath, targetKB) {
    const sessionID = crypto.randomUUID();
    const sessionDir = path.join("temp_images", sessionID);
    fs.mkdirSync(sessionDir);

    try {
        const dpi = targetKB > 150 ? 300 : 150;
        execSync(`pdftoppm -jpeg -r ${dpi} "${inputPath}" "${sessionDir}/page"`);
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

app.post("/compress-pdf", upload.single("file"), async (req, res) => {
    try {
        const target = parseInt(req.body.target);
        const input = req.file.path;

        // 1. Try Ghostscript Profiles in sequence
        const profiles = ['printer', 'ebook', 'screen'];
        let lastGsResult = null;

        for (const p of profiles) {
            const resGS = tryGhost(input, target, p);
            if (resGS.success) {
                return res.download(resGS.path); // Mil gaya target ke paas!
            }
            lastGsResult = resGS;
        }

        // 2. Agar GS fail ho gaya (ya size abhi bhi bada hai), use Extreme mode
        // Note: Agar GS ka 'screen' profile bhi target hit nahi kar paya, tabhi niche jayega
        const finalResult = await extremeCompress(input, target);
        res.download(finalResult);

    } catch (e) {
        res.status(500).send("Error: " + e.message);
    }
});

app.listen(3000, () => console.log("Engine running..."));
