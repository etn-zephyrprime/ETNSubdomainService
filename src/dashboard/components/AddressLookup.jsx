import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { green, mutedLight, muted, panel2, border, error as errorColor, monoFont } from "../theme.js";
import { useBlockscout } from "../hooks/useBlockscout.js";
import { useTokenChart } from "../hooks/useTokenChart.js";
import { useDisplayNames } from "../hooks/useDisplayNames.js";
import { useCexAddresses } from "../hooks/useCexAddresses.js";
import { useTokenLocks } from "../hooks/useTokenLocks.js";
import { usePayment } from "../../hooks/usePayment.js";
import { useOwnedNames } from "../../hooks/useOwnedNames.js";
import { useEtnPrice } from "../../hooks/useEtnPrice.js";
import { formatCompact, formatTokenAmount, formatUsdPrice, formatEtnBalance, formatInt, isSpamTokenName, formatChartDate } from "../utils/format.js";
import { readCachedTokenPrices, cacheTokenPrice } from "../utils/tokenPriceCache.js";
import { bucketDailyCounts, ONE_DAY_MS } from "../utils/history.js";
import { isTeamWallet } from "../utils/teamWallets.js";
import { lockBadgeText } from "../utils/lockStatus.js";
import { EXPLORER_BASE_URL } from "../config.js";
import NeonButton from "../../components/NeonButton.jsx";
import TileChart from "./TileChart.jsx";
import TeamWalletTag from "./TeamWalletTag.jsx";
import CexTag from "./CexTag.jsx";
import TokenLogo from "./TokenLogo.jsx";
import { Lock } from "lucide-react";

const inputStyle = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 6,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontFamily: monoFont,
  fontSize: 13,
  fontWeight: 600,
  boxSizing: "border-box",
  outline: "none",
};

// Default window for the transactions/token-transfers charts, and how much "Show more" extends
// it by each click — Blockscout has no count-over-time endpoint for either, so this derives one
// from whichever items were actually fetched (see utils/history.js). Found live that a fixed
// page-count fetch (the previous approach) could silently fall short of even 30 days for a
// genuinely active wallet (4,248 lifetime transactions reached only ~20 days back under 5 pages),
// rendering the rest of the chart's window as flat zero — indistinguishable from real inactivity.
// fetchUntilWindow below fetches by *coverage*, not page count: as many pages as it takes to
// reach `windowDays` back, capped by MAX_PAGES_PER_FETCH purely as a runaway-request safety net
// (an exchange-hot-wallet-tier address doing hundreds of tx/day), not as the primary limiter.
const DEFAULT_WINDOW_DAYS = 30;
const WINDOW_STEP_DAYS = 30;
const MAX_PAGES_PER_FETCH = 20; // 20 pages * 50/page = 1000 items per fetch/"Show more" click

// Fetches pages (starting from `startParams`, appending onto `existingItems`) until the oldest
// item reaches back `windowDays`, the address's data runs out (no next_page_params — this *is*
// the wallet's full history), or MAX_PAGES_PER_FETCH is hit in this call. Used both for the
// initial load (existingItems: [], startParams: null) and "Show more" (existingItems: current
// state, startParams: the next_page_params saved from the previous fetch) — same logic either
// way, since "do we already cover the window" only cares about the oldest item overall, not
// where this particular fetch started.
async function fetchUntilWindow(fetchFn, address, { existingItems = [], startParams = null, windowDays }) {
  const items = existingItems.slice();
  let nextParams = startParams;
  const cutoff = Date.now() - windowDays * ONE_DAY_MS;
  const oldestTs = () => (items.length ? new Date(items[items.length - 1].timestamp).getTime() : Infinity);

  for (let page = 0; page < MAX_PAGES_PER_FETCH; page++) {
    if (oldestTs() <= cutoff) break;
    const res = await fetchFn(address, nextParams);
    items.push(...(res.items || []));
    nextParams = res.next_page_params || null;
    if (!nextParams) break; // no more data at all — this is the wallet's complete history
  }
  return { items, nextParams };
}

const METRICS = [
  { id: "balance", label: "ETN Balance" },
  { id: "transactions", label: "Transactions" },
  { id: "tokenTransfers", label: "Token Transfers" },
];

const HOLDING_CATEGORIES = [
  { id: "tokens", label: "Tokens" },
  { id: "nfts", label: "NFT's" },
];
const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);
// How many fungible tokens get a price fetched at all — NOT just a render limit: a token beyond
// this cap never gets priced, full stop, so it necessarily sinks to the bottom of the USD-sorted
// list regardless of its real value (confirmed live on CoreTierPortfolio.jsx's own combined
// holdings: a wallet holding 30k of a token with a genuine ~$1,335 CLUB/WETN pool showed no $
// value and sorted last, purely because it fell past position 25 in Blockscout's own — unordered
// — token-balances response, not because it was actually worth less than everything above it).
// Raised from 25 to 50: comfortably covers realistic portfolios while bounding worst-case impact
// on the shared GeckoTerminal queue (tokenChartRouter.js) every visitor's price charts also
// depend on — that queue enforces ~1.5s between new-token lookups site-wide, so a wallet that
// maxes this cap can add up to ~75s of queued lookups ahead of everyone else's, not just its own.
const MAX_PRICED_HOLDINGS = 50;

// A holding's USD value from its own per-token price (see the tokenPrices-fetching effect below)
// — null (row just omits the $ figure) whenever there's no known price yet, same "omit rather
// than fake a number" convention as TokenDetail.jsx's holderUsdValue.
function tokenUsdValue(rawValue, decimals, priceUsd) {
  if (priceUsd == null) return null;
  try {
    const amount = parseFloat(ethers.formatUnits(rawValue, decimals == null ? 18 : Number(decimals)));
    return Number.isFinite(amount) ? amount * priceUsd : null;
  } catch {
    return null;
  }
}

// Session-only single wallet lookup (free tier) — accepts either a raw 0x address or a .etn name,
// reusing usePayment.js's existing resolveName() rather than re-implementing name resolution a
// second time. Nothing here is persisted; re-searching starts fresh, same as the brief's "not
// persisted" free-tier spec.
export default function AddressLookup({ initialAddress = null, onSelectToken }) {
  const { getAddress, getAddressCounters, getAddressTokenBalances, getAddressCoinBalanceHistory, getAddressTransactions, getAddressTokenTransfers } = useBlockscout();
  const { getTokenChart } = useTokenChart();
  const { resolveName } = usePayment();
  const cexMap = useCexAddresses();
  const locksByAddress = useTokenLocks();
  const { getNamesOwnedBy } = useOwnedNames();
  // Same shared, cached resolver used everywhere else on this dashboard (Team Wallets, Balance
  // History, the Tokens tab's burn lists) — prefers a verified reverse/primary name, falling back
  // to any name the address owns even without one set (see that hook's own header comment). More
  // accurate than Blockscout's own raw ens_domain_name field, which this app's own reverse-name
  // work already found can go stale (a name transferred away, whose old owner's reverse pointer
  // was never cleared) — see useReverseRecord.js's verifyPrimaryName.
  const { resolve: resolveDisplayName } = useDisplayNames(resolvedAddress ? [resolvedAddress] : []);
  const etnUsdPrice = useEtnPrice(); // shared, R2-cached live rate — same source every other "≈ $" estimate on this dashboard uses

  const [input, setInput] = useState(initialAddress || "");
  const [resolvedAddress, setResolvedAddress] = useState(initialAddress || null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);

  const [addressInfo, setAddressInfo] = useState(null);
  const [counters, setCounters] = useState(null);
  const [tokenBalances, setTokenBalances] = useState([]);
  const [tokenPrices, setTokenPrices] = useState({}); // lowercased token address -> USD price
  // Addresses confirmed to have no ElectroSwap pool at all — see CoreTierPortfolio.jsx's own
  // identical state for why this is tracked separately from "not in tokenPrices yet" (which just
  // means still loading, or a transient fetch error — never hidden on that basis alone).
  const [noLiquidityTokens, setNoLiquidityTokens] = useState(new Set());
  const [showHiddenTokens, setShowHiddenTokens] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [ownedNames, setOwnedNames] = useState(null); // null = loading, [] = owns none

  const [balanceHistory, setBalanceHistory] = useState(null);
  const [txHistory, setTxHistory] = useState(null);
  const [txNextParams, setTxNextParams] = useState(null);
  const [txWindowDays, setTxWindowDays] = useState(DEFAULT_WINDOW_DAYS);
  const [txLoadingMore, setTxLoadingMore] = useState(false);
  const [transferHistory, setTransferHistory] = useState(null);
  const [transferNextParams, setTransferNextParams] = useState(null);
  const [transferWindowDays, setTransferWindowDays] = useState(DEFAULT_WINDOW_DAYS);
  const [transferLoadingMore, setTransferLoadingMore] = useState(false);
  const [activeMetric, setActiveMetric] = useState("balance");
  const [holdingsCategory, setHoldingsCategory] = useState("tokens");

  const handleLookup = async () => {
    setResolveError(null);
    setAddressInfo(null);
    setLoadError(null);

    const trimmed = input.trim();
    if (!trimmed) return;

    setResolving(true);
    try {
      const address = ethers.isAddress(trimmed) ? trimmed : await resolveName(trimmed);
      setResolvedAddress(address);
    } catch (err) {
      setResolveError(err.message || "Couldn't resolve that address or name");
      setResolvedAddress(null);
    } finally {
      setResolving(false);
    }
  };

  useEffect(() => {
    if (!resolvedAddress) return;
    let cancelled = false;
    setBalanceHistory(null);
    setTxHistory(null);
    setTxNextParams(null);
    setTxWindowDays(DEFAULT_WINDOW_DAYS);
    setTransferHistory(null);
    setTransferNextParams(null);
    setTransferWindowDays(DEFAULT_WINDOW_DAYS);
    // Seed from the last-known-price cache (tokenPriceCache.js, shared with CoreTierPortfolio.jsx)
    // instead of a blank slate — see that file's own comment for why. The effect below still
    // fetches fresh values for every held token regardless.
    setTokenPrices(readCachedTokenPrices());
    setNoLiquidityTokens(new Set());
    setShowHiddenTokens(false);
    setOwnedNames(null);
    (async () => {
      try {
        const [info, counterRes, balances] = await Promise.all([
          getAddress(resolvedAddress),
          getAddressCounters(resolvedAddress),
          getAddressTokenBalances(resolvedAddress),
        ]);
        if (cancelled) return;
        setAddressInfo(info);
        setCounters(counterRes);
        setTokenBalances(Array.isArray(balances) ? balances : []);
      } catch (err) {
        console.error("Failed to load address detail:", err);
        if (!cancelled) setLoadError("Couldn't load this wallet's data — try again shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [resolvedAddress, getAddress, getAddressCounters, getAddressTokenBalances]);

  // Every name this address owns through this app — on-brand for an ENS platform's own
  // address-lookup tool, and the exact same cache (owned-names.json) the display-name fallback
  // below also draws from. Read-only here (this tab isn't the registration app, no manage/renew
  // actions) — just "here's what this address owns."
  useEffect(() => {
    if (!resolvedAddress) return;
    let cancelled = false;
    getNamesOwnedBy(resolvedAddress)
      .then((names) => { if (!cancelled) setOwnedNames(names); })
      .catch((err) => {
        console.warn("Failed to load owned names:", err.message);
        if (!cancelled) setOwnedNames([]);
      });
    return () => { cancelled = true; };
  }, [resolvedAddress, getNamesOwnedBy]);

  // USD value per holding — fetched per fungible token (NFTs have no ElectroSwap trading pair, so
  // there's no price to fetch for those), one small request each via the same GeckoTerminal-backed
  // chart endpoint TokenDetail.jsx's own price uses, just the smallest range (7D) purely to read
  // its last candle's close. Fired independently per token rather than awaited together, so each
  // row's $ value appears as its own request resolves instead of the whole list waiting on the
  // slowest one — the backend already serializes these against GeckoTerminal's own rate limit
  // (tokenChartRouter.js), so this doesn't risk hammering it just because several rows ask at once.
  // Capped at MAX_PRICED_HOLDINGS (see that constant's own comment). Spam-named tokens are
  // excluded before the cap is applied, not just from the rendered list later, so a wallet full
  // of airdropped junk can't burn through the priced-token budget before it ever reaches a real
  // holding.
  useEffect(() => {
    const fungible = tokenBalances.filter(
      (tb) => tb.token?.address && !NFT_TOKEN_TYPES.has(tb.token?.type) && !isSpamTokenName(tb.token?.name)
    );
    if (fungible.length === 0) return;
    let cancelled = false;
    fungible.slice(0, MAX_PRICED_HOLDINGS).forEach((tb) => {
      const addr = tb.token.address.toLowerCase();
      getTokenChart(tb.token.address, "7")
        .then((res) => {
          if (cancelled) return;
          // hasData:false covers two different things — no pool at all (no `pool` on the
          // response — genuinely no-liquidity/dead) vs. a real pool with no trades in this
          // specific 7-day window (`pool` present — a real market, just thin recently, not dead).
          // Only the former is safe to hide — see CoreTierPortfolio.jsx's identical comment.
          if (res?.hasData === false && !res.pool) {
            setNoLiquidityTokens((prev) => (prev.has(addr) ? prev : new Set(prev).add(addr)));
            return;
          }
          if (!res?.candles?.length) return;
          const price = res.candles[res.candles.length - 1].close;
          setTokenPrices((prev) => ({ ...prev, [addr]: price }));
          cacheTokenPrice(addr, price); // so the NEXT lookup/reload can show this immediately too
        })
        .catch((err) => console.error(`Failed to load price for ${addr}:`, err.message));
    });
    return () => { cancelled = true; };
  }, [tokenBalances, getTokenChart]);

  // Chart data loads separately from (and doesn't block) the core address detail above — each of
  // these is its own set of requests (balance history is one call; tx/transfer history fetch by
  // *coverage*, see fetchUntilWindow above), no reason to make the whole screen wait on all of
  // them together.
  useEffect(() => {
    if (!resolvedAddress) return;
    let cancelled = false;
    getAddressCoinBalanceHistory(resolvedAddress)
      .then((res) => { if (!cancelled) setBalanceHistory(Array.isArray(res?.items) ? res.items : []); })
      .catch((err) => { console.error("Failed to load balance history:", err); if (!cancelled) setBalanceHistory([]); });
    return () => { cancelled = true; };
  }, [resolvedAddress, getAddressCoinBalanceHistory]);

  useEffect(() => {
    if (!resolvedAddress) return;
    let cancelled = false;
    fetchUntilWindow(getAddressTransactions, resolvedAddress, { windowDays: DEFAULT_WINDOW_DAYS })
      .then(({ items, nextParams }) => { if (!cancelled) { setTxHistory(items); setTxNextParams(nextParams); } })
      .catch((err) => { console.error("Failed to load transaction history:", err); if (!cancelled) setTxHistory([]); });
    return () => { cancelled = true; };
  }, [resolvedAddress, getAddressTransactions]);

  useEffect(() => {
    if (!resolvedAddress) return;
    let cancelled = false;
    fetchUntilWindow(getAddressTokenTransfers, resolvedAddress, { windowDays: DEFAULT_WINDOW_DAYS })
      .then(({ items, nextParams }) => { if (!cancelled) { setTransferHistory(items); setTransferNextParams(nextParams); } })
      .catch((err) => { console.error("Failed to load token transfer history:", err); if (!cancelled) setTransferHistory([]); });
    return () => { cancelled = true; };
  }, [resolvedAddress, getAddressTokenTransfers]);

  // "Show more" for whichever of transactions/token-transfers is currently the active metric —
  // extends that series' window by another WINDOW_STEP_DAYS, fetching more pages only if what's
  // already loaded doesn't already cover the new window (fetchUntilWindow's own oldestTs() check
  // handles that). Balance has no equivalent since getAddressCoinBalanceHistory already returns
  // full history in one call, not paginated.
  const handleShowMore = async () => {
    if (activeMetric === "transactions") {
      if (!txNextParams || txLoadingMore) return;
      setTxLoadingMore(true);
      const newWindowDays = txWindowDays + WINDOW_STEP_DAYS;
      try {
        const { items, nextParams } = await fetchUntilWindow(getAddressTransactions, resolvedAddress, {
          existingItems: txHistory || [],
          startParams: txNextParams,
          windowDays: newWindowDays,
        });
        setTxHistory(items);
        setTxNextParams(nextParams);
        setTxWindowDays(newWindowDays);
      } catch (err) {
        console.error("Failed to load more transaction history:", err);
      } finally {
        setTxLoadingMore(false);
      }
    } else if (activeMetric === "tokenTransfers") {
      if (!transferNextParams || transferLoadingMore) return;
      setTransferLoadingMore(true);
      const newWindowDays = transferWindowDays + WINDOW_STEP_DAYS;
      try {
        const { items, nextParams } = await fetchUntilWindow(getAddressTokenTransfers, resolvedAddress, {
          existingItems: transferHistory || [],
          startParams: transferNextParams,
          windowDays: newWindowDays,
        });
        setTransferHistory(items);
        setTransferNextParams(nextParams);
        setTransferWindowDays(newWindowDays);
      } catch (err) {
        console.error("Failed to load more token transfer history:", err);
      } finally {
        setTransferLoadingMore(false);
      }
    }
  };

  // Each series is `{ label, value }[]` — label is a real date from whichever source backs that
  // metric, threaded through to SparklineChart for its axis labels + hover tooltip.
  const series = useMemo(() => ({
    // No .reverse() here, deliberately — unlike Blockscout's other chart-ish endpoints (stats
    // charts, main-page lists), coin-balance-history-by-day already comes back oldest-first
    // (confirmed live: earliest date first, today's date last). Reversing it was flipping the
    // chart's X-axis backwards (newest-to-oldest, left-to-right).
    balance: balanceHistory
      ? balanceHistory.map((d) => ({ label: d.date, value: parseFloat(ethers.formatEther(d.value)) }))
      : [],
    transactions: txHistory ? bucketDailyCounts(txHistory, "timestamp", txWindowDays) : [],
    tokenTransfers: transferHistory ? bucketDailyCounts(transferHistory, "timestamp", transferWindowDays) : [],
  }), [balanceHistory, txHistory, txWindowDays, transferHistory, transferWindowDays]);

  const chartLoading = { balance: balanceHistory === null, transactions: txHistory === null, tokenTransfers: transferHistory === null }[activeMetric];

  // Ordered by USD value, descending — raw on-chain amounts aren't comparable across tokens with
  // different decimals, so leaving the list in whatever order Blockscout happened to return (the
  // previous behavior) put arbitrarily-sized holdings ahead of genuinely larger ones. usdValue is
  // computed once here and reused at render time. A token with no resolved price yet (tokenPrices
  // hasn't caught up — see that effect above, prices trickle in one request per token) sinks to
  // the bottom instead of counting as $0, so it doesn't briefly occupy a top slot before its real
  // price arrives — same convention CoreTierPortfolio.jsx's own Combined Holdings sort uses.
  const visibleHoldings = useMemo(() => {
    const wantNft = holdingsCategory === "nfts";
    return tokenBalances
      .filter((tb) => {
        const isNft = NFT_TOKEN_TYPES.has(tb.token?.type);
        if (isNft !== wantNft) return false;
        if (isSpamTokenName(tb.token?.name)) return false;
        if (!showHiddenTokens && !isNft && noLiquidityTokens.has(tb.token?.address?.toLowerCase())) return false;
        return true;
      })
      .map((tb) => ({ ...tb, usdValue: tokenUsdValue(tb.value, tb.token?.decimals, tokenPrices[tb.token?.address?.toLowerCase()]) }))
      .sort((a, b) => {
        if (a.usdValue == null && b.usdValue == null) return 0;
        if (a.usdValue == null) return 1;
        if (b.usdValue == null) return -1;
        return b.usdValue - a.usdValue;
      });
  }, [tokenBalances, holdingsCategory, tokenPrices, noLiquidityTokens, showHiddenTokens]);
  const hiddenNoLiquidityCount = useMemo(
    () => tokenBalances.filter((tb) => !NFT_TOKEN_TYPES.has(tb.token?.type) && !isSpamTokenName(tb.token?.name) && noLiquidityTokens.has(tb.token?.address?.toLowerCase())).length,
    [tokenBalances, noLiquidityTokens]
  );

  const etnBalanceUsd = useMemo(() => {
    if (etnUsdPrice == null || !addressInfo?.coin_balance) return null;
    try {
      const etn = parseFloat(ethers.formatEther(addressInfo.coin_balance));
      return Number.isFinite(etn) ? etn * etnUsdPrice : null;
    } catch {
      return null;
    }
  }, [addressInfo, etnUsdPrice]);

  // ETN balance + every priced fungible holding (NFTs excluded — no market price to sum, same
  // reasoning nftPnlService.js's own header comment gives for never estimating a held NFT's
  // current value) — independent of the Tokens/NFT's toggle above, which only affects the LIST.
  // `incomplete: true` whenever at least one non-spam fungible holding has no known price yet
  // (still loading, or past MAX_PRICED_HOLDINGS) — the total is real, just a floor, not the whole
  // story, same "never silently overclaim precision" posture as this file's other USD figures.
  const totalWalletValue = useMemo(() => {
    if (!addressInfo) return { usd: null, incomplete: false };
    let usd = etnBalanceUsd;
    let incomplete = etnBalanceUsd == null;
    for (const tb of tokenBalances) {
      if (NFT_TOKEN_TYPES.has(tb.token?.type) || isSpamTokenName(tb.token?.name)) continue;
      const v = tokenUsdValue(tb.value, tb.token?.decimals, tokenPrices[tb.token?.address?.toLowerCase()]);
      if (v == null) {
        incomplete = true;
      } else {
        usd = (usd ?? 0) + v;
      }
    }
    return { usd, incomplete };
  }, [addressInfo, etnBalanceUsd, tokenBalances, tokenPrices]);

  // "Show more" is available whenever there's a saved next_page_params to resume from — null
  // means fetchUntilWindow ran out of data on its own, i.e. this address's *complete* history is
  // already loaded, not just the current window's worth.
  const showMoreAvailable = { transactions: !!txNextParams, tokenTransfers: !!transferNextParams }[activeMetric];
  const showMoreLoading = { transactions: txLoadingMore, tokenTransfers: transferLoadingMore }[activeMetric];

  // Prefer the resolved name; fall back to "Wallet" (not the short-hex resolve() itself returns
  // for an unresolved address) — the full address is already shown as its own link right below, so
  // repeating a short-hex version of it as the "name" would be redundant, not informative.
  const shortAddrFallback = resolvedAddress ? `${resolvedAddress.slice(0, 6)}...${resolvedAddress.slice(-4)}` : null;
  const resolvedDisplayName = resolvedAddress ? resolveDisplayName(resolvedAddress) : null;
  const displayName = resolvedDisplayName && resolvedDisplayName !== shortAddrFallback ? resolvedDisplayName : null;
  const cexLabel = resolvedAddress ? cexMap.get(resolvedAddress.toLowerCase()) : null;

  const captions = {
    balance: "ETN balance, full history by day",
    transactions: `Transactions per day, last ${txWindowDays} days (${counters ? formatCompact(counters.transactions_count) : "…"} total all-time)`,
    tokenTransfers: `Token transfers per day, last ${transferWindowDays} days (${counters ? formatCompact(counters.token_transfers_count) : "…"} total all-time)`,
  };

  const formatValues = {
    balance: (v) => `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETN`,
    transactions: formatInt,
    tokenTransfers: formatInt,
  };

  return (
    <div>
      <style>{`.dash-addr-row{transition:border-color .15s ease;} .dash-addr-row:hover:not(:disabled),.dash-addr-row:focus-visible{border-bottom-color:${green};}`}</style>

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          type="text"
          placeholder="0x... or a .etn name"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleLookup(); }}
          style={{ ...inputStyle, flex: 1 }}
        />
        <NeonButton variant="green" onClick={handleLookup} loading={resolving} style={{ padding: "12px 20px" }}>
          Look Up
        </NeonButton>
      </div>

      {resolveError && (
        <div style={{ fontSize: 12, color: errorColor, marginBottom: 16 }}>{resolveError}</div>
      )}
      {loadError && (
        <div style={{ fontSize: 12, color: errorColor, marginBottom: 16 }}>{loadError}</div>
      )}

      {resolvedAddress && addressInfo && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: "#fff" }}>
                {displayName || "Wallet"}
              </div>
              {isTeamWallet(resolvedAddress) && <TeamWalletTag />}
              {cexLabel && <CexTag label={cexLabel} />}
            </div>
            <a
              href={`${EXPLORER_BASE_URL}/address/${resolvedAddress}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: mutedLight, fontFamily: monoFont, textDecoration: "none", borderBottom: `1px solid ${border}` }}
            >
              {resolvedAddress}
            </a>
            {addressInfo.is_contract && (
              <div style={{ fontSize: 11, color: muted, marginTop: 4 }}>Contract{addressInfo.is_verified ? " · Verified" : ""}</div>
            )}
          </div>

          {ownedNames && ownedNames.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
                Names Owned ({ownedNames.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {ownedNames.map((n) => (
                  <div
                    key={n.node}
                    title={n.expiry ? `Expires ${new Date(n.expiry * 1000).toLocaleDateString()}` : undefined}
                    style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${border}`, background: panel2, fontSize: 11, fontFamily: monoFont, color: mutedLight }}
                  >
                    {n.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          <TileChart
            tiles={[
              {
                id: "totalValue",
                label: "Total Wallet Value",
                disabled: true, // informational only — no time-series to swap the chart to (see totalWalletValue's own comment)
                value:
                  totalWalletValue.usd != null ? (
                    <>
                      {totalWalletValue.incomplete && <span style={{ color: mutedLight }}>~</span>}
                      {formatUsdPrice(totalWalletValue.usd)}
                    </>
                  ) : (
                    "…"
                  ),
              },
              {
                id: "balance",
                label: "ETN Balance",
                value: (
                  <>
                    {formatEtnBalance(addressInfo.coin_balance)} ETN
                    {etnBalanceUsd != null && (
                      <div style={{ fontSize: 12, fontWeight: 700, color: mutedLight, marginTop: 2 }}>{formatUsdPrice(etnBalanceUsd)}</div>
                    )}
                  </>
                ),
              },
              { id: "transactions", label: "Transactions", value: counters ? formatCompact(counters.transactions_count) : "…" },
              { id: "tokenTransfers", label: "Token Transfers", value: counters ? formatCompact(counters.token_transfers_count) : "…" },
            ]}
            activeId={activeMetric}
            onSelect={setActiveMetric}
            data={series[activeMetric]}
            formatValue={formatValues[activeMetric]}
            formatLabel={formatChartDate}
            chartCaption={captions[activeMetric]}
            loading={chartLoading}
          />

          {(activeMetric === "transactions" || activeMetric === "tokenTransfers") && !chartLoading && (
            showMoreAvailable ? (
              <button
                onClick={handleShowMore}
                disabled={showMoreLoading}
                style={{
                  display: "block",
                  margin: "10px auto 0",
                  padding: "6px 16px",
                  borderRadius: 6,
                  border: `1px solid ${border}`,
                  background: panel2,
                  color: showMoreLoading ? muted : green,
                  fontFamily: monoFont,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: showMoreLoading ? "default" : "pointer",
                }}
              >
                {showMoreLoading ? "Loading…" : `Show ${WINDOW_STEP_DAYS} more days`}
              </button>
            ) : (
              <div style={{ fontSize: 11, color: muted, textAlign: "center", marginTop: 10 }}>
                Full history loaded — this wallet's first activity is within this window.
              </div>
            )
          )}

          <div style={{ display: "flex", gap: 8, margin: "24px 0 8px" }}>
            {HOLDING_CATEGORIES.map((c) => {
              const isActive = c.id === holdingsCategory;
              return (
                <button
                  key={c.id}
                  onClick={() => setHoldingsCategory(c.id)}
                  style={{
                    flex: "1 1 100px",
                    padding: "8px 8px",
                    borderRadius: 6,
                    border: `1px solid ${isActive ? green : border}`,
                    background: isActive ? "rgba(24,187,26,0.12)" : panel2,
                    color: isActive ? green : mutedLight,
                    fontFamily: monoFont,
                    fontSize: 11,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          {visibleHoldings.length === 0 && !(holdingsCategory === "tokens" && hiddenNoLiquidityCount > 0) ? (
            <div style={{ fontSize: 12, color: muted }}>
              {holdingsCategory === "nfts" ? "No NFTs held." : "No token balances."}
            </div>
          ) : (
            visibleHoldings.slice(0, 25).map((tb, i) => {
              const { usdValue } = tb;
              const lockInfo = holdingsCategory === "tokens" ? locksByAddress.get(tb.token?.address?.toLowerCase()) : null;
              const lockText = lockBadgeText(lockInfo);
              return (
                <button
                  key={`${tb.token?.address}-${i}`}
                  className="dash-addr-row"
                  onClick={() => onSelectToken?.(tb.token?.address)}
                  disabled={!onSelectToken || !tb.token?.address}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    width: "100%",
                    padding: "8px 0",
                    borderBottom: `1px solid ${border}`,
                    borderRadius: 2,
                    background: "transparent",
                    border: "none",
                    cursor: onSelectToken ? "pointer" : "default",
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: 12, color: "#fff" }}>
                    <TokenLogo address={tb.token?.address} label={tb.token?.symbol || tb.token?.name} placeholder={holdingsCategory === "tokens"} />
                    {tb.token?.name || "Unknown"} <span style={{ color: mutedLight }}>{tb.token?.symbol}</span>
                    {lockText && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: monoFont, fontSize: 10, fontWeight: 700, color: green, marginLeft: 8 }}>
                        <Lock size={10} />
                        {lockText}
                      </span>
                    )}
                  </span>
                  <span style={{ textAlign: "right" }}>
                    <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>{formatTokenAmount(tb.value, tb.token?.decimals)}</span>
                    {usdValue != null && (
                      <span style={{ display: "block", fontSize: 11, color: mutedLight }}>{formatUsdPrice(usdValue)}</span>
                    )}
                  </span>
                </button>
              );
            })
          )}
          {holdingsCategory === "tokens" && !showHiddenTokens && hiddenNoLiquidityCount > 0 && (
            <div style={{ marginTop: 10, fontSize: 11, color: muted, textAlign: "center" }}>
              {hiddenNoLiquidityCount} token{hiddenNoLiquidityCount === 1 ? "" : "s"} hidden (no ElectroSwap pool found) —{" "}
              <button type="button" onClick={() => setShowHiddenTokens(true)} style={{ background: "none", border: "none", padding: 0, color: green, cursor: "pointer", textDecoration: "underline", fontSize: 11 }}>
                Show
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
