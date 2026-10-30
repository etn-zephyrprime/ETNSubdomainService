import React, { useEffect, useRef, useState } from "react";
import { Wallet as WalletIcon, Coins, TrendingUp, Image as ImageIcon } from "lucide-react";
import { usePortfolioSummary } from "../../hooks/usePortfolioSummary.js";
import { usePnlSnapshot } from "../../hooks/usePnlSnapshot.js";
import { useNftPnlSnapshot } from "../../hooks/useNftPnlSnapshot.js";
import { useEtnPrice } from "../../../hooks/useEtnPrice.js";
import { formatUsdPrice, formatEtnAmount } from "../../utils/format.js";
import CornerBrackets from "../../components/CornerBrackets.jsx";
import { gold, goldGlow, green, greenGlow, error as errorColor, errorGlow, muted, mutedLight, panel2, monoFont } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
// While the PnL figures on show are SAVED ones being refreshed in the background (snapshot.refreshing),
// re-ask until the fresh ones land — but only while the PnL tab isn't open, since CoreTierPnl polls
// for itself then and hands its results up (onSnapshot).
const REFRESH_POLL_MS = 5000;
const REFRESH_POLL_MAX = 24; // ~2 minutes, then the saved figures stand

function signColor(v) {
  return v > 0 ? green : v < 0 ? errorColor : "#fff";
}
function signGlow(v) {
  return v > 0 ? greenGlow : v < 0 ? errorGlow : goldGlow;
}
const signedUsd = (v) => `${v >= 0 ? "+" : "−"}${formatUsdPrice(Math.abs(v))}`;
const signedEtn = (v) => `${v >= 0 ? "+" : "−"}${formatEtnAmount(Math.abs(v))} ETN`;

/** One headline card: gold-framed (Core Tier's premium colour, same as the tab buttons above it),
 * with the HUD corner brackets every dashboard card carries. `tone` (a signed number) tints the
 * main figure green/red for the PnL cards; the balance cards stay white. */
function HeadlineCard({ icon: Icon, label, value, tone, sub, note, loading }) {
  const hasTone = Number.isFinite(tone);
  return (
    <div
      style={{
        position: "relative",
        minWidth: 0,
        padding: "14px 14px 12px",
        borderRadius: 8,
        border: "1px solid rgba(232,191,76,0.45)",
        background: `linear-gradient(160deg, rgba(232,191,76,0.13) 0%, rgba(232,191,76,0.03) 45%, ${panel2} 100%)`,
        boxShadow: "0 0 18px rgba(232,191,76,0.10), inset 0 1px 0 rgba(255,255,255,0.04)",
        overflow: "hidden",
      }}
    >
      {/* Gold top edge — the "these are the headline numbers" accent. */}
      <div aria-hidden="true" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, transparent, ${gold}, transparent)`, opacity: 0.9 }} />
      <CornerBrackets color={gold} size={10} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            flexShrink: 0,
            borderRadius: "50%",
            background: "rgba(232,191,76,0.14)",
            border: "1px solid rgba(232,191,76,0.40)",
            boxShadow: `0 0 10px ${goldGlow}`,
          }}
        >
          <Icon size={13} color={gold} />
        </span>
        <span style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: "#d8c488", lineHeight: 1.2 }}>
          {label}
        </span>
      </div>
      <div
        style={{
          fontSize: 21,
          fontWeight: 900,
          lineHeight: 1.15,
          color: loading ? mutedLight : hasTone ? signColor(tone) : "#fff",
          textShadow: loading ? undefined : `0 0 12px ${hasTone ? signGlow(tone) : goldGlow}`,
          overflowWrap: "anywhere",
        }}
      >
        {loading ? "…" : value}
      </div>
      {!loading && sub && <div style={{ fontFamily: monoFont, fontSize: 12, fontWeight: 700, color: mutedLight, marginTop: 4, overflowWrap: "anywhere" }}>{sub}</div>}
      {!loading && note && <div style={{ fontSize: 10, color: muted, marginTop: 4, lineHeight: 1.35 }}>{note}</div>}
    </div>
  );
}

// Core Tier's four headline figures, right under the panel buttons: Total Portfolio Balance, ETN
// Balance, Net PnL (realized + unrealized, with its ETN value) and NFT PnL. All follow the page-wide
// wallet filter. Deliberately cheap — nothing here is computed just for the cards:
//   • balances: the Portfolio panel's own settled live figures when it has them (onLiveSummary), else
//     the summary it saved last visit (portfolio_summary_cache)
//   • Net PnL: /pnl-snapshot, which serves the in-memory/saved snapshot first (getSnapshotFast) —
//     and the PnL panel hands its own results up too, so a Refresh there updates this card
//   • NFT PnL: /nft-pnl, cached server-side per ingestion state (nftPnlService.js)
export default function CoreTierHeadlineCards({ wallet, getAuthParams, hasAccess, active, walletFilter, liveSummary, pnlSnapshot, onPnlSnapshot, pnlTabOpen }) {
  const etnUsdPrice = useEtnPrice();
  const { getPortfolioSummary } = usePortfolioSummary();
  const { getLiveSnapshot } = usePnlSnapshot();
  const { getNftPnlSnapshot } = useNftPnlSnapshot();

  const [savedSummary, setSavedSummary] = useState(undefined); // undefined = loading, null = none saved
  const [pnlError, setPnlError] = useState(false);
  const [nft, setNft] = useState(undefined); // undefined = loading, null = failed
  const pollsRef = useRef(0);

  useEffect(() => {
    if (!hasAccess || active.length === 0) return;
    let cancelled = false;
    setSavedSummary(undefined);
    setNft(undefined);
    setPnlError(false);
    pollsRef.current = 0;
    (async () => {
      let auth;
      try {
        auth = await getAuthParams(AUTH_PURPOSE);
      } catch {
        if (!cancelled) {
          setSavedSummary(null);
          setNft(null);
          setPnlError(true);
        }
        return;
      }
      const { signature, timestamp } = auth;
      getPortfolioSummary(wallet.account, signature, timestamp)
        .then((r) => !cancelled && setSavedSummary(r.summary || null))
        .catch(() => !cancelled && setSavedSummary(null));
      // The PnL panel, when it's the one open, fetches the same snapshot itself and hands it up.
      if (!pnlTabOpen) {
        getLiveSnapshot(wallet.account, signature, timestamp)
          .then((r) => !cancelled && onPnlSnapshot(r))
          .catch(() => !cancelled && setPnlError(true));
      }
      getNftPnlSnapshot(wallet.account, signature, timestamp)
        .then((r) => !cancelled && setNft(r))
        .catch(() => !cancelled && setNft(null));
    })();
    return () => { cancelled = true; };
    // Keyed on access/wallets only — NOT getAuthParams (rebuilt every parent render; see
    // CoreTierGasSpend.jsx's load effect for what listing it here did).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, active]);

  // Saved PnL figures being refreshed in the background: re-ask until the live ones arrive.
  useEffect(() => {
    if (!pnlSnapshot?.refreshing || pnlTabOpen || pollsRef.current >= REFRESH_POLL_MAX) return;
    const id = setTimeout(async () => {
      pollsRef.current += 1;
      try {
        const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
        onPnlSnapshot(await getLiveSnapshot(wallet.account, signature, timestamp));
      } catch {
        // keep showing the saved figures; the next tick (if any) tries again
      }
    }, REFRESH_POLL_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pnlSnapshot, pnlTabOpen]);

  if (!hasAccess || active.length === 0) return null;

  const inFilter = (addr) => walletFilter === "all" || String(addr).toLowerCase() === String(walletFilter).toLowerCase();
  const activeSet = new Set(active.map((w) => w.address.toLowerCase()));

  // ---- Balances ------------------------------------------------------------------------------
  // Live (this visit's settled Portfolio figures) beats saved (last visit's).
  const summary = liveSummary || savedSummary;
  const balanceRows = (summary?.perWallet || []).filter((w) => activeSet.has(String(w.address).toLowerCase()) && inFilter(w.address));
  const balancesLoading = !liveSummary && savedSummary === undefined;
  const totalUsd = balanceRows.reduce((s, w) => s + w.native + w.tokens + w.liquidity + w.staking, 0);
  // ETN amount: exact when the summary carries it; an older saved summary only has the USD value, so
  // that's converted at today's price (marked ≈).
  let etnAmount = 0;
  let etnEstimated = false;
  for (const w of balanceRows) {
    if (Number.isFinite(w.nativeEtn)) etnAmount += w.nativeEtn;
    else if (etnUsdPrice) {
      etnAmount += w.native / etnUsdPrice;
      etnEstimated = true;
    }
  }
  const balancesFromSaved = !liveSummary && balanceRows.length > 0;
  const approx = summary?.hasUnpriced ? "≈ " : "";

  // ---- Net PnL ---------------------------------------------------------------------------------
  const pnlFigures = walletFilter === "all" ? pnlSnapshot?.combined : pnlSnapshot?.perWallet?.find((w) => inFilter(w.walletAddress));
  const realizedUsd = Number(pnlFigures?.realizedPnlUsd);
  const unrealizedUsd = Number(pnlFigures?.unrealizedPnlUsd);
  const netUsd = (Number.isFinite(realizedUsd) ? realizedUsd : 0) + (Number.isFinite(unrealizedUsd) ? unrealizedUsd : 0);
  const pnlNeedsSetup = !pnlFigures && (pnlSnapshot?.ingesting || pnlSnapshot?.needsSelection?.length > 0);
  const pnlLoading = !pnlSnapshot && !pnlError;

  let pnlCard;
  if (pnlFigures) {
    pnlCard = {
      value: signedUsd(netUsd),
      tone: netUsd,
      sub: etnUsdPrice ? `${signedEtn(netUsd / etnUsdPrice)} at today's price` : null,
      note: `Realized ${signedUsd(Number.isFinite(realizedUsd) ? realizedUsd : 0)} · Unrealized ${signedUsd(Number.isFinite(unrealizedUsd) ? unrealizedUsd : 0)}${pnlSnapshot?.refreshing ? " · updating…" : ""}`,
    };
  } else if (pnlNeedsSetup) {
    pnlCard = { value: "—", note: "Open the PnL tab to finish setting up your wallets" };
  } else if (!pnlLoading) {
    pnlCard = { value: "—", note: "Couldn't load right now — try the PnL tab" };
  }

  // ---- NFT PnL ---------------------------------------------------------------------------------
  const nftFigures = walletFilter === "all" ? nft?.combined : nft?.perWallet?.find((w) => inFilter(w.walletAddress));
  const nftUsd = Number(nftFigures?.realizedPnlUsd);
  const nftEtn = Number(nftFigures?.realizedPnlEtn);
  let nftCard;
  if (nftFigures && Number.isFinite(nftUsd)) {
    nftCard = {
      value: signedUsd(nftUsd),
      tone: nftUsd,
      sub: Number.isFinite(nftEtn) ? signedEtn(nftEtn) : null,
      note: "Realized on NFTs sold, net of what you paid",
    };
  } else if (nft === null || (nft && !nftFigures)) {
    nftCard = { value: "—", note: nft === null ? "Couldn't load right now — try the NFT PnL tab" : "No NFT trades yet" };
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <style>{`
        .core-tier-headline{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
        @media (min-width:720px){
          .core-tier-headline{grid-template-columns:repeat(4,minmax(0,1fr));}
        }
      `}</style>
      <div className="core-tier-headline">
        <HeadlineCard
          icon={WalletIcon}
          label="Total Portfolio"
          loading={balancesLoading}
          value={balanceRows.length ? `${approx}${formatUsdPrice(totalUsd)}` : "—"}
          sub={balanceRows.length && etnUsdPrice ? `${approx}${formatEtnAmount(totalUsd / etnUsdPrice)} ETN` : null}
          note={!balanceRows.length ? "Open the Portfolio tab to load it" : balancesFromSaved ? "From your last visit — Portfolio tab updates it" : "ETN, tokens, liquidity & staking"}
        />
        <HeadlineCard
          icon={Coins}
          label="ETN Balance"
          loading={balancesLoading}
          value={balanceRows.length ? `${etnEstimated ? "≈ " : ""}${formatEtnAmount(etnAmount)} ETN` : "—"}
          sub={balanceRows.length && etnUsdPrice ? formatUsdPrice(etnAmount * etnUsdPrice) : null}
          note={balanceRows.length ? "Native ETN in your wallets" : null}
        />
        <HeadlineCard icon={TrendingUp} label="Net PnL" loading={pnlLoading} {...pnlCard} />
        <HeadlineCard icon={ImageIcon} label="NFT PnL" loading={nft === undefined} {...nftCard} />
      </div>
    </div>
  );
}
