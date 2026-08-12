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
// amount + fee in total). No fee-splitting contract is deployed for this (this repo has no
// Solidity/Hardhat setup to build/deploy one), so it's two separate transfers per send rather
// than one atomic tx — and the fee is sent FIRST, deliberately: if it went second, a sender could
// let the recipient's transfer through and then just cancel/reject the fee prompt in their
// wallet, keeping the fee for free. Fee-first flips the incentive — skipping the fee now means
// cancelling the payment they actually want, which defeats their own purpose. The one edge case
// this doesn't fully cover is the fee succeeding and the *main* transfer then failing for
// unrelated reasons (e.g. a dropped tx) — sendEtn/sendToken below surface that case with the fee
// tx hash included in the thrown error, rather than silently losing track of it. Reuses the same
// treasury address the Marketplace contract's buyBackAndBurn is gated to (see config.js).
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

  // Plain native-currency transfer, plus the 0.3% platform fee sent FIRST as its own transfer —
  // see the fee-ordering comment above. gasLimit is set explicitly on both (same reasoning as the
  // rest of this app — this chain's eth_estimateGas has proven unreliable) at a small buffer over
  // the standard 21000 an EOA-to-EOA send costs; a name resolved to a contract wallet could need
  // more, but that's outside what this flow targets.
  const sendEtn = useCallback(async (toAddress, amountEtn, signer) => {
    setLoading(true);
    setError(null);
    let feeTxHash = null;
    try {
      const mainValue = ethers.parseEther(amountEtn);
      const feeValue = feeFor(mainValue);

      if (feeValue > 0n) {
        const feeTx = await signer.sendTransaction({ to: FEE_ADDRESS, value: feeValue, gasLimit: 30000 });
        const feeReceipt = await feeTx.wait();
        if (!feeReceipt) throw new Error("Platform fee payment failed");
        feeTxHash = feeTx.hash;
      }

      const tx = await signer.sendTransaction({ to: toAddress, value: mainValue, gasLimit: 30000 });
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error(
          feeTxHash
            ? `The platform fee was sent (tx ${feeTxHash}) but the payment to the recipient failed. Contact support with that tx hash.`
            : "Send failed"
        );
      }

      return { success: true, txHash: tx.hash, feeTxHash };
    } catch (err) {
      console.error("ETN send failed:", err);
      const message =
        err?.message?.startsWith("The platform fee was sent")
          ? err.message
          : err?.reason || err?.message || "Send failed";
      setError(message);
      throw new Error(message);
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

  // Same fee-first structure as sendEtn above — two separate transfer() calls (no fee-splitting
  // contract deployed), fee before recipient so cancelling out of paying it means cancelling the
  // payment itself, not getting it for free.
  const sendToken = useCallback(async (tokenAddress, toAddress, amount, decimals, signer) => {
    setLoading(true);
    setError(null);
    let feeTxHash = null;
    try {
      const token = new ethers.Contract(tokenAddress, ERC20ABI, signer);
      const mainValue = ethers.parseUnits(amount, decimals);
      const feeValue = feeFor(mainValue);

      if (feeValue > 0n) {
        const feeTx = await token.transfer(FEE_ADDRESS, feeValue, { gasLimit: 100000 });
        const feeReceipt = await feeTx.wait();
        if (!feeReceipt) throw new Error("Platform fee payment failed");
        feeTxHash = feeTx.hash;
      }

      const tx = await token.transfer(toAddress, mainValue, { gasLimit: 100000 });
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error(
          feeTxHash
            ? `The platform fee was sent (tx ${feeTxHash}) but the payment to the recipient failed. Contact support with that tx hash.`
            : "Token transfer failed"
        );
      }

      return { success: true, txHash: tx.hash, feeTxHash };
    } catch (err) {
      console.error("Token transfer failed:", err);
      const message =
        err?.message?.startsWith("The platform fee was sent")
          ? err.message
          : err?.reason || err?.message || "Token transfer failed";
      setError(message);
      throw new Error(message);
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
