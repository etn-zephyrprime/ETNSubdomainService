import React, { useEffect, useMemo, useState } from "react";
import DualAxisLineChart from "../../components/DualAxisLineChart.jsx";
import { usePnlSnapshot } from "../../hooks/usePnlSnapshot.js";
import { formatChartDate } from "../../utils/format.js";
import { mutedLight, muted, error as errorColor, border, panel2, monoFont } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";

function fmtAmount(v) {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e6) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
  if (abs >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return v.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

// The PnL tab's "Tokens" view for Liquidity Positions / Staking & Yield Farms: one position's token0
// and token1 amounts over time, each on its own axis — as the pool's price moves, one line climbs
// while the other falls and the position ends up weighted towards one token. Data from
// /premium/lp-composition (backend/services/lpCompositionHistory.js), fetched the first time this
// view is opened. Follows the page-wide wallet filter; "liquidity" lists V2/V3 positions, "farm_staking"
// the yield farm positions (single-token staking has no pair to show).
export default function LpCompositionChart({ wallet, getAuthParams, category, walletFilter, resolveWalletName, multiWallet }) {
  const { getLpComposition } = usePnlSnapshot();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
        const res = await getLpComposition(wallet.account, signature, timestamp);
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError(err.message || "Couldn't load token balances");
      }
    })();
    return () => { cancelled = true; };
    // Once per wallet — not getAuthParams (new every render; see CoreTierGasSpend.jsx's load effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.account]);

  const positions = useMemo(() => {
    const list = [];
    for (const w of data?.perWallet || []) {
      if (walletFilter !== "all" && w.walletAddress.toLowerCase() !== String(walletFilter).toLowerCase()) continue;
      for (const p of w.positions || []) if (p.category === category) list.push({ ...p, walletAddress: w.walletAddress, key: `${w.walletAddress}|${p.id}` });
    }
    return list;
  }, [data, walletFilter, category]);

  const current = positions.find((p) => p.key === selected) || positions[0] || null;

  if (error) return <div style={{ fontSize: 12, color: errorColor }}>{error}</div>;
  if (!data) return <div style={{ fontSize: 12, color: mutedLight }}>Working out each position's token balances…</div>;
  if (!current) {
    return (
      <div style={{ fontSize: 12, color: mutedLight }}>
        {category === "liquidity" ? "No liquidity positions" : "No yield farm positions"} in the last year{walletFilter !== "all" ? " for this wallet" : ""}.
      </div>
    );
  }

  const first = current.points[0];
  const last = current.points[current.points.length - 1];
  const change = (from, to) => (from > 0 ? ((to / from - 1) * 100).toFixed(1) : null);
  const c0 = change(first.amount0, last.amount0);
  const c1 = change(first.amount1, last.amount1);

  return (
    <div>
      {positions.length > 1 && (
        <select
          value={current.key}
          onChange={(e) => setSelected(e.target.value)}
          style={{ width: "100%", marginBottom: 12, padding: "6px 8px", borderRadius: 6, border: `1px solid ${border}`, background: panel2, color: "#fff", fontFamily: monoFont, fontSize: 12 }}
        >
          {positions.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}{p.open ? "" : " (closed)"}{multiWallet && walletFilter === "all" ? ` — ${resolveWalletName(p.walletAddress)}` : ""}
            </option>
          ))}
        </select>
      )}
      {positions.length === 1 && <div style={{ fontFamily: monoFont, fontSize: 12, color: "#fff", marginBottom: 10 }}>{current.label}{current.open ? "" : " (closed)"}</div>}

      <DualAxisLineChart
        data={current.points.map((p) => ({ label: p.date, a: p.amount0, b: p.amount1 }))}
        a={{ name: current.token0.symbol, format: fmtAmount }}
        b={{ name: current.token1.symbol, format: fmtAmount }}
        formatLabel={formatChartDate}
      />

      {c0 != null && c1 != null && (
        <div style={{ fontSize: 11, color: mutedLight, marginTop: 8 }}>
          Since {formatChartDate(first.date, true)}: {current.token0.symbol} {c0 >= 0 ? "+" : ""}{c0}%, {current.token1.symbol} {c1 >= 0 ? "+" : ""}{c1}%
          {current.open ? "" : " (to when it closed)"}
        </div>
      )}
      <div style={{ fontSize: 10, color: muted, marginTop: 6, lineHeight: 1.4 }}>
        Principal only (uncollected fees not included), worked out from each day's prices. Changes from your own deposits and withdrawals show as both lines jumping together.
      </div>
    </div>
  );
}
