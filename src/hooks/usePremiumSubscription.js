import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { PREMIUM_SUBSCRIPTION_ADDRESS, RPC_URL } from "../config.js";
import PremiumSubscriptionABI from "../abis/PremiumSubscriptionABI.json";

// Fixed 30-day month, matching PremiumSubscription.sol's own SECONDS_PER_MONTH constant exactly
// (used here only for display estimates, never to compute what the contract will actually charge
// — that's always read live, see getMembershipPricePerMonth below).
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

export function usePremiumSubscription() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const isConfigured = !!PREMIUM_SUBSCRIPTION_ADDRESS;

  const getReadContract = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PremiumSubscriptionABI, provider);
  }, []);

  // Never hardcode a price — always read the contract's own live, owner-adjustable value, same
  // convention as useSubnamePricing.js's getSubnamePricePerYear.
  const getMembershipPricePerMonth = useCallback(async () => {
    const contract = getReadContract();
    return await contract.membershipPricePerMonth();
  }, [getReadContract]);

  const getMembershipExpiry = useCallback(async (address) => {
    const contract = getReadContract();
    return await contract.membershipExpiry(address);
  }, [getReadContract]);

  const getIsMembershipActive = useCallback(async (address) => {
    const contract = getReadContract();
    return await contract.isMembershipActive(address);
  }, [getReadContract]);

  const subscribe = useCallback(async (numMonths, priceWeiPerMonth, signer) => {
    setLoading(true);
    setError(null);
    try {
      const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PremiumSubscriptionABI, signer);
      const value = priceWeiPerMonth * BigInt(numMonths);
      // Fixed gas limit — this chain's eth_estimateGas has proven unreliable elsewhere in this
      // app (see usePayment.js/useSubnamePricing.js), so writes use a generous fixed limit
      // instead of trusting the wallet's estimate. subscribe() only ever writes one mapping slot
      // and does at most one refund transfer, so this is comfortably padded, not tuned tight.
      const tx = await contract.subscribe(numMonths, { value, gasLimit: 150000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Subscription failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Membership subscribe failed:", err);
      setError(err?.reason || err?.message || "Subscription failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    isConfigured,
    getMembershipPricePerMonth,
    getMembershipExpiry,
    getIsMembershipActive,
    subscribe,
    loading,
    error,
  };
}

export { SECONDS_PER_MONTH };
