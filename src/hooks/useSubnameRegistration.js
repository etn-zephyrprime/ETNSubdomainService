import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, MARKETPLACE_DEPLOY_BLOCK, NAME_WRAPPER_ADDRESS, RPC_URL } from "../config.js";
import { computeSubnode, decodeFirstLabel } from "../utils/ens.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";
import NameWrapperABI from "../abis/NameWrapperABI.json";

// The public RPC's actual eth_getLogs block-range cap isn't fixed — it's tolerated ~8,300 blocks
// once, then started rejecting ranges over ~1,000 a couple of days later with no code change on
// our end (shared/load-balanced gateway, likely per-node or load-dependent policy). Querying the
// whole MARKETPLACE_DEPLOY_BLOCK-to-latest range in one shot is therefore not reliable long-term
// regardless of what size is hardcoded, so this chunks the scan and halves the window on a
// range-rejection instead of assuming any fixed size will keep working.
async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize = 1000, minChunkSize = 50) {
  const events = [];
  let start = fromBlock;

  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      const chunk = await contract.queryFilter(filter, start, end);
      events.push(...chunk);
      start = end + 1;
    } catch (err) {
      const message = err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || "";
      const isRangeError = /block range/i.test(message) || /range is too large/i.test(message);
      if (isRangeError && chunkSize > minChunkSize) {
        chunkSize = Math.max(minChunkSize, Math.floor(chunkSize / 2));
        continue; // retry the same `start` with the smaller window
      }
      throw err;
    }
  }

  return events;
}

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

  const getSubnamePricePerYear = useCallback(async (parentNode) => {
    const { marketplace } = getReadContracts();
    return await marketplace.subnamePricePerYear(parentNode);
  }, [getReadContracts]);

  const quoteSubname = useCallback(async (parentNode, duration) => {
    const { marketplace } = getReadContracts();
    return await marketplace.quoteSubname(parentNode, duration);
  }, [getReadContracts]);

  // A subname's expiry can never exceed its parent's — used to filter which duration presets are
  // even offerable for a given parent.
  const getParentExpiry = useCallback(async (parentNode) => {
    const { nameWrapper } = getReadContracts();
    const data = await nameWrapper.getData(parentNode);
    return data.expiry;
  }, [getReadContracts]);

  const checkSubnameAvailable = useCallback(async (parentNode, label) => {
    const { nameWrapper } = getReadContracts();
    const subNode = computeSubnode(parentNode, label);
    const owner = await nameWrapper.ownerOf(subNode);
    return owner === ethers.ZeroAddress;
  }, [getReadContracts]);

  // No indexer exists yet, so this scans SubnamePricePerYearSet events directly — cheap while the
  // marketplace is young (a few hundred blocks/events), scoped to MARKETPLACE_DEPLOY_BLOCK since
  // the public RPC rejects unscoped fromBlock queries ("Block range is too large"), and chunked
  // (see queryLogsChunked) since even a scoped range isn't reliably small enough on its own.
  // Labels come from NameWrapper.names(node) (the same on-chain source the contract itself
  // trusts), not from the event — SubnamePricePerYearSet only carries the hashed node.
  const getAvailableParentDomains = useCallback(async () => {
    const { marketplace, nameWrapper } = getReadContracts();

    const latestBlock = await marketplace.runner.getBlockNumber();
    const events = await queryLogsChunked(
      marketplace,
      marketplace.filters.SubnamePricePerYearSet(),
      MARKETPLACE_DEPLOY_BLOCK,
      latestBlock
    );

    // queryFilter returns events in ascending block order, so a plain overwrite keeps each
    // node's latest rate — including 0 for domains that turned subname sales back off.
    const latestPriceByNode = new Map();
    for (const event of events) {
      latestPriceByNode.set(event.args.parentNode, event.args.pricePerYear);
    }

    const activeNodes = [...latestPriceByNode.entries()].filter(([, pricePerYear]) => pricePerYear > 0n);

    const domains = await Promise.all(
      activeNodes.map(async ([node, pricePerYear]) => {
        const encoded = await nameWrapper.names(node);
        const label = decodeFirstLabel(encoded);
        return label ? { label, node, pricePerYear } : null;
      })
    );

    return domains.filter(Boolean);
  }, [getReadContracts]);

  const registerSubname = useCallback(async (parentNode, label, duration, priceWei, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      // Explicit gas limit — this chain's eth_estimateGas has proven unreliable elsewhere in
      // this app (registerName ran out of gas at its auto-estimated limit), so writes use a
      // fixed generous limit instead of trusting the wallet's estimate.
      const tx = await marketplace.registerSubname(parentNode, label, duration, { value: priceWei, gasLimit: 450000 });
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
    getSubnamePricePerYear,
    quoteSubname,
    getParentExpiry,
    checkSubnameAvailable,
    getAvailableParentDomains,
    registerSubname,
    loading,
    error,
  };
}
