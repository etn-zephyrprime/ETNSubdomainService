import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, NAME_WRAPPER_ADDRESS, RPC_URL, r2ProxyUrl } from "../config.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";
import NameWrapperABI from "../abis/NameWrapperABI.json";
import { decodeDnsName } from "../utils/ens.js";

// backend/utils/marketplaceSellersCache.js publishes {seller address -> primary name} for every
// currently-active listing's seller to R2 on a timer — same reasoning and the same fix as
// src/hooks/useActivatedDomains.js: resolving every seller's primary name concurrently in the
// browser (Promise.all over every active listing) is exactly the pattern that made ethers batch
// those calls into one oversized JSON-RPC request, which Ankr's public RPC rejects outright —
// every seller was silently showing as a raw address. Fetched once per getActiveListings() call
// rather than once per listing.
//
// No fallback to the old per-listing getPrimaryName() calls if this fetch fails — same call as
// useActivatedDomains.js: that's the exact bug this exists to avoid reintroducing. A seller simply
// shows as their address (which the UI already handles, see Marketplace.jsx's sellerName
// fallback) if the cache is unreachable or hasn't indexed them yet.
async function fetchSellerPrimaryNames() {
  try {
    const res = await fetch(r2ProxyUrl("marketplace-sellers.json"));
    if (!res.ok) return {};
    const data = await res.json();
    return data?.sellers && typeof data.sellers === "object" ? data.sellers : {};
  } catch (err) {
    console.warn("Marketplace sellers cache fetch failed:", err.message);
    return {};
  }
}

// Always points directly at Electroneum RPC — same convention as the rest of this app's
// read-only hooks — for reads that shouldn't depend on whatever chain the connected wallet
// happens to be on.
const readOnlyProvider = new ethers.JsonRpcProvider(RPC_URL);

// Resale of an already-owned, already-wrapped name/subname — listExistingName/cancelListing/
// buyListing were already live on the deployed Marketplace contract (same 80/20 seller/burn-pool
// split registerSubname uses), just never wired into this app's frontend. No new contract, no
// backend — listings live entirely in the contract's own public `listings` mapping.
export function useMarketplaceListings() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getReadContracts = useCallback(() => ({
    marketplace: new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, readOnlyProvider),
    nameWrapper: new ethers.Contract(NAME_WRAPPER_ADDRESS, NameWrapperABI, readOnlyProvider),
  }), []);

  // Reads every listing directly off the contract's public `listings` mapping (ids 1..nextListingId-1
  // via Promise.all) rather than scanning ExistingNameListed/ListingCancelled/ListingSold events —
  // simpler and self-healing (always reflects live state, no event reconciliation), and this app's
  // scale doesn't need chunked eth_getLogs the way the Telegram watcher's historical scans do.
  // tokenId is the node itself cast to uint256 (same convention NameWrapper uses everywhere else
  // in this app), so each active listing's real name is resolved via NameWrapper.names(node).
  const getActiveListings = useCallback(async () => {
    const { marketplace, nameWrapper } = getReadContracts();
    const nextId = await marketplace.nextListingId();
    const count = Number(nextId) - 1;
    if (count <= 0) return [];

    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const raw = await Promise.all(ids.map((id) => marketplace.listings(id)));

    const active = raw
      .map((l, i) => ({
        listingId: ids[i],
        seller: l.seller,
        tokenId: l.tokenId,
        price: l.price,
        active: l.active,
      }))
      .filter((l) => l.active);

    const sellerPrimaryNames = await fetchSellerPrimaryNames();

    return Promise.all(active.map(async (l) => {
      const node = ethers.toBeHex(l.tokenId, 32);
      let name = null;
      try {
        name = decodeDnsName(await nameWrapper.names(node)) || null;
      } catch (err) {
        console.error(`Failed to decode name for listing ${l.listingId}:`, err);
      }

      const sellerName = sellerPrimaryNames[l.seller.toLowerCase()] || null;

      return { ...l, node, name, sellerName };
    }));
  }, [getReadContracts]);

  // Whether `tokenId` (a name's node, as a uint256) currently has an active listing — used by
  // ManageSubdomain's per-name "Resell" section to show "List for Resale" vs. the existing
  // listing's price + a "Cancel Listing" option, and to stop an owner double-listing.
  const getListingForToken = useCallback(async (tokenId) => {
    const listings = await getActiveListings();
    return listings.find((l) => BigInt(l.tokenId) === BigInt(tokenId)) || null;
  }, [getActiveListings]);

  // Lists an already-wrapped name/subname the caller owns for resale. Requires the caller to have
  // already approved the marketplace on NameWrapper (nameWrapper.isApprovedForAll) — the exact
  // same approval useSubnamePricing.js's isMarketplaceApproved/approveMarketplace already handle
  // for subname-selling, reused as-is rather than duplicated here.
  const listName = useCallback(async (tokenId, priceWei, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const tx = await marketplace.listExistingName(tokenId, priceWei, { gasLimit: 200000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Listing failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Listing failed:", err);
      setError(err?.reason || err?.message || "Listing failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const cancelListing = useCallback(async (listingId, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const tx = await marketplace.cancelListing(listingId, { gasLimit: 120000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Cancelling failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Cancelling listing failed:", err);
      setError(err?.reason || err?.message || "Cancelling failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Pays exactly the listing's price — the contract enforces msg.value >= price and refunds any
  // excess itself, but this always sends the exact price so there's nothing to refund.
  const buyListing = useCallback(async (listingId, priceWei, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const tx = await marketplace.buyListing(listingId, { value: priceWei, gasLimit: 250000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Purchase failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Buying listing failed:", err);
      setError(err?.reason || err?.message || "Purchase failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    getActiveListings,
    getListingForToken,
    listName,
    cancelListing,
    buyListing,
    loading,
    error,
  };
}
