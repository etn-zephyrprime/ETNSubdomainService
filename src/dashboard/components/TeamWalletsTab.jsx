import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { green, blue, mutedLight, muted, panel2, border } from "../theme.js";
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
        {formatEtnBalance(wallet.balance)} ETN
      </div>
    </button>
  );
}

// One merged ETN movement — every row involves at least one team wallet by construction (see
// teamWalletsCache.js), so each side gets its own tag only when THAT side is actually one, letting
// a team-to-team transfer read differently at a glance from a team-to-outside one.
function MovementRow({ movement }) {
  return (
    <a
      href={`${EXPLORER_BASE_URL}/tx/${movement.hash}`}
      target="_blank"
      rel="noreferrer"
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}`, textDecoration: "none", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: mutedLight, fontFamily: "monospace" }}>{shortHash(movement.from)}</span>
        {movement.fromIsTeam && <TeamWalletTag style={{ fontSize: 8 }} />}
        <span style={{ fontSize: 11, color: muted }}>→</span>
        <span style={{ fontSize: 11, color: mutedLight, fontFamily: "monospace" }}>{shortHash(movement.to)}</span>
        {movement.toIsTeam && <TeamWalletTag style={{ fontSize: 8 }} />}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 12, color: green, fontWeight: 700 }}>{formatEtnBalance(movement.value)} ETN</div>
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

  return (
    <div>
      <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16, lineHeight: 1.5 }}>
        Wallets confirmed as belonging to the Electroneum team — anyone holding more than 49 of{" "}
        <a href={`${EXPLORER_BASE_URL}/token/0x1760321f42A9BE39b39c779D92373769d829ef48?tab=holders`} target="_blank" rel="noreferrer" style={{ color: blue }}>
          The Three Graces Of The Sea
        </a>{" "}
        (SEAS), plus one wallet confirmed separately. {TEAM_WALLET_ADDRESSES.length} wallets tracked.
      </div>

      {loadError && (
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>{loadError}</div>
      )}

      <div style={{ marginBottom: 24 }}>
        <StatCard
          label="Combined Team ETN Balance"
          value={wallets === null ? "Loading…" : `${formatEtnBalance(totalBalanceWei)} ETN`}
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
            [...wallets]
              .sort((a, b) => {
                try {
                  const diff = BigInt(b.balance || "0") - BigInt(a.balance || "0");
                  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
                } catch {
                  return 0;
                }
              })
              .map((w) => <WalletRow key={w.address} wallet={w} onSelectAddress={onSelectAddress} />)
          )}
        </div>
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
        Recent ETN Movements
      </div>
      <div style={{ padding: "0 14px", background: panel2, border: `1px solid ${border}`, borderRadius: 12 }}>
        {wallets === null ? (
          <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>Loading…</div>
        ) : movements.length === 0 ? (
          <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>No recent ETN movements found.</div>
        ) : (
          movements.map((m) => <MovementRow key={m.hash} movement={m} />)
        )}
      </div>
    </div>
  );
}
