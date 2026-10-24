import { getValidatorWalletsCache, setValidatorWalletsCache } from "../state/validatorWalletsState.js";
import { getValidatorRewardsCache } from "../state/validatorRewardsState.js";
import { TEAM_WALLET_ADDRESSES } from "./teamWalletsCache.js";
import { listCexAddresses } from "../db/cexAddresses.js";

// Watches Electroneum's validators for the moment they start moving ETN — powers the Validators
// view of Argus's Team Wallets tab (src/dashboard/components/ValidatorWalletsView.jsx).
//
// As of Oct 2026 the nine validators each hold ~4.11M ETN and have sent essentially nothing ever
// (two test-sized transactions from one of them, March 2024): their balances grow from the
// protocol's block reward (~2.3 ETN/block, paid at consensus level, so it appears as a balance
// change, not a transaction) and just accumulate. Any OUTGOING transaction is therefore the signal
// worth surfacing, at any size — unlike teamWalletsCache.js's 1M-ETN floor.
//
// The validator set comes from validatorRewardsCache.js's published per-day block producers (every
// address that produced a block in the last 90 days), so a validator added or removed is picked up
// on its own; FALLBACK_VALIDATORS only covers a cache that isn't there yet.
//
// Per validator each cycle (Blockscout): the address (balance), its counters (blocks validated),
// its outgoing native transactions and outgoing token transfers, and coin-balance-history-by-day —
// Blockscout's 90-day daily balance series. The event-level coin-balance-history that
// teamWalletsBalanceHistory.js walks isn't usable here: every block reward is an event, ~1.77M per
// validator.
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
const CACHE_INTERVAL_MS = process.env.VALIDATOR_WALLETS_CACHE_INTERVAL_MS
  ? parseInt(process.env.VALIDATOR_WALLETS_CACHE_INTERVAL_MS, 10)
  : 10 * 60 * 1000;
const MAX_OUTGOING_TOTAL = 200;

// The nine block producers seen 2026-07-26..2026-10-24 (validator-rewards.json).
const FALLBACK_VALIDATORS = [
  "0x7779ab2cb675d7a31714e86d01bd7a56a03f41d8",
  "0x915956a26fd7ee449d37ec93bbcfc5cad5ac8e27",
  "0x57752beb85f0b8811023f048039591ef9eb78929",
  "0x5584c91681cd7d850750941618dbaea2944e8ed4",
  "0x135ec2bc4c04935ccd53967a072562120e4a3f92",
  "0xd3e10f17e2e34e0a0fea05573992b21e13c224c9",
  "0x763976728bc214a5c389d3928e03661bd6e7a649",
  "0x83ff6272d1de08ad8d492167412f1f329bd805f3",
  "0xd8a2376cf7afa426414b960cfbfb4bb780e5181a",
];

// Where an outgoing transfer went, as far as this backend can tell. A DEX router (or WETN, the
// first step of a swap) is the clearest "selling" signal; a known exchange deposit address too.
const DEX_ADDRESSES = new Map([
  ["0x2c12c8f15637b7a182dec202816148a5e767dcec", "ElectroSwap (Universal Router)"],
  ["0x072d4706f9a383d5608bd14b09b41683cb95ffd7", "ElectroSwap (V2 Router)"],
  ["0x5a3ab7e9f405250b36e7e0a4654c1052eadc1f07", "ElectroSwap (V3 Router)"],
  ["0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77", "WETN (wrap)"],
]);
const TEAM_WALLET_SET = new Set(TEAM_WALLET_ADDRESSES.map((a) => a.toLowerCase()));

async function fetchJson(path) {
  const res = await fetch(`${EXPLORER_BASE_URL}/api/v2${path}`);
  if (!res.ok) throw new Error(`Blockscout ${path} returned ${res.status}`);
  return res.json();
}

/** Every address that produced a block in the published validator-rewards cache, else the fallback. */
async function currentValidators() {
  const cache = await getValidatorRewardsCache().catch(() => null);
  const seen = new Set();
  for (const day of Object.values(cache?.days || {})) for (const v of Object.keys(day.validators || {})) if (v) seen.add(v.toLowerCase());
  return seen.size ? [...seen] : FALLBACK_VALIDATORS;
}

/** Label for a counterparty: { kind: "dex" | "cex" | "team" | "validator" | "other", label }. */
export function classifyDestination(address, { cexLabels, validatorSet }) {
  const a = (address || "").toLowerCase();
  if (DEX_ADDRESSES.has(a)) return { kind: "dex", label: DEX_ADDRESSES.get(a) };
  if (cexLabels.has(a)) return { kind: "cex", label: cexLabels.get(a) };
  if (validatorSet.has(a)) return { kind: "validator", label: "Validator" };
  if (TEAM_WALLET_SET.has(a)) return { kind: "team", label: "ETN Team wallet" };
  return { kind: "other", label: null };
}

async function fetchValidator(address, ctx) {
  const [info, counters, txs, tokenTxs, daily] = await Promise.all([
    fetchJson(`/addresses/${address}`),
    fetchJson(`/addresses/${address}/counters`).catch(() => null),
    fetchJson(`/addresses/${address}/transactions?filter=from`),
    fetchJson(`/addresses/${address}/token-transfers?filter=from`).catch(() => ({ items: [] })),
    fetchJson(`/addresses/${address}/coin-balance-history-by-day`).catch(() => ({ items: [] })),
  ]);

  const outgoing = [];
  for (const tx of txs.items || []) {
    if ((tx.from?.hash || "").toLowerCase() !== address) continue;
    outgoing.push({
      hash: tx.hash,
      from: address,
      to: tx.to?.hash || null,
      value: tx.value || "0",
      symbol: "ETN",
      decimals: 18,
      timestamp: tx.timestamp,
      method: tx.method || null,
      failed: tx.status === "error",
      destination: classifyDestination(tx.to?.hash, ctx),
    });
  }
  for (const t of tokenTxs.items || []) {
    if ((t.from?.hash || "").toLowerCase() !== address) continue;
    outgoing.push({
      hash: t.transaction_hash,
      from: address,
      to: t.to?.hash || null,
      value: t.total?.value || "0",
      symbol: t.token?.symbol || "token",
      decimals: Number(t.total?.decimals ?? t.token?.decimals ?? 18),
      timestamp: t.timestamp,
      method: t.method || null,
      failed: false,
      destination: classifyDestination(t.to?.hash, ctx),
    });
  }

  return {
    address,
    balance: info.coin_balance || "0",
    validations: counters?.validations_count != null ? Number(counters.validations_count) : null,
    // Whole ETN per day (keeps the file small), oldest first. Blockscout can list a date twice
    // (today, confirmed live) — keep the later entry so a day is never counted twice in the total.
    daily: [...new Map((daily.items || []).map((d) => [d.date, Number(BigInt(d.value || "0") / 10n ** 18n)])).entries()]
      .sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([date, etn]) => ({ date, etn })),
    outgoing,
  };
}

/**
 * Builds the published snapshot for `addresses`, merging in `previous` (the last published object,
 * or null): a validator whose fetch fails keeps its last entry, and outgoing transfers seen before
 * are kept even once they fall off Blockscout's first page. Returns null when every fetch failed.
 */
export async function buildValidatorSnapshot(addresses, previous, cexLabels = new Map()) {
  const ctx = { cexLabels, validatorSet: new Set(addresses) };
  const results = await Promise.all(
    addresses.map((a) =>
      fetchValidator(a, ctx).catch((err) => {
        console.warn(`⚠️  Validator wallets cache: failed to fetch ${a}:`, err.message);
        return null;
      })
    )
  );
  const fetched = results.filter(Boolean);
  if (fetched.length === 0) return null;

  const prevByAddress = new Map((previous?.validators || []).map((v) => [v.address, v]));
  const validators = addresses
    .map((a) => fetched.find((v) => v.address === a) || (prevByAddress.has(a) ? { ...prevByAddress.get(a), stale: true } : null))
    .filter(Boolean);

  const byKey = new Map();
  for (const v of fetched) for (const o of v.outgoing) byKey.set(`${o.hash}:${o.symbol}`, o);
  for (const o of previous?.outgoing || []) if (!byKey.has(`${o.hash}:${o.symbol}`)) byKey.set(`${o.hash}:${o.symbol}`, o);
  const outgoing = [...byKey.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, MAX_OUTGOING_TOTAL);

  // Combined daily balance across every validator.
  const totals = new Map();
  for (const v of validators) for (const d of v.daily || []) totals.set(d.date, (totals.get(d.date) || 0) + d.etn);
  const series = [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, etn]) => ({ date, etn }));

  return {
    fetchedCount: fetched.length,
    validators: validators.map((v) => ({
      address: v.address,
      balance: v.balance,
      validations: v.validations,
      daily: v.daily,
      outgoingCount: outgoing.filter((o) => o.from === v.address).length,
      lastOutgoingAt: outgoing.find((o) => o.from === v.address)?.timestamp || null,
      stale: Boolean(v.stale),
    })),
    outgoing,
    series,
  };
}

let isRunning = false;

async function refreshAndPublish() {
  if (isRunning) return;
  isRunning = true;
  try {
    const addresses = await currentValidators();
    // Exchange labels are optional (Supabase); without them a CEX deposit just shows as "other".
    // Bounded: a restricted/unreachable database must not stall the whole refresh.
    const cexRows = await Promise.race([listCexAddresses().catch(() => []), new Promise((r) => setTimeout(() => r([]), 10000))]);
    const cexLabels = new Map((cexRows || []).map((r) => [String(r.address).toLowerCase(), r.label]));

    const previous = await getValidatorWalletsCache();
    const snapshot = await buildValidatorSnapshot(addresses, previous, cexLabels);
    if (!snapshot) {
      console.warn("⚠️  Validator wallets cache: every fetch failed this cycle — keeping previous published data");
      return;
    }
    const { fetchedCount, ...published } = snapshot;
    await setValidatorWalletsCache(published);
    console.log(`🛡️  Validator wallets cache updated — ${fetchedCount}/${addresses.length} validator(s), ${published.outgoing.length} outgoing transfer(s) on record`);
  } catch (err) {
    console.error("⚠️  Validator wallets cache refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the background refresher. No-op if R2 isn't configured. */
export function startValidatorWalletsCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — validator wallets cache disabled");
    return;
  }
  console.log(`🛡️  Validator wallets cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  refreshAndPublish();
  setInterval(refreshAndPublish, CACHE_INTERVAL_MS);
}
