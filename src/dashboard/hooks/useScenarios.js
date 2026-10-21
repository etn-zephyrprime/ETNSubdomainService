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

  const post = useCallback(async (path, body) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/scenarios/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await parseErrorOrThrow(res);
    return res.json();
  }, []);

  // Tool 2: { farmKey, action: "add" | "withdraw", addUsd?, withdrawPct? } for one tracked wallet.
  const runFarmScenario = useCallback(
    (wallet, signature, timestamp, walletAddress, input) => post("farm", { wallet, signature, timestamp, walletAddress, ...input }),
    [post]
  );

  // Tool 4: projectionTarget = "staking" | farm key; deposit = null | { usd } | { core, nfts }.
  const runRewardProjection = useCallback(
    (wallet, signature, timestamp, walletAddress, projectionTarget, deposit) => post("rewards", { wallet, signature, timestamp, walletAddress, projectionTarget, deposit }),
    [post]
  );

  const getActiveFarms = useCallback(async () => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/scenarios/farms`);
    await parseErrorOrThrow(res);
    return res.json(); // { farms: [{ key, id, name, rewards }] }
  }, []);

  // Tool 5: { asset, amountType: "usd"|"etn"|"tokens", amount, start, end?, mode: "lump"|"weekly"|"monthly" }.
  const runBacktest = useCallback((wallet, signature, timestamp, input) => post("backtest", { wallet, signature, timestamp, ...input }), [post]);

  const getBacktestTokens = useCallback(async () => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/scenarios/backtest-tokens`);
    await parseErrorOrThrow(res);
    return res.json(); // { tokens: [{ asset, symbol }] }
  }, []);

  return { getScenarioConfig, runStressTest, runFarmScenario, runRewardProjection, getActiveFarms, runBacktest, getBacktestTokens };
}
