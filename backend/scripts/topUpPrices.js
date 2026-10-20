// backend/scripts/topUpPrices.js
//
// Manual run of the daily price top-up (see pnlPricing.js's topUpRecentPrices and
// utils/priceTopUpScheduler.js) — e.g. right after deploying it, or to cover a longer gap.
//
// Usage (from backend/):
//   node scripts/topUpPrices.js              # last 10 completed days
//   node scripts/topUpPrices.js --days=30    # longer window (ElectroSwap: 100 + 1 credit per candle per token)
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { topUpRecentPrices } from "../services/pnlPricing.js";

dotenv.config();

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = daysArg ? parseInt(daysArg.split("=")[1], 10) : 10;
const unknown = process.argv.slice(2).filter((a) => !a.startsWith("--days="));

async function main() {
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  if (!Number.isFinite(days) || days <= 0 || days > 499) throw new Error(`--days must be 1-499, got ${daysArg}`);
  if (!getPool()) throw new Error("DATABASE_URL not set.");
  console.log(`Topping up the last ${days} day(s) of prices...`);
  const r = await topUpRecentPrices({ days });
  console.log(`Done: ${r.updated}/${r.assets} assets updated, ${r.pricesWritten} daily prices written (${r.noData} no data, ${r.skipped} skipped, ${r.failed} failed).`);
  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Price top-up failed:", err.message);
  process.exitCode = 1;
});
