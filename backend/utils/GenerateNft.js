import express from "express";
import { generateNftImage } from "../utils/imageGenerator.js";
import { uploadNftToR2 } from "../utils/R2Upload.js";

const router = express.Router();

router.post("/generate-nft", async (req, res) => {
  const { fullName, nodeHex, template } = req.body;

  if (!fullName || !nodeHex) {
    return res.status(400).json({ error: "fullName and nodeHex are required" });
  }

  try {
    const { buffer, filename } = await generateNftImage(fullName, nodeHex, template);
    
    const base64 = buffer.toString("base64");
    const dataUrl = `data:image/png;base64,${base64}`;

    res.json({
      success: true,
      image: dataUrl,
      filename,
    });

    // Fire-and-forget upload to R2 — no on-chain metadata linking (see NFT-art plan decision:
    // NameWrapper's metadataService is a single protocol-wide setting we don't control, not a
    // per-project mechanism, so art stays backend-hosted only).
    uploadNftToR2(buffer, filename).catch((err) => {
      console.error(`R2 upload failed for ${filename}:`, err.message);
    });

  } catch (err) {
    console.error("NFT generation failed:", err);
    res.status(500).json({ error: "Image generation failed", details: err.message });
  }
});

export default router;