// backend/scripts/diagnoseV3PositionLedger.js
//
// Whether a specific V3 position's cost basis / realized P&L actually made it into a wallet's FIFO
// ledger. pnlIngestion.js's detectAndRecordV3PositionEvent decomposes V3 mint/increase/decrease/
// collect into synthetic ingested_transfers rows keyed by v3PositionAssetKey (tokenAddress =
// "<positionManagerAddress>:<tokenId>") — these flow through fifoLotEngine.js exactly like a
// regular fungible token's lots, so a closed position (liquidity withdrawn back to the live V3
// contract's own on-chain state) should still leave a real acquisition lot (opened) and a real
// disposal/realizedEvent (closed) in the ledger, the same way selling a fungible token does. If the
// live getLiquidityPositionsUsd lookup correctly shows nothing (because the position is genuinely
// closed on-chain right now), THIS script is what confirms whether the historical cost-basis/
// realized-P&L record for that same position actually exists — a real gap here (an acquisition lot
// with no matching disposal) would mean the decrease/collect side of detectAndRecordV3PositionEvent
// didn't fire for this specific transaction, not that nothing happened on-chain.
//
// Usage:
//   node backend/scripts/diagnoseV3PositionLedger.js <walletAddress> <tokenId>
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getLedgerState } from "../services/pnlSnapshotService.js";

dotenv.config();

const POSITION_MANAGER_ADDRESS = "0x3a7f64c57433555b23dac4409a0ac7e84275398d";

async function main() {
  const [wallet, tokenId] = process.argv.slice(2);
  if (!wallet || !ethers.isAddress(wallet) || !tokenId) {
    throw new Error("Usage: node backend/scripts/diagnoseV3PositionLedger.js <walletAddress> <tokenId>");
  }
  const positionKey = `${POSITION_MANAGER_ADDRESS}:${tokenId}`;

  console.log(`Replaying ${wallet}'s ledger, looking for position key ${positionKey}...`);
  const { closing } = await getLedgerState(wallet, [], null);

  const lots = closing.lots.filter((l) => l.tokenAddress === positionKey);
  const realized = closing.realizedEvents.filter((e) => e.tokenAddress === positionKey);

  console.log(`\n${lots.length} open lot(s) for this position:`);
  for (const lot of lots) {
    console.log(`  qty=${lot.quantityRemaining} unitCostUsd=${lot.unitCostUsd} opened=${new Date(lot.openedTimestamp).toISOString()} openedTx=${lot.openedTxHash}`);
  }

  console.log(`\n${realized.length} realized (disposal) event(s) for this position:`);
  for (const e of realized) {
    console.log(
      `  qty=${e.quantityConsumed} costBasisUsd=${e.costBasisUsd} proceedsUsd=${e.proceedsUsd} realizedPnlUsd=${e.realizedPnlUsd} ` +
        `disposedTx=${e.disposalTxHash} disposedAt=${new Date(e.timestamp).toISOString()} acquiredAt=${e.acquisitionTimestamp ? new Date(e.acquisitionTimestamp).toISOString() : "—"}`
    );
  }

  if (lots.length === 0 && realized.length === 0) {
    console.log("\nNOTHING found for this position key at all — the mint itself was never recorded into the ledger.");
  } else if (lots.length > 0 && realized.length === 0) {
    console.log("\nAn open lot exists but NO disposal was ever recorded — the position still shows as 'held' in this wallet's ledger even though it's closed on-chain. This is the gap.");
  } else {
    console.log("\nBoth sides are present — the position's full lifecycle (open + close) is correctly recorded.");
  }
}

main().catch((err) => {
  console.error("Diagnosis failed:", err);
  process.exit(1);
});
