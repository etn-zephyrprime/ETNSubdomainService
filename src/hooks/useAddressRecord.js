import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { ENS_REGISTRY_ADDRESS, RPC_URL } from "../config.js";
import EnsRegistryABI from "../abis/EnsRegistryABI.json";
import PublicResolverABI from "../abis/PublicResolverABI.json";

// Forward address record — the opposite direction from useReverseRecord.js (which sets what
// name a wallet shows as its own). This is "what address does this name point to", read/written
// via addr(node)/setAddr(node, addr) on whatever resolver ENSRegistry.resolver(node) says is
// actually assigned to that name — read fresh each time rather than assuming a fixed resolver
// address, so this keeps working if a name's resolver ever changes.
export function useAddressRecord() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getResolverFor = useCallback(async (node, providerOrSigner) => {
    const registry = new ethers.Contract(ENS_REGISTRY_ADDRESS, EnsRegistryABI, providerOrSigner);
    const resolverAddress = await registry.resolver(node);
    if (resolverAddress === ethers.ZeroAddress) return null;
    return resolverAddress;
  }, []);

  // Reads the address a name currently resolves to, or null if no resolver/record is set.
  const getResolvedAddress = useCallback(async (node) => {
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const resolverAddress = await getResolverFor(node, provider);
      if (!resolverAddress) return null;

      const resolver = new ethers.Contract(resolverAddress, PublicResolverABI, provider);
      const addr = await resolver.addr(node);
      return addr === ethers.ZeroAddress ? null : addr;
    } catch (err) {
      console.error("Failed to fetch resolved address:", err);
      throw err;
    }
  }, [getResolverFor]);

  // Points a name at an address — pass the connected wallet's own signer and, typically,
  // wallet.account itself (assigning the name to your own wallet). The resolver's own
  // authorization (checked on-chain, not here) requires the caller to be the name's real owner —
  // NameWrapper-aware for wrapped names, so this works whether or not the name happens to be
  // wrapped.
  const setAddr = useCallback(async (node, addr, signer) => {
    setLoading(true);
    setError(null);
    try {
      const resolverAddress = await getResolverFor(node, signer);
      if (!resolverAddress) {
        throw new Error("This name has no resolver set — nothing to point at an address yet.");
      }

      const resolver = new ethers.Contract(resolverAddress, PublicResolverABI, signer);
      // Explicit gas limit — this chain's eth_estimateGas has proven unreliable elsewhere in
      // this app, so writes use a fixed generous limit instead of trusting the wallet's estimate.
      const tx = await resolver.setAddr(node, addr, { gasLimit: 120000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Setting address failed");

      return { success: true, txHash: tx.hash, addr };
    } catch (err) {
      console.error("setAddr failed:", err);
      setError(err?.reason || err?.message || "Setting address failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, [getResolverFor]);

  return {
    getResolvedAddress,
    setAddr,
    loading,
    error,
  };
}
