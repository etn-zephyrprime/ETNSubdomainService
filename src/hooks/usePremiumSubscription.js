import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { PREMIUM_SUBSCRIPTION_ADDRESS, RPC_URL } from "../config.js";
import PremiumSubscriptionABI from "../abis/PremiumSubscriptionABI.json";

// Fixed 30-day month / 365-day year, matching PremiumSubscription.sol's own SECONDS_PER_MONTH/
// SECONDS_PER_YEAR constants exactly (used here only for display estimates, never to compute what
// the contract will actually charge — that's always read live, see the getters below).
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

// Two independent membership tiers — see PremiumSubscription.sol's header comment. Monthly
// unlocks nothing on its own; ONLY annual grants the PnL discount (isEligibleForDiscount).
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

  const getAnnualMembershipPricePerYear = useCallback(async () => {
    const contract = getReadContract();
    return await contract.annualMembershipPricePerYear();
  }, [getReadContract]);

  const getMembershipExpiry = useCallback(async (address) => {
    const contract = getReadContract();
    return await contract.membershipExpiry(address);
  }, [getReadContract]);

  const getAnnualMembershipExpiry = useCallback(async (address) => {
    const contract = getReadContract();
    return await contract.annualMembershipExpiry(address);
  }, [getReadContract]);

  const getIsMembershipActive = useCallback(async (address) => {
    const contract = getReadContract();
    return await contract.isMembershipActive(address);
  }, [getReadContract]);

  const getIsAnnualMember = useCallback(async (address) => {
    const contract = getReadContract();
    return await contract.isAnnualMember(address);
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

  const subscribeAnnual = useCallback(async (numYears, priceWeiPerYear, signer) => {
    setLoading(true);
    setError(null);
    try {
      const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PremiumSubscriptionABI, signer);
      const value = priceWeiPerYear * BigInt(numYears);
      const tx = await contract.subscribeAnnual(numYears, { value, gasLimit: 150000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Annual subscription failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Annual membership subscribe failed:", err);
      setError(err?.reason || err?.message || "Annual subscription failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    isConfigured,
    getMembershipPricePerMonth,
    getAnnualMembershipPricePerYear,
    getMembershipExpiry,
    getAnnualMembershipExpiry,
    getIsMembershipActive,
    getIsAnnualMember,
    subscribe,
    subscribeAnnual,
    loading,
    error,
  };
}

export { SECONDS_PER_MONTH, SECONDS_PER_YEAR };
