import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getTokenLiquidityCache } from "../../state/tokenLiquidityState.js";
import { getFactsSummaries } from "../../db/contractCheckLists.js";
import { analyseContract } from "./analyseContract.js";
import { FACTS_SCHEMA_VERSION } from "./buildFacts.js";

// The free tier's only view of Contract Check: the overall badge (no flags, no explanation) for each
// ElectroSwap-listed token on the Tokens tab. Published to R2 as contract-badges.json so the free
// dashboard reads a static file — no Contract Check API call and no Supabase egress per visitor.
//
// The token list is the liquidity cache's keys (tokenLiquidityCache.js — every token in an ElectroSwap
// pool that could be valued). Facts come from contract_facts via one lean query; only tokens with no
// facts, facts older than STALE_MS, or facts from an older FACTS_SCHEMA_VERSION (new rules) are
// re-analysed, one at a time.
const CACHE_KEY = "contract-badges.json";
const INTERVAL_MS = Number(process.env.CONTRACT_BADGES_INTERVAL_MS) || 6 * 3600 * 1000;
const STALE_MS = 24 * 3600 * 1000;
const MAX_ANALYSES_PER_RUN = 60; // bounds explorer + RPC work; the rest are picked up next run

let r2 = null;
function r2Client() {
  if (!r2) r2 = new S3Client({ region: "auto", endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  return r2;
}

/** `{ [lowercased address]: "green" | "amber" | "red" }` for the listed tokens that have facts. */
export async function buildBadges(addresses, { analyse = analyseContract, summaries = getFactsSummaries, max = MAX_ANALYSES_PER_RUN, now = Date.now() } = {}) {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const have = await summaries(list);
  const stale = list.filter((a) => !have[a]?.overall || have[a].schemaVersion !== FACTS_SCHEMA_VERSION || now - new Date(have[a].analysedAt).getTime() > STALE_MS);
  const fresh = {};
  for (const a of stale.slice(0, max)) {
    const facts = await analyse(a).catch(() => null);
    if (facts?.overall && !facts.incomplete) fresh[a] = facts.overall;
  }
  const badges = {};
  for (const a of list) {
    const overall = fresh[a] || have[a]?.overall;
    if (overall === "green" || overall === "amber" || overall === "red") badges[a] = overall;
  }
  return badges;
}

let running = false;
async function refreshAndPublish() {
  if (running) return;
  running = true;
  try {
    const liquidity = await getTokenLiquidityCache();
    const tokens = Object.keys(liquidity?.liquidityUsd || {});
    if (!tokens.length) return console.warn("⚠️  Contract badges: no ElectroSwap token list yet — skipping");
    const badges = await buildBadges(tokens);
    await r2Client().send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: CACHE_KEY,
        Body: JSON.stringify({ badges, updatedAt: new Date().toISOString() }),
        ContentType: "application/json",
        CacheControl: "public, max-age=300",
      })
    );
    console.log(`🛡️  Contract badges published — ${Object.keys(badges).length}/${tokens.length} listed token(s)`);
  } catch (err) {
    console.error("⚠️  Contract badges refresh failed:", err.message);
  } finally {
    running = false;
  }
}

export function startContractBadges() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.DATABASE_URL) {
    console.log("ℹ️  R2 or database not configured — contract badges disabled");
    return;
  }
  setTimeout(refreshAndPublish, 5 * 60 * 1000); // after the liquidity cache's first run
  setInterval(refreshAndPublish, INTERVAL_MS);
}
