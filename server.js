import express from "express";
import multer from "multer";
import fs from "fs";
import sharp from "sharp";
import { execSync } from "child_process";
import { PDFDocument } from "pdf-lib";

const app = express();
const upload = multer({ dest: "uploads/" });

function sizeKB(path){
  return fs.statSync(path).size / 1024;
}

function cleanTemp(){
  if(!fs.existsSync("temp_images")) fs.mkdirSync("temp_images");
  fs.readdirSync("temp_images").forEach(f=>{
    fs.unlinkSync(`temp_images/${f}`);
  });
}

// -------- Ghostscript --------
function ghostCompress(input,output){

 execSync(`gs -sDEVICE=pdfwrite \
 -dCompatibilityLevel=1.4 \
 -dPDFSETTINGS=/screen \
 -dNOPAUSE -dQUIET -dBATCH \
 -sOutputFile=${output} ${input}`);

}

// -------- Extreme Adaptive --------
async function extremeCompress(input,target){

 cleanTemp();

 execSync(`pdftoppm -jpeg -r 72 ${input} temp_images/page`);

 const files = fs.readdirSync("temp_images")
  .filter(f => f.endsWith(".jpg") || f.endsWith(".jpeg"))
  .sort();

 if(files.length === 0){
   throw new Error("Image extraction failed");
 }

 const qualities = [70,60,50,40,35,30,25,20];

 let bestFile = null;
 let bestDiff = Infinity;

 for(const q of qualities){

   const pdf = await PDFDocument.create();

   for(const f of files){

     const imgPath = `temp_images/${f}`;

     const imgBuffer = fs.readFileSync(imgPath);

     const compressed = await sharp(imgBuffer)
       .resize({ width: 900 })
       .jpeg({ quality: q })
       .toBuffer();

     const img = await pdf.embedJpg(compressed);

     const page = pdf.addPage([img.width, img.height]);

     page.drawImage(img,{
       x:0,
       y:0,
       width:img.width,
       height:img.height
     });

   }

   const pdfBytes = await pdf.save();

   const out = `outputs/out-${Date.now()}-${q}.pdf`;

   fs.writeFileSync(out,pdfBytes);

   const size = sizeKB(out);

   if(size < 5){
     continue; // corrupted ignore
   }

   const diff = Math.abs(size-target);

   if(diff < bestDiff){
     bestDiff = diff;
     bestFile = out;
   }

   if(size <= target){
     return out;
   }

 }

 return bestFile;
}

// -------- API --------
app.post("/compress",upload.single("file"),async(req,res)=>{

 try{

   const input = req.file.path;
   const target = parseInt(req.body.target);

   const original = sizeKB(input);

   let output;

   if(original / target > 2){

     output = await extremeCompress(input,target);

   }else{

     output = `outputs/out-${Date.now()}.pdf`;

     ghostCompress(input,output);

   }

   if(!fs.existsSync(output)){
     return res.status(500).send("Compression failed");
   }

   res.download(output);

 }catch(e){

   console.error(e);
   res.status(500).send("Compression error");

 }

});

app.get("/",(req,res)=>{
 res.send("Smart PDF Compressor running");
});

app.listen(3000,()=>{
 console.log("Server running");
});
