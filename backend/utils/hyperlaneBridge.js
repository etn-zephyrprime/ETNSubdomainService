// backend/utils/hyperlaneBridge.js
//
// Tracks USD-stablecoin flows in and out of Electroneum over Hyperlane, for the free dashboard's "Hyperlane
// Bridge" tab (net inflow/outflow per day, filterable by the chain the money came from / went to).
//
// THE CONTRACTS. USDT and USDC on Electroneum are Hyperlane "warp route" synthetic tokens (HypERC20) behind
// TransparentUpgradeableProxy contracts — the proxies below hold the state and emit the events. (The
// addresses often quoted from the explorer, e.g. 0x97B8…Dc96 / 0x2e8e…6840, are only the proxies'
// IMPLEMENTATION contracts: they were initialised once and never used.)
//
// WHICH CHAIN? Hyperlane identifies every chain by a numeric "domain" (for the big EVM chains that is just the
// chain id: 1 Ethereum, 8453 Base, 43114 Avalanche, 56 BNB…), and the contract tells us directly:
//   - domains()/routers(domain) list the remote chains the route is enrolled with;
//   - every transfer OUT of Electroneum emits SentTransferRemote(uint32 indexed destination, bytes32 indexed
//     recipient, uint256 amount) — the token is burned here and released on `destination`;
//   - every transfer IN emits ReceivedTransferRemote(uint32 indexed origin, bytes32 indexed recipient,
//     uint256 amount) — minted here after being locked on `origin`.
// So inflow/outflow per chain is exact, straight from the events. Sanity check: for each token, total received
// minus total sent equals its totalSupply() (verified live; logged if it ever drifts).
//
// SOURCE. The explorer's etherscan-style getLogs endpoint (topic-filtered, 1,000 results/page, timestamps
// included), so no RPC scanning and no per-block timestamp lookups. The first run reads the whole history (a
// few hundred events); after that each cycle only reads blocks after the stored cursor. Events are kept as
// compact rows [timestampSec, tokenIndex, domain, direction (0 = in, 1 = out), amount, block].
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import { getHyperlaneBridgeData, setHyperlaneBridgeData } from "../state/hyperlaneBridgeState.js";

const EXPLORER_BASE = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
const REFRESH_INTERVAL_MS = process.env.HYPERLANE_BRIDGE_INTERVAL_MS ? parseInt(process.env.HYPERLANE_BRIDGE_INTERVAL_MS, 10) : 10 * 60 * 1000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;
// Events older than this are dropped from the published file (the tab only shows a rolling 12 months); the
// cursor, not the stored events, decides what still needs fetching.
const KEEP_DAYS = 1100; // ~3 years: a few hundred rows a year, and it keeps the supply reconciliation below meaningful

export const HYPERLANE_TOKENS = [
  { symbol: "USDT", name: "Tether USD", address: "0x48E722f1458b253c2FB0E573F939318D7Dbd54e7", decimals: 6 },
  { symbol: "USDC", name: "USD Coin", address: "0x3187deAd7A2Bd6770F5Fe81495D1B715926AAe6e", decimals: 6 },
];

const ABI = [
  "function totalSupply() view returns (uint256)",
  "function domains() view returns (uint32[])",
  "event SentTransferRemote(uint32 indexed destination, bytes32 indexed recipient, uint256 amount)",
  "event ReceivedTransferRemote(uint32 indexed origin, bytes32 indexed recipient, uint256 amount)",
];
const IFACE = new ethers.Interface(ABI);
const SENT_TOPIC = IFACE.getEvent("SentTransferRemote").topicHash;
const RECEIVED_TOPIC = IFACE.getEvent("ReceivedTransferRemote").topicHash;
const DIR_IN = 0;
const DIR_OUT = 1;

// ---- pure helpers (exported for tests) ---------------------------------------------------------------

/** One etherscan-style log row -> `[timestampSec, tokenIndex, domain, direction, amount, block]`, or null if it
 * isn't a well-formed transfer event. Pure. */
export function parseLogRow(row, tokenIndex, direction, decimals) {
  try {
    const domain = Number(BigInt(row.topics?.[1]));
    const amountRaw = BigInt(row.data);
    const ts = Number(BigInt(row.timeStamp));
    const block = Number(BigInt(row.blockNumber));
    if (!Number.isSafeInteger(domain) || !Number.isFinite(ts) || ts <= 0 || !Number.isFinite(block)) return null;
    return [ts, tokenIndex, domain, direction, Number(ethers.formatUnits(amountRaw, decimals)), block];
  } catch {
    return null;
  }
}

/** Adds new events after the stored ones: anything at or before a token's cursor is already stored and is
 * ignored (so a retry can't double-count), and events older than KEEP_DAYS are dropped. Sorted by time. Pure. */
export function mergeEvents(existing, incoming, cursorsByTokenIndex, now = Date.now()) {
  const fresh = incoming.filter((e) => e[5] > (cursorsByTokenIndex[e[1]] ?? -1));
  const cutoffSec = Math.floor(now / 1000) - KEEP_DAYS * 86400;
  return [...existing, ...fresh].filter((e) => e[0] >= cutoffSec).sort((a, b) => a[0] - b[0] || a[5] - b[5]);
}

/** Total received minus total sent for one token, from stored events (NOT windowed — use before pruning
 * matters, i.e. for the reconciliation log). Pure. */
export function netFromEvents(events, tokenIndex) {
  let net = 0;
  for (const e of events) if (e[1] === tokenIndex) net += e[3] === DIR_IN ? e[4] : -e[4];
  return net;
}

// ---- fetching ----------------------------------------------------------------------------------------

/** All logs with `topic0` from `address` in [fromBlock, toBlock], following pagination. */
async function fetchLogs({ address, topic0, fromBlock, toBlock, fetchImpl = fetch }) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${EXPLORER_BASE}/api?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${address}&topic0=${topic0}&page=${page}&offset=${PAGE_SIZE}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`explorer getLogs returned ${res.status}`);
    const json = await res.json();
    // status "0" + "No logs found" is a normal empty result; anything else non-array is a real failure.
    if (!Array.isArray(json.result)) {
      if (/no (logs|records)/i.test(String(json.message)) || /no (logs|records)/i.test(String(json.result))) break;
      throw new Error(`explorer getLogs error: ${json.message || json.result}`);
    }
    rows.push(...json.result);
    if (json.result.length < PAGE_SIZE) break;
  }
  return rows;
}

let isRunning = false;

/** One refresh cycle: read new events for every token up to a fixed block, merge, refresh supply/domains,
 * publish. Never throws. Dependencies injectable for tests. */
export async function refreshHyperlaneBridge({ provider, getData = getHyperlaneBridgeData, setData = setHyperlaneBridgeData, fetchImpl = fetch, now = Date.now() } = {}) {
  if (isRunning) return;
  isRunning = true;
  try {
    const stored = await getData();
    if (stored === null) {
      console.warn("⚠️  Hyperlane bridge: couldn't read the stored data — skipping this cycle rather than overwrite it");
      return;
    }

    const latestBlock = await provider.getBlockNumber();
    const cursors = { ...stored.cursors };
    const cursorByIndex = {};
    HYPERLANE_TOKENS.forEach((t, i) => { cursorByIndex[i] = cursors[t.symbol] ?? -1; });

    // A FIXED upper block for both directions of every token, so a block can't be half-read (sent fetched
    // before it existed, received after) and then skipped by the cursor.
    const incoming = [];
    for (let i = 0; i < HYPERLANE_TOKENS.length; i++) {
      const token = HYPERLANE_TOKENS[i];
      const fromBlock = (cursors[token.symbol] ?? -1) + 1;
      if (fromBlock > latestBlock) continue;
      const [sent, received] = await Promise.all([
        fetchLogs({ address: token.address, topic0: SENT_TOPIC, fromBlock, toBlock: latestBlock, fetchImpl }),
        fetchLogs({ address: token.address, topic0: RECEIVED_TOPIC, fromBlock, toBlock: latestBlock, fetchImpl }),
      ]);
      for (const r of sent) { const e = parseLogRow(r, i, DIR_OUT, token.decimals); if (e) incoming.push(e); }
      for (const r of received) { const e = parseLogRow(r, i, DIR_IN, token.decimals); if (e) incoming.push(e); }
      cursors[token.symbol] = latestBlock;
    }

    const events = mergeEvents(stored.events, incoming, cursorByIndex, now);

    // Current supply + enrolled chains, straight from the contracts. A failed read keeps the previous value.
    const current = { ...stored.current };
    for (let i = 0; i < HYPERLANE_TOKENS.length; i++) {
      const token = HYPERLANE_TOKENS[i];
      try {
        const contract = new ethers.Contract(token.address, ABI, provider);
        const [supply, domains] = await Promise.all([contract.totalSupply(), contract.domains()]);
        current[token.symbol] = { supply: Number(ethers.formatUnits(supply, token.decimals)), domains: domains.map(Number), block: latestBlock };
      } catch (err) {
        console.warn(`⚠️  Hyperlane bridge: couldn't read ${token.symbol} supply/domains: ${err.message}`);
      }
    }

    await setData({
      tokens: HYPERLANE_TOKENS.map(({ symbol, name, address, decimals }) => ({ symbol, name, address, decimals })),
      events,
      cursors,
      current,
    });

    const summary = HYPERLANE_TOKENS.map((t, i) => {
      const net = netFromEvents(events, i);
      const supply = current[t.symbol]?.supply;
      const drift = supply != null && Math.abs(net - supply) > 1 ? ` ⚠️ events net ${net.toFixed(2)} vs supply ${supply.toFixed(2)}` : "";
      return `${t.symbol} net ${net.toFixed(2)}${drift}`;
    }).join(", ");
    console.log(`🌐 Hyperlane bridge updated — ${events.length} event(s) (+${incoming.length} new); ${summary}`);
  } catch (err) {
    console.error("⚠️  Hyperlane bridge refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Starts the tracker: an immediate refresh (which is also the full-history backfill on first run), then every
 * REFRESH_INTERVAL_MS. No-op without R2. */
export function startHyperlaneBridge() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — Hyperlane bridge tracker disabled");
    return;
  }
  const provider = createRpcProvider({ batchMaxCount: 1 });
  console.log(`🌐 Hyperlane bridge tracker started (refreshing every ${REFRESH_INTERVAL_MS / 1000}s)`);
  refreshHyperlaneBridge({ provider });
  setInterval(() => refreshHyperlaneBridge({ provider }), REFRESH_INTERVAL_MS);
}
