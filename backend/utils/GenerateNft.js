import express from "express";
import { generateNftImage } from "../utils/imageGenerator.js";
import { uploadNftToR2 } from "../utils/R2Upload.js";
import { verifyOwnership, OwnershipVerificationError } from "../utils/verifyOwnership.js";

const router = express.Router();

router.post("/generate-nft", async (req, res) => {
  const { fullName, nodeHex, template, timestamp, signature } = req.body;

  if (!fullName || !nodeHex || timestamp == null || !signature) {
    return res.status(400).json({ error: "fullName, nodeHex, timestamp, and signature are required" });
  }

  // Proves the caller actually owns nodeHex on-chain (via NameWrapper) before letting them
  // generate/overwrite that name's stored NFT art. Without this, anyone could POST any node's
  // (publicly-computable, non-secret) hash to deface an already-registered name's artwork.
  try {
    await verifyOwnership({ nodeHex, timestamp, signature });
  } catch (err) {
    if (err instanceof OwnershipVerificationError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Ownership verification failed unexpectedly:", err);
    return res.status(500).json({ error: "Verification failed" });
  }

  try {
    const { buffer, filename } = await generateNftImage(fullName, nodeHex, template);

    const base64 = buffer.toString("base64");
    const dataUrl = `data:image/png;base64,${base64}`;

    // Awaited (not fire-and-forget) so the response can include the real storage URL — no
    // on-chain metadata linking (see NFT-art plan decision: NameWrapper's metadataService is a
    // single protocol-wide setting we don't control, not a per-project mechanism, so art stays
    // backend-hosted only, but the frontend still wants a link to it). A failed/unconfigured
    // upload doesn't fail the request — the generated image is still returned, just without a
    // storageUrl.
    let storageUrl = null;
    try {
      storageUrl = await uploadNftToR2(buffer, filename);
    } catch (err) {
      console.error(`R2 upload failed for ${filename}:`, err.message);
    }

    res.json({
      success: true,
      image: dataUrl,
      filename,
      storageUrl,
    });
  } catch (err) {
    // Full detail stays server-side only — the raw message can include internal filesystem
    // paths (e.g. imageGenerator.js's "Missing template image: <absolute path>").
    console.error("NFT generation failed:", err);
    res.status(500).json({ error: "Image generation failed" });
  }
});

export default router;