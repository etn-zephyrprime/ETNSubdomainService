import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { LineChart } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import SparklineChart from "../../components/SparklineChart.jsx";
import { useCoreTierAccess } from "../../hooks/useCoreTierAccess.js";
import { useBlockscout } from "../../hooks/useBlockscout.js";
import { mergeBalanceHistories } from "../../utils/balanceHistory.js";
import { formatChartDate, shortHash } from "../../utils/format.js";
import { green, muted, mutedLight, border } from "../../theme.js";

function fmtEtn(v) {
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETN`;
}

// Core Tier's second feature: full ETN balance history — combined across every tracked wallet,
// plus each wallet's own — reusing the exact same Blockscout endpoint (coin-balance-history-by-
// day) AddressLookup.jsx already charts for a single free-tier lookup, just fanned out across the
// tracked-wallet list and merged (see balanceHistory.js for why that merge needs to forward-fill
// rather than just sum whatever lands on the same date). Deliberately ETN-only, not per-token:
// Blockscout has no equivalent historical-balance endpoint for ERC-20/721/1155 holdings, only the
// live snapshot CoreTierPortfolio.jsx already shows — reconstructing token balance-over-time would
// mean indexing every transfer ourselves, a materially bigger feature than this one.
//
// Shares useCoreTierAccess with CoreTierPortfolio.jsx (same membershipVersion prop, passed down
// from PortfolioDashboardSection.jsx) rather than each maintaining its own copy of "is this member
// allowed, and which wallets do they track" — see that hook's own header comment.
export default function CoreTierBalanceHistory({ wallet, membershipVersion = 0 }) {
  const {
    hasAccess, accessError, awaitingActivation, manualCheckLoading,
    active, checkAccessOnce,
  } = useCoreTierAccess(wallet, membershipVersion);
  const { getAddressCoinBalanceHistory } = useBlockscout();

  const [historiesByAddress, setHistoriesByAddress] = useState({}); // address -> items[] | null (loading)
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setHistoriesByAddress({});
      return;
    }
    let cancelled = false;
    setError(null);
    setHistoriesByAddress(Object.fromEntries(active.map((w) => [w.address, null])));

    Promise.all(
      active.map((w) =>
        getAddressCoinBalanceHistory(w.address)
          .then((res) => [w.address, Array.isArray(res?.items) ? res.items : []])
          .catch((err) => {
            console.error(`Failed to load balance history for ${w.address}:`, err.message);
            return [w.address, []]; // one wallet failing shouldn't blank the whole chart
          })
      )
    ).then((entries) => {
      if (cancelled) return;
      setHistoriesByAddress(Object.fromEntries(entries));
    });

    return () => { cancelled = true; };
  }, [hasAccess, active, getAddressCoinBalanceHistory]);

  const loaded = active.length > 0 && active.every((w) => historiesByAddress[w.address] != null);
  const combinedSeries = loaded
    ? mergeBalanceHistories(active.map((w) => historiesByAddress[w.address]))
    : [];

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <LineChart size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Core Tier — Balance History
        </div>
      </div>

      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="see full ETN balance history for your tracked wallets, combined and individually"
      >
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>
            No wallets tracked yet — add up to 3 under Core Tier — Portfolio above to see their
            balance history here.
          </div>
        ) : error ? (
          <div style={{ fontSize: 12, color: "#ff6b6b" }}>{error}</div>
        ) : !loaded ? (
          <div style={{ fontSize: 12, color: mutedLight }}>Loading balance history…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
                {active.length > 1 ? "Combined ETN Balance History" : "ETN Balance History"}
              </div>
              {combinedSeries.length < 2 ? (
                <div style={{ fontSize: 12, color: muted }}>Not enough history yet to chart.</div>
              ) : (
                <SparklineChart data={combinedSeries} height={140} formatValue={fmtEtn} formatLabel={formatChartDate} />
              )}
            </div>

            {active.length > 1 &&
              active.map((w) => {
                const items = historiesByAddress[w.address] || [];
                const series = items.map((d) => ({ label: d.date, value: parseFloat(ethers.formatEther(d.value)) }));
                return (
                  <div key={w.address}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
                      {w.address.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                      {shortHash(w.address, 8)}
                    </div>
                    {series.length < 2 ? (
                      <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Not enough history yet to chart.</div>
                    ) : (
                      <SparklineChart data={series} height={100} formatValue={fmtEtn} formatLabel={formatChartDate} />
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </CoreTierGate>
    </DashboardPanel>
  );
}
