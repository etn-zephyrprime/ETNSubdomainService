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

  // purchasePnlPeriods() itself computes free eligibility on-chain and charges 0 when it applies —
  // this mirrors that same logic up front (plus a couple of extra reads purely for a friendlier
  // "why" in the UI) so the price shown before signing always matches what the contract will
  // actually charge. `activatedDomainNode` (bytes32, or null to skip that path) is the specific
  // domain node the caller wants to claim free access through, if any — see
  // PnlStatementRequest.jsx for how that's discovered from the wallet's owned/activated names.
  const getFreeAccessInfo = useCallback(async (address, activatedDomainNode) => {
    const contract = getReadContract();

    const [eligible, isMember, isWhitelisted, erevosSharesAddr] = await Promise.all([
      contract.isEligibleForFreeAccess(address),
      contract.isMembershipActive(address),
      contract.whitelisted(address),
      contract.erevosShares(),
    ]);

    if (isMember) return { free: true, reason: "active membership" };
    if (isWhitelisted) return { free: true, reason: "whitelisted" };
    if (eligible && erevosSharesAddr && erevosSharesAddr !== ethers.ZeroAddress) {
      // isEligibleForFreeAccess was true and neither membership nor whitelist explain it — must
      // be the ErevosShares holder path (the only other thing that function checks).
      return { free: true, reason: "Erevos Shares holder" };
    }

    if (activatedDomainNode && activatedDomainNode !== ethers.ZeroHash) {
      const ownsActivatedDomain = await contract.isActivatedDomainOwner(address, activatedDomainNode);
      if (ownsActivatedDomain) return { free: true, reason: "activated domain owner" };
    }

    return { free: false, reason: null };
  }, [getReadContract]);

  const purchasePnlPeriods = useCallback(async (trackedWallet, numPeriods, activatedDomainNode, requiredValueWei, signer) => {
    setLoading(true);
    setError(null);
    try {
      const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PremiumSubscriptionABI, signer);
      const node = activatedDomainNode || ethers.ZeroHash;
      // Fixed gas limit — same reasoning as usePremiumSubscription.js's subscribe(). Padded
      // higher than subscribe() since this writes no persistent state on the happy path (funds
      // just sit escrowed) but still needs headroom for the refund-of-excess transfer plus the
      // extra cross-contract reads the activated-domain free-access check does.
      const tx = await contract.purchasePnlPeriods(trackedWallet, numPeriods, node, { value: requiredValueWei, gasLimit: 220000 });
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
    getFreeAccessInfo,
    purchasePnlPeriods,
    waitForStatementRequests,
    loading,
    error,
  };
}
