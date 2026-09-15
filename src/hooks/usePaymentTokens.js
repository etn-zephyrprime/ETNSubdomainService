import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, CANDIDATE_PAYMENT_TOKENS, RPC_URL } from "../config.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";
import ERC20ABI from "../abis/ERC20ABI.json";

// Always points directly at Electroneum RPC — same convention as the rest of this app's
// read-only hooks — for reads that shouldn't depend on whatever chain the connected wallet
// happens to be on.
const readOnlyProvider = new ethers.JsonRpcProvider(RPC_URL);

// Resolves CANDIDATE_PAYMENT_TOKENS (config.js's static, hand-maintained list) down to whichever
// of them are ACTUALLY whitelisted on the live marketplace contract right now — see that list's
// own comment for why a live check is required (whitelistedPaymentTokens is a plain on-chain
// mapping with no enumeration function, so this list can only ever be a set of candidates to
// verify, never treated as itself authoritative). A token the owner has de-whitelisted since this
// list was last updated silently disappears from every currency picker that uses this hook; it
// never shows a stale/broken option.
export function usePaymentTokens() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getAvailablePaymentTokens = useCallback(async () => {
    const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, readOnlyProvider);
    const whitelisted = await Promise.all(
      CANDIDATE_PAYMENT_TOKENS.map((t) => marketplace.whitelistedPaymentTokens(t.address))
    );
    return CANDIDATE_PAYMENT_TOKENS.filter((_, i) => whitelisted[i]);
  }, []);

  // Current allowance `ownerAddress` has granted the marketplace to spend `tokenAddress` — read
  // fresh every time (not cached), since a stale value here is exactly what would make
  // ensureAllowance below wrongly skip a real approve step.
  const getAllowance = useCallback(async (tokenAddress, ownerAddress) => {
    const token = new ethers.Contract(tokenAddress, ERC20ABI, readOnlyProvider);
    return token.allowance(ownerAddress, MARKETPLACE_ADDRESS);
  }, []);

  // Approves the marketplace to spend exactly `amount` of `tokenAddress` — a fresh approve() call
  // every time (not infinite/MaxUint256), so a buyer/activator never grants the contract standing
  // permission beyond the one purchase they're actually making right now. Some real ERC20s
  // (confirmed elsewhere in this ecosystem's own tokens — see CORE's transfer tax) revert on
  // approve() if an existing non-zero allowance is changed directly rather than reset to 0 first
  // (the same "safeApprove" footgun most ERC20 guides warn about) — resetting to 0 first is the
  // conservative move whenever the current allowance is already non-zero, and a harmless no-op
  // extra transaction otherwise.
  const approveToken = useCallback(async (tokenAddress, amount, signer) => {
    setLoading(true);
    setError(null);
    try {
      const token = new ethers.Contract(tokenAddress, ERC20ABI, signer);
      const signerAddress = await signer.getAddress();
      const currentAllowance = await token.allowance(signerAddress, MARKETPLACE_ADDRESS);
      if (currentAllowance > 0n && currentAllowance < amount) {
        const resetTx = await token.approve(MARKETPLACE_ADDRESS, 0n, { gasLimit: 80000 });
        await resetTx.wait();
      }
      const tx = await token.approve(MARKETPLACE_ADDRESS, amount, { gasLimit: 80000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Approval failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Token approval failed:", err);
      setError(err?.reason || err?.message || "Approval failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Convenience wrapper: approves `tokenAddress` for `amount` ONLY if the current allowance is
  // actually insufficient — skips a pointless extra approve tx (and its own confirm prompt) when
  // a prior purchase already left a sufficient allowance in place.
  const ensureAllowance = useCallback(async (tokenAddress, amount, signer) => {
    const signerAddress = await signer.getAddress();
    const currentAllowance = await getAllowance(tokenAddress, signerAddress);
    if (currentAllowance >= amount) return { success: true, skipped: true };
    return approveToken(tokenAddress, amount, signer);
  }, [getAllowance, approveToken]);

  return { getAvailablePaymentTokens, getAllowance, approveToken, ensureAllowance, loading, error };
}
