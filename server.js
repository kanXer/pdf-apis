import express from "express";
import multer from "multer";
import { exec } from "child_process";
import fs from "fs";

const app = express();
const upload = multer({ dest: "uploads/" });

function getFileSizeKB(path) {
  const stats = fs.statSync(path);
  return stats.size / 1024;
}

const presets = [
  "/printer",
  "/ebook",
  "/screen"
];

app.post("/compress", upload.single("file"), async (req, res) => {

  const inputPath = req.file.path;
  const targetKB = parseInt(req.body.target);

  if (!targetKB) {
    return res.status(400).send("target (KB) required");
  }

  let bestOutput = null;

  for (let preset of presets) {

    const outputPath = `outputs/compressed-${Date.now()}.pdf`;

    const command = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${preset} -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${outputPath} ${inputPath}`;

    await new Promise((resolve) => {
      exec(command, () => resolve());
    });

    const sizeKB = getFileSizeKB(outputPath);

    bestOutput = outputPath;

    if (sizeKB <= targetKB) {
      break;
    }
  }

  res.download(bestOutput, () => {
    fs.unlinkSync(inputPath);
    fs.unlinkSync(bestOutput);
  });

});

app.get("/", (req,res)=>{
  res.send("PDF Compress API Running");
});

app.listen(3000, ()=>{
  console.log("Server running");
});
