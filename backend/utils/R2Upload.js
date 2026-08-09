import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;

  cachedClient = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  return cachedClient;
}

/**
 * Uploads a PNG buffer to R2 and returns its public URL. Throws if R2 env vars aren't
 * configured or the upload fails — callers that don't want a failed/unconfigured upload to break
 * the whole request (e.g. GenerateNft.js) should catch this themselves.
 */
export async function uploadNftToR2(buffer, filename) {
  const BUCKET_NAME = process.env.R2_BUCKET_NAME;
  const PUBLIC_URL_BASE = process.env.R2_PUBLIC_URL; // e.g. https://pub-xxxx.r2.dev

  if (!BUCKET_NAME || !PUBLIC_URL_BASE) {
    throw new Error("R2 env vars not configured (R2_BUCKET_NAME / R2_PUBLIC_URL)");
  }

  const r2 = getClient();

  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: filename,
      Body: buffer,
      ContentType: "image/png",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  const publicUrl = `${PUBLIC_URL_BASE.replace(/\/$/, "")}/${filename}`;

  console.log(`✅ Uploaded to R2: ${publicUrl}`);

  return publicUrl;
}

/**
 * Whether `filename` already exists in the bucket — lets a bulk job (e.g.
 * scripts/backfillNftImages.js) skip names that already have an image instead of
 * unconditionally re-generating and overwriting every one of them.
 */
export async function objectExistsInR2(filename) {
  const BUCKET_NAME = process.env.R2_BUCKET_NAME;
  if (!BUCKET_NAME) {
    throw new Error("R2 env vars not configured (R2_BUCKET_NAME)");
  }

  const r2 = getClient();
  try {
    await r2.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: filename }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return false;
    throw err;
  }
}