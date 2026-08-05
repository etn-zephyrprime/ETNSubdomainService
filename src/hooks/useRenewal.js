import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, BASE_REGISTRAR_ADDRESS, NAME_WRAPPER_ADDRESS, RPC_URL } from "../config.js";
import { computeTokenId, computeNode } from "../utils/ens.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";
import BaseRegistrarABI from "../abis/BaseRegistrarABI.json";
import NameWrapperABI from "../abis/NameWrapperABI.json";

export function useRenewal() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getReadContracts = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return {
      marketplace: new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, provider),
      baseRegistrar: new ethers.Contract(BASE_REGISTRAR_ADDRESS, BaseRegistrarABI, provider),
      nameWrapper: new ethers.Contract(NAME_WRAPPER_ADDRESS, NameWrapperABI, provider),
    };
  }, []);

  // The raw registrar's expiry (not NameWrapper's wrapped+grace-period value) — this is what
  // actually determines whether a name needs renewing.
  const getCurrentExpiry = useCallback(async (label) => {
    try {
      const { baseRegistrar } = getReadContracts();
      const tokenId = computeTokenId(label);
      return await baseRegistrar.nameExpires(tokenId);
    } catch (err) {
      console.error("Failed to fetch current expiry:", err);
      throw err;
    }
  }, [getReadContracts]);

  // registerName() always wraps, so the raw ERC721 lives in NameWrapper's own custody once
  // registered — real ownership must be read from NameWrapper.ownerOf(node), not
  // BaseRegistrar.ownerOf(tokenId) (that would just return NameWrapper's address).
  const getOwner = useCallback(async (label) => {
    try {
      const { nameWrapper } = getReadContracts();
      const node = computeNode(label);
      return await nameWrapper.ownerOf(node);
    } catch (err) {
      console.error("Failed to fetch name owner:", err);
      throw err;
    }
  }, [getReadContracts]);

  const quoteRenewal = useCallback(async (label, duration) => {
    try {
      const { marketplace } = getReadContracts();
      const [basePrice, brokerageFee, totalPrice] = await marketplace.quoteRenewal(label, duration);
      return { basePrice, brokerageFee, totalPrice };
    } catch (err) {
      console.error("Failed to fetch renewal price:", err);
      throw err;
    }
  }, [getReadContracts]);

  // Renewal is permissionless (matches the real registrar's own renew()) — any connected
  // wallet can renew any name, not just its owner.
  const renewName = useCallback(async (label, duration, referrer, totalPrice, signer) => {
    setLoading(true);
    setError(null);

    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const tx = await marketplace.renewName(label, duration, referrer, { value: totalPrice });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Renewal failed");

      return { success: true, txHash: tx.hash, name: `${label}.etn` };
    } catch (err) {
      console.error("Renewal failed:", err);
      setError(err?.reason || err?.message || "Renewal failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    getCurrentExpiry,
    getOwner,
    quoteRenewal,
    renewName,
    loading,
    error,
  };
}
