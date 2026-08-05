import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, MARKETPLACE_DEPLOY_BLOCK, NAME_WRAPPER_ADDRESS, RPC_URL } from "../config.js";
import { computeSubnode, decodeFirstLabel } from "../utils/ens.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";
import NameWrapperABI from "../abis/NameWrapperABI.json";

export function useSubnameRegistration() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getReadContracts = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return {
      marketplace: new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, provider),
      nameWrapper: new ethers.Contract(NAME_WRAPPER_ADDRESS, NameWrapperABI, provider),
    };
  }, []);

  const getSubnamePrice = useCallback(async (parentNode) => {
    const { marketplace } = getReadContracts();
    return await marketplace.subnamePrice(parentNode);
  }, [getReadContracts]);

  const checkSubnameAvailable = useCallback(async (parentNode, label) => {
    const { nameWrapper } = getReadContracts();
    const subNode = computeSubnode(parentNode, label);
    const owner = await nameWrapper.ownerOf(subNode);
    return owner === ethers.ZeroAddress;
  }, [getReadContracts]);

  // No indexer exists yet, so this scans SubnamePriceSet events directly — cheap while the
  // marketplace is young (a few hundred blocks/events), scoped to MARKETPLACE_DEPLOY_BLOCK since
  // the public RPC rejects unscoped fromBlock queries ("Block range is too large"). Labels come
  // from NameWrapper.names(node) (the same on-chain source the contract itself trusts), not from
  // the event — SubnamePriceSet only carries the hashed node.
  const getAvailableParentDomains = useCallback(async () => {
    const { marketplace, nameWrapper } = getReadContracts();

    const events = await marketplace.queryFilter(
      marketplace.filters.SubnamePriceSet(),
      MARKETPLACE_DEPLOY_BLOCK,
      "latest"
    );

    // queryFilter returns events in ascending block order, so a plain overwrite keeps each
    // node's latest price — including 0 for domains that turned subname sales back off.
    const latestPriceByNode = new Map();
    for (const event of events) {
      latestPriceByNode.set(event.args.parentNode, event.args.price);
    }

    const activeNodes = [...latestPriceByNode.entries()].filter(([, price]) => price > 0n);

    const domains = await Promise.all(
      activeNodes.map(async ([node, price]) => {
        const encoded = await nameWrapper.names(node);
        const label = decodeFirstLabel(encoded);
        return label ? { label, node, price } : null;
      })
    );

    return domains.filter(Boolean);
  }, [getReadContracts]);

  const registerSubname = useCallback(async (parentNode, label, priceWei, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const tx = await marketplace.registerSubname(parentNode, label, { value: priceWei });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Registration failed");

      const subNode = computeSubnode(parentNode, label);
      return { success: true, txHash: tx.hash, subNode };
    } catch (err) {
      console.error("Subname registration failed:", err);
      setError(err?.reason || err?.message || "Registration failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    getSubnamePrice,
    checkSubnameAvailable,
    getAvailableParentDomains,
    registerSubname,
    loading,
    error,
  };
}
