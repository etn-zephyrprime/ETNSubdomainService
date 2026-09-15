import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, LEGACY_MARKETPLACE_ADDRESS, RPC_URL } from "../config.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";

// How far out to set buyBackAndBurn's deadline from the moment the tx is submitted. Generous
// enough to clear this chain's block times comfortably without the admin having to think about
// it — the contract only uses this to bound how stale the swap quote can get, not as a UI concern.
const DEADLINE_BUFFER_SECONDS = 20 * 60;

export function useBurnPool() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getReadContract = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, provider);
  }, []);

  // totalCoreBurned()/burnPool() are unchanged getters between V3 and V4 (same selector), so the
  // V4 ABI reads correctly against the deprecated V3 address too — no separate legacy ABI needed.
  const getLegacyReadContract = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Contract(LEGACY_MARKETPLACE_ADDRESS, MarketplaceABI, provider);
  }, []);

  // Returns the ETN (wei) currently sitting in V4's burnPool, awaiting a buyBackAndBurn call to
  // swap it for CORE and burn it. Deliberately V4-only, unlike getTotalCoreBurned below — this is
  // a current balance, not a lifetime total, and buyBackAndBurn only ever acts on this contract's
  // own pool.
  const getBurnPool = useCallback(async () => {
    const marketplace = getReadContract();
    return await marketplace.burnPool();
  }, [getReadContract]);

  // Lifetime total of CORE (wei, 18 decimals like ETN) actually burned via buyBackAndBurn — each
  // contract's own running counter (totalCoreBurned), incremented by the real amount received from
  // each swap. V4 is a fresh contract whose own counter starts at 0, so its figure alone would
  // silently drop every CORE burned while V3 was live — summed with the deprecated V3 contract's
  // counter (which only ever stops growing, never resets) so the figure shown is lifetime V3 + V4.
  const getTotalCoreBurned = useCallback(async () => {
    const marketplace = getReadContract();
    let legacyBurned = 0n;
    try {
      const legacy = getLegacyReadContract();
      legacyBurned = await legacy.totalCoreBurned();
    } catch (err) {
      console.warn("⚠️  Couldn't read legacy V3 totalCoreBurned, showing V4-only total:", err.message);
    }
    const currentBurned = await marketplace.totalCoreBurned();
    return currentBurned + legacyBurned;
  }, [getReadContract, getLegacyReadContract]);

  // minCoreOut is in CORE's smallest unit (wei, 18 decimals) — the caller is responsible for
  // converting from a human-entered CORE amount via ethers.parseUnits before calling this.
  // Passing 0 disables slippage protection entirely (the swap accepts whatever the pool gives),
  // which is fine for a manual admin-triggered call but is the caller's choice, not this hook's.
  const buyBackAndBurn = useCallback(async (minCoreOutWei, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const deadline = Math.floor(Date.now() / 1000) + DEADLINE_BUFFER_SECONDS;
      // Fixed gas limit, same reasoning as elsewhere in this app — this chain's
      // eth_estimateGas has proven unreliable, so writes use a generous fixed limit instead.
      // Covers the Uniswap V2 swap plus the CORE.burn() call.
      const tx = await marketplace.buyBackAndBurn(minCoreOutWei, deadline, { gasLimit: 400000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Buy back and burn failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Buy back and burn failed:", err);
      setError(err?.reason || err?.message || "Buy back and burn failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    getBurnPool,
    getTotalCoreBurned,
    buyBackAndBurn,
    loading,
    error,
  };
}
