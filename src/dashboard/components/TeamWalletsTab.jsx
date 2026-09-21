import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { green, blue, mutedLight, muted, panel2, border, error as red } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import { useTeamWallets } from "../hooks/useTeamWallets.js";
import { formatEtnBalance, shortHash, timeAgo } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import { TEAM_WALLET_ADDRESSES } from "../utils/teamWallets.js";
import StatCard from "./StatCard.jsx";
import TeamWalletTag from "./TeamWalletTag.jsx";
import TeamBalanceChart from "./TeamBalanceChart.jsx";

// Re-polls the published cache periodically — backend/utils/teamWalletsCache.js itself only
// refreshes every 10 minutes by default, so this just needs to be frequent enough to pick up a
// fresh publish shortly after it happens, not to poll Blockscout itself.
const POLL_INTERVAL_MS = 60000;

// Wallets holding less than this are tucked behind a "show more" button, and movements older than
// MOVEMENT_MAX_AGE_DAYS aren't listed (a year is also the balance chart's window).
const MIN_LISTED_BALANCE_WEI = 1000n * 10n ** 18n; // 1,000 ETN
const MOVEMENT_MAX_AGE_DAYS = 365;

function balanceOf(wallet) {
  try {
    return BigInt(wallet.balance || "0");
  } catch {
    return 0n;
  }
}

function WalletRow({ wallet, onSelectAddress }) {
  return (
    <button
      onClick={() => onSelectAddress(wallet.address)}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        width: "100%",
        padding: "10px 0",
        borderBottom: `1px solid ${border}`,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "#fff", fontWeight: 600, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {wallet.ensName || shortHash(wallet.address)}
        </div>
      </div>
      <div style={{ fontSize: 12, color: green, fontWeight: 700, flexShrink: 0 }}>
        <TokenLogo address="NATIVE" label="ETN" size={14} spacing={5} />{formatEtnBalance(wallet.balance)} ETN
      </div>
    </button>
  );
}

// One merged ETN movement — every row involves at least one team wallet by construction (see
// teamWalletsCache.js), so each side gets its own tag only when THAT side is actually one, letting
// a team-to-team transfer read differently at a glance from a team-to-outside one.
//
// Colour-coded by what it means for the TEAM's total: OUT (team -> outside, red, ETN leaving the team's hands),
// IN (outside -> team, green) and INTERNAL (team -> team, blue: it only moves ETN between the team's own
// wallets, so the combined balance doesn't change).
function movementKind(movement) {
  if (movement.fromIsTeam && !movement.toIsTeam) return { label: "OUT", sign: "−", color: red, bg: "rgba(255,107,107,0.06)" };
  if (!movement.fromIsTeam && movement.toIsTeam) return { label: "IN", sign: "+", color: green, bg: "rgba(24,187,26,0.06)" };
  return { label: "INTERNAL", sign: "", color: blue, bg: "rgba(62,166,255,0.05)" };
}

function MovementRow({ movement }) {
  const kind = movementKind(movement);
  return (
    <a
      href={`${EXPLORER_BASE_URL}/tx/${movement.hash}`}
      target="_blank"
      rel="noreferrer"
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", margin: "0 -10px", borderBottom: `1px solid ${border}`, borderLeft: `3px solid ${kind.color}`, background: kind.bg, textDecoration: "none", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.6, color: kind.color, border: `1px solid ${kind.color}`, borderRadius: 4, padding: "1px 5px" }}>{kind.label}</span>
        <span style={{ fontSize: 11, color: mutedLight, fontFamily: "monospace" }}>{shortHash(movement.from)}</span>
        {movement.fromIsTeam && <TeamWalletTag style={{ fontSize: 8 }} />}
        <span style={{ fontSize: 11, color: kind.color }}>→</span>
        <span style={{ fontSize: 11, color: mutedLight, fontFamily: "monospace" }}>{shortHash(movement.to)}</span>
        {movement.toIsTeam && <TeamWalletTag style={{ fontSize: 8 }} />}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 12, color: kind.color, fontWeight: 700 }}><TokenLogo address="NATIVE" label="ETN" size={14} spacing={5} />{kind.sign}{formatEtnBalance(movement.value)} ETN</div>
        <div style={{ fontSize: 10, color: muted }}>{timeAgo(movement.timestamp)}</div>
      </div>
    </a>
  );
}

// Free-tier tab tracking every known Electroneum team wallet (see utils/teamWallets.js) — current
// ETN balance per wallet plus a merged feed of their recent real ETN movements. Backed entirely by
// backend/utils/teamWalletsCache.js's R2-published snapshot (useTeamWallets.js) — nothing here
// talks to Blockscout directly, same reasoning as every other cache-backed tab on this dashboard.
export default function TeamWalletsTab({ onSelectAddress }) {
  const { getTeamWallets } = useTeamWallets();

  const [wallets, setWallets] = useState(null); // null = loading, [] = loaded but empty
  const [movements, setMovements] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [showSmallWallets, setShowSmallWallets] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const refresh = () => {
      getTeamWallets()
        .then((res) => {
          if (cancelled) return;
          setWallets(res.wallets);
          setMovements(res.movements);
          setUpdatedAt(res.updatedAt);
          setLoadError(null);
        })
        .catch((err) => {
          console.error("Failed to load team wallets:", err);
          if (!cancelled) setLoadError("Couldn't load team wallet data — try again shortly.");
        });
    };

    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [getTeamWallets]);

  const totalBalanceWei = (wallets || []).reduce((sum, w) => {
    try {
      return sum + BigInt(w.balance || "0");
    } catch {
      return sum;
    }
  }, 0n);

  const sortedWallets = [...(wallets || [])].sort((a, b) => {
    const diff = balanceOf(b) - balanceOf(a);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });
  const bigWallets = sortedWallets.filter((w) => balanceOf(w) >= MIN_LISTED_BALANCE_WEI);
  const smallWallets = sortedWallets.filter((w) => balanceOf(w) < MIN_LISTED_BALANCE_WEI);
  const listedWallets = showSmallWallets ? sortedWallets : bigWallets;

  const movementCutoffMs = Date.now() - MOVEMENT_MAX_AGE_DAYS * 86400000;
  const recentMovements = movements.filter((m) => {
    const t = Date.parse(m.timestamp);
    return !Number.isFinite(t) || t >= movementCutoffMs; // an unparseable date isn't evidence it's old
  });

  return (
    <div>
      <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16, lineHeight: 1.5 }}>
        Suspected Electroneum team wallets — anyone holding more than 49 of{" "}
        <a href={`${EXPLORER_BASE_URL}/token/0x1760321f42A9BE39b39c779D92373769d829ef48?tab=holders`} target="_blank" rel="noreferrer" style={{ color: blue }}>
          The Three Graces Of The Sea
        </a>{" "}
        (SEAS), plus a few flagged separately. {TEAM_WALLET_ADDRESSES.length} wallets tracked.
      </div>

      {loadError && (
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>{loadError}</div>
      )}

      <div style={{ marginBottom: 24 }}>
        <StatCard
          label="Combined Team ETN Balance"
          value={wallets === null ? "Loading…" : <><TokenLogo address="NATIVE" label="ETN" size={22} spacing={8} />{formatEtnBalance(totalBalanceWei)} ETN</>}
          sub={updatedAt ? `Updated ${timeAgo(updatedAt)}` : undefined}
        />
      </div>

      <TeamBalanceChart />

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
        Wallets
      </div>
      <div style={{ padding: "0 0 8px", background: panel2, border: `1px solid ${border}`, borderRadius: 12, marginBottom: 24 }}>
        <div style={{ padding: "0 14px" }}>
          {wallets === null ? (
            <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>Loading…</div>
          ) : wallets.length === 0 ? (
            <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>No wallet data available yet.</div>
          ) : (
            listedWallets.map((w) => <WalletRow key={w.address} wallet={w} onSelectAddress={onSelectAddress} />)
          )}
        </div>
        {wallets !== null && smallWallets.length > 0 && (
          <div style={{ padding: "8px 14px 0", textAlign: "center" }}>
            <button
              onClick={() => setShowSmallWallets((v) => !v)}
              style={{ background: "transparent", border: `1px solid ${border}`, borderRadius: 8, color: mutedLight, fontSize: 12, fontWeight: 700, padding: "6px 14px", cursor: "pointer" }}
            >
              {showSmallWallets ? "Show fewer" : `Show ${smallWallets.length} more (under 1,000 ETN)`}
            </button>
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 4 }}>
        Recent ETN Team Wallet Movements
      </div>
      <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10 }}>
        Transfers of 1,000,000 ETN or more from the last 12 months only.{" "}
        <span style={{ color: red, fontWeight: 700 }}>OUT</span> = leaving the team's wallets,{" "}
        <span style={{ color: green, fontWeight: 700 }}>IN</span> = arriving,{" "}
        <span style={{ color: blue, fontWeight: 700 }}>INTERNAL</span> = between team wallets (combined balance unchanged).
      </div>
      <div style={{ padding: "0 14px", background: panel2, border: `1px solid ${border}`, borderRadius: 12 }}>
        {wallets === null ? (
          <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>Loading…</div>
        ) : recentMovements.length === 0 ? (
          <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>No team wallet movements of 1,000,000+ ETN found in the last 12 months.</div>
        ) : (
          recentMovements.map((m) => <MovementRow key={m.hash} movement={m} />)
        )}
      </div>
    </div>
  );
}
