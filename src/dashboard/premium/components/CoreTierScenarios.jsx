import React, { useEffect, useState } from "react";
import { FlaskConical, Gauge, ArrowLeftRight, Sprout, Coins, History } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import CoreTierStressTest from "./CoreTierStressTest.jsx";
import CoreTierWhatIf from "./CoreTierWhatIf.jsx";
import CoreTierFarmScenario from "./CoreTierFarmScenario.jsx";
import CoreTierRewardProjection from "./CoreTierRewardProjection.jsx";
import CoreTierBacktest from "./CoreTierBacktest.jsx";
import { useScenarios } from "../../hooks/useScenarios.js";
import { green, muted, mutedLight, border, monoFont } from "../../theme.js";

// Core Tier Scenarios — read-only what-if tools under one panel. Each tool is switched on/off by the
// backend (/premium/scenarios/config, env SCENARIO_<TOOL>_ENABLED) so they can go live separately.
const TOOLS = [
  { id: "stress", label: "Stress test", hint: "Price shocks", icon: Gauge },
  { id: "sellExit", label: "Sell / exit", hint: "Before you trade", icon: ArrowLeftRight, flags: ["sell", "exit"] },
  { id: "farm", label: "Farm", hint: "Add or withdraw", icon: Sprout },
  { id: "rewards", label: "Rewards", hint: "Projected yield", icon: Coins },
  { id: "backtest", label: "Backtest", hint: "What if I'd bought", icon: History },
];

export default function CoreTierScenarios({ wallet, getAuthParams, coreTierAccess, walletFilter }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } = coreTierAccess;
  const { getScenarioConfig } = useScenarios();
  const [flags, setFlags] = useState(null);
  const [tool, setTool] = useState("stress");

  useEffect(() => {
    getScenarioConfig()
      .then((c) => setFlags(c.tools || {}))
      .catch(() => setFlags({ stress: true, sell: true, exit: true, farm: true, rewards: true, backtest: true })); // config unreachable: don't hide tools over it
  }, [getScenarioConfig]);

  const enabled = TOOLS.filter((t) => (t.flags || [t.id]).some((f) => flags?.[f] !== false));
  const current = enabled.find((t) => t.id === tool) ? tool : enabled[0]?.id;

  const tabStyle = (id) => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    textAlign: "left",
    background: current === id ? "rgba(24,187,26,0.12)" : "rgba(255,255,255,0.02)",
    color: current === id ? "#fff" : mutedLight,
    border: `1px solid ${current === id ? green : border}`,
    boxShadow: current === id ? "0 0 14px rgba(24,187,26,0.25)" : "none",
    borderRadius: 10,
    padding: "10px 12px",
    cursor: "pointer",
  });

  return (
    <CollapsibleCoreTierPanel icon={FlaskConical} title="Core Tier — Scenarios" defaultCollapsed={false}>
      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="try what-if scenarios on your real holdings — price shocks, sales and position exits — without touching anything"
      >
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>Track a wallet under Core Tier — Portfolio above to run scenarios on it.</div>
        ) : !flags ? (
          <div style={{ fontSize: 12, color: mutedLight }}>Loading…</div>
        ) : enabled.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>Scenarios aren't available right now.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
              {enabled.map((t) => {
                const Icon = t.icon;
                return (
                  <button key={t.id} type="button" onClick={() => setTool(t.id)} style={tabStyle(t.id)}>
                    <Icon size={18} color={current === t.id ? green : mutedLight} style={{ flexShrink: 0 }} />
                    <span>
                      <span style={{ display: "block", fontFamily: monoFont, fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase" }}>{t.label}</span>
                      <span style={{ display: "block", fontSize: 10, color: muted }}>{t.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {current === "stress" && <CoreTierStressTest wallet={wallet} getAuthParams={getAuthParams} active={active} />}
            {current === "farm" && <CoreTierFarmScenario wallet={wallet} getAuthParams={getAuthParams} active={active} />}
            {current === "rewards" && <CoreTierRewardProjection wallet={wallet} getAuthParams={getAuthParams} active={active} />}
            {current === "backtest" && <CoreTierBacktest wallet={wallet} getAuthParams={getAuthParams} />}
            {current === "sellExit" && (
              <CoreTierWhatIf wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} embedded />
            )}
          </div>
        )}
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}
