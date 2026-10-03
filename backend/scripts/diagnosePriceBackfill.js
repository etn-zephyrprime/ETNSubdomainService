// backend/scripts/diagnosePriceBackfill.js
//
// Why a specific token's historical USD price never resolves, even when live GeckoTerminal data
// clearly exists for the dates in question (confirmed for CLUB via direct curl against
// GeckoTerminal's own API — the pool and candles are there right now). pnlPricing.js's
// ensureBackfilled runs a token's full bulk price-history backfill exactly ONCE, ever, and
// permanently records the result in price_history_backfill_state — ALL later lookups trust that
// recorded row blindly (see getHistoricalPriceUsd's own "known bulk-backfill ceiling" fail-fast)
// and never re-attempt a live fetch, even if the one-time backfill was incomplete (e.g. it hit a
// transient API error partway through its paginated walk and silently stopped early — see
// backfillPoolDailyHistory's own catch-and-break). This prints that recorded state directly, then
// retries a real getHistoricalPriceUsd lookup for the date(s) given so a stale/wrong record is
// visible rather than guessed at.
//
// Usage:
//   node backend/scripts/diagnosePriceBackfill.js <tokenAddress> [YYYY-MM-DD ...]
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getBackfillState } from "../db/priceHistoryBackfillState.js";
import { getPricePoint } from "../db/pricePoints.js";
import { getHistoricalPriceUsd } from "../services/pnlPricing.js";

dotenv.config();

async function main() {
  const [tokenAddress, ...dateArgs] = process.argv.slice(2);
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    throw new Error("Usage: node backend/scripts/diagnosePriceBackfill.js <tokenAddress> [YYYY-MM-DD ...]");
  }
  const cacheAsset = tokenAddress.toLowerCase();

  const state = await getBackfillState(cacheAsset);
  console.log(`price_history_backfill_state row for ${cacheAsset}:`);
  console.log(state ? JSON.stringify(state, null, 2) : "  (none — never backfilled yet)");

  const dates = dateArgs.length > 0 ? dateArgs : [];
  for (const dateStr of dates) {
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) {
      console.log(`\nSkipping invalid date: ${dateStr}`);
      continue;
    }
    const cached = await getPricePoint(cacheAsset, d);
    console.log(`\n${dateStr} — price_points cache: ${cached ? `$${cached.price_usd} (source: ${cached.source})` : "(no cached row)"}`);
    try {
      const live = await getHistoricalPriceUsd(cacheAsset, d);
      console.log(`${dateStr} — getHistoricalPriceUsd resolved: $${live}`);
    } catch (err) {
      console.log(`${dateStr} — getHistoricalPriceUsd THREW: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("Diagnosis failed:", err);
  process.exit(1);
});
