// backend/scripts/diagnoseLedgerDrift.js
//
// Read-only. Answers: "why does this wallet's PnL ledger disagree with what it actually holds
// on-chain, and which transactions are responsible?" — the PnL Current Value vs Total Portfolio
// Balance gap, at the source. Changes nothing (no ingestion, no writes).
//
// 1. Rebuilds the wallet's FIFO ledger from the database exactly as the live PnL snapshot does and
//    compares each asset's ledger quantity against the real on-chain balance (native via RPC, tokens
//    via Blockscout). Ledger inventory excludes anything currently locked in a farm/stake, same as
//    the on-chain balance does, so the two are directly comparable.
// 2. For native ETN specifically, walks the wallet's internal transactions (independently, straight
//    from Blockscout) and classifies every transaction the way ingestion does — swap / liquidity /
//    V3 position / DeFi farm-stake (all of which are EXCLUDED from ingestion's plain internal-
//    transaction walk, see pnlIngestion.js's excludeTxHashes) versus plain — then compares the ETN
//    the wallet really received in each against what the ledger recorded for that tx. The classes
//    with a large "unrecorded" figure are where the missing ETN went; the top offending transactions
//    are listed so they can be inspected by hand.
//
// Usage: node backend/scripts/diagnoseLedgerDrift.js <wallet> [otherTrackedWallet ...]
//   (pass the member's OTHER tracked wallets too if there are any — same selfOwned handling as the
//    live snapshot.)
import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { getPool } from "../db/pool.js";
import { getAllTransfersBefore } from "../db/ingestedTransfers.js";
import { getAllSwapTradesBefore } from "../db/swapTrades.js";
import { getAllDefiActivityBefore } from "../db/defiActivity.js";
import { buildEventsForWallet } from "../services/pnlSnapshotService.js";
import { replayFifo } from "../services/fifoLotEngine.js";
import { NATIVE_SENTINEL } from "../services/pnlEventBuilder.js";

dotenv.config();

const BLOCKSCOUT = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;

async function getJson(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${BLOCKSCOUT}${path}`, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.json();
    } catch {
      // retry below
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`Blockscout request failed after retries: ${path}`);
}

async function getAllPages(path) {
  const items = [];
  let extra = "";
  for (let page = 0; page < 500; page++) {
    const res = await getJson(`${path}${extra}`);
    // /token-balances returns a bare array (no {items, next_page_params} envelope) — treating it like
    // the paged endpoints made every token balance read as 0.
    if (Array.isArray(res)) {
      items.push(...res);
      break;
    }
    items.push(...(res.items || []));
    if (!res.next_page_params) break;
    extra = `${path.includes("?") ? "&" : "?"}${new URLSearchParams(Object.fromEntries(Object.entries(res.next_page_params).map(([k, v]) => [k, String(v)])))}`;
  }
  return items;
}

const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const fmt = (n, d = 2) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });

async function main() {
  const [wallet, ...others] = process.argv.slice(2);
  if (!wallet || !ethers.isAddress(wallet)) throw new Error("Usage: node backend/scripts/diagnoseLedgerDrift.js <wallet> [otherTrackedWallet ...]");
  if (!getPool()) throw new Error("DATABASE_URL not set — the ledger lives in the database.");
  const walletLc = wallet.toLowerCase();
  const selfOwned = others.map((a) => a.toLowerCase());
  const now = new Date();

  // ---- 1. ledger vs on-chain, per asset ----
  const { events, transfers, defiActivity } = await buildEventsForWallet(walletLc, selfOwned, null, now);
  const { closing } = replayFifo(events, now, now);
  const ledger = new Map();
  for (const lot of closing.lots) {
    ledger.set(lot.tokenAddress, (ledger.get(lot.tokenAddress) || 0) + Number(lot.quantityRemaining));
  }

  const provider = createRpcProvider();
  const nativeBalance = Number(ethers.formatEther(await provider.getBalance(walletLc)));
  const balances = new Map([[NATIVE_SENTINEL, nativeBalance]]);
  for (const b of await getAllPages(`/addresses/${walletLc}/token-balances`)) {
    if (!b.token?.address || b.token.type !== "ERC-20") continue;
    balances.set(b.token.address.toLowerCase(), Number(ethers.formatUnits(b.value || "0", Number(b.token.decimals ?? 18))));
  }
  // The ledger books WETN as ETN (pnlEventBuilder.js's canonicalTokenKey), so compare against both combined.
  balances.set(NATIVE_SENTINEL, nativeBalance + (balances.get(WETN_ADDRESS) ?? 0));
  balances.delete(WETN_ADDRESS);

  console.log(`\nLedger vs on-chain — ${walletLc}\n`);
  console.log("asset".padEnd(14), "on-chain".padStart(20), "ledger".padStart(20), "ledger − chain".padStart(20));
  const rows = [];
  for (const key of new Set([...ledger.keys(), ...balances.keys()])) {
    if (key.includes(":")) continue; // NFT / V3 position keys — not comparable to an ERC-20 balance
    const chain = balances.get(key) ?? 0;
    const led = ledger.get(key) ?? 0;
    const diff = led - chain;
    if (Math.abs(diff) > Math.max(1e-9, Math.abs(chain) * 1e-6)) rows.push({ key, chain, led, diff });
  }
  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  for (const r of rows.slice(0, 25)) {
    console.log(String(r.key === NATIVE_SENTINEL ? "ETN + WETN" : r.key.slice(0, 12)).padEnd(14), fmt(r.chain, 4).padStart(20), fmt(r.led, 4).padStart(20), fmt(r.diff, 4).padStart(20));
  }
  if (rows.length === 0) console.log("(no drift — ledger matches on-chain for every asset)");

  // ---- 2. where did the native ETN go? ----
  console.log("\nBuilding the native-ETN breakdown (walks the wallet's full transaction + internal-transaction history — can take a minute)...");
  const swapHashes = new Set((await getAllSwapTradesBefore(walletLc, now)).map((s) => String(s.tx_hash).toLowerCase()));
  const defiHashes = new Set(defiActivity.map((d) => String(d.tx_hash).toLowerCase()));
  const lpHashes = new Set();
  const v3Hashes = new Set();
  for (const t of transfers) {
    const li = Number(t.log_index);
    if (li <= -2000 && li > -3000) lpHashes.add(String(t.tx_hash).toLowerCase());
    if (li <= -4000 && li > -5000) v3Hashes.add(String(t.tx_hash).toLowerCase());
  }
  const classify = (hash) =>
    swapHashes.has(hash) ? "swap" : lpHashes.has(hash) ? "liquidity" : v3Hashes.has(hash) ? "v3-position" : defiHashes.has(hash) ? "defi-farm-stake" : "plain";

  // What the ledger has for ETN (WETN included), per tx — read from the assembled FIFO events, so
  // it reflects exactly what the PnL replays (WETN folded in, farm-owned V3 rows dropped, same-tx
  // round trips netted), plus locks/unlocks into and out of farms/stakes.
  const recordedNet = new Map();
  const bump = (h, q) => recordedNet.set(String(h).toLowerCase(), (recordedNet.get(String(h).toLowerCase()) || 0) + q);
  for (const e of events) {
    if (e.kind === "swap") {
      if (e.boughtTokenAddress === NATIVE_SENTINEL) bump(e.txHash, Number(e.boughtQuantity) || 0);
      if (e.soldTokenAddress === NATIVE_SENTINEL) bump(e.txHash, -(Number(e.soldQuantity) || 0));
      continue;
    }
    if (e.tokenAddress !== NATIVE_SENTINEL) continue;
    const q = Number(e.quantity) || 0;
    if (["in", "self_in", "unlock"].includes(e.kind)) bump(e.txHash, q);
    else if (["out", "self_out", "lock"].includes(e.kind)) bump(e.txHash, -q);
  }

  const txs = await getAllPages(`/addresses/${walletLc}/transactions`);
  const methodByHash = new Map(txs.map((t) => [t.hash.toLowerCase(), t.method || "(none)"]));
  // Successful txs only — a reverted tx moved no value (see pnlIngestion.js's isFailedTransaction).
  const valueByHash = new Map(
    txs
      .filter((t) => t.from?.hash?.toLowerCase() === walletLc && t.status !== "error" && (typeof t.result !== "string" || t.result === "success"))
      .map((t) => [t.hash.toLowerCase(), Number(ethers.formatEther(BigInt(t.value || "0")))])
  );

  const internalNet = new Map(); // tx hash -> net ETN the wallet received via internal txs
  for (const i of await getAllPages(`/addresses/${walletLc}/internal-transactions`)) {
    if (i.success === false) continue;
    const from = String(i.from?.hash || "").toLowerCase();
    const to = String(i.to?.hash || "").toLowerCase();
    if (from === to || (from !== walletLc && to !== walletLc)) continue;
    const v = Number(ethers.formatEther(BigInt(i.value || "0")));
    if (v === 0) continue;
    const h = String(i.transaction_hash).toLowerCase();
    internalNet.set(h, (internalNet.get(h) || 0) + (to === walletLc ? v : -v));
  }

  // WETN moves too, since the ledger counts it as ETN: a wrap is ETN out + WETN in (net 0 either way).
  for (const t of await getAllPages(`/addresses/${walletLc}/token-transfers?token=${WETN_ADDRESS}`)) {
    const from = String(t.from?.hash || "").toLowerCase();
    const to = String(t.to?.hash || "").toLowerCase();
    if (from === to || (from !== walletLc && to !== walletLc)) continue;
    const v = Number(ethers.formatUnits(BigInt(t.total?.value || "0"), 18));
    if (v === 0) continue;
    const h = String(t.transaction_hash || t.tx_hash).toLowerCase();
    internalNet.set(h, (internalNet.get(h) || 0) + (to === walletLc ? v : -v));
  }

  const byClass = new Map();
  const perTx = [];
  // Every tx that moved native ETN either way — internal transfers AND ETN sent as tx.value. Walking
  // internalNet alone missed every tx whose only native movement was the wallet's own tx.value (an
  // ETN->token swap, a plain addLiquidityETH with no refund), which is where a swap's unrecorded ETN
  // disposal hides.
  const nativeTxHashes = new Set([...internalNet.keys(), ...[...valueByHash].filter(([, v]) => v > 0).map(([h]) => h)]);
  for (const hash of nativeTxHashes) {
    const chainNet = internalNet.get(hash) ?? 0;
    const cls = classify(hash);
    // On-chain net native for this tx = internal net − tx.value the wallet sent (gas excluded from both sides).
    const trueNet = chainNet - (valueByHash.get(hash) ?? 0);
    const recorded = recordedNet.get(hash) ?? 0;
    const unrecorded = trueNet - recorded; // > 0: ETN really arrived that the ledger never saw
    const agg = byClass.get(cls) || { txs: 0, chainNet: 0, recorded: 0, unrecorded: 0 };
    agg.txs++;
    agg.chainNet += trueNet;
    agg.recorded += recorded;
    agg.unrecorded += unrecorded;
    byClass.set(cls, agg);
    if (Math.abs(unrecorded) > 1) perTx.push({ hash, cls, method: methodByHash.get(hash) ?? "(tx from another wallet)", trueNet, recorded, unrecorded });
  }

  console.log("\nNative ETN, by how each transaction was classified by ingestion:\n");
  console.log("class".padEnd(18), "txs".padStart(6), "on-chain net".padStart(18), "ledger recorded".padStart(18), "UNRECORDED".padStart(18));
  for (const [cls, a] of [...byClass.entries()].sort((x, y) => Math.abs(y[1].unrecorded) - Math.abs(x[1].unrecorded))) {
    console.log(cls.padEnd(18), String(a.txs).padStart(6), fmt(a.chainNet).padStart(18), fmt(a.recorded).padStart(18), fmt(a.unrecorded).padStart(18));
  }

  perTx.sort((a, b) => Math.abs(b.unrecorded) - Math.abs(a.unrecorded));
  console.log("\nLargest per-transaction differences (ETN the ledger missed is positive):\n");
  for (const t of perTx.slice(0, 20)) {
    console.log(t.hash.slice(0, 14), t.cls.padEnd(16), String(t.method).slice(0, 34).padEnd(36), fmt(t.unrecorded).padStart(16));
  }
  console.log(
    "\nRead this as: a large UNRECORDED figure in a class ingestion excludes from its plain internal-transaction walk\n" +
      "(swap / liquidity / v3-position / defi-farm-stake) is ETN that arrived but was never recorded anywhere. A large figure in\n" +
      '"plain" points at something else (ingestion gaps, pagination, price/quantity rounding) — inspect the listed transactions.'
  );

  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
