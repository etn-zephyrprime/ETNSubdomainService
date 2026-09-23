import React, { useState, useEffect, useCallback } from "react";
import { ArrowLeft } from "lucide-react";
import { green, greenGlow, muted, mutedLight, error, border } from "../styles/theme.js";
import { useMarketplaceListings } from "../hooks/useMarketplaceListings.js";
import { formatEth } from "../utils/format.js";
import NeonButton from "./NeonButton.jsx";
import UsdEstimate from "./UsdEstimate.jsx";
import { EXPLORER_BASE_URL, MARKETPLACE_ADDRESS, LEGACY_MARKETPLACES } from "../config.js";

// LEGACY_MARKETPLACES is ordered V4-then-V3 (see its own comment in config.js) — a listing not on
// the current contract could be from either, so this labels it by whichever one it's actually on
// rather than assuming every legacy listing is V3 (that assumption used to be baked into the badge
// below as a plain "Legacy" label with a hardcoded "(V3)" in its tooltip, which would have quietly
// mislabeled a real V4 listing).
const LEGACY_VERSION_LABELS = ["V4", "V3"];
function legacyVersionLabel(marketplaceAddress) {
  const index = LEGACY_MARKETPLACES.findIndex((m) => m.address === marketplaceAddress);
  return index === -1 ? "Legacy" : LEGACY_VERSION_LABELS[index];
}

// Browse/buy screen for the resale marketplace — every active listing on the deployed
// Marketplace contract's own `listings` mapping, bought atomically via buyListing (payment +
// NameWrapper transfer in one transaction, no escrow). Listing a name for sale lives in
// ManageSubdomain.jsx instead (per-name, alongside that name's other management actions), not
// here — this screen is purely the buyer's side.
export default function Marketplace({ wallet, onBack = null }) {
  const [listings, setListings] = useState(null); // null = loading
  const [listingsError, setListingsError] = useState(null);

  // marketplaceAddress+listingId, not listingId alone — V4 and legacy V3 each number their own
  // listings starting from 1, so ids alone can collide between the two contracts (used as this
  // list's React key too, for the same reason).
  const listingKey = (listing) => `${listing.marketplaceAddress}-${listing.listingId}`;

  const [buyingId, setBuyingId] = useState(null);
  const [buyError, setBuyError] = useState(null);
  const [success, setSuccess] = useState(null); // { name, price, txHash } | null

  const { getActiveListings, buyListing } = useMarketplaceListings();

  const loadListings = useCallback(async () => {
    setListingsError(null);
    try {
      const active = await getActiveListings();
      // Newest first — nextListingId only ever increases *within a single contract*, so a higher
      // listingId is more recent there, but getActiveListings now merges V4 with the deprecated V3
      // contract, and the two have entirely separate listingId sequences (a V3 #50 isn't newer
      // than a V4 #3). Sorted by contract first (current V4 ahead of legacy V3 — genuinely newer
      // activity lives there) and by listingId within each, rather than comparing ids across
      // contracts directly.
      active.sort((a, b) => {
        const aCurrent = a.marketplaceAddress === MARKETPLACE_ADDRESS;
        const bCurrent = b.marketplaceAddress === MARKETPLACE_ADDRESS;
        if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
        return b.listingId - a.listingId;
      });
      setListings(active);
    } catch (err) {
      console.error("Failed to load marketplace listings:", err);
      setListingsError("Couldn't load listings — try again in a moment.");
    }
  }, [getActiveListings]);

  useEffect(() => {
    loadListings();
  }, [loadListings]);

  const handleBuy = async (listing) => {
    if (!wallet.isConnected) {
      await wallet.connectWallet();
      return;
    }
    setBuyError(null);
    setBuyingId(listingKey(listing));
    try {
      await wallet.ensureCorrectNetwork();
      const signer = await wallet.getSigner();
      const result = await buyListing(listing.listingId, listing.price, signer, listing.marketplaceAddress);
      setSuccess({ name: listing.name, price: listing.price, txHash: result.txHash });
      // Matched on marketplaceAddress too, not just listingId — V4 and legacy V3 each number their
      // own listings starting from 1, so the ids alone can collide between the two contracts.
      setListings((prev) =>
        prev?.filter((l) => !(l.listingId === listing.listingId && l.marketplaceAddress === listing.marketplaceAddress)) ?? null
      );
    } catch (err) {
      console.error("Purchase failed:", err);
      setBuyError(err?.reason || err?.message || "Purchase failed");
    } finally {
      setBuyingId(null);
    }
  };

  if (success) {
    return (
      <div style={{ width: "100%", maxWidth: 600, margin: "0 auto", padding: "0 16px" }}>
        <div style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
          <h2 style={{ fontSize: 28, fontWeight: 900, color: green, marginBottom: 8 }}>Purchased!</h2>
          <p style={{ fontSize: 13, color: mutedLight, marginBottom: 24, lineHeight: 1.6 }}>
            <strong>{success.name}</strong> is now yours, for <strong>{formatEth(success.price)} ETN</strong>.
          </p>
          {success.txHash && (
            <div style={{ marginBottom: 24 }}>
              <a
                href={`${EXPLORER_BASE_URL}/tx/${success.txHash}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, color: green, textDecoration: "none", borderBottom: `1px solid ${green}` }}
              >
                View Transaction →
              </a>
            </div>
          )}
          <NeonButton variant="green" onClick={() => setSuccess(null)} style={{ width: "100%" }}>
            Back to Marketplace
          </NeonButton>
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", maxWidth: 600, margin: "0 auto", padding: "0 16px" }}>
      <div style={{ marginBottom: 20 }}>
        <button
          onClick={onBack}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: green,
            background: "rgba(18,86,131,0.06)",
            border: `1px solid rgba(62,166,255,0.2)`,
            borderRadius: 10,
            cursor: "pointer",
            padding: "8px 14px",
          }}
        >
          <ArrowLeft size={14} />
          Back
        </button>
      </div>

      <div style={{ marginBottom: 32, textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
          Marketplace
        </div>
        <h2 style={{ fontSize: 28, fontWeight: 900, margin: "0 0 12px 0", color: "#fff", textShadow: `0 0 16px ${greenGlow}` }}>
          Names For Sale
        </h2>
        <div style={{ width: 40, height: 2, background: green, margin: "0 auto", borderRadius: 2, boxShadow: `0 0 8px ${greenGlow}` }} />
      </div>

      {listings === null && !listingsError && (
        <div style={{ fontSize: 13, color: mutedLight, textAlign: "center", padding: "24px 0" }}>
          Loading listings...
        </div>
      )}

      {listingsError && (
        <div style={{ fontSize: 13, color: error, textAlign: "center", padding: "24px 0" }}>
          {listingsError}
        </div>
      )}

      {listings?.length === 0 && (
        <div style={{ fontSize: 13, color: mutedLight, textAlign: "center", padding: "24px 0", lineHeight: 1.6 }}>
          Nothing listed for resale yet. Owners can list a name they own from "Your Names".
        </div>
      )}

      {buyError && (
        <div style={{ fontSize: 12, color: error, marginBottom: 16, textAlign: "center" }}>
          {buyError}
        </div>
      )}

      {listings && listings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {listings.map((listing) => {
            const isOwnListing = wallet.account && listing.seller.toLowerCase() === wallet.account.toLowerCase();
            return (
              <div
                key={listingKey(listing)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: 14,
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.05)",
                  backdropFilter: "blur(14px)",
                  WebkitBackdropFilter: "blur(14px)",
                  border: `1px solid rgba(62,166,255,0.2)`,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {listing.name || "(unknown name)"}
                    </div>
                    {!listing.isActivated && (
                      <span
                        title="Not activated on this service yet — the buyer can activate it after purchase to start selling subnames"
                        style={{
                          flexShrink: 0,
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: 0.4,
                          textTransform: "uppercase",
                          color: muted,
                          border: `1px solid rgba(62,166,255,0.2)`,
                          borderRadius: 4,
                          padding: "2px 5px",
                        }}
                      >
                        Not activated
                      </span>
                    )}
                    {listing.marketplaceAddress !== MARKETPLACE_ADDRESS && (
                      <span
                        title={`Listed on this service's previous (${legacyVersionLabel(listing.marketplaceAddress)}) marketplace contract — still a real, live listing, just not the current one`}
                        style={{
                          flexShrink: 0,
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: 0.4,
                          textTransform: "uppercase",
                          color: muted,
                          border: `1px solid rgba(62,166,255,0.2)`,
                          borderRadius: 4,
                          padding: "2px 5px",
                        }}
                      >
                        {legacyVersionLabel(listing.marketplaceAddress)}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: mutedLight, marginTop: 2 }}>
                    Seller {listing.sellerName || `${listing.seller.slice(0, 6)}...${listing.seller.slice(-4)}`}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                  <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <div style={{ fontSize: 15, fontWeight: 900, color: green }}>
                      {formatEth(listing.price)} ETN
                    </div>
                    <UsdEstimate etn={formatEth(listing.price)} />
                  </div>
                  <NeonButton
                    variant={isOwnListing ? "dark" : "green"}
                    onClick={() => handleBuy(listing)}
                    disabled={isOwnListing || buyingId === listingKey(listing)}
                    loading={buyingId === listingKey(listing)}
                    style={{ padding: "8px 14px", fontSize: 12 }}
                  >
                    {isOwnListing
                      ? "Your Listing"
                      : !wallet.isConnected
                      ? "Connect"
                      : buyingId === listingKey(listing)
                      ? "Buying..."
                      : "Buy"}
                  </NeonButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
