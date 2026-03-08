import express from "express";
import multer from "multer";
import { exec } from "child_process";
import fs from "fs";

const app = express();

const upload = multer({ dest: "uploads/" });

app.post("/compress", upload.single("file"), (req, res) => {

  const inputPath = req.file.path;
  const outputPath = `outputs/compressed-${Date.now()}.pdf`;

  const command = `
  gs -sDEVICE=pdfwrite
  -dCompatibilityLevel=1.4
  -dPDFSETTINGS=/ebook
  -dNOPAUSE
  -dQUIET
  -dBATCH
  -sOutputFile=${outputPath}
  ${inputPath}
  `;

  exec(command, (error) => {

    if (error) {
      return res.status(500).send("Compression failed");
    }

    res.download(outputPath, () => {

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);

    });

  });

});

app.get("/", (req,res)=>{
  res.send("PDF Compress API Running");
});

app.listen(3000, ()=>{
  console.log("Server running on port 3000");
});
