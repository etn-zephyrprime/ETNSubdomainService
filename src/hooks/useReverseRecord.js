import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { REVERSE_REGISTRAR_ADDRESS, RPC_URL } from "../config.js";
import ReverseRegistrarABI from "../abis/ReverseRegistrarABI.json";
import NameResolverABI from "../abis/NameResolverABI.json";

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

  // Reads the primary name currently set for an address, or null if none is set. Reads straight
  // off the registrar's own defaultResolver — the same one setName()/setNameForAddr() write
  // through — so this reflects exactly what those calls would have set.
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
      return name || null;
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
