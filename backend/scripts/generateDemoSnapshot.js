// backend/scripts/generateDemoSnapshot.js
//
// Computes the Core Tier demo's PnL/DeFi/LP/NFT/holdings data for its 3 fixed wallets (see
// coreTierDemoRouter.js's own DEMO_WALLET_ADDRESSES comment) and persists the REAL, unscaled
// result to R2 so the live route just serves it instead of recomputing on every cache miss. See
// coreTierDemoState.js's own header comment for why this moved off the request path entirely: the
// live computation is a real cost (FIFO replay + live pricing + DeFi/LP/NFT valuation, for 3
// wallets, 365 days of history) that used to regularly time out the request.
//
// Deliberately does NOT scale/anonymize the figures before storing them — that used to happen here
// (scaling to 75% of the real number before persisting), but per explicit request the stored data
// is now the wallets' true computed figures; CoreTierDemo.jsx applies its own display-only scale
// (DEMO_DISPLAY_SCALE) client-side instead, so what's actually computed and persisted always stays
// accurate even though what a visitor sees is scaled down.
//
// Not on any scheduler — the demo's data doesn't need to track the real wallets' activity in real
// time (it's a preview, not a live account), so this is meant to be re-run manually, occasionally,
// whenever a fresher-looking demo is wanted. Safe to re-run any time: it fully recomputes and
// overwrites the stored snapshot, it doesn't append to it.
//
// Usage:
//   node backend/scripts/generateDemoSnapshot.js
//   node backend/scripts/generateDemoSnapshot.js --force   (persist despite pricing-health warnings)
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { computeDemoData } from "../utils/coreTierDemoRouter.js";
import { setDemoSnapshot } from "../state/coreTierDemoState.js";

dotenv.config();

// Confirmed live (2026-09-18): running this script while ElectroSwap pricing was still degraded
// (recovering from a real key suspension — see the "electroswap-suspension-incident" write-up)
// silently persisted a snapshot where every Combined Holdings token showed $0.00 and a WETN/CORE
// LP position showed roughly HALF its real value (one leg priced, the other fell through to a
// wrong/negligible on-chain quote) — because this script has no concept of "the data I just
// computed looks broken", only "did the computation throw". A demo visitor then sees confidently-
// wrong numbers with zero indication anything's off, for as long as this stale snapshot sits in
// R2 (this demo is fully static — nothing here self-heals until someone re-runs this script).
//
// This is a heuristic, not a proof: it catches the "pricing infra was broadly down" pattern (ETN
// itself failing to price, or most held tokens coming back unpriced) that caused the incident
// above, NOT a single leg quietly resolving to a wrong-but-non-null price (that needs a human
// glancing at the numbers, which this can't automate) — see this file's own git history for that
// specific failure mode if it recurs.
function checkForSuspiciousPricing(data) {
  const warnings = [];

  let totalCoinBalance = 0n;
  try { totalCoinBalance = BigInt(data.combinedHoldings?.totalCoinBalance || "0"); } catch { /* leave 0n */ }
  if (totalCoinBalance > 0n && data.combinedHoldings?.etnUsdValue == null) {
    warnings.push("Native ETN balance is nonzero but etnUsdValue came back null — the ETN/USD price cache looks unavailable right now.");
  }

  const heldTokens = (data.combinedHoldings?.tokens || []).filter((t) => {
    try { return BigInt(t.rawBalance || "0") > 0n; } catch { return false; }
  });
  const unpriced = heldTokens.filter((t) => t.usdValue == null);
  if (heldTokens.length > 0 && unpriced.length / heldTokens.length > 0.5) {
    warnings.push(`${unpriced.length}/${heldTokens.length} held tokens came back unpriced (>50%) — ElectroSwap/GeckoTerminal pricing looks degraded right now.`);
  }

  return warnings;
}

async function main() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY not set — nowhere to persist the snapshot.");
  }

  console.log("Computing Core Tier demo data (PnL, DeFi, liquidity, NFT PnL, holdings) for all 3 demo wallets...");
  const data = await computeDemoData();

  const warnings = checkForSuspiciousPricing(data);
  if (warnings.length > 0 && !process.argv.includes("--force")) {
    console.error("❌ Refusing to persist — this snapshot's pricing looks degraded right now:");
    warnings.forEach((w) => console.error(`   - ${w}`));
    console.error("   Check whether ElectroSwap is currently rate-limited/suspended (see recent backend logs for");
    console.error("   the circuit breaker's own \"pausing ALL ElectroSwap calls\" message) and re-run once it's");
    console.error("   recovered. Pass --force to persist anyway despite these warnings.");
    process.exitCode = 1;
    if (getPool()) await getPool().end();
    return;
  }
  if (warnings.length > 0) {
    console.warn("⚠️  --force passed — persisting despite these pricing-health warnings:");
    warnings.forEach((w) => console.warn(`   - ${w}`));
  }

  console.log("Persisting to R2...");
  await setDemoSnapshot(data);

  console.log("✅ Demo snapshot generated and stored — the live route will serve it on the next request.");

  if (getPool()) await getPool().end();
}

main().catch((err) => {
  console.error("❌ Demo snapshot generation failed:", err);
  process.exitCode = 1;
});
