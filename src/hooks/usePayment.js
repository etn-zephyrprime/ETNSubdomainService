import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { RPC_URL, MARKETPLACE_OWNER_ADDRESS } from "../config.js";
import { computeNodeForName } from "../utils/ens.js";
import { useAddressRecord } from "./useAddressRecord.js";
import ERC20ABI from "../abis/ERC20ABI.json";
import ERC721ABI from "../abis/ERC721ABI.json";

// Always points directly at Electroneum RPC — same convention as useReownWallet.js's
// readOnlyProvider — for read-only lookups (name resolution, token metadata) that shouldn't
// depend on whatever chain the connected wallet happens to be on.
const readOnlyProvider = new ethers.JsonRpcProvider(RPC_URL);

// Platform fee on ETN/token sends through the Pay flow — 0.3%, charged *on top* of the amount
// the sender enters (the recipient always gets the full amount they were sent; the sender pays
// amount + fee in total). No fee-splitting contract is deployed for this, so it's two separate
// transfers per send — the recipient's, then the fee's — rather than one atomic tx. Reuses the
// same treasury address the Marketplace contract's buyBackAndBurn is gated to (see config.js).
const FEE_BPS = 30n; // 30 / 10000 = 0.3%
const FEE_DENOMINATOR = 10000n;
const FEE_ADDRESS = MARKETPLACE_OWNER_ADDRESS;

function feeFor(valueWei) {
  return (valueWei * FEE_BPS) / FEE_DENOMINATOR;
}

/**
 * Pure helper for the UI to preview the fee before sending — "0.3% fee: X, total: Y" — without
 * duplicating the bignum math. Returns null for empty/invalid/zero input.
 */
export function calculateFeeDisplay(amountStr, decimals = 18) {
  if (!amountStr || Number(amountStr) <= 0) return null;
  try {
    const value = ethers.parseUnits(amountStr, decimals);
    const fee = feeFor(value);
    return {
      fee: ethers.formatUnits(fee, decimals),
      total: ethers.formatUnits(value + fee, decimals),
    };
  } catch {
    return null;
  }
}

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

  // Plain native-currency transfer, plus the 0.3% platform fee as a second transfer. gasLimit is
  // set explicitly on both (same reasoning as the rest of this app — this chain's
  // eth_estimateGas has proven unreliable) at a small buffer over the standard 21000 an
  // EOA-to-EOA send costs; a name resolved to a contract wallet could need more, but that's
  // outside what this flow targets.
  //
  // The recipient's transfer is sent first and is what determines success/failure — the fee
  // transfer is best-effort after that: the recipient already has their full amount regardless
  // of whether it succeeds, so a failure there is logged and surfaced via feeError rather than
  // thrown, instead of leaving the sender thinking their payment itself failed.
  const sendEtn = useCallback(async (toAddress, amountEtn, signer) => {
    setLoading(true);
    setError(null);
    try {
      const mainValue = ethers.parseEther(amountEtn);
      const tx = await signer.sendTransaction({ to: toAddress, value: mainValue, gasLimit: 30000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Send failed");

      let feeTxHash = null;
      let feeError = null;
      const feeValue = feeFor(mainValue);
      if (feeValue > 0n) {
        try {
          const feeTx = await signer.sendTransaction({ to: FEE_ADDRESS, value: feeValue, gasLimit: 30000 });
          await feeTx.wait();
          feeTxHash = feeTx.hash;
        } catch (err) {
          console.warn("Platform fee transfer failed (recipient still received their full amount):", err.message);
          feeError = err?.reason || err?.message || "Fee transfer failed";
        }
      }

      return { success: true, txHash: tx.hash, feeTxHash, feeError };
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

  // Same recipient-first, fee-best-effort structure as sendEtn above — two separate transfer()
  // calls (no fee-splitting contract deployed), where only the first one determines success.
  const sendToken = useCallback(async (tokenAddress, toAddress, amount, decimals, signer) => {
    setLoading(true);
    setError(null);
    try {
      const token = new ethers.Contract(tokenAddress, ERC20ABI, signer);
      const mainValue = ethers.parseUnits(amount, decimals);
      const tx = await token.transfer(toAddress, mainValue, { gasLimit: 100000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Token transfer failed");

      let feeTxHash = null;
      let feeError = null;
      const feeValue = feeFor(mainValue);
      if (feeValue > 0n) {
        try {
          const feeTx = await token.transfer(FEE_ADDRESS, feeValue, { gasLimit: 100000 });
          await feeTx.wait();
          feeTxHash = feeTx.hash;
        } catch (err) {
          console.warn("Platform fee transfer failed (recipient still received their full amount):", err.message);
          feeError = err?.reason || err?.message || "Fee transfer failed";
        }
      }

      return { success: true, txHash: tx.hash, feeTxHash, feeError };
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
