// backend/scripts/repairSwapAndFarmBoltLegs.js
//
// One-time, in-place repair for two ingestion bugs found tracing burny.etn's BOLT drift (ledger
// showed 10,570 BOLT more than the wallet held). Both are fixed in pnlIngestion.js for NEW ingestion;
// this corrects the rows already stored, with no reset and no re-ingest:
//
//  1. swap_trades — detectAndRecordSwap matched legs against ONE pool, so a split route (part V2,
//     part V3) recorded only part of what was bought, and a multi-hop route starting in V3 never
//     recorded the token sold. Each row is re-derived with deriveSwapLegs (net flow across every
//     pool in the tx) and its token/amount columns updated where they differ. A leg whose token
//     changed is re-priced (left null if the lookup fails — backfillDeferredPrices fills it later).
//     Rows that would no longer count as a swap at all (more than one token in or out) are only
//     reported, never changed: they'd need their legs re-ingested as plain transfers.
//  2. defi_activity — enrichFarmRowsWithBolt took the FIRST BOLT transfer between farmer and farm
//     as the multiplier, which on a BOLT-pool farm is the liquidity leg (deposit) or the BOLT fees
//     (every harvest). raw_args.amountBoltAdded/amountBoltReturned is recomputed with
//     computeFarmBoltAmount and set, changed, or removed to match.
//
// pnl_snapshots are cleared for every wallet that changed (unless --keep-history), since
// backfillPnlHistory only fills MISSING days. Run backfillPnlHistory.js afterwards.
//
// DRY RUN BY DEFAULT.
//   node scripts/repairSwapAndFarmBoltLegs.js                         # report what would change
//   node scripts/repairSwapAndFarmBoltLegs.js --apply                 # change rows + clear history
//   node scripts/repairSwapAndFarmBoltLegs.js --wallet=0xabc... [--wallet=0xdef...]
//   node scripts/repairSwapAndFarmBoltLegs.js --swaps-only | --farms-only
//   node scripts/repairSwapAndFarmBoltLegs.js --apply --keep-history
//
// Safe to re-run: rows that are already right are left alone.
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getPool, query } from "../db/pool.js";
import { deriveSwapLegs, computeFarmBoltAmount, getFarmBoltContext } from "../services/pnlIngestion.js";
import { getHistoricalPriceUsd } from "../services/pnlPricing.js";
import { createRpcProvider } from "../utils/rpcProvider.js";

dotenv.config();

const KNOWN_FLAGS = ["--apply", "--keep-history", "--swaps-only", "--farms-only"];
const args = process.argv.slice(2);
const unknown = args.filter((a) => !KNOWN_FLAGS.includes(a) && !a.startsWith("--wallet="));
if (unknown.length) {
  console.error(`❌ Unknown argument(s): ${unknown.join(" ")}`);
  process.exit(1);
}
const apply = args.includes("--apply");
const keepHistory = args.includes("--keep-history");
const doSwaps = !args.includes("--farms-only");
const doFarms = !args.includes("--swaps-only");
const wallets = args.filter((a) => a.startsWith("--wallet=")).map((a) => a.slice("--wallet=".length).toLowerCase());
for (const w of wallets) if (!ethers.isAddress(w)) throw new Error(`--wallet is not a valid address: ${w}`);

const BLOCKSCOUT = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Blockscout rate-limits a long run like this one (confirmed: three parallel requests per tx with a
// ~7s retry budget had whole runs of txs skipped). Requests go one at a time, and a 429 waits for
// Retry-After (or a long backoff) rather than burning through the retries.
async function getJson(path) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(`${BLOCKSCOUT}${path}`, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.json();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * (attempt + 1));
        continue;
      }
    } catch {
      // retry below
    }
    await sleep(1000 * 2 ** Math.min(attempt, 5));
  }
  throw new Error(`Blockscout request failed after retries: ${path}`);
}

async function getAllItems(path) {
  const items = [];
  let extra = "";
  for (let page = 0; page < 50; page++) {
    const res = await getJson(`${path}${extra}`);
    items.push(...(res.items || []));
    if (!res.next_page_params) break;
    extra = `?${new URLSearchParams(Object.fromEntries(Object.entries(res.next_page_params).map(([k, v]) => [k, String(v)])))}`;
  }
  return items;
}

const walletFilter = (col, params) => {
  if (!wallets.length) return "";
  params.push(wallets);
  return ` AND ${col} = ANY($${params.length}::text[])`;
};

const sameAmount = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  return Math.abs(x - y) <= Math.max(1e-12, Math.abs(y) * 1e-9);
};
const sameToken = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const short = (a) => (String(a).toUpperCase() === "NATIVE" ? "ETN" : String(a).slice(0, 10));
const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });

async function priceOrNull(asset, timestamp) {
  try {
    return await getHistoricalPriceUsd(asset, new Date(timestamp));
  } catch {
    return null;
  }
}

async function repairSwaps(changedWallets) {
  const params = [];
  const res = await query(
    `SELECT id, tracked_wallet, tx_hash, token_sold_address, amount_sold, token_bought_address, amount_bought,
            price_usd_sold_leg, price_usd_bought_leg, "timestamp"
     FROM swap_trades WHERE true${walletFilter("tracked_wallet", params)} ORDER BY tracked_wallet, "timestamp"`,
    params
  );
  const rows = res?.rows || [];
  console.log(`\n== swap_trades: checking ${rows.length} row(s) ==\n`);
  const txCache = new Map();
  let changed = 0;
  let notSwap = 0;
  let failed = 0;
  let retryLater = [];
  let isRetryPass = false;

  // Second pass: rows whose tx couldn't be fetched get one more try at the end, after a pause, once
  // whatever rate limit hit them has had time to clear.
  for (let pass = 0; pass < 2; pass++) {
    const passRows = pass === 0 ? rows : retryLater;
    if (pass === 1) {
      if (passRows.length === 0) break;
      console.log(`\n  retrying ${passRows.length} row(s) whose tx couldn't be fetched, after a 60s pause…`);
      await sleep(60000);
      isRetryPass = true;
      retryLater = [];
    }
    for (const [i, row] of passRows.entries()) {
      if (i > 0 && i % 100 === 0) console.log(`  …${i}/${passRows.length}`);
      const hash = String(row.tx_hash).toLowerCase();
      let data = txCache.get(hash);
      if (!data) {
        try {
          const tx = await getJson(`/transactions/${hash}`);
          const logs = await getAllItems(`/transactions/${hash}/logs`);
          const transfers = await getAllItems(`/transactions/${hash}/token-transfers`);
          data = { tx, logs, transfers };
        } catch (err) {
          if (!isRetryPass) {
            retryLater.push(row);
            continue;
          }
          console.log(`  ⚠️  ${hash} skipped — ${err.message}`);
          failed++;
          continue;
        }
        txCache.set(hash, data);
        await sleep(250);
      }

      const legs = deriveSwapLegs(String(row.tracked_wallet).toLowerCase(), data.tx, data.logs, data.transfers);
      if (!legs) {
        console.log(`  ?  ${row.tracked_wallet.slice(0, 10)} ${hash} no longer a one-for-one swap — left unchanged (needs a re-ingest)`);
        notSwap++;
        continue;
      }
      const soldSame = sameToken(legs.soldAddress, row.token_sold_address) && sameAmount(legs.soldAmount, row.amount_sold);
      const boughtSame = sameToken(legs.boughtAddress, row.token_bought_address) && sameAmount(legs.boughtAmount, row.amount_bought);
      if (soldSame && boughtSame) continue;

      changed++;
      changedWallets.add(String(row.tracked_wallet).toLowerCase());
      console.log(
        `  ✎  ${row.tracked_wallet.slice(0, 10)} ${hash}\n` +
          `       was ${fmt(row.amount_sold)} ${short(row.token_sold_address)} -> ${fmt(row.amount_bought)} ${short(row.token_bought_address)}\n` +
          `       now ${fmt(legs.soldAmount)} ${short(legs.soldAddress)} -> ${fmt(legs.boughtAmount)} ${short(legs.boughtAddress)}`
      );
      if (!apply) continue;

      const soldPrice = sameToken(legs.soldAddress, row.token_sold_address) ? row.price_usd_sold_leg : await priceOrNull(legs.soldAddress, row.timestamp);
      const boughtPrice = sameToken(legs.boughtAddress, row.token_bought_address)
        ? row.price_usd_bought_leg
        : await priceOrNull(legs.boughtAddress, row.timestamp);
      const norm = (a) => (a === "NATIVE" ? "NATIVE" : a.toLowerCase());
      await query(
        `UPDATE swap_trades SET token_sold_address = $2, amount_sold = $3, token_bought_address = $4, amount_bought = $5,
              price_usd_sold_leg = $6, price_usd_bought_leg = $7 WHERE id = $1`,
        [row.id, norm(legs.soldAddress), legs.soldAmount, norm(legs.boughtAddress), legs.boughtAmount, soldPrice, boughtPrice]
      );
    }
  }
  console.log(`\nswap_trades: ${changed} ${apply ? "corrected" : "would be corrected"}, ${notSwap} left for re-ingest, ${failed} skipped (fetch failed).`);
}

async function repairFarms(changedWallets) {
  const params = [];
  const res = await query(
    `SELECT id, tracked_wallet, tx_hash, contract_address, event_type, farm_id, raw_args
     FROM defi_activity WHERE event_type IN ('farm_deposit', 'farm_withdraw')${walletFilter("tracked_wallet", params)}
     ORDER BY tracked_wallet, "timestamp"`,
    params
  );
  const rows = res?.rows || [];
  console.log(`\n== defi_activity: checking ${rows.length} farm row(s) for BOLT ==\n`);
  const provider = createRpcProvider();
  const receipts = new Map();
  const farms = new Map();
  let changed = 0;
  let failed = 0;

  for (const row of rows) {
    const hash = String(row.tx_hash).toLowerCase();
    if (!receipts.has(hash)) {
      try {
        receipts.set(hash, await provider.getTransactionReceipt(hash));
      } catch {
        receipts.set(hash, null);
      }
    }
    const receipt = receipts.get(hash);
    const farmKey = `${row.contract_address}:${row.farm_id}`;
    if (!farms.has(farmKey)) farms.set(farmKey, await getFarmBoltContext(row.contract_address, row.farm_id));
    const farm = farms.get(farmKey);
    if (!receipt || !farm) {
      console.log(`  ⚠️  ${hash} skipped — couldn't read ${!receipt ? "its receipt" : "the farm's tokens"}`);
      failed++;
      continue;
    }

    const key = row.event_type === "farm_deposit" ? "amountBoltAdded" : "amountBoltReturned";
    const raw = row.raw_args || {};
    const want = computeFarmBoltAmount(row.event_type, raw, String(row.contract_address).toLowerCase(), receipt.logs, farm);
    const have = raw[key] && BigInt(raw[key]) > 0n ? String(raw[key]) : null;
    if (want === have) continue;

    changed++;
    changedWallets.add(String(row.tracked_wallet).toLowerCase());
    const show = (v) => (v ? fmt(ethers.formatUnits(v, 18)) : "none");
    console.log(`  ✎  ${row.tracked_wallet.slice(0, 10)} ${row.event_type.padEnd(13)} ${hash}  ${key}: ${show(have)} -> ${show(want)}`);
    if (!apply) continue;

    if (want) {
      await query(`UPDATE defi_activity SET raw_args = raw_args || jsonb_build_object($2::text, $3::text) WHERE id = $1`, [row.id, key, want]);
    } else {
      await query(`UPDATE defi_activity SET raw_args = raw_args - $2::text WHERE id = $1`, [row.id, key]);
    }
  }
  console.log(`\ndefi_activity: ${changed} ${apply ? "corrected" : "would be corrected"}, ${failed} skipped.`);
}

async function main() {
  if (!getPool()) throw new Error("DATABASE_URL not set — nothing to repair.");
  const changedWallets = new Set();
  if (doFarms) await repairFarms(changedWallets);
  if (doSwaps) await repairSwaps(changedWallets);

  console.log(`\nWallets affected: ${changedWallets.size}${changedWallets.size ? `\n  ${[...changedWallets].join("\n  ")}` : ""}`);
  if (!apply) {
    console.log("\nDry run — no changes made. Re-run with --apply to write them.");
  } else if (changedWallets.size && !keepHistory) {
    await query(`DELETE FROM pnl_snapshots WHERE wallet_address = ANY($1::text[])`, [[...changedWallets]]);
    console.log("\npnl_snapshots cleared for those wallets — run node scripts/backfillPnlHistory.js next to recompute them.");
  }
  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
