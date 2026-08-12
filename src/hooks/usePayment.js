import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { RPC_URL } from "../config.js";
import { computeNodeForName } from "../utils/ens.js";
import { useAddressRecord } from "./useAddressRecord.js";
import ERC20ABI from "../abis/ERC20ABI.json";
import ERC721ABI from "../abis/ERC721ABI.json";

// Always points directly at Electroneum RPC — same convention as useReownWallet.js's
// readOnlyProvider — for read-only lookups (name resolution, token metadata) that shouldn't
// depend on whatever chain the connected wallet happens to be on.
const readOnlyProvider = new ethers.JsonRpcProvider(RPC_URL);

// Backs the "Pay" flow — sending ETN, an ERC-20 token, or an ERC-721 NFT to a .etn name instead
// of a raw address. Resolution reuses useAddressRecord's addr() read, just against a node
// computed from an arbitrary (possibly multi-label) name rather than a caller-supplied one.
export function usePayment() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { getResolvedAddress } = useAddressRecord();

  // Resolves "alice", "alice.etn", "shop.alice", or "shop.alice.etn" to the address that name's
  // forward record currently points at. Throws with a message safe to show directly in the UI.
  const resolveName = useCallback(async (rawName) => {
    const name = (rawName || "").trim().toLowerCase();
    if (!name) throw new Error("Enter a name");

    const node = computeNodeForName(name);
    if (!node) throw new Error("Enter a valid name");

    const address = await getResolvedAddress(node);
    if (!address) {
      throw new Error(`"${name.replace(/\.etn$/, "")}.etn" doesn't resolve to a wallet address yet`);
    }
    return address;
  }, [getResolvedAddress]);

  // Plain native-currency transfer. gasLimit is set explicitly (same reasoning as the rest of
  // this app — this chain's eth_estimateGas has proven unreliable) at a small buffer over the
  // standard 21000 an EOA-to-EOA send costs; a name resolved to a contract wallet could need
  // more, but that's outside what this flow targets.
  const sendEtn = useCallback(async (toAddress, amountEtn, signer) => {
    setLoading(true);
    setError(null);
    try {
      const tx = await signer.sendTransaction({
        to: toAddress,
        value: ethers.parseEther(amountEtn),
        gasLimit: 30000,
      });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Send failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("ETN send failed:", err);
      setError(err?.reason || err?.message || "Send failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Symbol + decimals for whatever ERC-20 contract the user pastes in — symbol() isn't part of
  // the strict ERC-20 standard, so a missing implementation falls back to a generic label rather
  // than failing the whole lookup.
  const getTokenInfo = useCallback(async (tokenAddress) => {
    const token = new ethers.Contract(tokenAddress, ERC20ABI, readOnlyProvider);
    const [symbol, decimals] = await Promise.all([
      token.symbol().catch(() => "TOKEN"),
      token.decimals(),
    ]);
    return { symbol, decimals: Number(decimals) };
  }, []);

  const sendToken = useCallback(async (tokenAddress, toAddress, amount, decimals, signer) => {
    setLoading(true);
    setError(null);
    try {
      const token = new ethers.Contract(tokenAddress, ERC20ABI, signer);
      const value = ethers.parseUnits(amount, decimals);
      const tx = await token.transfer(toAddress, value, { gasLimit: 100000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Token transfer failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Token transfer failed:", err);
      setError(err?.reason || err?.message || "Token transfer failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Current owner of an NFT — used to confirm the connected wallet actually holds it before
  // attempting the transfer, so a mistyped token id fails fast with a clear message instead of a
  // generic revert.
  const getNftOwner = useCallback(async (nftAddress, tokenId) => {
    const nft = new ethers.Contract(nftAddress, ERC721ABI, readOnlyProvider);
    return nft.ownerOf(tokenId);
  }, []);

  // Standard ERC-721 transfer only — this doesn't attempt to detect/support ERC-1155 contracts.
  const sendNft = useCallback(async (nftAddress, toAddress, tokenId, fromAddress, signer) => {
    setLoading(true);
    setError(null);
    try {
      const nft = new ethers.Contract(nftAddress, ERC721ABI, signer);
      const tx = await nft.safeTransferFrom(fromAddress, toAddress, tokenId, { gasLimit: 200000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("NFT transfer failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("NFT transfer failed:", err);
      setError(err?.reason || err?.message || "NFT transfer failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    resolveName,
    sendEtn,
    getTokenInfo,
    sendToken,
    getNftOwner,
    sendNft,
    loading,
    error,
  };
}
