import { generateNftImage } from "./imageGenerator.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  try {
    const { buffer, filename } = await generateNftImage(
      "planetzephyros.etn",
      "8607034444057300214419640742371266237737643979798175560172819860381375338987"
    );

    const outputDir = path.join(__dirname, "..", "generated");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, buffer);

    console.log("Image generated:", outputPath);
  } catch (err) {
    console.error("Generation failed:", err);
  }
}

run();