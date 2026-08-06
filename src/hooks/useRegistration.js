import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, REGISTRAR_CONTROLLER_ADDRESS, RPC_URL } from "../config.js";
import { computeNode } from "../utils/ens.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";
import ETHRegistrarControllerABI from "../abis/ETHRegistrarControllerABI.json";

const SESSION_STORAGE_PREFIX = "etn-pending-registration:";

export function useRegistration() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getReadContracts = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return {
      marketplace: new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, provider),
      controller: new ethers.Contract(REGISTRAR_CONTROLLER_ADDRESS, ETHRegistrarControllerABI, provider),
    };
  }, []);

  // Fetch registration price from the marketplace (registrar's own price + brokerage fee).
  const quoteRegistration = useCallback(async (label, duration) => {
    try {
      const { marketplace } = getReadContracts();
      const [basePrice, brokerageFee, totalPrice] = await marketplace.quoteRegistration(label, duration);
      return { basePrice, brokerageFee, totalPrice };
    } catch (err) {
      console.error("Failed to fetch registration price:", err);
      throw err;
    }
  }, [getReadContracts]);

  // Builds the exact commitment the buyer must commit() on the real registrar before calling
  // registerName — via the marketplace's own computeCommitment, so it's guaranteed to match
  // (owner is forced to the marketplace contract internally, not something we set here).
  const computeCommitment = useCallback(async (label, duration, secret, referrer) => {
    try {
      const { marketplace } = getReadContracts();
      return await marketplace.computeCommitment(label, duration, secret, referrer);
    } catch (err) {
      console.error("Failed to compute commitment:", err);
      throw err;
    }
  }, [getReadContracts]);

  const getMinCommitmentAge = useCallback(async () => {
    const { controller } = getReadContracts();
    return await controller.minCommitmentAge();
  }, [getReadContracts]);

  const getMaxCommitmentAge = useCallback(async () => {
    const { controller } = getReadContracts();
    return await controller.maxCommitmentAge();
  }, [getReadContracts]);

  // Submits commit() directly on the real ETHRegistrarController — a separate transaction
  // against a separate contract from the eventual registerName() call.
  const commitRegistration = useCallback(async (commitment, signer) => {
    setLoading(true);
    setError(null);
    try {
      const controller = new ethers.Contract(REGISTRAR_CONTROLLER_ADDRESS, ETHRegistrarControllerABI, signer);
      // Explicit gas limit — this chain's eth_estimateGas has proven unreliable (an earlier
      // registerName() call ran out of gas at its auto-estimated limit despite prior successful
      // calls using meaningfully less), so every write here sets its own generous fixed limit
      // rather than trusting the wallet's estimate.
      const tx = await controller.commit(commitment, { gasLimit: 120000 });
      const receipt = await tx.wait();
      return { success: true, txHash: tx.hash, blockTimestamp: (await receipt.getBlock())?.timestamp ?? null };
    } catch (err) {
      console.error("Commit failed:", err);
      setError(err?.reason || err?.message || "Commit failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Persists the in-flight commitment so a page reload during the minCommitmentAge wait doesn't
  // lose the secret needed to complete registration.
  const savePendingCommitment = useCallback((label, data) => {
    sessionStorage.setItem(SESSION_STORAGE_PREFIX + label, JSON.stringify(data));
  }, []);

  const loadPendingCommitment = useCallback((label) => {
    const raw = sessionStorage.getItem(SESSION_STORAGE_PREFIX + label);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, []);

  const clearPendingCommitment = useCallback((label) => {
    sessionStorage.removeItem(SESSION_STORAGE_PREFIX + label);
  }, []);

  // Registers + wraps the name via the marketplace. expectedNode is caller-computed
  // (ethers.namehash-equivalent, see utils/ens.js) and passed straight through — NameRegistered
  // doesn't emit the node, so there's nothing to parse back out of the receipt for it.
  const registerName = useCallback(async (label, duration, secret, referrer, wrappedOwner, totalPrice, signer) => {
    setLoading(true);
    setError(null);

    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const expectedNode = computeNode(label);

      const tx = await marketplace.registerName(
        label,
        duration,
        secret,
        referrer,
        wrappedOwner,
        0, // ownerControlledFuses — no restrictions by default
        expectedNode,
        { value: totalPrice, gasLimit: 600000 }
      );

      const receipt = await tx.wait();
      if (!receipt) throw new Error("Registration failed");

      clearPendingCommitment(label);

      return {
        success: true,
        txHash: tx.hash,
        name: `${label}.etn`,
        node: expectedNode,
      };
    } catch (err) {
      console.error("Registration failed:", err);
      setError(err?.reason || err?.message || "Registration failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, [clearPendingCommitment]);

  return {
    quoteRegistration,
    computeCommitment,
    getMinCommitmentAge,
    getMaxCommitmentAge,
    commitRegistration,
    registerName,
    savePendingCommitment,
    loadPendingCommitment,
    clearPendingCommitment,
    loading,
    error,
  };
}
