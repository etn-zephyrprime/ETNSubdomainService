// backend/scripts/diagnoseAvgCostBasis.js
//
// Per-lot breakdown behind avgCostBasisService.js's own average-purchase-price figures — reported
// live: CLUB showed "avg $0.000000 / 1.05e-15 ETN" on Combined Holdings, where the ETN figure is
// ~11 orders of magnitude smaller than dividing the (already near-zero) USD figure by ETN's own
// price could explain — a real calculation anomaly, not just a display/rounding issue (confirmed:
// formatEtnPrice's exponential-notation branch only fires for the real underlying number, it
// doesn't fabricate one). This prints every open lot for one wallet/token — quantity, USD unit
// cost, acquisition date, and the resolved ETN price at that exact date — so the one bad lot (or
// bad historical price lookup) is visible directly instead of guessed at from the aggregate.
//
// Usage:
//   node backend/scripts/diagnoseAvgCostBasis.js <walletAddress> <tokenAddress> [selfOwnedAddress...]
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getHistoricalPriceUsd } from "../services/pnlPricing.js";
import { NATIVE_SENTINEL } from "../services/pnlEventBuilder.js";
import { getLedgerState } from "../services/pnlSnapshotService.js";

dotenv.config();

async function main() {
  const [wallet, tokenAddress, ...selfOwned] = process.argv.slice(2);
  if (!wallet || !ethers.isAddress(wallet) || !tokenAddress || !ethers.isAddress(tokenAddress)) {
    throw new Error("Usage: node backend/scripts/diagnoseAvgCostBasis.js <walletAddress> <tokenAddress> [selfOwnedAddress...]");
  }
  const tokenLc = tokenAddress.toLowerCase();

  console.log(`Replaying ${wallet}'s ledger (this re-fetches/replays the full history — same cost as a cold Core Tier load)...`);
  const { closing } = await getLedgerState(wallet, selfOwned, null);
  const lots = closing.lots.filter((l) => l.tokenAddress === tokenLc);

  if (lots.length === 0) {
    console.log(`No open lots for ${tokenAddress} in this wallet's ledger.`);
    return;
  }

  console.log(`${lots.length} open lot(s) for ${tokenAddress}:\n`);

  let totalQty = 0;
  let totalCostUsd = 0;
  let totalCostEtn = 0;
  let totalEtnQty = 0;

  for (const lot of lots) {
    const qty = Number(lot.quantityRemaining);
    const unitCostUsd = Number(lot.unitCostUsd);
    let etnPriceUsd = null;
    let etnErr = null;
    try {
      etnPriceUsd = await getHistoricalPriceUsd(NATIVE_SENTINEL, lot.openedTimestamp);
    } catch (err) {
      etnErr = err.message;
    }
    const unitCostEtn = etnPriceUsd != null && etnPriceUsd > 0 ? unitCostUsd / etnPriceUsd : null;

    totalQty += qty;
    totalCostUsd += qty * unitCostUsd;
    if (unitCostEtn != null) {
      totalCostEtn += qty * unitCostEtn;
      totalEtnQty += qty;
    }

    console.log(
      `  qty=${qty.toLocaleString()} unitCostUsd=${unitCostUsd} opened=${new Date(lot.openedTimestamp).toISOString()} ` +
        `openedTx=${lot.openedTxHash} etnPriceUsdAtOpen=${etnPriceUsd ?? `FAILED (${etnErr})`} ` +
        `unitCostEtn=${unitCostEtn ?? "—"}`
    );
  }

  console.log(`\nTotals: quantity=${totalQty}, avgCostUsd=${totalQty > 0 ? totalCostUsd / totalQty : "—"}, ` +
    `avgCostEtn=${totalEtnQty > 0 ? totalCostEtn / totalEtnQty : "—"} (priced ${totalEtnQty}/${totalQty} of quantity)`);
}

main().catch((err) => {
  console.error("Diagnosis failed:", err);
  process.exit(1);
});
