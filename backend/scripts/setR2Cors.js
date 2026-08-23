import "dotenv/config";
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from "@aws-sdk/client-s3";

// One-time (or re-run-whenever-needed) setup: applies a CORS policy to the R2 bucket so browsers
// can actually fetch objects from it via `fetch()` — see backend/state/subnameDomainsState.js and
// utils/subnameDomainsCache.js, whose whole point is a fast public JSON the frontend fetches
// directly from R2's public URL instead of scanning on-chain history in every visitor's browser.
//
// Without this, that fetch fails in real browsers even though the object is served fine (curl
// doesn't enforce CORS, so it looks fine there) — confirmed live: the bucket's public r2.dev URL
// returns 403 on a CORS preflight OPTIONS request with no CORS policy set, which is what pushed
// the frontend into its slow on-chain-scan fallback every single time. NFT images never surfaced
// this because they're loaded via <img src> tags, which don't require CORS the way fetch() does.
//
// Usage:
//   node scripts/setR2Cors.js                                    # allow SITE_URL only (default)
//   node scripts/setR2Cors.js --origin=https://example.com       # allow one specific origin
//   node scripts/setR2Cors.js --origin=* --origin=http://localhost:5173   # allow multiple (repeatable)
//   node scripts/setR2Cors.js --dry-run                           # print the policy, apply nothing

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const originArgs = args.filter((a) => a.startsWith("--origin=")).map((a) => a.slice("--origin=".length));

// Every object this bucket serves publicly (NFT images, subname-domains.json) is meant to be
// freely readable by anyone — there's no auth/user data behind this bucket's public URL — so
// defaulting to the site's own origin (not "*") is just being conservative by default, not a
// security requirement. Pass --origin=* yourself if you want it wide open (e.g. for local dev
// against a deployed bucket without also passing --origin=http://localhost:5173).
const SITE_URL = process.env.SITE_URL || "https://nameservice.planetzephyros.xyz";
const allowedOrigins = originArgs.length > 0 ? originArgs : [SITE_URL];

const REQUIRED_ENV = ["R2_ENDPOINT", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];

async function main() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`❌ Missing required env var(s): ${missing.join(", ")}`);
    console.error("   Set these the same way you did for R2 image uploads (see backend/.env.example).");
    process.exit(1);
  }

  const client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  const corsRule = {
    AllowedOrigins: allowedOrigins,
    AllowedMethods: ["GET", "HEAD"],
    AllowedHeaders: ["*"],
    MaxAgeSeconds: 3600,
  };

  console.log(`Bucket: ${process.env.R2_BUCKET_NAME}`);
  console.log("CORS rule to apply:");
  console.log(JSON.stringify(corsRule, null, 2));

  if (dryRun) {
    console.log("\n--dry-run: not applying. Re-run without it to actually set this.");
    return;
  }

  await client.send(
    new PutBucketCorsCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      CORSConfiguration: { CORSRules: [corsRule] },
    })
  );
  console.log("\n✅ CORS policy applied.");

  // Read it back so you can see it took effect immediately, rather than trusting a 200 blindly.
  const current = await client.send(new GetBucketCorsCommand({ Bucket: process.env.R2_BUCKET_NAME }));
  console.log("\nCurrent bucket CORS configuration:");
  console.log(JSON.stringify(current.CORSRules, null, 2));

  console.log(
    `\nVerify from a browser (or: curl -I -X OPTIONS -H "Origin: ${allowedOrigins[0]}" -H "Access-Control-Request-Method: GET" <your R2_PUBLIC_URL>/subname-domains.json)` +
      " — should now return 2xx with an Access-Control-Allow-Origin header instead of 403."
  );
}

main().catch((err) => {
  console.error("❌ Failed to set R2 CORS policy:", err.message);
  process.exit(1);
});
