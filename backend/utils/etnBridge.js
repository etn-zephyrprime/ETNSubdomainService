// backend/utils/etnBridge.js
//
// Tracks the ETNBridge — the contract that migrates legacy-chain ETN onto the Electroneum 2.0 EVM chain —
// for the free dashboard's "ETN Bridge" tab: how much has migrated over time, what is left in the bridge,
// and the biggest recent migrations.
//
// THE CONTRACT. The live bridge is the ERC-1967 proxy at BRIDGE_PROXY_ADDRESS (the address holding the
// ETN and the state); 0x16D78e…A564C is only its implementation (logic) contract and reads as all zeros.
// Every migration calls crosschainTransfer(), which pays native ETN out of the proxy's own balance and
// emits CrossChainTransfer(_fromIndexed, _from (the legacy address), _to (the EVM recipient), _value).
// The proxy also keeps running totals — getTotalCrosschainAmount() (cumulative ETN migrated, in wei) and
// getTotalTxCount() — and its native balance is what has NOT yet migrated.
//
// HISTORY / BACKFILL. Because those totals are contract state, the RPC node can report them at any past
// block (archive state), so the backfill is EXACT rather than reconstructed from balance changes or by
// scanning ~1M events: for each UTC day since the proxy was deployed, find the last block of that day and
// read the two totals there. Resumable (progress is saved as it goes) and idempotent.
//
// LIVE. Once an hour a snapshot of the totals + the bridge's balance is appended, and the top migrations of
// the rolling last 7 days are recomputed from the CrossChainTransfer events.
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import { getEtnBridgeData, setEtnBridgeData } from "../state/etnBridgeState.js";

export const BRIDGE_PROXY_ADDRESS = "0xB7990022d3F22B6FB3afb626E05289ee3bf0AE62";
const BLOCKSCOUT_API = `${process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com"}/api/v2`;

const BRIDGE_ABI = [
  "function getTotalCrosschainAmount() view returns (uint256)",
  "function getTotalTxCount() view returns (uint256)",
  "event CrossChainTransfer(string indexed _fromIndexed, string _from, address indexed _to, uint256 _value)",
];

const BLOCK_TIME_SEC = 5; // ~5.0s on this chain; only a first guess, findBlockAtOrBefore corrects it
const DAY_SEC = 86400;
const SNAPSHOT_INTERVAL_MS = process.env.ETN_BRIDGE_INTERVAL_MS ? parseInt(process.env.ETN_BRIDGE_INTERVAL_MS, 10) : 60 * 60 * 1000;
const RECENT_HOURLY_DAYS = 14;
const TOP_WINDOW_DAYS = 7;
const TOP_LIMIT = 5;
const LOG_CHUNK_BLOCKS = 1000; // Ankr rejects getLogs ranges above 1,000 blocks ("Block range is too large")
const BACKFILL_CONCURRENCY = 3;
const SAVE_EVERY_DAYS = 30;

const toEtn = (wei) => Number(ethers.formatEther(wei));
export const dayKey = (t) => String(t).slice(0, 10);
const timeOf = (t) => (String(t).length <= 10 ? Date.parse(`${t}T00:00:00Z`) : Date.parse(t));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- serialised read-modify-write on the published file ----------------------------------------------
// The hourly snapshot and the (long) backfill both update the same R2 object; every update goes through
// this one queue so neither can overwrite the other with a stale copy.
let writeChain = Promise.resolve();
export function makeStore(get = getEtnBridgeData, set = setEtnBridgeData) {
  return {
    get,
    update(fn) {
      const run = async () => {
        const next = fn(await get());
        await set(next);
        return next;
      };
      const p = writeChain.then(run, run);
      writeChain = p.catch(() => {});
      return p;
    },
  };
}

// ---- pure helpers ------------------------------------------------------------------------------------

/** Sorted ascending, one entry per exact `t`, dropping malformed points. Pure. Exported for tests. */
export function sortPoints(points) {
  const byT = new Map();
  for (const p of points || []) if (p && Number.isFinite(p.migratedEtn) && Number.isFinite(timeOf(p.t))) byT.set(p.t, p);
  return [...byT.values()].sort((a, b) => timeOf(a.t) - timeOf(b.t));
}

/** Hourly points are kept for RECENT_HOURLY_DAYS; older ones collapse to the LAST point of each UTC day
 * (re-keyed date-only). Keeps the published file small. Pure. Exported for tests. */
export function compactPoints(points, now = Date.now()) {
  const cutoff = now - RECENT_HOURLY_DAYS * DAY_SEC * 1000;
  const recent = [];
  const lastOfOldDay = new Map();
  for (const p of sortPoints(points)) {
    if (timeOf(p.t) >= cutoff) recent.push(p);
    else lastOfOldDay.set(dayKey(p.t), { ...p, t: dayKey(p.t) });
  }
  return [...lastOfOldDay.values(), ...recent];
}

/** Merges backfilled daily points into existing ones: a day that already has a point is left alone (a live
 * reading beats a backfilled one). Pure. Exported for tests. */
export function mergeDailyPoints(existing, dailyPoints) {
  const have = new Set(existing.map((p) => dayKey(p.t)));
  const added = dailyPoints.filter((p) => !have.has(p.t));
  return { points: sortPoints([...existing, ...added]), added: added.length };
}

/** Whether a live reading is believable. Cumulative migrated ETN only ever goes up, so a reading BELOW the
 * last recorded one is an RPC glitch (a lagging node) — recording it would draw a dip and a negative
 * "migrated today". Pure. Exported for tests. */
export function assessSnapshot(candidate, points) {
  const last = sortPoints(points).slice(-1)[0];
  if (last && candidate.migratedEtn < last.migratedEtn - 1e-6) {
    return { ok: false, reason: `migrated total went DOWN (${last.migratedEtn} -> ${candidate.migratedEtn}) — treating as a stale/glitchy node reading` };
  }
  return { ok: true, reason: "ok" };
}

/** The last block whose timestamp is <= tsSec. Block time is ~constant, so it converges from a good `hint`
 * in a couple of getTimestamp() calls instead of a ~24-step binary search per day. `getTimestamp(block)` is
 * injected (and should cache). Exported for tests. */
export async function findBlockAtOrBefore({ getTimestamp, tsSec, hint, maxBlock }) {
  let b = Math.max(0, Math.min(hint, maxBlock));
  for (let i = 0; i < 4; i++) {
    const delta = Math.round((tsSec - (await getTimestamp(b))) / BLOCK_TIME_SEC);
    if (delta === 0) break;
    b = Math.max(0, Math.min(maxBlock, b + delta));
  }

  // The estimate above is exact while block time is steady, but the chain's early history wasn't (gaps,
  // slower blocks), so finish with a bracketed binary search that is right whatever the block time was:
  // gallop away from `b` until [lo, hi] straddles tsSec, then bisect. `lo` always has ts <= tsSec.
  let lo;
  let hi;
  if ((await getTimestamp(b)) <= tsSec) {
    lo = b;
    let step = 1;
    hi = Math.min(maxBlock, b + step);
    while (hi < maxBlock && (await getTimestamp(hi)) <= tsSec) {
      lo = hi;
      step *= 2;
      hi = Math.min(maxBlock, hi + step);
    }
    if (hi === maxBlock && (await getTimestamp(hi)) <= tsSec) return maxBlock;
  } else {
    hi = b;
    let step = 1;
    lo = Math.max(0, b - step);
    while (lo > 0 && (await getTimestamp(lo)) > tsSec) {
      hi = lo;
      step *= 2;
      lo = Math.max(0, lo - step);
    }
    if (lo === 0 && (await getTimestamp(0)) > tsSec) return 0;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await getTimestamp(mid)) <= tsSec) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ---- chain reads -------------------------------------------------------------------------------------

function makeTimestampReader(provider) {
  const cache = new Map();
  return async (block) => {
    if (cache.has(block)) return cache.get(block);
    const b = await provider.getBlock(block);
    if (!b) throw new Error(`block ${block} not found`);
    cache.set(block, b.timestamp);
    return b.timestamp;
  };
}

async function withRetry(fn, label, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await sleep(400 * (i + 1));
    }
  }
  throw new Error(`${label}: ${lastErr?.shortMessage || lastErr?.message || lastErr}`);
}

/** The bridge's current totals + balance, at the latest block. */
export async function readBridgeNow(provider, contract) {
  const blockNumber = await provider.getBlockNumber();
  const [amount, count, balance] = await Promise.all([
    contract.getTotalCrosschainAmount({ blockTag: blockNumber }),
    contract.getTotalTxCount({ blockTag: blockNumber }),
    provider.getBalance(BRIDGE_PROXY_ADDRESS, blockNumber),
  ]);
  return { blockNumber, migratedEtn: toEtn(amount), count: Number(count), balanceEtn: toEtn(balance) };
}

/** getLogs over a block range in chunks, halving the chunk when the node rejects a range as too large. */
async function getLogsChunked(provider, filter, fromBlock, toBlock) {
  const logs = [];
  let chunk = LOG_CHUNK_BLOCKS;
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      logs.push(...(await provider.getLogs({ ...filter, fromBlock: start, toBlock: end })));
      start = end + 1;
    } catch (err) {
      const message = err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || "";
      if (chunk > 100 && /block range|range is too large|too large|limit/i.test(message)) {
        chunk = Math.max(100, Math.floor(chunk / 2));
        continue;
      }
      throw err;
    }
  }
  return logs;
}

/** Every CrossChainTransfer after `cutoffBlock`, newest data first from Blockscout's own index (one or two
 * calls for a normal week) with the raw log parsed by the contract interface, so nothing depends on
 * Blockscout's decoding. Falls back to chunked eth_getLogs if Blockscout is unreachable — that path needs
 * ~120 calls for a week, hence not the primary. `contract` supplies the event interface. */
export async function fetchMigrationEvents({ provider, contract, cutoffBlock, latestBlock, fetchImpl = fetch }) {
  const topic = contract.interface.getEvent("CrossChainTransfer").topicHash;
  const toEvent = (blockNumber, txHash, topics, data) => {
    const parsed = contract.interface.parseLog({ topics, data });
    return { txHash, to: parsed.args._to, legacyAddress: parsed.args._from, etn: toEtn(parsed.args._value), blockNumber };
  };

  try {
    const events = [];
    let params = "";
    for (let page = 0; page < 400; page++) {
      const res = await fetchImpl(`${BLOCKSCOUT_API}/addresses/${BRIDGE_PROXY_ADDRESS}/logs${params}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Blockscout logs returned ${res.status}`);
      const json = await res.json();
      let reachedCutoff = false;
      for (const item of json.items || []) {
        if (Number(item.block_number) <= cutoffBlock) { reachedCutoff = true; continue; }
        if (String(item.topics?.[0]).toLowerCase() !== topic.toLowerCase()) continue;
        events.push(toEvent(Number(item.block_number), item.transaction_hash, item.topics.filter(Boolean), item.data));
      }
      if (reachedCutoff || !json.next_page_params) return events;
      params = `?${new URLSearchParams(Object.fromEntries(Object.entries(json.next_page_params).map(([k, v]) => [k, String(v)])))}`;
    }
    throw new Error("too many Blockscout log pages");
  } catch (err) {
    console.warn(`⚠️  ETN bridge: Blockscout logs unavailable (${err.message}) — falling back to chunked RPC getLogs`);
    const logs = await getLogsChunked(provider, { address: BRIDGE_PROXY_ADDRESS, topics: [topic] }, cutoffBlock + 1, latestBlock);
    return logs.map((l) => toEvent(l.blockNumber, l.transactionHash, l.topics, l.data));
  }
}

/** The largest individual migrations of the rolling last `days` days, plus that window's totals.
 * `{ windowDays, since, totalEtn, count, top: [{ txHash, to, legacyAddress, etn, blockNumber, timestamp }] }`. */
export async function fetchTopMigrations({ provider, contract, latestBlock, days = TOP_WINDOW_DAYS, limit = TOP_LIMIT, nowSec = Math.floor(Date.now() / 1000), fetchImpl = fetch }) {
  const getTimestamp = makeTimestampReader(provider);
  const sinceSec = nowSec - days * DAY_SEC;
  const cutoffBlock = await findBlockAtOrBefore({ getTimestamp, tsSec: sinceSec, hint: latestBlock - Math.round((days * DAY_SEC) / BLOCK_TIME_SEC), maxBlock: latestBlock });

  const events = await fetchMigrationEvents({ provider, contract, cutoffBlock, latestBlock, fetchImpl });

  const top = [...events].sort((a, b) => b.etn - a.etn || b.blockNumber - a.blockNumber).slice(0, limit); // ties: newest first, so the table is stable
  for (const e of top) e.timestamp = new Date((await getTimestamp(e.blockNumber)) * 1000).toISOString();
  return {
    windowDays: days,
    since: new Date(sinceSec * 1000).toISOString(),
    totalEtn: events.reduce((s, e) => s + e.etn, 0),
    count: events.length,
    top,
  };
}

// ---- live snapshot -----------------------------------------------------------------------------------

/** Records one live reading and refreshes `current` and the top-migrations table. Never throws. */
export async function snapshotBridge({ provider, contract, store, now = Date.now() }) {
  try {
    const cur = await withRetry(() => readBridgeNow(provider, contract), "bridge read");
    const top7d = await fetchTopMigrations({ provider, contract, latestBlock: cur.blockNumber, nowSec: Math.floor(now / 1000) }).catch((err) => {
      console.warn("⚠️  ETN bridge: top migrations lookup failed:", err.message);
      return undefined; // keep the previous table rather than blank it
    });
    await store.update((data) => {
      const candidate = { t: new Date(now).toISOString(), migratedEtn: cur.migratedEtn, count: cur.count };
      const verdict = assessSnapshot(candidate, data.points);
      if (!verdict.ok) {
        console.warn(`⚠️  ETN bridge: not recording — ${verdict.reason}`);
        return data;
      }
      return {
        ...data,
        points: compactPoints([...data.points, candidate], now),
        current: { migratedEtn: cur.migratedEtn, count: cur.count, balanceEtn: cur.balanceEtn, blockNumber: cur.blockNumber, asOf: candidate.t },
        top7d: top7d === undefined ? data.top7d : top7d,
      };
    });
    console.log(`🌉 ETN bridge snapshot — ${Math.round(cur.migratedEtn).toLocaleString()} ETN migrated in ${cur.count.toLocaleString()} migrations, ${Math.round(cur.balanceEtn).toLocaleString()} ETN still in the bridge`);
  } catch (err) {
    console.error("⚠️  ETN bridge snapshot failed:", err.message);
  }
}

// ---- backfill ----------------------------------------------------------------------------------------

/** The UTC day the bridge proxy was deployed (from its creation transaction). */
export async function getBridgeCreationDay(fetchImpl = fetch) {
  const addr = await (await fetchImpl(`${BLOCKSCOUT_API}/addresses/${BRIDGE_PROXY_ADDRESS}`, { signal: AbortSignal.timeout(20000) })).json();
  const txHash = addr?.creation_transaction_hash;
  if (!txHash) throw new Error("couldn't find the bridge's creation transaction");
  const tx = await (await fetchImpl(`${BLOCKSCOUT_API}/transactions/${txHash}`, { signal: AbortSignal.timeout(20000) })).json();
  if (!tx?.timestamp) throw new Error("creation transaction has no timestamp");
  return dayKey(tx.timestamp);
}

/** Fills in one daily point per UTC day, from `startDay` through yesterday, that has none yet: the cumulative
 * migrated ETN and migration count as of the END of that day, read from contract state at that block.
 * Resumable (saves as it goes; a re-run only does missing days) and idempotent. Throws if archive state
 * can't be read, leaving `backfill` unset so the next start retries. Dependencies injected for tests. */
export async function backfillBridgeHistory({ provider, contract, store, startDay, now = Date.now(), onProgress = () => {} }) {
  const existing = await store.get();
  const have = new Set(existing.points.map((p) => dayKey(p.t)));
  const todayMs = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);

  const days = [];
  for (let ms = Date.parse(`${startDay}T00:00:00Z`); ms < todayMs; ms += DAY_SEC * 1000) {
    const d = new Date(ms).toISOString().slice(0, 10);
    if (!have.has(d)) days.push(d);
  }
  if (days.length === 0) return { added: 0, total: 0 };

  const getTimestamp = makeTimestampReader(provider);
  const latestBlock = await provider.getBlockNumber();
  const nowSec = Math.floor(now / 1000);
  const results = [];
  let sinceSave = 0;

  const one = async (day) => {
    const endSec = Math.floor(Date.parse(`${day}T23:59:59Z`) / 1000);
    const block = await findBlockAtOrBefore({ getTimestamp, tsSec: endSec, hint: latestBlock - Math.round((nowSec - endSec) / BLOCK_TIME_SEC), maxBlock: latestBlock });
    const [amount, count] = await withRetry(
      () => Promise.all([contract.getTotalCrosschainAmount({ blockTag: block }), contract.getTotalTxCount({ blockTag: block })]),
      `contract state at block ${block} (${day})`
    );
    return { t: day, migratedEtn: toEtn(amount), count: Number(count), block };
  };

  for (let i = 0; i < days.length; i += BACKFILL_CONCURRENCY) {
    const batch = await Promise.all(days.slice(i, i + BACKFILL_CONCURRENCY).map(one));
    results.push(...batch);
    sinceSave += batch.length;
    onProgress(results.length, days.length);
    if (sinceSave >= SAVE_EVERY_DAYS && i + BACKFILL_CONCURRENCY < days.length) {
      const snapshot = results.map(({ block, ...p }) => p);
      await store.update((data) => ({ ...data, points: compactPoints(mergeDailyPoints(data.points, snapshot).points, now) }));
      sinceSave = 0;
    }
  }

  const daily = results.map(({ block, ...p }) => p);
  await store.update((data) => ({
    ...data,
    points: compactPoints(mergeDailyPoints(data.points, daily).points, now),
    backfill: { source: "contract state at each day's last block", fetchedAt: new Date(now).toISOString(), days: daily.length },
  }));
  return { added: daily.length, total: days.length };
}

async function ensureBackfilled({ provider, contract, store }) {
  try {
    const data = await store.get();
    if (data.backfill) return;
    const startDay = await getBridgeCreationDay();
    console.log(`🌉 ETN bridge: backfilling daily history from ${startDay} (reads contract state at each day's last block — takes a few minutes)`);
    const { added } = await backfillBridgeHistory({
      provider, contract, store, startDay,
      onProgress: (done, total) => { if (done % 100 < BACKFILL_CONCURRENCY || done === total) console.log(`🌉 ETN bridge backfill: ${done}/${total} day(s)`); },
    });
    console.log(`🌉 ETN bridge history backfilled — ${added} daily point(s)`);
  } catch (err) {
    console.error("⚠️  ETN bridge backfill failed (progress so far is kept; resumes at next start):", err.message);
  }
}

/** Starts the bridge tracker: an immediate snapshot, then the (resumable) backfill in the background, then a
 * snapshot every hour. No-op without R2. */
export function startEtnBridge() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — ETN bridge tracker disabled");
    return;
  }
  const provider = createRpcProvider({ batchMaxCount: 1 });
  const contract = new ethers.Contract(BRIDGE_PROXY_ADDRESS, BRIDGE_ABI, provider);
  const store = makeStore();
  console.log(`🌉 ETN bridge tracker started (snapshot every ${SNAPSHOT_INTERVAL_MS / 1000}s; backfill runs once)`);

  snapshotBridge({ provider, contract, store }).then(() => ensureBackfilled({ provider, contract, store }));
  setInterval(() => snapshotBridge({ provider, contract, store }), SNAPSHOT_INTERVAL_MS);
}

export { BRIDGE_ABI };
