import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, NAME_WRAPPER_ADDRESS, REGISTRAR_CONTROLLER_ADDRESS, RPC_URL } from "../config.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";
import NameWrapperABI from "../abis/NameWrapperABI.json";
import ETHRegistrarControllerABI from "../abis/ETHRegistrarControllerABI.json";

export function useSubnamePricing() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getReadContracts = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return {
      marketplace: new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, provider),
      nameWrapper: new ethers.Contract(NAME_WRAPPER_ADDRESS, NameWrapperABI, provider),
      controller: new ethers.Contract(REGISTRAR_CONTROLLER_ADDRESS, ETHRegistrarControllerABI, provider),
    };
  }, []);

  const getSubnamePrice = useCallback(async (parentNode) => {
    const { marketplace } = getReadContracts();
    return await marketplace.subnamePrice(parentNode);
  }, [getReadContracts]);

  const isDomainActivated = useCallback(async (node) => {
    const { marketplace } = getReadContracts();
    return await marketplace.domainActivated(node);
  }, [getReadContracts]);

  const isMarketplaceApproved = useCallback(async (ownerAddress) => {
    const { nameWrapper } = getReadContracts();
    return await nameWrapper.isApprovedForAll(ownerAddress, MARKETPLACE_ADDRESS);
  }, [getReadContracts]);

  const approveMarketplace = useCallback(async (signer) => {
    setLoading(true);
    setError(null);
    try {
      const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NameWrapperABI, signer);
      // Explicit gas limit — this chain's eth_estimateGas has proven unreliable elsewhere in
      // this app, so writes use a fixed generous limit instead of trusting the wallet's estimate.
      const tx = await nameWrapper.setApprovalForAll(MARKETPLACE_ADDRESS, true, { gasLimit: 120000 });
      await tx.wait();
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Marketplace approval failed:", err);
      setError(err?.reason || err?.message || "Approval failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Replicates the contract's own _activationFee math (brokerageBps of what the registrar would
  // charge today to register this name for however much time is actually left on it, read from
  // NameWrapper) plus a 5% buffer — mirrors scripts/testActivateDomain2_remix.ts's estimate,
  // since a few seconds pass before the tx mines. Excess is always refunded on-chain regardless.
  const getActivationFee = useCallback(async (label, node) => {
    const { marketplace, nameWrapper, controller } = getReadContracts();
    const data = await nameWrapper.getData(node);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const remaining = data.expiry - BigInt(nowSeconds);
    if (remaining <= 0n) throw new Error("Name has expired");

    const price = await controller.rentPrice(label, remaining);
    const basePrice = price.base + price.premium;
    const brokerageBps = await marketplace.brokerageBps();
    return (basePrice * brokerageBps / 10000n) * 105n / 100n;
  }, [getReadContracts]);

  const activateDomain = useCallback(async (node, label, fee, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const tx = await marketplace.activateDomain(node, label, { value: fee, gasLimit: 350000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Activation failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Domain activation failed:", err);
      setError(err?.reason || err?.message || "Activation failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const setSubnamePrice = useCallback(async (node, priceWei, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const tx = await marketplace.setSubnamePrice(node, priceWei, { gasLimit: 180000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Setting price failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Setting subname price failed:", err);
      setError(err?.reason || err?.message || "Setting price failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    getSubnamePrice,
    isDomainActivated,
    isMarketplaceApproved,
    approveMarketplace,
    getActivationFee,
    activateDomain,
    setSubnamePrice,
    loading,
    error,
  };
}
