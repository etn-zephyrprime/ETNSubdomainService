import { getTeamWalletsCache, setTeamWalletsCache } from "../state/teamWalletsState.js";

// Periodically snapshots every known Electroneum team wallet's current ETN balance plus its own
// recent ETN-value transactions, and publishes a merged/deduped movement feed to R2 — powers
// Argus's Team Wallets tab (src/dashboard/components/TeamWalletsTab.jsx). Same
// snapshot-and-publish-on-a-timer shape as dashboardStatsCache.js/etnPriceCache.js, just against
// Blockscout's per-address endpoints instead of the chain-wide /stats one.
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
const CACHE_INTERVAL_MS = process.env.TEAM_WALLETS_CACHE_INTERVAL_MS
  ? parseInt(process.env.TEAM_WALLETS_CACHE_INTERVAL_MS, 10)
  : 10 * 60 * 1000; // 10 minutes — balances/movements don't need to be sub-minute fresh
// How many of each wallet's own most-recent transactions (already filtered to real, large ETN
// value — see MIN_MOVEMENT_ETN_WEI below) to keep before merging — Blockscout's default one-page
// response (~50 items, unpaginated here) for a wallet that's mostly small/zero-value activity
// could easily contain fewer than this many qualifying transfers; that's fine, this is "recent
// large activity", not an exhaustive ledger.
const MAX_MOVEMENTS_PER_WALLET = 25;
// Cap on the published, merged-across-every-wallet feed's size.
const MAX_MOVEMENTS_TOTAL = 150;
// "Recent ETN Movements" only cares about genuinely large transfers — everyday small transfers
// between team wallets/counterparties would otherwise crowd out the movements actually worth
// noticing. Confirmed live plenty of real team-wallet transfers clear this bar (e.g. single
// transfers of 9M, 10M, 15M, 80M ETN seen across a handful of team wallets' own recent history).
const MIN_MOVEMENT_ETN_WEI = 1_000_000n * 10n ** 18n; // 1,000,000 ETN

// Anyone holding more than 49 of "The Three Graces Of The Sea" (SEAS, an ERC-721 collection at
// 0x1760321f42A9BE39b39c779D92373769d829ef48) is a confirmed genuine Electroneum team wallet — see
// that collection's own holders list:
// https://blockexplorer.electroneum.com/token/0x1760321f42A9BE39b39c779D92373769d829ef48?tab=holders
// Snapshotted 2026-09-15 (11 wallets from that list, >49 SEAS each) plus 10 additional wallets
// confirmed separately (one on 2026-09-15, five more the same day, four more on 2026-09-16). This
// is a point-in-time list,
// not a live on-chain check — if the team's own wallets are ever reorganized, re-verify against
// that collection's holders and update both this list AND the frontend's own copy
// (src/dashboard/utils/teamWallets.js) — no shared build step between backend/frontend in this
// repo, same "small per-file lists are fine to drift independently, just keep them in sync by
// hand" convention as this backend's other duplicated token/address lists (e.g.
// TOKEN_DECIMALS_BY_ADDRESS in marketplaceWatcher.js/subdomainAdvertScheduler.js).
export const TEAM_WALLET_ADDRESSES = [
  "0xBdaFE4294F92039CCc2C97C74d046871F0b65BCB",
  "0xF0E7d64Ede6c56bEa9160E560f602Dd6E409f2cC",
  "0x4635D3e2d056A428fe32Db124528D74DC529D349",
  "0xEB258553BCf9134C02543E284671f6b4c48e2a7C",
  "0xcFb24d4CBAaA5630CBC7a516A6A094A593D624fd",
  "0xb40b04636D058Da2d10111e50417344479878907",
  "0x904403D9a0f591AC1cA12acBF8d80DC79b5c7E94",
  "0xcae0eBB25FdDe03B339B00FA2bdB05b9FE9FC6E0",
  "0x0bC0Fac6c972C4a0320dA6Ef20aB3526F375784B",
  "0x1F2407b300a3C768fF4531A751BD59D538e6d20E",
  "0x32Fd79d48d104c404fCcA35CfCD56Fff77082332",
  "0xc873974Ec3161b82FB0C28f587c348b00fCebD30",
  "0x217444Ce087deB274726Cb8CdfB636c35F039593",
  "0xa94E524197717DAE43b767B8B492C45d4d5EF0De",
  "0xd8185212c609a99c3446E7044D605C6732bdae7a",
  "0x096121F2f56b390eb2c7Dd02F8746450345d8255",
  "0x9266c334BABCEfE07577bE4C34C9D9028c4BDb03",
  "0x3C85Da8873F0baC9F22222a9887554a657D54312",
  "0x1fe3c69EF519f3452c4370CeCB77514773DaF56D",
  "0x90e5B91d961d3E1288311389d6cBA5cE6b053551",
  "0xB62d61E4077dD40d3a152E60F9f678860bAf026F",
  "0xC25CfD4901aA9b43ab81A57b423fd5D17ace9545", // added 2026-09-25 — suspected, not SEAS-verified yet
  "0x3CFa6D6E7e1216393C2cb9393Bc0f411492E33e9", // added 2026-10-19 — confirmed team wallet by the owner
];
const TEAM_WALLET_SET = new Set(TEAM_WALLET_ADDRESSES.map((a) => a.toLowerCase()));

async function fetchJson(path) {
  const res = await fetch(`${EXPLORER_BASE_URL}/api/v2${path}`);
  if (!res.ok) throw new Error(`Blockscout ${path} returned ${res.status}`);
  return res.json();
}

async function fetchWalletSnapshot(address) {
  const [info, txRes] = await Promise.all([
    fetchJson(`/addresses/${address}`),
    fetchJson(`/addresses/${address}/transactions`),
  ]);

  // Large ETN moves only — most of a busy wallet's transactions are either zero-value contract
  // calls (subname activity, marketplace approvals, etc.) or everyday small transfers, neither of
  // which "Recent ETN Movements" needs to surface; see MIN_MOVEMENT_ETN_WEI's own comment.
  const movements = (txRes.items || [])
    .filter((tx) => {
      if (!tx.value) return false;
      try {
        return BigInt(tx.value) >= MIN_MOVEMENT_ETN_WEI;
      } catch {
        return false;
      }
    })
    .slice(0, MAX_MOVEMENTS_PER_WALLET)
    .map((tx) => ({
      hash: tx.hash,
      from: tx.from?.hash || null,
      to: tx.to?.hash || null,
      value: tx.value,
      timestamp: tx.timestamp,
    }));

  return {
    address,
    balance: info.coin_balance || "0",
    ensName: info.ens_domain_name || null,
    movements,
  };
}

/**
 * Fills the wallets whose fetch failed this cycle from the last published snapshot, so one slow cycle can't
 * make the combined balance drop. 2026-11-12 19:47 UTC: during a deploy both servers refreshed at once,
 * Blockscout answered 18 of 23 wallets with HTTP 429, and the 5 that loaded were published on their own —
 * "Combined Team ETN Balance" fell from ~2.5bn to 20m ETN with no ETN having moved.
 * Returns `{ wallets, movements, stale }` (wallets in TEAM_WALLET_ADDRESSES order, `stale` = the carried-over
 * addresses), or null when a failed wallet has nothing to carry over — then nothing is published.
 * @param results per-address snapshot or null (failed), aligned to `addresses`
 * @param previous the last published `{ wallets, movements }`
 */
export function mergeWithPrevious(addresses, results, previous) {
  const prevBy = new Map((previous?.wallets || []).map((w) => [String(w.address).toLowerCase(), w]));
  const wallets = [];
  const extraMovements = [];
  const stale = [];
  for (const [i, address] of addresses.entries()) {
    const fresh = results[i];
    if (fresh) {
      wallets.push(fresh);
      continue;
    }
    const prev = prevBy.get(address.toLowerCase());
    if (!prev) return null; // no earlier figure for this wallet: publishing without it would understate the total
    stale.push(address);
    wallets.push({ address, balance: prev.balance, ensName: prev.ensName || null, movements: [] });
    const lc = address.toLowerCase();
    for (const m of previous.movements || []) if ((m.from || "").toLowerCase() === lc || (m.to || "").toLowerCase() === lc) extraMovements.push(m);
  }
  return { wallets, extraMovements, stale };
}

let isRunning = false;

async function refreshAndPublish() {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  try {
    const results = await Promise.all(
      TEAM_WALLET_ADDRESSES.map((address) =>
        fetchWalletSnapshot(address).catch((err) => {
          console.warn(`⚠️  Team wallets cache: failed to fetch ${address}:`, err.message);
          return null;
        })
      )
    );
    const loaded = results.filter(Boolean);

    if (loaded.length === 0) {
      // Every fetch failed this cycle (Blockscout hiccup, etc.) — keep whatever was last
      // published rather than overwriting good data with nothing, same "don't misrepresent a
      // stale-but-real value as freshly-confirmed-empty" reasoning this backend's other caches use.
      console.warn("⚠️  Team wallets cache: every wallet fetch failed this cycle — keeping previous published data");
      return;
    }

    // Some failed: carry those over from the last snapshot (see mergeWithPrevious) — never publish a
    // partial set as if it were the whole team.
    let wallets = loaded;
    let extraMovements = [];
    let stale = [];
    if (loaded.length < TEAM_WALLET_ADDRESSES.length) {
      const merged = mergeWithPrevious(TEAM_WALLET_ADDRESSES, results, await getTeamWalletsCache());
      if (!merged) {
        console.warn(`⚠️  Team wallets cache: ${TEAM_WALLET_ADDRESSES.length - loaded.length} wallet(s) failed and there's no earlier figure for some of them — keeping previous published data`);
        return;
      }
      ({ wallets, extraMovements, stale } = merged);
    }

    // Merge every wallet's own recent movements into one feed, deduped by tx hash — a transfer
    // BETWEEN two team wallets would otherwise appear twice, once from each side's own tx list.
    const byHash = new Map();
    for (const w of [...wallets, { movements: extraMovements }]) {
      for (const m of w.movements) {
        if (byHash.has(m.hash)) continue;
        byHash.set(m.hash, {
          ...m,
          fromIsTeam: TEAM_WALLET_SET.has((m.from || "").toLowerCase()),
          toIsTeam: TEAM_WALLET_SET.has((m.to || "").toLowerCase()),
        });
      }
    }
    const movements = [...byHash.values()]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, MAX_MOVEMENTS_TOTAL);

    await setTeamWalletsCache({
      wallets: wallets.map(({ address, balance, ensName }) => ({ address, balance, ensName })),
      movements,
      stale,
    });
    console.log(
      `👥 Team wallets cache updated — ${loaded.length}/${TEAM_WALLET_ADDRESSES.length} wallet(s) fresh${stale.length ? `, ${stale.length} carried over from the last snapshot` : ""}, ${movements.length} movement(s)`
    );
  } catch (err) {
    console.error("⚠️  Team wallets cache refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured — nowhere public to
 * publish to, same as every other R2-backed cache in this backend.
 */
export function startTeamWalletsCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — team wallets cache disabled");
    return;
  }

  console.log(`👥 Team wallets cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s, ${TEAM_WALLET_ADDRESSES.length} wallet(s))`);
  refreshAndPublish();
  setInterval(refreshAndPublish, CACHE_INTERVAL_MS);
}
