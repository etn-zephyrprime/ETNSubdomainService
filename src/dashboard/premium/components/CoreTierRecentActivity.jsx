import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import { useRecentActivity } from "../../hooks/useRecentActivity.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { useTokenNames } from "../../hooks/useTokenNames.js";
import { formatUsdPrice, shortHash, timeAgo } from "../../utils/format.js";
import TokenLogo, { TokenPairLogo } from "../../components/TokenLogo.jsx";
import { EXPLORER_BASE_URL } from "../../config.js";
import { green, error as errorColor, muted, mutedLight, border, panel2, monoFont } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const NATIVE_SENTINEL = "NATIVE";

const selectStyle = { padding: "8px 12px", borderRadius: 6, border: `1px solid ${border}`, background: panel2, color: "#fff", fontFamily: monoFont, fontSize: 12, fontWeight: 600, outline: "none" };

// Dropdown options map 1:1 onto recentActivityService.js's own `category` values (see that
// file's header comment for exactly what lands in each bucket) — "all" is frontend-only, never
// sent to the backend.
const CATEGORY_OPTIONS = [
  { value: "all", label: "All Activity" },
  { value: "native", label: "ETN" },
  { value: "tokens", label: "Tokens" },
  { value: "nft", label: "NFTs" },
  { value: "liquidity", label: "Liquidity Pools" },
  { value: "farm", label: "Yield Farms" },
];

const SHOW_COUNT_STEP = 20;

// Every amount this feed shows (amount_decimal, swap_trades' amount_sold/amount_bought) is
// ALREADY a human decimal, never raw base units — unlike formatTokenAmount elsewhere in this app,
// which expects a raw value + decimals pair and converts. A plain locale-formatted number is
// correct here; reusing formatTokenAmount would silently feed decimal values through
// ethers.formatUnits (expecting an integer string) and swallow every result as "—".
function fmtAmt(decimalValue) {
  const n = Number(decimalValue);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(decimalValue);
}

function directionColor(direction, isSelfTransfer) {
  if (isSelfTransfer) return mutedLight;
  if (direction === "in") return green;
  if (direction === "out") return errorColor;
  return mutedLight; // swap — neither a gain nor a loss on its own
}

// One item's logo(s) — a pair for a swap/liquidity row (two assets involved), a single logo
// otherwise. `resolveTokenName` feeds TokenLogo's placeholder-letter fallback only; a missing logo
// image is the common case for most tokens/NFT collections (see TokenLogo.jsx's own comment).
function ItemLogo({ item, resolveTokenName }) {
  if (item.kind === "swap") {
    return (
      <TokenPairLogo
        legs={[
          { tokenAddress: item.soldTokenAddress, symbol: resolveTokenName(item.soldTokenAddress) },
          { tokenAddress: item.boughtTokenAddress, symbol: resolveTokenName(item.boughtTokenAddress) },
        ]}
        size={22}
      />
    );
  }
  if (item.kind === "liquidity") {
    return <TokenPairLogo legs={item.tokenAddresses.map((a) => ({ tokenAddress: a, symbol: resolveTokenName(a) }))} size={22} />;
  }
  if (item.kind === "defi") {
    return <TokenLogo address={item.contractAddress} label={item.label} size={22} />;
  }
  // Plain transfer — native/erc20/nft.
  const address = item.category === "native" ? NATIVE_SENTINEL : item.tokenAddress;
  return <TokenLogo address={address} label={resolveTokenName(address)} size={22} placeholder={item.category !== "nft"} />;
}

// What actually happened, in one short line — the main thing this feed exists to show at a
// glance. Self-transfers (between the member's own tracked wallets) are called out explicitly
// ("Moved") rather than shown as an ordinary send/receive, since they're not a real gain or loss.
function describeItem(item, resolveTokenName, resolveWalletName) {
  if (item.kind === "swap") {
    const soldSymbol = resolveTokenName(item.soldTokenAddress === "NATIVE" ? NATIVE_SENTINEL : item.soldTokenAddress);
    const boughtSymbol = resolveTokenName(item.boughtTokenAddress === "NATIVE" ? NATIVE_SENTINEL : item.boughtTokenAddress);
    return `Swapped ${fmtAmt(item.soldAmount)} ${soldSymbol} → ${fmtAmt(item.boughtAmount)} ${boughtSymbol}`;
  }
  if (item.kind === "liquidity") {
    const symbols = item.tokenAddresses.map((a) => resolveTokenName(a)).join(" / ");
    return symbols ? `${item.label} (${symbols})` : item.label;
  }
  if (item.kind === "defi") {
    return item.label;
  }
  // Plain transfer.
  const counterparty = resolveWalletName(item.counterpartyAddress);
  if (item.category === "nft") {
    const collection = resolveTokenName(item.tokenAddress);
    const verb = item.direction === "in" ? "Received" : "Sent";
    const prep = item.direction === "in" ? "from" : "to";
    return `${item.isSelfTransfer ? "Moved" : verb} ${collection} #${item.tokenId} ${item.isSelfTransfer ? (item.direction === "in" ? "from" : "to") : prep} ${counterparty}`;
  }
  const symbol = item.category === "native" ? "ETN" : resolveTokenName(item.tokenAddress);
  const verb = item.direction === "in" ? "Received" : "Sent";
  const prep = item.direction === "in" ? "from" : "to";
  return `${item.isSelfTransfer ? "Moved" : verb} ${fmtAmt(item.amount)} ${symbol} ${item.isSelfTransfer ? (item.direction === "in" ? "from" : "to") : prep} ${counterparty}`;
}

function ActivityRow({ item, resolveTokenName, resolveWalletName }) {
  const color = directionColor(item.direction, item.isSelfTransfer);
  return (
    <a
      href={`${EXPLORER_BASE_URL}/tx/${item.txHash}`}
      target="_blank"
      rel="noreferrer"
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `1px solid ${border}`, textDecoration: "none" }}
    >
      <ItemLogo item={item} resolveTokenName={resolveTokenName} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {describeItem(item, resolveTokenName, resolveWalletName)}
        </div>
        <div style={{ fontSize: 10, color: muted, fontFamily: monoFont }}>{shortHash(item.txHash)}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {item.usdValue != null && <div style={{ fontSize: 12, color, fontWeight: 700 }}>{formatUsdPrice(item.usdValue)}</div>}
        <div style={{ fontSize: 10, color: muted }}>{timeAgo(item.timestamp)}</div>
      </div>
    </a>
  );
}

// Core Tier's Recent Activity — a chronological, filterable glance at a wallet's own recent
// events (ETN moved, tokens sent/received/swapped, NFTs traded, liquidity added/removed,
// yield-farm/staking activity), as opposed to the cost-basis/valuation figures every other panel
// on this page reports. See recentActivityService.js's own header comment for exactly how each
// event is categorized and, for a multi-leg liquidity action, grouped into one item.
//
// Never triggers ingestion itself (no refresh-on-mount fetch loop against Blockscout) — relies on
// CoreTierPortfolio.jsx's own /premium/pnl-snapshot call, rendered earlier on this same page,
// having already started it — same assumption CoreTierNftPnl.jsx's panel already makes.
export default function CoreTierRecentActivity({ wallet, getAuthParams, coreTierAccess, walletFilter }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } = coreTierAccess;
  const { getRecentActivity } = useRecentActivity();

  const [snapshot, setSnapshot] = useState(null); // { perWallet, failed } | null
  const [snapshotError, setSnapshotError] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [category, setCategory] = useState("all");
  const [showCount, setShowCount] = useState(SHOW_COUNT_STEP);

  const loadSnapshot = useCallback(async () => {
    setSnapshotLoading(true);
    setSnapshotError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await getRecentActivity(wallet.account, signature, timestamp);
      setSnapshot(res);
    } catch (err) {
      setSnapshotError(err.message || "Couldn't load your recent activity");
    } finally {
      setSnapshotLoading(false);
    }
  }, [getAuthParams, getRecentActivity, wallet.account]);

  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setSnapshot(null);
      return;
    }
    loadSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, active]);

  // Reset pagination whenever the scope (wallet filter or category) changes, same reasoning as
  // every other filterable Core Tier list — a stale "Show more" depth from a wider scope would
  // otherwise leave a narrower one looking truncated for no visible reason.
  useEffect(() => {
    setShowCount(SHOW_COUNT_STEP);
  }, [walletFilter, category]);

  // All items across the wallets this filter covers, newest first — combining (not picking one
  // wallet's own pre-sorted list) is necessary even when walletFilter === "all", since each
  // wallet's own item array is only sorted within itself.
  const scopedItems = useMemo(() => {
    const perWallet = snapshot?.perWallet || [];
    const wallets = walletFilter === "all" ? perWallet : perWallet.filter((w) => w.walletAddress === walletFilter);
    const merged = wallets.flatMap((w) => w.items);
    merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return merged;
  }, [snapshot, walletFilter]);

  const filteredItems = category === "all" ? scopedItems : scopedItems.filter((i) => i.category === category);
  const visibleItems = filteredItems.slice(0, showCount);

  const filteredWalletFailed = walletFilter !== "all" && (snapshot?.failed || []).includes(walletFilter);

  const walletAddresses = (snapshot?.perWallet || []).map((w) => w.walletAddress);
  const { resolve: resolveWalletName } = useDisplayNames(walletAddresses);

  const tokenAddressesToResolve = useMemo(() => {
    const addrs = new Set();
    for (const item of scopedItems) {
      if (item.tokenAddress) addrs.add(item.tokenAddress);
      if (item.soldTokenAddress && item.soldTokenAddress !== "NATIVE") addrs.add(item.soldTokenAddress);
      if (item.boughtTokenAddress && item.boughtTokenAddress !== "NATIVE") addrs.add(item.boughtTokenAddress);
      if (item.tokenAddresses) for (const a of item.tokenAddresses) addrs.add(a);
    }
    return [...addrs];
  }, [scopedItems]);
  const { resolve: resolveTokenName } = useTokenNames(tokenAddressesToResolve);

  return (
    <CollapsibleCoreTierPanel
      icon={Activity}
      title="Core Tier — Recent Activity"
      headerRight={
        hasAccess && active.length > 0 && (
          <DashboardButton
            onClick={loadSnapshot}
            disabled={snapshotLoading}
            style={{ background: "transparent", border: `1px solid ${border}`, color: mutedLight, boxShadow: "none", padding: "6px 12px", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}
          >
            <RefreshCw size={12} />
            {snapshotLoading ? "Refreshing…" : "Refresh"}
          </DashboardButton>
        )
      }
    >
      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="see a feed of your wallets' recent on-chain activity"
      >
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>
            Track a wallet under Core Tier — Portfolio above to see its recent activity here.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <span style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted }}>Show</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} style={selectStyle}>
                {CATEGORY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {snapshotError && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{snapshotError}</div>}
            {walletFilter === "all" && snapshot?.failed?.length > 0 && (snapshot?.perWallet?.length || 0) > 0 && (
              <div style={{ fontSize: 11, color: errorColor, marginBottom: 12 }}>
                Couldn't load activity for {snapshot.failed.map((a) => resolveWalletName(a)).join(", ")} right now — the feed below only
                reflects your other tracked wallet{snapshot.failed.length === active.length - 1 ? "" : "s"}. Try Refresh.
              </div>
            )}

            {!snapshot && !snapshotError ? (
              <div style={{ fontSize: 12, color: mutedLight }}>Loading your recent activity — this can take a moment…</div>
            ) : filteredWalletFailed ? (
              <div style={{ fontSize: 12, color: mutedLight }}>Couldn't load activity for {resolveWalletName(walletFilter)} right now — try Refresh.</div>
            ) : !snapshot && snapshotError ? null /* total failure — the error line above already says everything */ : scopedItems.length === 0 && !snapshotLoading ? (
              <div style={{ fontSize: 12, color: muted }}>No activity found yet for your tracked wallet{active.length === 1 ? "" : "s"}.</div>
            ) : filteredItems.length === 0 ? (
              <div style={{ fontSize: 12, color: muted }}>No {CATEGORY_OPTIONS.find((o) => o.value === category)?.label.toLowerCase()} activity found.</div>
            ) : (
              <>
                {visibleItems.map((item) => (
                  <ActivityRow key={item.id} item={item} resolveTokenName={resolveTokenName} resolveWalletName={resolveWalletName} />
                ))}
                {showCount < filteredItems.length && (
                  <button
                    onClick={() => setShowCount((c) => c + SHOW_COUNT_STEP)}
                    style={{ display: "block", width: "100%", margin: "12px auto 0", padding: "8px 16px", borderRadius: 6, border: `1px solid ${border}`, background: panel2, color: green, fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                  >
                    Show {Math.min(SHOW_COUNT_STEP, filteredItems.length - showCount)} more
                  </button>
                )}
              </>
            )}
          </>
        )}
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}
