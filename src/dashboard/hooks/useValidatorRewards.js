import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/validatorRewardsCache.js's real per-UTC-day, per-validator block counts + ETN
// rewards earned — see that file's header comment for why this is a separate cache/source from
// useDailyBlockStats.js's validator block counts (no reward data available there). Same
// no-fallback-on-failure pattern as this app's other R2-backed hooks: a fetch failure just means
// this chart shows no data.
export function useValidatorRewards() {
  const getValidatorRewards = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("validator-rewards.json"));
      if (!res.ok) return null;
      return res.json(); // { days: { "2026-08-28": { validators: { "0xabc...": { blocks, rewardWei } } } } }
    } catch (err) {
      console.warn("Validator rewards fetch failed:", err.message);
      return null;
    }
  }, []);

  return { getValidatorRewards };
}
