import React, { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import CoreTierStressTest from "./CoreTierStressTest.jsx";
import CoreTierWhatIf from "./CoreTierWhatIf.jsx";
import CoreTierFarmScenario from "./CoreTierFarmScenario.jsx";
import CoreTierRewardProjection from "./CoreTierRewardProjection.jsx";
import CoreTierBacktest from "./CoreTierBacktest.jsx";
import { useScenarios } from "../../hooks/useScenarios.js";
import { green, mutedLight, border, monoFont } from "../../theme.js";

// Core Tier Scenarios — read-only what-if tools under one panel. Each tool is switched on/off by the
// backend (/premium/scenarios/config, env SCENARIO_<TOOL>_ENABLED) so they can go live separately.
const TOOLS = [
  { id: "stress", label: "Stress test" },
  { id: "sellExit", label: "Sell / exit", flags: ["sell", "exit"] },
  { id: "farm", label: "Farm: add / withdraw" },
  { id: "rewards", label: "Rewards" },
  { id: "backtest", label: "Backtest" },
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
    background: current === id ? green : "none",
    color: current === id ? "#000" : mutedLight,
    border: `1px solid ${current === id ? green : border}`,
    borderRadius: 4,
    fontFamily: monoFont,
    fontSize: 11,
    fontWeight: 700,
    padding: "6px 12px",
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
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {enabled.map((t) => (
                <button key={t.id} type="button" onClick={() => setTool(t.id)} style={tabStyle(t.id)}>
                  {t.label}
                </button>
              ))}
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
