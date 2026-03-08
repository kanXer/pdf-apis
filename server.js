import express from "express"
import multer from "multer"
import fs from "fs"
import sharp from "sharp"
import { execSync } from "child_process"
import { PDFDocument } from "pdf-lib"

const app = express()
const upload = multer({ dest:"uploads/" })

function sizeKB(path){
 return fs.statSync(path).size / 1024
}

function cleanTemp(){

 if(!fs.existsSync("temp_images")) fs.mkdirSync("temp_images")

 fs.readdirSync("temp_images").forEach(f=>{
  fs.unlinkSync(`temp_images/${f}`)
 })

}

// -------- Ghostscript Compression --------

function ghostCompress(input,output){

 execSync(`gs -sDEVICE=pdfwrite \
 -dCompatibilityLevel=1.4 \
 -dPDFSETTINGS=/screen \
 -dNOPAUSE -dQUIET -dBATCH \
 -sOutputFile=${output} ${input}`)

}

// -------- Extreme Binary Search Compression --------

async function extremeCompress(input,target){

 cleanTemp()

 execSync(`pdftoppm -jpeg -r 72 ${input} temp_images/page`)

 const files = fs.readdirSync("temp_images")
   .filter(f=>f.endsWith(".jpg") || f.endsWith(".jpeg"))
   .sort()

 if(files.length === 0){
  throw new Error("Image extraction failed")
 }

import express from "express";
import multer from "multer";
import fs from "fs";
import sharp from "sharp";
import { execSync } from "child_process";
import { PDFDocument } from "pdf-lib";
import path from "path";

const app = express();
const upload = multer({ dest: "uploads/" });

// Ensure directories exist
["uploads", "outputs", "temp_images"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

function sizeKB(filePath) {
    return fs.statSync(filePath).size / 1024;
}

function cleanTemp() {
    fs.readdirSync("temp_images").forEach(f => fs.unlinkSync(path.join("temp_images", f)));
}

async function smartCompress(inputPath, targetKB) {
    cleanTemp();
    
    // Extract pages as high-quality images (150 DPI is enough for text)
    execSync(`pdftoppm -jpeg -r 150 ${inputPath} temp_images/page`);
    const files = fs.readdirSync("temp_images").filter(f => f.endsWith(".jpg")).sort();

    let minQ = 5;
    let maxQ = 90;
    let currentWidth = 1100; // Optimal starting width for A4
    let bestFile = null;
    let bestDiff = Infinity;

    // Max 10 iterations to find the sweet spot
    for (let i = 0; i < 10; i++) {
        const q = Math.floor((minQ + maxQ) / 2);
        const pdf = await PDFDocument.create();

        for (const f of files) {
            const imgBuffer = fs.readFileSync(path.join("temp_images", f));
            
            const compressedImg = await sharp(imgBuffer)
                .resize({ width: Math.floor(currentWidth) })
                .jpeg({ 
                    quality: q, 
                    mozjpeg: true, 
                    chromaSubsampling: '4:2:0' 
                })
                .toBuffer();

            const img = await pdf.embedJpg(compressedImg);
            const page = pdf.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        }

        const pdfBytes = await pdf.save();
        const outPath = `outputs/res-${q}-${currentWidth}.pdf`;
        fs.writeFileSync(outPath, pdfBytes);

        const currentSize = sizeKB(outPath);
        const diff = Math.abs(currentSize - targetKB);

        // Track the best result so far
        if (diff < bestDiff) {
            bestDiff = diff;
            bestFile = outPath;
        }

        // Logic: Agar target ke 5% kareeb hain toh stop
        if (diff < (targetKB * 0.05)) break;

        if (currentSize > targetKB) {
            maxQ = q - 1;
            // Logical Trigger: Agar quality bohot gir gayi phir bhi size bada hai, resolution kam karo
            if (q < 15) {
                currentWidth *= 0.8; 
                minQ = 10; maxQ = 80; // Reset quality range for new resolution
            }
        } else {
            minQ = q + 1;
        }
    }
    return bestFile;
}

app.post("/compress", upload.single("file"), async (req, res) => {
    try {
        const target = parseInt(req.body.target);
        if (!target) return res.status(400).send("Target KB required");

        const resultPath = await smartCompress(req.file.path, target);
        
        if (resultPath) {
            res.download(resultPath);
        } else {
            res.status(500).send("Compression failed");
        }
    } catch (e) {
        console.error(e);
        res.status(500).send("Server Error");
    }
});

app.listen(3000, () => console.log("Engine running on port 3000"));
 
