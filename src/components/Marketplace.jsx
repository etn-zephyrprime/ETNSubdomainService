import React, { useState, useEffect, useCallback } from "react";
import { ArrowLeft } from "lucide-react";
import { green, greenGlow, muted, mutedLight, error, panel2, border } from "../styles/theme.js";
import { useMarketplaceListings } from "../hooks/useMarketplaceListings.js";
import { formatEth } from "../utils/format.js";
import NeonButton from "./NeonButton.jsx";
import { EXPLORER_BASE_URL } from "../config.js";

// Browse/buy screen for the resale marketplace — every active listing on the deployed
// Marketplace contract's own `listings` mapping, bought atomically via buyListing (payment +
// NameWrapper transfer in one transaction, no escrow). Listing a name for sale lives in
// ManageSubdomain.jsx instead (per-name, alongside that name's other management actions), not
// here — this screen is purely the buyer's side.
export default function Marketplace({ wallet, onBack = null }) {
  const [listings, setListings] = useState(null); // null = loading
  const [listingsError, setListingsError] = useState(null);

  const [buyingId, setBuyingId] = useState(null);
  const [buyError, setBuyError] = useState(null);
  const [success, setSuccess] = useState(null); // { name, price, txHash } | null

  const { getActiveListings, buyListing } = useMarketplaceListings();

  const loadListings = useCallback(async () => {
    setListingsError(null);
    try {
      const active = await getActiveListings();
      // Newest first — nextListingId only ever increases, so a higher listingId is more recent.
      active.sort((a, b) => b.listingId - a.listingId);
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
    setBuyingId(listing.listingId);
    try {
      await wallet.ensureCorrectNetwork();
      const signer = await wallet.getSigner();
      const result = await buyListing(listing.listingId, listing.price, signer);
      setSuccess({ name: listing.name, price: listing.price, txHash: result.txHash });
      setListings((prev) => prev?.filter((l) => l.listingId !== listing.listingId) ?? null);
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
            <strong>{success.name}.etn</strong> is now yours, for <strong>{formatEth(success.price)} ETN</strong>.
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
            border: `1px solid ${border}`,
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
                key={listing.listingId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: 14,
                  borderRadius: 12,
                  background: panel2,
                  border: `1px solid ${border}`,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {listing.name ? `${listing.name}.etn` : "(unknown name)"}
                  </div>
                  <div style={{ fontSize: 12, color: mutedLight, marginTop: 2 }}>
                    Seller {listing.seller.slice(0, 6)}...{listing.seller.slice(-4)}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 900, color: green, whiteSpace: "nowrap" }}>
                    {formatEth(listing.price)} ETN
                  </div>
                  <NeonButton
                    variant={isOwnListing ? "dark" : "green"}
                    onClick={() => handleBuy(listing)}
                    disabled={isOwnListing || buyingId === listing.listingId}
                    loading={buyingId === listing.listingId}
                    style={{ padding: "8px 14px", fontSize: 12 }}
                  >
                    {isOwnListing
                      ? "Your Listing"
                      : !wallet.isConnected
                      ? "Connect"
                      : buyingId === listing.listingId
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
