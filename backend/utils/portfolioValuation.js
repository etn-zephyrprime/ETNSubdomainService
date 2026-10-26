// backend/utils/portfolioValuation.js
//
// Shared "what is this member's combined tracked-wallet portfolio worth in USD right now"
// computation — used by both portfolioAlertScheduler.js (threshold alerts) and
// portfolioDigestScheduler.js (daily summary, each looping over every subscribed member's wallet
// in one tick), so the two features can never quietly disagree on what "portfolio value" means.
// Token pricing is now ElectroSwap's own official API FIRST — one batched call per wallet, through
// electroSwapPriceCache.js's shared cache (so a token more than one member happens to hold, priced
// already this tick by an earlier wallet's own call, costs nothing the second time — see that
// file's own header comment on why the actual saving here is real but opportunistic, not free) —
// falling back per-token to dexPriceQuote.js's on-chain ElectroSwap read (ETN leg, times the live
// etnPriceCache.js ETN/USD price) for anything ElectroSwap's API doesn't price (ELECTROSWAP_API_KEY
// not configured, the account is out of credits, or the specific token just isn't indexed there
// yet) — never a hard dependency on the new API, always the same coverage this app already had
// before it existed.
//
// Spam-token and NFT exclusion mirrors CoreTierPortfolio.jsx's own frontend total (isSpamTokenName,
// NFT type filtering) so a member sees the same total here as on the dashboard, not two subtly
// different numbers for "the same" figure.
import { ethers } from "ethers";
import { getCoveredWallets } from "../db/trackedWallets.js";
import { getTokenEtnPrice } from "./dexPriceQuote.js";
import { getCachedBatchTokenPrices } from "./electroSwapPriceCache.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { fetchBlockscoutJson } from "./blockscoutClient.js";
import { getOpenDefiPositionsUsd } from "../services/defiPositionValuation.js";
import { getLastKnownPrice, recordLastKnownPrice } from "./lastKnownPrices.js";
import { isTestNamedToken } from "../services/ignoredAssets.js";
import { probeV2Pool } from "../services/lpPositionValuation.js";

const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);
// MUST stay byte-for-byte in sync with src/dashboard/utils/format.js's SPAM_NAME_PATTERN — kept as
// its own small copy here rather than importing a frontend module from the backend (no shared
// build step between them, same reasoning as pnlStatementGenerator.js's own hand-synced THEME
// constant). Confirmed drifted from that canonical pattern once already (this copy checked for a
// URL/TLD in the name, the real one is a plain "dead"/"test"/"token" substring match) — fixed here
// to match exactly; if the frontend pattern ever changes, update this too.
function isSpamTokenName(name) {
  return /dead|test|token/i.test(name || "");
}
// Same reasoning/value as CoreTierPortfolio.jsx's own MAX_PRICED_HOLDINGS — bounds worst-case
// per-wallet RPC volume for a wallet holding a large number of distinct tokens (airdropped spam in
// particular), not just the GeckoTerminal discovery burst dexPriceQuote.js already caches away.
const MAX_PRICED_TOKENS_PER_WALLET = 50;

// LAST-KNOWN PRICES. A price lookup can fail for a minute or ten (ElectroSwap's key gets rate-limited or
// suspended and the shared breaker blanks every caller; the GeckoTerminal fallback is rate-limited too). Before
// this, a token that couldn't be priced simply contributed $0 — so the daily summary's total could swing by
// thousands of dollars from one bad minute. Now a token that can't be priced live is valued at the last price it
// WAS priced at (lastKnownPrices.js — persisted to R2, so a restart doesn't lose them) and the valuation is
// flagged `usedStale`; only a token that has never been priced still counts as unpriced.
//
// A staked/farmed position that can't be valued at all (a failed read, not just a missing price — prices are
// covered by the same store inside defiPositionValuation.js) is carried at its last successful figure, in memory.
const STALE_MAX_MS = 48 * 60 * 60 * 1000;
const lastGoodDefiUsd = new Map(); // lowercased wallet -> { usd, at }
const fresh = (entry) => entry && Date.now() - entry.at <= STALE_MAX_MS;

/**
 * Combined USD value of every wallet `ownerWallet`'s Core tier features cover — their own
 * connected wallet plus up to 3 explicitly tracked ones (see trackedWallets.js's
 * getCoveredWallets) — ETN + every priced fungible token holding, up to
 * MAX_PRICED_TOKENS_PER_WALLET per wallet, PLUS the live value of any currently-open yield-farm/
 * staking position (see defiPositionValuation.js) — funds moved into one of those contracts don't
 * show up as a wallet token balance at all otherwise. `usedStale` is true when some figure is a carried-forward last-known-good value (see lastKnownPrices.js) rather than a live one. `hasUnpriced` mirrors CoreTierPortfolio.jsx's own
 * convention: true when at least one non-zero holding couldn't be priced (ETN/USD cache not
 * ready, a token has no ElectroSwap pool, or the per-wallet cap was hit), meaning the real total
 * is AT LEAST this much, not exactly this much. The `{ totalUsd: 0, hasUnpriced: false }` empty
 * case is now unreachable in practice (getCoveredWallets always returns at least the owner's own
 * wallet) — kept as a defensive fallback, not a real "no wallets" state anymore.
 */
//
// `unpriced` lists WHY the total is incomplete — one short reason per holding that couldn't be valued —
// so a digest that keeps saying "some holdings couldn't be priced" can be traced to the exact token or
// position (logged by portfolioDigestScheduler.js). `options.wallets` overrides the covered-wallet
// lookup (diagnostics: scripts/diagnosePortfolioValuation.js).
export async function getPortfolioUsdValue(provider, ownerWallet, options = {}) {
  const tracked = options.wallets ? options.wallets.map((address) => ({ address })) : await getCoveredWallets(ownerWallet);
  if (tracked.length === 0) return { totalUsd: 0, hasUnpriced: false, unpriced: [] };

  const priceCache = await getEtnPriceCache();
  const etnUsd = priceCache?.usd ?? null;
  const unpriced = [];
  const markUnpriced = (reason) => {
    hasUnpriced = true;
    unpriced.push(reason);
  };
  let hasUnpriced = false;
  if (etnUsd == null) markUnpriced("ETN/USD price not available");
  let usedStale = false; // some figure below is a carried-forward last-known-good value, not a live one

  let totalUsd = 0;
  for (const w of tracked) {
    let addressInfo;
    let tokenBalances = [];
    try {
      [addressInfo, tokenBalances] = await Promise.all([
        fetchBlockscoutJson(`/addresses/${w.address}`),
        fetchBlockscoutJson(`/addresses/${w.address}/token-balances`).then((r) => (Array.isArray(r) ? r : r?.items || [])),
      ]);
    } catch (err) {
      console.warn(`⚠️  Portfolio valuation: fetch failed for ${w.address}:`, err.message);
      markUnpriced(`${w.address}: balances couldn't be read (${err.message})`);
      continue;
    }

    const etnAmount = parseFloat(ethers.formatEther(addressInfo?.coin_balance || "0"));
    if (etnUsd != null) totalUsd += etnAmount * etnUsd;
    else if (etnAmount > 0) markUnpriced(`${w.address}: ETN balance (no ETN/USD price)`);

    // Test items ("test" anywhere, or a "TSA" prefix: the owner's own test tokens) are skipped the same
    // way the PnL valuation skips them (ignoredAssets.js): they never have a market, so counting them
    // marked every digest incomplete (Oct 2026: TSA2/TSA3 did, every day).
    const fungible = tokenBalances.filter(
      (tb) => !NFT_TOKEN_TYPES.has(tb.token?.type) && !isSpamTokenName(tb.token?.name) && !isTestNamedToken(tb.token) && BigInt(tb.value || 0) > 0n
    );
    if (fungible.length > MAX_PRICED_TOKENS_PER_WALLET) markUnpriced(`${w.address}: ${fungible.length - MAX_PRICED_TOKENS_PER_WALLET} token(s) over the ${MAX_PRICED_TOKENS_PER_WALLET}-token cap`);
    const priced = fungible.slice(0, MAX_PRICED_TOKENS_PER_WALLET);

    // One batched ElectroSwap call (via electroSwapPriceCache.js's shared cache — so a token
    // several members happen to hold, priced already this tick by another wallet's own call here,
    // costs nothing the second time) for every fungible holding in this wallet, up to
    // MAX_PRICED_TOKENS_PER_WALLET (also ElectroSwap's own per-call max — the whole wallet fits in
    // a single request). Returns an empty Map (never throws) if ELECTROSWAP_API_KEY isn't
    // configured, so the fallback loop below is exactly this app's pre-existing behavior on any
    // deployment that hasn't set the key yet.
    const electroSwapPrices = await getCachedBatchTokenPrices(priced.map((tb) => tb.token.address));

    for (const tb of priced) {
      const addressLc = tb.token.address.toLowerCase();
      const amount = parseFloat(ethers.formatUnits(tb.value, Number(tb.token?.decimals || 18)));

      const electroSwapPrice = electroSwapPrices.get(addressLc)?.usd;
      if (electroSwapPrice != null) {
        totalUsd += amount * electroSwapPrice;
        recordLastKnownPrice(addressLc, electroSwapPrice);
        continue;
      }

      // Values a token at its last known price when it can't be priced now (see lastKnownPrices.js).
      const priceUnavailable = async () => {
        const last = await getLastKnownPrice(addressLc);
        if (last != null) {
          totalUsd += amount * last;
          usedStale = true;
        } else if (await probeV2Pool(tb.token.address).catch(() => null)) {
          // A V2 liquidity-pool token held in the wallet. LP positions are outside this quick total by design
          // (the digest says so on every message); it has no market price of its own, so it must not mark the
          // total incomplete — before this, an ES-LP token in the wallet blanked the comparison every day.
        } else {
          markUnpriced(`${w.address}: ${tb.token?.symbol || "?"} (${tb.token.address}) — never priced, no ElectroSwap price or WETN pool`);
        }
      };

      // Fall back to the on-chain read for anything ElectroSwap didn't price — same behavior this
      // app had before ElectroSwap's API existed.
      if (etnUsd == null) {
        await priceUnavailable();
        continue;
      }
      try {
        // skipElectroSwap: true — this token was already checked against ElectroSwap's BATCH
        // endpoint just above and came back absent; retrying the SINGLE endpoint here would almost
        // certainly fail again too (same underlying pricing data), just at a real credit cost for a
        // near-guaranteed miss. Falls straight to the on-chain path.
        const tokenEtnPrice = await getTokenEtnPrice(provider, tb.token.address, { skipElectroSwap: true });
        if (tokenEtnPrice == null) {
          await priceUnavailable();
          continue;
        }
        totalUsd += amount * tokenEtnPrice * etnUsd;
        recordLastKnownPrice(addressLc, tokenEtnPrice * etnUsd);
      } catch (err) {
        console.warn(`⚠️  Portfolio valuation: price lookup failed for ${tb.token?.address}:`, err.message);
        await priceUnavailable();
      }
    }

    // Funds currently staked/farmed at a known YieldFarm/CoreAscension contract don't show up as a
    // wallet token balance at all (they've moved into that contract) — without this, they'd simply
    // be invisible from the portfolio total. See defiPositionValuation.js's own header comment for
    // why this is always a live on-chain read, never reconstructed from ingested event history.
    try {
      const defi = await getOpenDefiPositionsUsd(w.address);
      const defiUsd = defi.totalUsd != null ? Number(defi.totalUsd) : 0;
      const key = w.address.toLowerCase();
      if (!defi.hasUnpriced) {
        // A complete valuation — remember it (including "nothing staked", so a closed position isn't carried on).
        lastGoodDefiUsd.set(key, { usd: defiUsd, at: Date.now() });
        totalUsd += defiUsd;
      } else {
        // Incomplete this time (a position couldn't be read/priced). Never report LESS than what we last knew
        // it to be worth just because a lookup failed.
        const last = lastGoodDefiUsd.get(key);
        if (fresh(last) && last.usd > defiUsd) {
          totalUsd += last.usd;
          usedStale = true;
        } else {
          totalUsd += defiUsd;
          markUnpriced(`${w.address}: a farm/staking position couldn't be valued${defi.unpricedReason ? ` (${defi.unpricedReason})` : ""}`);
        }
      }
    } catch (err) {
      console.warn(`⚠️  Portfolio valuation: DeFi position lookup failed for ${w.address}:`, err.message);
      const last = lastGoodDefiUsd.get(w.address.toLowerCase());
      if (fresh(last)) {
        totalUsd += last.usd;
        usedStale = true;
      } else {
        markUnpriced(`${w.address}: farm/staking lookup failed (${err.message})`);
      }
    }
  }

  return { totalUsd, hasUnpriced, usedStale, unpriced };
}
