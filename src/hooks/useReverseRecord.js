import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { REVERSE_REGISTRAR_ADDRESS, ENS_REGISTRY_ADDRESS, RPC_URL } from "../config.js";
import ReverseRegistrarABI from "../abis/ReverseRegistrarABI.json";
import NameResolverABI from "../abis/NameResolverABI.json";
import EnsRegistryABI from "../abis/EnsRegistryABI.json";
import PublicResolverABI from "../abis/PublicResolverABI.json";

// Confirms a reverse-claimed name's FORWARD resolution actually points back to `addr` before
// getPrimaryName below trusts it. Confirmed live (2026-09-18) this matters, not just theoretical:
// a wallet's reverse record can keep claiming a name it's since transferred away indefinitely —
// transferring a name doesn't clear the OLD owner's own reverse pointer unless they explicitly do
// so, and nothing in ENS enforces the two stay in sync. Mirrors useAddressRecord.js's own
// getResolvedAddress rather than importing it directly — composing two independent hooks'
// internals through React's own hook system would be more awkward than this small, self-contained
// duplicate (same "just duplicate the small constant/lookup" convention this app already uses for
// ENS_REGISTRY_ADDRESS/REVERSE_REGISTRAR_ADDRESS existing independently per file). Never throws —
// any failure (no resolver set for the name, a bad call) is treated as "can't verify" -> false,
// never "assume it's fine".
async function verifyPrimaryName(provider, name, addr) {
  try {
    const node = ethers.namehash(name);
    const registry = new ethers.Contract(ENS_REGISTRY_ADDRESS, EnsRegistryABI, provider);
    const resolverAddress = await registry.resolver(node);
    if (resolverAddress === ethers.ZeroAddress) return false;
    const resolver = new ethers.Contract(resolverAddress, PublicResolverABI, provider);
    const forwardAddr = await resolver.addr(node);
    return String(forwardAddr).toLowerCase() === String(addr).toLowerCase();
  } catch (err) {
    console.error("Failed to verify primary name:", err);
    return false;
  }
}

// Primary ("reverse") name — the name a wallet shows as its own, the opposite direction from
// resolving a name to an address. Set via ReverseRegistrar.setName (self) or setNameForAddr
// (an authorised caller setting it for someone/something else, e.g. a contract address), both of
// which are otherwise identical to the real ENS ReverseRegistrar this chain's fork ships.
export function useReverseRecord() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const requireAddress = useCallback(() => {
    if (!REVERSE_REGISTRAR_ADDRESS) {
      throw new Error(
        "ReverseRegistrar address isn't configured for this deployment " +
        "(set VITE_REVERSE_REGISTRAR_ADDRESS)."
      );
    }
    return REVERSE_REGISTRAR_ADDRESS;
  }, []);

  const getReadContract = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Contract(requireAddress(), ReverseRegistrarABI, provider);
  }, [requireAddress]);

  // The deterministic reverse node for an address (namehash of "<addr, no 0x, lowercase>.addr.reverse").
  // Always resolves to something, whether or not that address has ever actually claimed/set it.
  const getReverseNode = useCallback(async (addr) => {
    const reverseRegistrar = getReadContract();
    return await reverseRegistrar.node(addr);
  }, [getReadContract]);

  // Reads the primary name currently set for an address, or null if none is set/verified. Reads
  // straight off the registrar's own defaultResolver — the same one setName()/setNameForAddr()
  // write through — so this reflects exactly what those calls would have set. Verified via
  // verifyPrimaryName above before being trusted — a reverse record alone isn't reliable (see
  // that function's own comment for why).
  const getPrimaryName = useCallback(async (addr) => {
    try {
      const reverseRegistrar = getReadContract();
      const [node, resolverAddr] = await Promise.all([
        reverseRegistrar.node(addr),
        reverseRegistrar.defaultResolver(),
      ]);
      if (resolverAddr === ethers.ZeroAddress) return null;

      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const resolver = new ethers.Contract(resolverAddr, NameResolverABI, provider);
      const name = await resolver.name(node);
      if (!name) return null;
      return (await verifyPrimaryName(provider, name, addr)) ? name : null;
    } catch (err) {
      console.error("Failed to fetch primary name:", err);
      throw err;
    }
  }, [getReadContract]);

  // Sets the caller's own primary name, e.g. "alice.etn" or "hi.alice.etn" for a subname —
  // pass the connected wallet's own signer. Matches ReverseRegistrar.setName(): resolves through
  // the registrar's own defaultResolver, no separate resolver address needed.
  const setName = useCallback(async (name, signer) => {
    setLoading(true);
    setError(null);
    try {
      const reverseRegistrar = new ethers.Contract(requireAddress(), ReverseRegistrarABI, signer);
      // Explicit gas limit — this chain's eth_estimateGas has proven unreliable elsewhere in this
      // app, so writes use a fixed generous limit instead of trusting the wallet's estimate.
      const tx = await reverseRegistrar.setName(name, { gasLimit: 200000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Setting primary name failed");

      return { success: true, txHash: tx.hash, name };
    } catch (err) {
      console.error("setName failed:", err);
      setError(err?.reason || err?.message || "Setting primary name failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, [requireAddress]);

  // Sets the primary name for a different address than the caller — only succeeds if the
  // signer is "authorised" for addr under the registrar's own rules (addr itself, an approved
  // operator, or — for contract addresses — their Ownable owner). Useful for e.g. setting the
  // reverse name of a smart-contract wallet from its owning EOA.
  const setNameForAddr = useCallback(async (addr, owner, resolverAddress, name, signer) => {
    setLoading(true);
    setError(null);
    try {
      const reverseRegistrar = new ethers.Contract(requireAddress(), ReverseRegistrarABI, signer);
      const tx = await reverseRegistrar.setNameForAddr(addr, owner, resolverAddress, name, { gasLimit: 220000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Setting primary name failed");

      return { success: true, txHash: tx.hash, name };
    } catch (err) {
      console.error("setNameForAddr failed:", err);
      setError(err?.reason || err?.message || "Setting primary name failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, [requireAddress]);

  return {
    getReverseNode,
    getPrimaryName,
    setName,
    setNameForAddr,
    loading,
    error,
  };
}
