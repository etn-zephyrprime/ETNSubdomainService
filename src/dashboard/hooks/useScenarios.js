import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Core Tier Scenarios — GET /api/premium/scenarios/config (which tools are switched on) and the
// tools' own runs. See backend/services/scenarioStressTest.js. Same error conventions as the other
// Core Tier hooks.
async function parseErrorOrThrow(res) {
  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error === "Core tier membership required" || !data.error ? "CORE_ACCESS_REQUIRED" : data.error);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useScenarios() {
  const getScenarioConfig = useCallback(async () => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/scenarios/config`);
    await parseErrorOrThrow(res);
    return res.json(); // { tools: { stress, sell, exit } }
  }, []);

  // shocks: { etnPct, allTokensPct, tokenPct: { [token]: pct } }; scope: "all" | wallet address
  const runStressTest = useCallback(async (wallet, signature, timestamp, { scope, shocks }) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/scenarios/stress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, scope, shocks }),
    });
    await parseErrorOrThrow(res);
    return res.json();
  }, []);

  return { getScenarioConfig, runStressTest };
}
