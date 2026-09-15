import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, LEGACY_MARKETPLACES, RPC_URL } from "../config.js";
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

  // totalCoreBurned()/burnPool() are unchanged getters across V3/V4/V5 (same selector), so the
  // current ABI reads correctly against any deprecated address too — no separate legacy ABI needed.
  const getLegacyReadContracts = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return LEGACY_MARKETPLACES.map(({ address }) => new ethers.Contract(address, MarketplaceABI, provider));
  }, []);

  // Returns the ETN (wei) currently sitting in the current contract's burnPool, awaiting a
  // buyBackAndBurn call to swap it for CORE and burn it. Deliberately current-contract-only,
  // unlike getTotalCoreBurned below — this is a current balance, not a lifetime total, and
  // buyBackAndBurn only ever acts on this contract's own pool.
  const getBurnPool = useCallback(async () => {
    const marketplace = getReadContract();
    return await marketplace.burnPool();
  }, [getReadContract]);

  // Lifetime total of CORE (wei, 18 decimals like ETN) actually burned via buyBackAndBurn — each
  // contract's own running counter (totalCoreBurned), incremented by the real amount received from
  // each swap. The current contract is a fresh deployment whose own counter starts at 0, so its
  // figure alone would silently drop everything burned on every prior deployment — summed with
  // every deprecated marketplace's own counter (each only ever stops growing, never resets) so the
  // figure shown is genuinely lifetime, not just since the latest switch.
  const getTotalCoreBurned = useCallback(async () => {
    const marketplace = getReadContract();
    const legacyContracts = getLegacyReadContracts();
    const legacyBurnedResults = await Promise.all(
      legacyContracts.map((legacy) =>
        legacy.totalCoreBurned().catch((err) => {
          console.warn(`⚠️  Couldn't read legacy totalCoreBurned from ${legacy.target}, excluding it from the total:`, err.message);
          return 0n;
        })
      )
    );
    const currentBurned = await marketplace.totalCoreBurned();
    return legacyBurnedResults.reduce((sum, v) => sum + v, currentBurned);
  }, [getReadContract, getLegacyReadContracts]);

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
