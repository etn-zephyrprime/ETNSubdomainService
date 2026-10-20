import React, { useEffect, useMemo, useState } from "react";
import { Fuel } from "lucide-react";
import { useGasSpend } from "../../hooks/useGasSpend.js";
import { muted, mutedLight, border, panel2, monoFont, error as errorColor } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";

function fmtGas(n) {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0 ETN";
  if (Math.abs(n) >= 1_000_000) return `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n)} ETN`;
  // Gas is small per tx; keep enough precision that a tiny wallet doesn't read as "0.00".
  return `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 })} ETN`;
}

// Core Tier: total gas spent, in ETN, across the member's tracked wallets (or the one picked in the
// page-wide wallet filter) — a one-line ticker at the top of the page (it replaced the old Gas Spent
// tab and its chart). Built from the ingested transfer history's gas rows — one per transaction the
// wallet itself sent, failed ones included — so it only covers what's been ingested.
export default function CoreTierGasSpend({ wallet, getAuthParams, hasAccess, active, walletFilter }) {
  const { getGasSpend } = useGasSpend();
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setData(null);
      return;
    }
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
        const res = await getGasSpend(wallet.account, signature, timestamp);
        if (!cancelled) setData(res.perWallet || []);
      } catch (err) {
        console.error("Failed to load gas spend:", err.message);
        if (!cancelled) setError("Couldn't load");
      }
    })();
    return () => { cancelled = true; };
  }, [hasAccess, active, getAuthParams, getGasSpend, wallet.account]);

  const { total, txCount } = useMemo(() => {
    let sum = 0;
    let count = 0;
    for (const w of data || []) {
      if (walletFilter !== "all" && w.walletAddress !== walletFilter) continue;
      for (const d of w.daily) {
        sum += d.etn;
        count += d.txCount;
      }
    }
    return { total: sum, txCount: count };
  }, [data, walletFilter]);

  return (
    <div
      title="All time, failed transactions included"
      style={{ flex: "1 1 220px", minWidth: 0, display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 8, border: `1px solid ${border}`, background: panel2 }}
    >
      <Fuel size={20} color={mutedLight} style={{ flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 2 }}>
          Total Gas Spent
        </div>
        <div style={{ fontFamily: monoFont, fontSize: 14, fontWeight: 800, color: error ? errorColor : "#fff" }}>
          {error || (data == null ? "Loading…" : fmtGas(total))}
        </div>
        {data != null && !error && (
          <div style={{ fontSize: 10, color: muted, marginTop: 2 }}>
            {txCount.toLocaleString()} transaction{txCount === 1 ? "" : "s"} sent
          </div>
        )}
      </div>
    </div>
  );
}
