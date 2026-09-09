import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { Wallet as WalletIcon, TriangleAlert, Sparkles } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import CoreTierDemo from "./CoreTierDemo.jsx";
import { useCombinedPortfolio } from "../../hooks/useCombinedPortfolio.js";
import { useDefiPositions } from "../../hooks/useDefiPositions.js";
import { useLiquidityPositions } from "../../hooks/useLiquidityPositions.js";
import { useTokenChart } from "../../hooks/useTokenChart.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { useEtnPrice } from "../../../hooks/useEtnPrice.js";
import { formatTokenAmount, formatUsdPrice, formatEtnBalance, isSpamTokenName } from "../../utils/format.js";
import { readCachedTokenPrices, cacheTokenPrice } from "../../utils/tokenPriceCache.js";
import { green, greenGlow, muted, mutedLight, border, panel, panel2, orange, error as errorColor } from "../../theme.js";
import PortfolioCompositionChart from "./PortfolioCompositionChart.jsx";
import InfoTooltip from "../../components/InfoTooltip.jsx";

const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);
// How many fungible tokens get a price fetched at all, independent of HOLDINGS_PAGE_SIZE below
// (how many rows show at once) — matches AddressLookup.jsx's own cap. This is NOT just a render
// limit: a token beyond this cap never gets priced, full stop, so it necessarily sinks to the
// bottom of the USD-sorted list regardless of its real value (confirmed live: a wallet holding
// 30k of a token with a genuine ~$1,335 CLUB/WETN pool showed no $ value and sorted last, purely
// because it fell past position 25 in Blockscout's own — unordered — token-balances response, not
// because it was actually worth less than everything above it). Raised from 25 to 50: comfortably
// covers realistic portfolios while bounding worst-case impact on the shared GeckoTerminal queue
// (tokenChartRouter.js) every visitor's price charts also depend on — that queue enforces ~1.5s
// between new-token lookups site-wide, so a wallet that maxes this cap can add up to ~75s of
// queued lookups ahead of everyone else's, not just its own.
const MAX_PRICED_HOLDINGS = 50;
const HOLDING_CATEGORIES = [
  { id: "tokens", label: "Tokens" },
  { id: "nfts", label: "NFT's" },
];
const HOLDINGS_PAGE_SIZE = 10;
// Same literal every Core tier endpoint signs — see e.g. CoreTierPnl.jsx's own copy of this
// constant; a signature cached client-side (useWalletAuthSignature.js) covers all of them.
const AUTH_PURPOSE = "Premium Dashboard";

function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Same "no known price yet -> omit the $ figure, never fake one" convention as AddressLookup.jsx's
// own tokenUsdValue.
function tokenUsdValue(rawValue, decimals, priceUsd) {
  if (priceUsd == null) return null;
  try {
    const amount = parseFloat(ethers.formatUnits(rawValue, decimals == null ? 18 : Number(decimals)));
    return Number.isFinite(amount) ? amount * priceUsd : null;
  } catch {
    return null;
  }
}

const smallInputStyle = {
  flex: 1,
  padding: "10px 12px",
  borderRadius: 10,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  boxSizing: "border-box",
  outline: "none",
  fontFamily: "monospace",
};

// A standing, always-visible warning (not just something shown mid-action) — the cooldown is a
// real lock, not a soft suggestion, so a member deciding whether to track a wallet at all should
// see this before they ever reach the confirm step below.
function CooldownNotice({ children }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: "rgba(255,138,61,0.08)", border: `1px solid ${border}`, marginBottom: 12 }}>
      <TriangleAlert size={14} color={orange} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

// Core tier's flagship feature: your own connected wallet is always covered automatically, plus
// up to MAX_TRACKED_WALLETS more you can explicitly track (cold storage, a friend's — anything; no
// ownership proof is required of the *tracked* wallets, only of the member's own connected one) —
// see all of them combined as one merged ETN + token portfolio. Always mounted regardless of
// wallet/membership state — same "decide what to show internally, don't gate at the call site"
// pattern as PnlStatementRequest.jsx.
//
// Tracking and untracking each carry a real 30-day cooldown (see trackedWallets.js) specifically
// to stop "untrack A, track B, untrack B, retrack A" from being a free way to see more than
// MAX_TRACKED_WALLETS explicitly-tracked wallets' data over time — the member's own connected
// wallet is exempt from all of this (see getCoveredWallets), never locked, never counted against
// the cap. Both actions require an explicit confirm step (handlePendingConfirm below) with the
// consequence spelled out in the confirmation itself, not
// just mentioned once in passing — a member should never be surprised by a 30-day lock they didn't
// see coming.
export default function CoreTierPortfolio({ wallet, getAuthParams, onSelectToken, coreTierAccess, walletFilter }) {
  // Access + tracked-wallet-list state now lives in PortfolioDashboardSection.jsx, called ONCE for
  // all four Core Tier panels (was: each of them calling useCoreTierAccess.js independently — four
  // separate /premium/tracked-wallets fetches for the same data) — also the prerequisite for the
  // page-wide wallet filter (`walletFilter`, also passed down) that replaced this panel's own,
  // separate Combined Holdings filter.
  const {
    hasAccess, accessError, awaitingActivation, manualCheckLoading,
    active, cooling, maxWallets, cooldownDays,
    refresh, checkAccessOnce, addWallet, removeWallet,
  } = coreTierAccess;
  const { getCombinedPortfolio } = useCombinedPortfolio();
  const { getDefiPositions } = useDefiPositions();
  const { getLiquidityPositions } = useLiquidityPositions();
  const { getTokenChart } = useTokenChart();
  const etnUsdPrice = useEtnPrice();

  const [managing, setManaging] = useState(false);
  // Shows CoreTierDemo.jsx (Balance History + PnL for one fixed demo wallet) in place of
  // CoreTierGate's own connect/subscribe messaging — available to literally anyone, including a
  // visitor with no wallet connected at all, per the actual point of a demo. Toggled off
  // automatically below once real access is confirmed, so a member who subscribes mid-demo doesn't
  // get stuck looking at a stranger's wallet instead of their own.
  const [showDemo, setShowDemo] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [addInputError, setAddInputError] = useState(null);

  // The one action currently awaiting confirmation — null | { type: "add"|"remove", address }.
  // Nothing is sent to the backend until the member confirms, and the confirm panel itself states
  // the exact consequence (see renderPending below). Declared BEFORE the useDisplayNames call below
  // (which reads pending?.address) — referencing it earlier would hit the temporal dead zone.
  const [pending, setPending] = useState(null);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState(null);

  const { resolve: resolveName } = useDisplayNames([
    ...active.map((w) => w.address),
    ...cooling.map((w) => w.address),
    ...(pending?.address ? [pending.address] : []), // a brand-new "add" candidate isn't in active/cooling yet
  ]);
  // `active` always includes the member's own connected wallet as a permanent first entry (see
  // trackedWallets.js's getCoveredWallets) — it doesn't spend one of `maxWallets`' explicit slots,
  // so every cap check ("can I add another wallet?") needs the EXPLICIT count, not active.length.
  const explicitCount = active.filter((w) => !w.isOwnWallet).length;

  const [portfolio, setPortfolio] = useState(null); // null = loading/nothing to show yet
  const [portfolioError, setPortfolioError] = useState(null);
  // Live value of any currently-open yield-farm/staking position — { perWallet, combined } | null
  // while loading. A separate load from `portfolio` above (a real on-chain lookup per known
  // position, not just a Blockscout balance read — see useDefiPositions.js), so a member with no
  // DeFi activity at all sees Combined Holdings load at its usual speed while this only adds a
  // real wait for members who actually have something staked/farmed.
  const [defiPositions, setDefiPositions] = useState(null);
  const [defiPositionsError, setDefiPositionsError] = useState(null);
  // Live value of directly-held LP/V3 positions — { perWallet, combined } | null while loading.
  // Same "separate, independent load" reasoning as defiPositions above (real on-chain reads, not
  // just a Blockscout balance read — see lpPositionValuation.js), but this one also NEEDS
  // `portfolio` to have already loaded (it supplies the V2-LP candidate token list, see
  // buildWalletTokensPayload below) — defiPositions has no such dependency.
  const [lpPositions, setLpPositions] = useState(null);
  const [lpPositionsError, setLpPositionsError] = useState(null);
  const [tokenPrices, setTokenPrices] = useState({}); // lowercased token address -> USD price
  // A token with no resolved USD value (price never found — no ElectroSwap pool, still pending, or
  // beyond MAX_PRICED_HOLDINGS) is hidden by default and only shown once the member clicks through
  // — same "hide zero-value holdings behind a click" convention as CoreTierPnl.jsx's own Current
  // Holdings list (see that file's own hiddenCount/showHiddenTokens).
  const [showHiddenTokens, setShowHiddenTokens] = useState(false);
  const [holdingsCategory, setHoldingsCategory] = useState("tokens");
  const [holdingsShown, setHoldingsShown] = useState(HOLDINGS_PAGE_SIZE);

  // Drops any in-progress editor state on an account change — one built for the previous account
  // has no business surviving a disconnect/switch. The access/tracked-wallet state itself resets
  // inside useCoreTierAccess.
  useEffect(() => {
    setManaging(false);
    setPending(null);
    setPendingError(null);
    setAddInput("");
    setAddInputError(null);
    setShowDemo(false);
  }, [wallet.isConnected, wallet.account]);

  // Closes the demo automatically once real access is confirmed — a member who subscribes (or
  // connects an already-active membership's wallet) while the demo is open should land on their
  // own real portfolio, not stay stuck looking at the demo wallet.
  useEffect(() => {
    if (hasAccess) setShowDemo(false);
  }, [hasAccess]);

  // Resets pagination whenever the page-wide wallet filter changes — same reasoning as the
  // category toggle just below doing the same, so "Show more" never leaves a stale page depth from
  // a previous filter selection.
  useEffect(() => {
    setHoldingsShown(HOLDINGS_PAGE_SIZE);
  }, [walletFilter]);

  // Combined portfolio loads whenever the active tracked-wallet list changes.
  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setPortfolio(null);
      return;
    }
    let cancelled = false;
    setPortfolio(null);
    setPortfolioError(null);
    // Seed from the last-known-price cache (tokenPriceCache.js) instead of a blank slate — a
    // reload/reconnect otherwise had to wait out the same rate-limited per-token trickle below all
    // over again for prices it already knew moments earlier. The effect below still fetches fresh
    // values for every held token regardless, overwriting these as they arrive — this only makes
    // the FIRST paint show real numbers instead of "still pricing...".
    setTokenPrices(readCachedTokenPrices());
    setShowHiddenTokens(false);
    setHoldingsShown(HOLDINGS_PAGE_SIZE);
    getCombinedPortfolio(active.map((w) => w.address))
      .then((res) => { if (!cancelled) setPortfolio(res); })
      .catch((err) => {
        console.error("Failed to load combined portfolio:", err);
        if (!cancelled) setPortfolioError("Couldn't load portfolio data — try again shortly.");
      });
    return () => { cancelled = true; };
  }, [hasAccess, active, getCombinedPortfolio]);

  // Open DeFi positions load alongside the combined portfolio, independently — a slow/failed
  // lookup here never blocks Combined Holdings/Total Portfolio Balance from showing what they
  // already know from Blockscout.
  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setDefiPositions(null);
      return;
    }
    let cancelled = false;
    setDefiPositions(null);
    setDefiPositionsError(null);
    (async () => {
      try {
        const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
        const res = await getDefiPositions(wallet.account, signature, timestamp);
        if (!cancelled) setDefiPositions(res);
      } catch (err) {
        console.error("Failed to load DeFi positions:", err);
        if (!cancelled) setDefiPositionsError("Couldn't load staked/farmed positions — try again shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [hasAccess, active, getAuthParams, getDefiPositions, wallet.account]);

  // Live LP/V3 position values load once `portfolio` has resolved — unlike defiPositions above,
  // this needs each wallet's own token-balance list as the V2 LP-pool candidate set (see
  // useLiquidityPositions.js's own comment on why that's sent up rather than re-fetched
  // server-side). Deliberately keyed on `portfolio` itself (not just `hasAccess`/`active`) so a
  // reconnect/wallet-list change that reloads `portfolio` also refreshes this.
  useEffect(() => {
    if (!hasAccess || !portfolio) {
      setLpPositions(null);
      return;
    }
    let cancelled = false;
    setLpPositions(null);
    setLpPositionsError(null);
    (async () => {
      try {
        const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
        // Same fungible/non-spam filter as allVisibleTokens below — an LP token's own address is a
        // perfectly valid candidate here (that's exactly what's being probed for), only real NFTs
        // and junk-named tokens are excluded.
        const walletTokens = {};
        for (const w of portfolio.perWallet) {
          walletTokens[w.address.toLowerCase()] = (w.balances || [])
            .filter((tb) => tb.token?.address && !NFT_TOKEN_TYPES.has(tb.token?.type) && !isSpamTokenName(tb.token?.name))
            .map((tb) => ({ address: tb.token.address, decimals: tb.token.decimals, rawBalance: tb.value }));
        }
        const res = await getLiquidityPositions(wallet.account, signature, timestamp, walletTokens);
        if (!cancelled) setLpPositions(res);
      } catch (err) {
        console.error("Failed to load liquidity positions:", err);
        if (!cancelled) setLpPositionsError("Couldn't load liquidity positions — try again shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [hasAccess, portfolio, getAuthParams, getLiquidityPositions, wallet.account]);

  // USD price per merged token — one small independent request each, same pattern (and the same
  // MAX_PRICED_HOLDINGS cap) as AddressLookup.jsx's own price-fetching effect. Spam-named tokens
  // are excluded before the cap is applied (not just from the rendered list later) so a wallet
  // full of airdropped junk can't burn through the priced-token budget before it ever reaches a
  // real holding.
  useEffect(() => {
    if (!portfolio) return;
    const fungible = portfolio.tokens.filter(
      (t) => t.token?.address && !NFT_TOKEN_TYPES.has(t.token?.type) && !isSpamTokenName(t.token?.name)
    );
    if (fungible.length === 0) return;
    let cancelled = false;
    fungible.slice(0, MAX_PRICED_HOLDINGS).forEach((t) => {
      const addr = t.token.address.toLowerCase();
      getTokenChart(t.token.address, "7")
        .then((res) => {
          if (cancelled) return;
          // No candles at all — whether from no pool ever existing, or a real pool with no trades
          // in this specific 7-day window (see tokenChartRouter.js's own loadTokenChart) — just
          // leaves tokenPrices unset for it, same as a fetch that's still pending. Either way it has
          // no resolved USD value, so the render-time filter below hides it by default regardless of
          // which case this was; no need to distinguish them here anymore.
          if (!res?.candles?.length) return;
          const price = res.candles[res.candles.length - 1].close;
          setTokenPrices((prev) => ({ ...prev, [addr]: price }));
          cacheTokenPrice(addr, price); // so the NEXT reload/reconnect can show this immediately too
        })
        .catch((err) => console.error(`Failed to load price for ${addr}:`, err.message));
    });
    return () => { cancelled = true; };
  }, [portfolio, getTokenChart]);

  const requestAdd = (rawAddress) => {
    setAddInputError(null);
    const trimmed = rawAddress.trim();
    if (!trimmed) return;
    if (!ethers.isAddress(trimmed)) {
      setAddInputError("Enter a valid wallet address");
      return;
    }
    if (trimmed.toLowerCase() === wallet.account?.toLowerCase()) {
      setAddInputError("Your connected wallet is already included automatically");
      return;
    }
    if (active.some((w) => w.address.toLowerCase() === trimmed.toLowerCase())) {
      setAddInputError("Already tracking that wallet");
      return;
    }
    if (explicitCount >= maxWallets) {
      setAddInputError(`You can track up to ${maxWallets} additional wallets — untrack one first`);
      return;
    }
    const stillCooling = cooling.find((w) => w.address.toLowerCase() === trimmed.toLowerCase());
    setPendingError(null);
    setPending({ type: "add", address: trimmed, blockedUntil: stillCooling ? stillCooling.retrackableAt : null });
  };

  const requestRemove = (address) => {
    setPendingError(null);
    setPending({ type: "remove", address });
  };

  const cancelPending = () => {
    setPending(null);
    setPendingError(null);
  };

  const confirmPending = async () => {
    if (!pending) return;
    setPendingLoading(true);
    setPendingError(null);
    try {
      if (pending.type === "add") {
        await addWallet(pending.address);
        setAddInput("");
      } else {
        await removeWallet(pending.address);
      }
      await refresh().catch(() => {}); // also refreshes `cooling` — non-fatal if it fails
      setPending(null);
    } catch (err) {
      console.error(`Failed to ${pending.type} wallet:`, err);
      setPendingError(err.message || "That didn't go through — try again.");
    } finally {
      setPendingLoading(false);
    }
  };

  // Ordered by USD value, descending — raw on-chain amounts aren't comparable across tokens with
  // different decimals, so sorting by those (the previous behavior) was effectively meaningless.
  // usdValue is attached here once and reused at render time rather than recomputed. A token with
  // no resolved price yet (tokenPrices hasn't caught up — see that effect above, prices trickle in
  // one request per token) sinks to the bottom instead of counting as $0, so it doesn't briefly
  // occupy a top slot before its real price arrives.
  // Split by category (fungible tokens vs NFTs — same NFT_TOKEN_TYPES membership check the price-
  // fetching effect above uses to skip NFTs, since Blockscout's own `type` field is the only
  // signal available), same convention as AddressLookup.jsx's own Tokens/NFT's toggle. Only the
  // fungible list is meaningfully sortable by USD value — NFTs never get a price (no ElectroSwap
  // trading pair), so they stay in whatever order useCombinedPortfolio.js's merge produced them.
  // Source list for the holdings breakdown: the merged cross-wallet list (portfolio.tokens) when
  // showing all wallets, or ONE wallet's own unmerged balances when the page-wide filter picks a
  // specific wallet — normalized to the same { token, value, heldBy } shape either way, so every
  // computation below (usdValue, category split, sort) works unchanged regardless of source. Fixes
  // a real bug: the filter used to narrow WHICH tokens were listed but kept showing each one's
  // MERGED (all-wallets) quantity/value even when a single wallet was selected.
  const holdingsSource =
    walletFilter === "all"
      ? portfolio?.tokens || []
      : (portfolio?.perWallet.find((w) => w.address === walletFilter)?.balances || []).map((tb) => ({
          token: tb.token,
          value: BigInt(tb.value || 0),
          heldBy: [walletFilter], // shape-compatible with the merged list; always length 1 here, so the "Held in N of M wallets" line never shows for a filtered view
        }));
  // Confirmed real ElectroSwap V2 LP pool tokens among ANY covered wallet's holdings (see
  // lpPositionValuation.js) — excluded from the regular Tokens list below and from perWalletTotals'
  // own tokensUsd sum: an LP token has no price feed of its own (so it always sits unpriced/noisy
  // there) and now has its OWN dedicated, correctly-valued display (Liquidity Positions below) —
  // showing it twice, once wrong, would be worse than showing it once, right. Deliberately the
  // COMBINED set regardless of walletFilter — whether an address is a real LP pool is a fact about
  // the token, not about which wallet holds it, and perWalletTotals below computes every wallet's
  // own row unconditionally (walletFilter only narrows the RESULT, see filteredWalletTotals), so
  // each wallet's own exclusion needs the full set, not just whichever wallet is currently filtered.
  const lpTokenAddressSet = new Set(lpPositions?.combined?.lpTokenAddresses || []);
  const allVisibleTokens = portfolio
    ? holdingsSource
        .filter((t) => !isSpamTokenName(t.token?.name) && !NFT_TOKEN_TYPES.has(t.token?.type) && !lpTokenAddressSet.has(t.token?.address?.toLowerCase()))
        .map((t) => ({ ...t, usdValue: tokenUsdValue(t.value, t.token?.decimals, tokenPrices[t.token?.address?.toLowerCase()]) }))
        .sort((a, b) => {
          if (a.usdValue == null && b.usdValue == null) return 0;
          if (a.usdValue == null) return 1;
          if (b.usdValue == null) return -1;
          return b.usdValue - a.usdValue;
        })
    : [];
  const hiddenNoLiquidityCount = allVisibleTokens.filter((t) => t.usdValue == null).length;
  const visibleTokens = showHiddenTokens ? allVisibleTokens : allVisibleTokens.filter((t) => t.usdValue != null);
  // "Unknown" (t.token?.name falsy — see the render below's own `|| "Unknown"` fallback) means
  // Blockscout has no metadata for this NFT contract at all, same category of junk as an
  // isSpamTokenName match just above — not worth a member's time, and unlike a fungible token with
  // no $ value there's no "click to reveal" path for these (no economically real fallback quantity
  // to show while hidden), so they're filtered out entirely rather than counted/revealable.
  const visibleNfts = portfolio
    ? holdingsSource.filter((t) => !isSpamTokenName(t.token?.name) && NFT_TOKEN_TYPES.has(t.token?.type) && t.token?.name)
    : [];
  const visibleHoldings = holdingsCategory === "nfts" ? visibleNfts : visibleTokens;

  // Combined ETN Balance: the merged total across every tracked wallet, or just the filtered
  // wallet's own balance — same "pick the right source, same shape either way" approach as
  // holdingsSource above.
  const combinedEtnRaw =
    walletFilter === "all" ? portfolio?.totalCoinBalance : portfolio?.perWallet.find((w) => w.address === walletFilter)?.info?.coin_balance;
  const combinedEtnAmount = portfolio && combinedEtnRaw != null ? parseFloat(ethers.formatEther(combinedEtnRaw)) : null;
  const combinedUsdValue =
    etnUsdPrice != null && combinedEtnAmount != null && Number.isFinite(combinedEtnAmount)
      ? combinedEtnAmount * etnUsdPrice
      : null;

  // Per-wallet total USD value (ETN + every priced fungible token holding) — uses each wallet's
  // own UNMERGED balances (portfolio.perWallet), not the merged/combined token list above, since a
  // real per-wallet breakdown needs what THAT wallet specifically holds, not a cross-wallet sum.
  // A wallet holding ETN with no known price yet, or any fungible token whose price hasn't
  // resolved (still trickling in, or beyond MAX_PRICED_HOLDINGS — see that constant's own
  // comment), makes its own figure — and the grand total's — a lower bound, not an exact number:
  // flagged with "≈" rather than silently understating as if it were precise.
  const perWalletTotals = portfolio
    ? portfolio.perWallet.map((w) => {
        const etnAmount = w.info?.coin_balance != null ? parseFloat(ethers.formatEther(w.info.coin_balance)) : 0;
        const etnUsd = etnUsdPrice != null ? etnAmount * etnUsdPrice : null;
        let tokensUsd = 0;
        let hasUnpriced = etnUsd == null && etnAmount > 0;
        for (const tb of w.balances) {
          if (NFT_TOKEN_TYPES.has(tb.token?.type) || isSpamTokenName(tb.token?.name)) continue;
          if (lpTokenAddressSet.has(tb.token?.address?.toLowerCase())) continue; // valued separately — see lpTokenAddressSet's own comment
          const usd = tokenUsdValue(tb.value, tb.token?.decimals, tokenPrices[tb.token?.address?.toLowerCase()]);
          if (usd != null) {
            tokensUsd += usd;
          } else if (BigInt(tb.value || 0) > 0n) {
            hasUnpriced = true;
          }
        }
        return { address: w.address, total: (etnUsd || 0) + tokensUsd, hasUnpriced };
      })
    : [];
  // Scoped to the filtered wallet when one's selected — same wallets perWalletTotals already
  // computed above, just narrowed to the one row that matters for the header figures below.
  const filteredWalletTotals = walletFilter === "all" ? perWalletTotals : perWalletTotals.filter((w) => w.address === walletFilter);

  // Live value of open farm/staking positions, scoped to the same walletFilter as everything else
  // — folded into the total below so a member who's staked funds doesn't see a total that quietly
  // excludes them (see useDefiPositions.js / defiPositionValuation.js).
  const defiEntry =
    walletFilter === "all" ? defiPositions?.combined : defiPositions?.perWallet?.find((w) => w.walletAddress === walletFilter);
  const defiUsd = defiEntry?.totalUsd != null ? Number(defiEntry.totalUsd) : null;
  const defiHasUnpriced = Boolean(defiEntry?.hasUnpriced);

  // Live value of directly-held LP/V3 positions, same walletFilter scoping and "fold into the
  // total" reasoning as defiEntry above — a member holding LP/V3 positions shouldn't see a total
  // that quietly excludes them either (see lpPositionValuation.js).
  const lpEntry =
    walletFilter === "all" ? lpPositions?.combined : lpPositions?.perWallet?.find((w) => w.walletAddress === walletFilter);
  const lpUsd = lpEntry?.totalUsd != null ? Number(lpEntry.totalUsd) : null;
  const lpHasUnpriced = Boolean(lpEntry?.hasUnpriced);

  const totalPortfolioUsd =
    filteredWalletTotals.length > 0 || defiUsd != null || lpUsd != null
      ? filteredWalletTotals.reduce((sum, w) => sum + w.total, 0) + (defiUsd ?? 0) + (lpUsd ?? 0)
      : null;
  const totalPortfolioHasUnpriced = filteredWalletTotals.some((w) => w.hasUnpriced) || defiHasUnpriced || lpHasUnpriced;

  // Composition pie chart's 4 slices — Native ETN, regular fungible Tokens, Liquidity Positions
  // (V2 LP + V3, held directly), Staking/Yield Farms (locked in a farm/staking contract). Each
  // slice is the SAME figure already computed above for its own section, just grouped together —
  // no new computation, so the chart can never disagree with the numbers shown elsewhere on this
  // panel. A slice is 0 (not omitted) when its own figure is null/unresolved — see
  // PortfolioCompositionChart.jsx's own comment on why a $0 wedge is the honest choice here, since
  // the OTHER three slices' real values would otherwise silently look like the whole portfolio.
  const compositionSlices = [
    { key: "native", label: "Native ETN", value: combinedUsdValue ?? 0 },
    { key: "tokens", label: "Tokens", value: allVisibleTokens.reduce((sum, t) => sum + (t.usdValue ?? 0), 0) },
    { key: "liquidity", label: "Liquidity Positions", value: lpUsd ?? 0 },
    { key: "staking", label: "Staking / Yield Farms", value: defiUsd ?? 0 },
  ];

  const renderPending = () => {
    if (!pending) return null;
    const isAdd = pending.type === "add";
    return (
      <div style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${isAdd ? orange : errorColor}`, background: isAdd ? "rgba(255,138,61,0.08)" : "rgba(255,107,107,0.08)", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 10 }}>
          <TriangleAlert size={15} color={isAdd ? orange : errorColor} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12, color: "#fff", lineHeight: 1.6 }}>
            {isAdd ? (
              pending.blockedUntil ? (
                <>You untracked <b>{resolveName(pending.address)}</b> too recently — it can't be re-tracked until <b>{fmtDate(pending.blockedUntil)}</b>.</>
              ) : (
                <>Track <b>{resolveName(pending.address)}</b>? Once added, it's locked in — you won't be able to untrack it for <b>{cooldownDays} days</b>.</>
              )
            ) : (
              <>Untrack <b>{resolveName(pending.address)}</b>? You won't be able to re-track this exact wallet for <b>{cooldownDays} days</b> afterward.</>
            )}
          </div>
        </div>
        {pendingError && <div style={{ fontSize: 11, color: errorColor, marginBottom: 10 }}>{pendingError}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          {!(isAdd && pending.blockedUntil) && (
            <DashboardButton onClick={confirmPending} disabled={pendingLoading} loading={pendingLoading} style={{ flex: 1, justifyContent: "center", padding: "8px 12px", fontSize: 12 }}>
              {isAdd ? "Confirm Track" : "Confirm Untrack"}
            </DashboardButton>
          )}
          <button
            type="button"
            onClick={cancelPending}
            disabled={pendingLoading}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 10, border: `1px solid ${border}`, background: panel2, color: mutedLight, fontSize: 12, fontWeight: 700, cursor: pendingLoading ? "not-allowed" : "pointer" }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  };

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <WalletIcon size={18} color={green} />
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
            Core Tier — Portfolio
          </div>
        </div>
        {/* Visible to literally anyone — including a visitor with no wallet connected at all —
            whenever they don't already have real access; hidden once they do (see the effect
            above closing it automatically), since a real member has no reason to look at a demo
            of their own feature. */}
        {!hasAccess && (
          <button
            type="button"
            onClick={() => setShowDemo((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 14px",
              borderRadius: 20,
              border: `1px solid ${showDemo ? border : green}`,
              background: showDemo ? panel2 : green,
              color: showDemo ? mutedLight : panel,
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: 0.2,
              cursor: "pointer",
              boxShadow: showDemo ? "none" : `0 0 16px ${greenGlow}`,
            }}
          >
            <Sparkles size={13} />
            {showDemo ? "Exit Demo" : "View Demo"}
          </button>
        )}
      </div>

      {showDemo && !hasAccess ? (
        <div>
          <div style={{ fontSize: 11, color: mutedLight, marginBottom: 14, lineHeight: 1.6 }}>
            A live preview of what Core Tier actually offers, combined across three real wallets —
            not your own. Connect and subscribe below to track your own instead.
          </div>
          <CoreTierDemo onSelectToken={onSelectToken} />
        </div>
      ) : (
      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription={`your connected wallet is always included, plus up to ${maxWallets} more you track — see their combined ETN + token balances in one view`}
      >
        <div>
          {!managing ? (
            <>
              {/* No wallet-chip list here anymore — PortfolioDashboardSection.jsx's own "Showing"
                  filter bar, right above every Core Tier panel, already lists these same wallets
                  (and lets you act on the list, unlike this one which was purely static) — showing
                  both was a confirmed duplicate. */}
              <DashboardButton onClick={() => setManaging(true)} style={{ width: "100%", justifyContent: "center" }}>
                {explicitCount === 0 ? "Track More Wallets" : "Manage Tracked Wallets"}
              </DashboardButton>
            </>
          ) : (
            <div>
              <CooldownNotice>
                Your connected wallet is always included, automatically — it doesn't count toward
                your {maxWallets} additional slots and can't be untracked. Tracking one of those
                extra wallets locks it in for {cooldownDays} days before you can untrack it.
                Untracking one then locks that same address out from being re-tracked for another
                {" "}{cooldownDays} days. Any address works — cold storage, a friend's, anyone
                else's you want to watch; you only ever prove ownership of your own connected
                wallet, never of the ones you track.
              </CooldownNotice>

              {renderPending()}

              {active.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {active.map((w) => {
                    if (w.isOwnWallet) {
                      return (
                        <div
                          key={w.address}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                            padding: "8px 10px",
                            borderRadius: 8,
                            border: `1px solid ${border}`,
                            background: panel2,
                          }}
                        >
                          <div>
                            <div style={{ fontSize: 12, fontFamily: "monospace", color: "#fff" }}>You — {resolveName(w.address)}</div>
                            <div style={{ fontSize: 10, color: mutedLight, marginTop: 2 }}>Always included</div>
                          </div>
                        </div>
                      );
                    }
                    const locked = new Date(w.removableAt).getTime() > Date.now();
                    return (
                      <div
                        key={w.address}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: `1px solid ${border}`,
                          background: panel2,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 12, fontFamily: "monospace", color: "#fff" }}>{resolveName(w.address)}</div>
                          <div style={{ fontSize: 10, color: locked ? orange : mutedLight, marginTop: 2 }}>
                            {locked ? `Locked until ${fmtDate(w.removableAt)}` : "Eligible to untrack"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => requestRemove(w.address)}
                          disabled={locked}
                          style={{
                            background: "none",
                            border: `1px solid ${locked ? border : errorColor}`,
                            borderRadius: 8,
                            padding: "5px 10px",
                            color: locked ? muted : errorColor,
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: locked ? "not-allowed" : "pointer",
                          }}
                        >
                          Untrack
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {cooling.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 6 }}>
                    Recently Untracked
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {cooling.map((w) => (
                      <div key={w.address} style={{ fontSize: 10, color: muted, fontFamily: "monospace" }}>
                        {resolveName(w.address)} — re-trackable {fmtDate(w.retrackableAt)}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {explicitCount < maxWallets && (
                <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                  <input
                    type="text"
                    placeholder="0x... wallet address"
                    value={addInput}
                    onChange={(e) => setAddInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") requestAdd(addInput); }}
                    style={smallInputStyle}
                  />
                  <button
                    type="button"
                    onClick={() => requestAdd(addInput)}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: `1px solid ${green}`,
                      background: "rgba(24,187,26,0.12)",
                      color: green,
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Track
                  </button>
                </div>
              )}
              {addInputError && <div style={{ fontSize: 11, color: errorColor, marginBottom: 8 }}>{addInputError}</div>}

              <button
                type="button"
                onClick={() => setManaging(false)}
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 10,
                  textAlign: "center",
                  fontSize: 13,
                  fontWeight: 700,
                  color: mutedLight,
                  background: panel2,
                  border: `1px solid ${border}`,
                  borderRadius: 10,
                  cursor: "pointer",
                  padding: "10px 0",
                }}
              >
                Done
              </button>
            </div>
          )}

          {!managing && active.length > 0 && (
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
              {portfolioError ? (
                <div style={{ fontSize: 12, color: errorColor }}>{portfolioError}</div>
              ) : !portfolio ? (
                <div style={{ fontSize: 12, color: mutedLight }}>Loading combined portfolio…</div>
              ) : (
                <>
                  <div style={{ marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${border}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
                      Total Portfolio Balance (USD)
                      <InfoTooltip text="Everything this dashboard can currently price for you: native ETN, regular token holdings, liquidity positions, and anything staked or farming — added together. A '≈' means at least one piece hasn't resolved a price yet, so the real total is at least this much." />
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 900, color: "#fff", textShadow: `0 0 10px ${greenGlow}` }}>
                      {totalPortfolioUsd != null ? `${totalPortfolioHasUnpriced ? "≈ " : ""}${formatUsdPrice(totalPortfolioUsd)}` : "—"}
                    </div>
                    <div style={{ fontSize: 11, color: mutedLight, marginTop: 4 }}>
                      {walletFilter === "all"
                        ? `ETN + all priced token holdings, across ${active.length} tracked wallet${active.length === 1 ? "" : "s"}`
                        : "ETN + all priced token holdings, this wallet only"}
                    </div>
                    {totalPortfolioHasUnpriced && (
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", borderRadius: 8, background: "rgba(255,138,61,0.12)", border: `1px solid ${orange}`, marginTop: 10 }}>
                        <TriangleAlert size={14} color={orange} style={{ flexShrink: 0, marginTop: 1 }} />
                        <div style={{ fontSize: 11, color: orange, fontWeight: 700, lineHeight: 1.5 }}>
                          Lower bound — some holdings' prices haven't resolved yet. The real total is at least this much.
                        </div>
                      </div>
                    )}

                    {walletFilter === "all" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
                        {filteredWalletTotals.map((w) => (
                          <div key={w.address} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                            <span style={{ color: mutedLight }}>
                              {w.address.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                              {resolveName(w.address)}
                            </span>
                            <span style={{ color: "#fff", fontWeight: 700 }}>
                              {w.hasUnpriced ? "≈ " : ""}{formatUsdPrice(w.total)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${border}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
                      Portfolio Composition
                      <InfoTooltip text="How your Total Portfolio Balance splits across the four kinds of value this dashboard tracks. Hover a wedge or a legend row to highlight it. A $0 category means nothing's there yet, or it just hasn't priced — the total above tells you which." />
                    </div>
                    <PortfolioCompositionChart slices={compositionSlices} hasUnpriced={totalPortfolioHasUnpriced} />
                  </div>

                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
                      {walletFilter === "all" ? "Combined ETN Balance" : "ETN Balance"}
                      <InfoTooltip text="Native ETN sitting directly in your wallet(s) — the chain's own coin, not a token contract. Doesn't include ETN wrapped as WETN for trading, which shows up under Tokens instead." />
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", textShadow: `0 0 10px ${greenGlow}` }}>
                        {combinedEtnRaw != null ? formatEtnBalance(combinedEtnRaw) : "0.00"} ETN
                      </div>
                      {combinedUsdValue != null && (
                        <div style={{ fontSize: 13, color: mutedLight, fontWeight: 600 }}>{formatUsdPrice(combinedUsdValue)}</div>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: mutedLight, marginTop: 4 }}>
                      {walletFilter === "all"
                        ? `Across ${active.length} tracked wallet${active.length === 1 ? "" : "s"}`
                        : "This wallet only"}
                    </div>
                  </div>

                  {defiPositionsError ? (
                    <div style={{ fontSize: 11, color: errorColor, marginBottom: 16 }}>{defiPositionsError}</div>
                  ) : defiEntry?.positions?.length > 0 ? (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
                        Staked / Farming Positions
                        <InfoTooltip text="Funds currently locked in a yield farm or the Core Ascension staking contract — no longer a plain wallet balance, so Blockscout alone can't see them. Valued live from the contract's own state, including any real-time price movement (not the value it was worth when you deposited)." />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {defiEntry.positions.map((p, i) => (
                          <div
                            key={`${p.contractAddress}-${p.farmId ?? "stake"}-${i}`}
                            style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${border}`, background: panel2 }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>{p.label}</span>
                              <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>
                                {p.totalUsd != null ? `${p.hasUnpriced ? "≈ " : ""}${formatUsdPrice(Number(p.totalUsd))}` : "price unavailable"}
                              </span>
                            </div>
                            <div style={{ fontSize: 10, color: mutedLight, marginTop: 2 }}>
                              {p.legs.map((leg) => `${Number(leg.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${leg.symbol || "?"}`).join(" + ")}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {lpPositionsError ? (
                    <div style={{ fontSize: 11, color: errorColor, marginBottom: 16 }}>{lpPositionsError}</div>
                  ) : lpEntry && (lpEntry.v2Positions?.length > 0 || lpEntry.v3Positions?.length > 0) ? (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
                        Liquidity Positions
                        <InfoTooltip text="LP pool tokens and concentrated-liquidity (V3) positions you hold directly — not deposited into a yield farm (those show under Staked / Farming Positions instead). Valued live from each pool's own current reserves/price, converted into the underlying tokens your share currently represents." />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {(lpEntry.v2Positions || []).map((p) => (
                          <div key={p.tokenAddress} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${border}`, background: panel2 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>
                                {(p.legs[0]?.symbol || "?")}/{(p.legs[1]?.symbol || "?")} LP
                              </span>
                              <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>
                                {p.totalUsd != null ? `${p.hasUnpriced ? "≈ " : ""}${formatUsdPrice(Number(p.totalUsd))}` : "price unavailable"}
                              </span>
                            </div>
                            <div style={{ fontSize: 10, color: mutedLight, marginTop: 2 }}>
                              {p.legs.map((leg) => `${Number(leg.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${leg.symbol || "?"}`).join(" + ")}
                            </div>
                          </div>
                        ))}
                        {(lpEntry.v3Positions || []).map((p) => (
                          <div key={p.tokenId} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${border}`, background: panel2 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>
                                {(p.legs[0]?.symbol || "?")}/{(p.legs[1]?.symbol || "?")} V3 #{p.tokenId}
                                {!p.inRange && <span style={{ color: orange, fontWeight: 700 }}> · out of range</span>}
                              </span>
                              <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>
                                {p.totalUsd != null ? `${p.hasUnpriced ? "≈ " : ""}${formatUsdPrice(Number(p.totalUsd))}` : "price unavailable"}
                              </span>
                            </div>
                            <div style={{ fontSize: 10, color: mutedLight, marginTop: 2 }}>
                              {p.legs.map((leg) => `${Number(leg.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${leg.symbol || "?"}`).join(" + ")}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
                    Combined Holdings
                    <InfoTooltip text="Regular token and NFT balances sitting directly in your wallet(s) — the same thing a block explorer would show you. Tokens with no resolved value are hidden by default; liquidity/farming positions have their own dedicated sections above instead of showing up here unpriced." />
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                    {HOLDING_CATEGORIES.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => { setHoldingsCategory(c.id); setHoldingsShown(HOLDINGS_PAGE_SIZE); }}
                        style={{
                          flex: "1 1 100px",
                          padding: "8px 8px",
                          borderRadius: 10,
                          border: `1px solid ${c.id === holdingsCategory ? green : border}`,
                          background: c.id === holdingsCategory ? "rgba(24,187,26,0.12)" : panel2,
                          color: c.id === holdingsCategory ? green : mutedLight,
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  {visibleHoldings.length === 0 && !(holdingsCategory === "tokens" && hiddenNoLiquidityCount > 0) ? (
                    <div style={{ fontSize: 12, color: muted }}>
                      {walletFilter === "all"
                        ? holdingsCategory === "nfts"
                          ? "No NFTs held across your tracked wallets."
                          : "No token balances across your tracked wallets."
                        : holdingsCategory === "nfts"
                          ? "No NFTs held in this wallet."
                          : "No token balances in this wallet."}
                    </div>
                  ) : (
                    <>
                      {visibleHoldings.slice(0, holdingsShown).map((t, i) => {
                        const usdValue = t.usdValue ?? null;
                        return (
                          <div
                            key={`${t.token?.address}-${i}`}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              padding: "8px 0",
                              borderBottom: `1px solid ${border}`,
                            }}
                          >
                            <span style={{ fontSize: 12, color: "#fff" }}>
                              {onSelectToken && t.token?.address ? (
                                <button
                                  type="button"
                                  onClick={() => onSelectToken(t.token.address)}
                                  style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline", textDecorationColor: "transparent" }}
                                  onMouseEnter={(e) => { e.currentTarget.style.textDecorationColor = green; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.textDecorationColor = "transparent"; }}
                                  title="View on the Tokens page"
                                >
                                  {t.token?.name || "Unknown"} <span style={{ color: mutedLight }}>{t.token?.symbol}</span>
                                </button>
                              ) : (
                                <>{t.token?.name || "Unknown"} <span style={{ color: mutedLight }}>{t.token?.symbol}</span></>
                              )}
                              {t.heldBy.length > 1 && (
                                <span style={{ display: "block", fontSize: 10, color: muted }}>
                                  Held in {t.heldBy.length} of {active.length} wallets
                                </span>
                              )}
                            </span>
                            <span style={{ textAlign: "right" }}>
                              <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>{formatTokenAmount(t.value, t.token?.decimals)}</span>
                              {usdValue != null && (
                                <span style={{ display: "block", fontSize: 11, color: mutedLight }}>{formatUsdPrice(usdValue)}</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                      {visibleHoldings.length > holdingsShown && (
                        <button
                          type="button"
                          onClick={() => setHoldingsShown((n) => n + HOLDINGS_PAGE_SIZE)}
                          style={{
                            display: "block",
                            width: "100%",
                            marginTop: 10,
                            padding: "8px 0",
                            borderRadius: 8,
                            border: `1px solid ${border}`,
                            background: panel2,
                            color: green,
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          Show more ({visibleHoldings.length - holdingsShown} more)
                        </button>
                      )}
                      {holdingsCategory === "tokens" && !showHiddenTokens && hiddenNoLiquidityCount > 0 && (
                        <div style={{ marginTop: 10, fontSize: 11, color: muted, textAlign: "center" }}>
                          {hiddenNoLiquidityCount} token{hiddenNoLiquidityCount === 1 ? "" : "s"} hidden (no ElectroSwap pool found) —{" "}
                          <button type="button" onClick={() => setShowHiddenTokens(true)} style={{ background: "none", border: "none", padding: 0, color: green, cursor: "pointer", textDecoration: "underline", fontSize: 11 }}>
                            Show
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </CoreTierGate>
      )}
    </DashboardPanel>
  );
}
