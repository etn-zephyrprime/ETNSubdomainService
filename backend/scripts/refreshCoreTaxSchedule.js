// backend/scripts/refreshCoreTaxSchedule.js
//
// Runs coreTaxScheduleService.js's binary-search refresh once, immediately, instead of waiting for
// the backend's own daily background timer (see startCoreTaxScheduleRefresh) — useful for the very
// first run, so the Tokens tab's CORE tax chart has real data without waiting up to a day after
// deploy.
//
// Usage:
//   node backend/scripts/refreshCoreTaxSchedule.js
//
// Safe to re-run: already-confirmed thresholds are skipped, only newly-reached ones are searched.
import dotenv from "dotenv";
import { refreshCoreTaxSchedule, TAX_SCHEDULE } from "../services/coreTaxScheduleService.js";

dotenv.config();

async function main() {
  console.log(`Checking CORE's on-chain supply history against all ${TAX_SCHEDULE.length} tax-schedule thresholds...`);
  const steps = await refreshCoreTaxSchedule();
  if (steps === null) return; // service already logged why (CORE_TOKEN_ADDRESS not set)

  console.log("\nConfirmed so far:");
  for (const s of steps) {
    console.log(`  ${s.supplyPct}% (${s.totalSupply.toLocaleString()} CORE) — buy ${s.buyTaxPct}% / sell ${s.sellTaxPct}% — crossed ${s.crossedAt || "?"} (block ${s.crossedAtBlock ?? "?"})`);
  }
  const remaining = TAX_SCHEDULE.length - steps.length;
  if (remaining > 0) {
    console.log(`\n${remaining} threshold(s) not yet reached by CORE's current supply.`);
  }
}

main().catch((err) => {
  console.error("CORE tax schedule refresh failed:", err);
  process.exit(1);
});
