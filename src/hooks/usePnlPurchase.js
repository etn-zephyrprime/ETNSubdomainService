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

  // purchasePnlPeriods() itself computes discount eligibility on-chain — this mirrors that same
  // logic up front (plus a couple of extra reads purely for a friendlier "why" in the UI) so the
  // price shown before signing always matches what the contract will actually charge.
  // `activatedDomainNode` (bytes32, or null to skip that path) is the specific domain node the
  // caller wants to claim the discount through, if any — see PnlStatementRequest.jsx for how
  // that's discovered from the wallet's owned/activated names.
  const getDiscountInfo = useCallback(async (address, activatedDomainNode) => {
    const contract = getReadContract();

    const [eligible, isAnnual, isWhitelisted, erevosSharesAddr] = await Promise.all([
      contract.isEligibleForDiscount(address),
      contract.isAnnualMember(address),
      contract.whitelisted(address),
      contract.erevosShares(),
    ]);

    if (isAnnual) return { discounted: true, reason: "annual member" };
    if (isWhitelisted) return { discounted: true, reason: "whitelisted" };
    if (eligible && erevosSharesAddr && erevosSharesAddr !== ethers.ZeroAddress) {
      // isEligibleForDiscount was true and neither annual membership nor whitelist explain it —
      // must be the ErevosShares holder path (the only other thing that function checks).
      return { discounted: true, reason: "Erevos Shares holder" };
    }

    if (activatedDomainNode && activatedDomainNode !== ethers.ZeroHash) {
      const ownsActivatedDomain = await contract.isActivatedDomainOwner(address, activatedDomainNode);
      if (ownsActivatedDomain) return { discounted: true, reason: "activated domain owner" };
    }

    return { discounted: false, reason: null };
  }, [getReadContract]);

  /** Pure client-side mirror of the contract's pricing (see PremiumSubscription.sol's
   * purchasePnlPeriods): if discounted, every period costs basePrice/2; otherwise the first
   * period costs basePrice and every subsequent period costs basePrice*2/3 (33% off, multi-buy).
   * Never authoritative — the contract always re-derives and enforces this itself — used only to
   * show a price preview and compute msg.value before submitting. */
  const computePeriodPrices = useCallback((basePriceWei, numPeriods, discounted) => {
    const discountedPrice = basePriceWei / 2n;
    const multiBuyPrice = (basePriceWei * 2n) / 3n;
    const prices = [];
    for (let i = 0; i < numPeriods; i++) {
      prices.push(discounted ? discountedPrice : i === 0 ? basePriceWei : multiBuyPrice);
    }
    return prices;
  }, []);

  /** `periods`: [{ periodType, year, periodEnd }] — periodEnd is a JS Date or unix-seconds bigint/
   * number for that period's exact end (see src/utils/periodTypes.js's computePeriodBoundaries).
   * `totalValueWei` must equal the sum computePeriodPrices() gives for these periods. */
  const purchasePnlPeriods = useCallback(async (trackedWallet, periods, activatedDomainNode, totalValueWei, signer) => {
    setLoading(true);
    setError(null);
    try {
      const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PremiumSubscriptionABI, signer);
      const node = activatedDomainNode || ethers.ZeroHash;
      const periodClaims = periods.map((p) => ({
        periodType: p.periodType,
        year: p.year,
        periodEnd: Math.floor((p.periodEnd instanceof Date ? p.periodEnd.getTime() : Number(p.periodEnd) * 1000) / 1000),
      }));
      // Fixed gas limit — same reasoning as usePremiumSubscription.js's subscribe(). Padded per
      // period since each one does its own event emission and validation; comfortable for the
      // MAX_PERIODS_PER_PURCHASE (12) ceiling.
      const gasLimit = 180000 + periods.length * 60000;
      const tx = await contract.purchasePnlPeriods(trackedWallet, periodClaims, node, { value: totalValueWei, gasLimit });
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
  // after it independently confirms the PnlPeriodPurchased events on-chain — never instantly, and
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
    getDiscountInfo,
    computePeriodPrices,
    purchasePnlPeriods,
    waitForStatementRequests,
    loading,
    error,
  };
}
