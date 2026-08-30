import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { PREMIUM_SUBSCRIPTION_ADDRESS, RPC_URL, PNL_BACKEND_URL } from "../config.js";
import PremiumSubscriptionABI from "../abis/PremiumSubscriptionABI.json";

export function usePnlPurchase() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const isConfigured = !!PREMIUM_SUBSCRIPTION_ADDRESS;

  const getReadContract = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PremiumSubscriptionABI, provider);
  }, []);

  const getPnlPricePerPeriod = useCallback(async () => {
    const contract = getReadContract();
    return await contract.pnlPricePerPeriod();
  }, [getReadContract]);

  // purchasePnlPeriods() itself computes whether msg.sender has an active membership and charges
  // 0 in that case — this just reads that same live state up front so the UI can show "Free
  // (active member)" instead of a price before the user ever signs anything.
  const getIsFreeForCaller = useCallback(async (address) => {
    const contract = getReadContract();
    return await contract.isMembershipActive(address);
  }, [getReadContract]);

  const purchasePnlPeriods = useCallback(async (trackedWallet, numPeriods, requiredValueWei, signer) => {
    setLoading(true);
    setError(null);
    try {
      const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PremiumSubscriptionABI, signer);
      // Fixed gas limit — same reasoning as usePremiumSubscription.js's subscribe(). Padded
      // higher than subscribe() since this writes no persistent state on the happy path (funds
      // just sit escrowed) but still needs headroom for the refund-of-excess transfer.
      const tx = await contract.purchasePnlPeriods(trackedWallet, numPeriods, { value: requiredValueWei, gasLimit: 150000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Purchase failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("PnL period purchase failed:", err);
      setError(err?.reason || err?.message || "Purchase failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // The backend's watcher (premiumSubscriptionWatcher.js) creates statement_requests rows only
  // after it independently confirms the PnlPeriodsPurchased event on-chain — never instantly, and
  // never from this frontend telling it "I paid". Polls /api/pnl/statement/by-tx/:txHash until
  // that watcher has caught up (its own poll interval, default 60s) or `maxAttempts` is reached.
  const waitForStatementRequests = useCallback(async (txHash, expectedCount, { maxAttempts = 40, intervalMs = 3000 } = {}) => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(`${PNL_BACKEND_URL}/api/pnl/statement/by-tx/${txHash}`);
        if (res.ok) {
          const requests = await res.json();
          if (Array.isArray(requests) && requests.length >= expectedCount) return requests;
        }
      } catch (err) {
        console.warn("Polling for statement requests failed, retrying:", err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error("Timed out waiting for the backend to record this purchase — it may still be catching up. Check back on this page shortly, or look up your purchase by transaction hash.");
  }, []);

  return {
    isConfigured,
    getPnlPricePerPeriod,
    getIsFreeForCaller,
    purchasePnlPeriods,
    waitForStatementRequests,
    loading,
    error,
  };
}
