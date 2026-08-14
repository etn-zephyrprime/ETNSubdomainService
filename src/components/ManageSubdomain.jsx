import React, { useState } from "react";
import { ethers } from "ethers";
import { ArrowLeft } from "lucide-react";
import { green, greenGlow, muted, mutedLight, error, panel2, border } from "../styles/theme.js";
import { useRenewal } from "../hooks/useRenewal.js";
import { useSubnamePricing } from "../hooks/useSubnamePricing.js";
import { useReverseRecord } from "../hooks/useReverseRecord.js";
import { useAddressRecord } from "../hooks/useAddressRecord.js";
import { useMarketplaceListings } from "../hooks/useMarketplaceListings.js";
import { computeNode, computeSubnode, computeNftImageUrl } from "../utils/ens.js";
import { formatEth } from "../utils/format.js";
import { signNftGenerationRequest } from "../utils/backendAuth.js";
import NeonButton from "./NeonButton.jsx";
import { DEFAULT_DURATION_SECONDS, MIN_SUBNAME_PRICE_PER_YEAR_ETN, BACKEND_IMAGE_URL } from "../config.js";

const MIN_SUBNAME_PRICE_PER_YEAR_WEI = ethers.parseEther(MIN_SUBNAME_PRICE_PER_YEAR_ETN);

// "Manage & Resell" — look up a name you own, view its expiry, renew it, set a price for
// self-serve subname registration under it, or list it for resale (activation/approval handled
// inline as needed).
// intent="retro" is the same flow, entered from the "Retro Register" CTA aimed at names
// registered directly through Electroneum (bypassing this marketplace) — just different framing
// copy, since activation is the first step of the flow regardless of how someone got here.
export default function ManageSubdomain({ wallet, onBack = null, intent = "manage" }) {
  const [nameInput, setNameInput] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState(null);
  const [verifiedName, setVerifiedName] = useState(null);
  const [node, setNode] = useState(null);
  const [expiry, setExpiry] = useState(null);
  const [isSubname, setIsSubname] = useState(false);

  const [renewLoading, setRenewLoading] = useState(false);
  const [renewError, setRenewError] = useState(null);
  const [renewSuccess, setRenewSuccess] = useState(false);
  const [renewTxHash, setRenewTxHash] = useState(null);
  const [renewQuote, setRenewQuote] = useState(null);
  const [renewQuoteLoading, setRenewQuoteLoading] = useState(false);

  const [activated, setActivated] = useState(null);
  const [activationFee, setActivationFee] = useState(null);
  const [activationLoading, setActivationLoading] = useState(false);
  const [activationError, setActivationError] = useState(null);

  // Only relevant for a top-level name that's registered but not yet wrapped — activateDomain
  // now wraps it as part of activation, which needs this approval first. null = not applicable
  // (subname, or the name's already wrapped) / not checked yet.
  const [baseRegistrarApproved, setBaseRegistrarApproved] = useState(null);
  const [baseRegistrarApproveLoading, setBaseRegistrarApproveLoading] = useState(false);
  const [baseRegistrarApproveError, setBaseRegistrarApproveError] = useState(null);

  const [approved, setApproved] = useState(null);
  const [approveLoading, setApproveLoading] = useState(false);
  const [approveError, setApproveError] = useState(null);

  const [currentPrice, setCurrentPrice] = useState(null);
  const [priceInput, setPriceInput] = useState("");
  const [priceLoading, setPriceLoading] = useState(false);
  const [priceError, setPriceError] = useState(null);
  const [priceSuccess, setPriceSuccess] = useState(false);

  const [primaryName, setPrimaryNameState] = useState(null);
  const [primaryNameLoading, setPrimaryNameLoading] = useState(false);
  const [setPrimaryLoading, setSetPrimaryLoading] = useState(false);
  const [setPrimaryError, setSetPrimaryError] = useState(null);
  const [setPrimarySuccess, setSetPrimarySuccess] = useState(false);

  // Forward record — opposite direction from Primary Name above (that's "what name does my
  // wallet show as", this is "what address does this name point to").
  const [resolvedAddress, setResolvedAddress] = useState(null);
  const [resolvedAddressLoading, setResolvedAddressLoading] = useState(false);
  const [setAddrLoading, setSetAddrLoading] = useState(false);
  const [setAddrError, setSetAddrError] = useState(null);
  const [setAddrSuccess, setSetAddrSuccess] = useState(false);

  // Send subname — transfers ownership away entirely, so kept as its own confirm-and-commit
  // flow rather than folded into any of the read/write pairs above.
  const [sendAddress, setSendAddress] = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [sendSuccess, setSendSuccess] = useState(false);
  const [sendTxHash, setSendTxHash] = useState(null);

  // Resale listing (see useMarketplaceListings.js) — null while checking, or once confirmed not
  // listed; { listingId, price } once confirmed listed.
  const [listing, setListing] = useState(null);
  const [listingLoading, setListingLoading] = useState(false);
  const [resellPriceInput, setResellPriceInput] = useState("");
  const [resellLoading, setResellLoading] = useState(false);
  const [resellError, setResellError] = useState(null);
  const [cancelListingLoading, setCancelListingLoading] = useState(false);
  const [cancelListingError, setCancelListingError] = useState(null);

  const {
    getOwner,
    getOwnerByNode,
    getCurrentExpiry,
    getNameWrapperExpiry,
    isWrapped,
    transferSubname,
    quoteRenewal,
    renewName,
  } = useRenewal();
  const {
    isDomainActivated,
    getActivationFee,
    activateDomain,
    isMarketplaceApproved,
    approveMarketplace,
    isBaseRegistrarApproved,
    approveBaseRegistrar,
    getSubnamePricePerYear,
    setSubnamePricePerYear,
  } = useSubnamePricing();
  const { getPrimaryName, setName: setReverseName } = useReverseRecord();
  const { getResolvedAddress, setAddr } = useAddressRecord();
  const { getListingForToken, listName, cancelListing } = useMarketplaceListings();

  const handleLookup = async () => {
    if (!wallet.isConnected) {
      setLookupError("Connect your wallet first");
      return;
    }
    if (!nameInput) {
      setLookupError("Enter a name");
      return;
    }

    setLookupLoading(true);
    setLookupError(null);
    setVerifiedName(null);
    setNode(null);
    setExpiry(null);
    setIsSubname(false);
    setRenewSuccess(false);
    setRenewError(null);
    setRenewQuote(null);
    setActivated(null);
    setActivationFee(null);
    setActivationError(null);
    setBaseRegistrarApproved(null);
    setBaseRegistrarApproveError(null);
    setApproved(null);
    setApproveError(null);
    setCurrentPrice(null);
    setPriceInput("");
    setPriceError(null);
    setPriceSuccess(false);
    setPrimaryNameState(null);
    setSetPrimaryError(null);
    setSetPrimarySuccess(false);
    setResolvedAddress(null);
    setSetAddrError(null);
    setSetAddrSuccess(false);
    setSendAddress("");
    setSendError(null);
    setSendSuccess(false);
    setSendTxHash(null);
    setListing(null);
    setResellPriceInput("");
    setResellError(null);
    setCancelListingError(null);

    // Strip a trailing ".etn" if typed — a natural, common thing to enter even though the
    // placeholder just asks for "your-name" (e.g. "planetzephyros.etn"). Without this, the
    // dot-based subname split below would misparse it as subname "planetzephyros" under parent
    // "etn" (the literal TLD), silently computing a different, genuinely nonexistent node
    // instead of the intended top-level name — surfacing as a false "doesn't exist".
    const normalizedInput = nameInput.replace(/\.etn$/i, "");

    // Subnames (e.g. "hi.test6") aren't tracked by BaseRegistrar at all — only their parent's
    // top-level label is. Their node is computeSubnode(parentNode, subLabel), not computeNode of
    // the whole dotted string, and their expiry has to come from NameWrapper directly since
    // there's no independent renewal to look up.
    const dotIndex = normalizedInput.indexOf(".");
    const subname = dotIndex !== -1;
    const subLabel = subname ? normalizedInput.slice(0, dotIndex) : null;
    const parentLabel = subname ? normalizedInput.slice(dotIndex + 1) : normalizedInput;

    try {
      const domainNode = subname ? computeSubnode(computeNode(parentLabel), subLabel) : computeNode(parentLabel);
      const owner = subname ? await getOwnerByNode(domainNode) : await getOwner(parentLabel);

      if (owner === ethers.ZeroAddress) {
        setLookupError(`"${normalizedInput}.etn" doesn't exist`);
        return;
      }

      if (owner.toLowerCase() !== wallet.account.toLowerCase()) {
        setLookupError("Your wallet doesn't own this name");
        return;
      }

      setIsSubname(subname);
      setVerifiedName(normalizedInput);
      setNode(domainNode);

      // Non-blocking — the rest of this lookup (expiry, activation, pricing) still needs to work
      // even when ReverseRegistrar isn't configured for this deployment (see config.js).
      setPrimaryNameLoading(true);
      getPrimaryName(wallet.account)
        .then(setPrimaryNameState)
        .catch((err) => console.error("Failed to fetch primary name:", err))
        .finally(() => setPrimaryNameLoading(false));

      // Also non-blocking, and independent of ownership/wrapped state — a name's forward record
      // reads through whatever resolver it's actually assigned, resolved fresh each time.
      setResolvedAddressLoading(true);
      getResolvedAddress(domainNode)
        .then(setResolvedAddress)
        .catch((err) => console.error("Failed to fetch resolved address:", err))
        .finally(() => setResolvedAddressLoading(false));

      if (subname) {
        const subExpiry = await getNameWrapperExpiry(domainNode);
        setExpiry(subExpiry);
      } else {
        const currentExpiry = await getCurrentExpiry(parentLabel);
        setExpiry(currentExpiry);

        setRenewQuoteLoading(true);
        quoteRenewal(parentLabel, DEFAULT_DURATION_SECONDS)
          .then(setRenewQuote)
          .catch((err) => console.error("Failed to fetch renewal quote:", err))
          .finally(() => setRenewQuoteLoading(false));
      }

      const isActivated = await isDomainActivated(domainNode);
      setActivated(isActivated);

      if (isActivated) {
        const [isApproved, price] = await Promise.all([
          isMarketplaceApproved(wallet.account),
          getSubnamePricePerYear(domainNode),
        ]);
        setApproved(isApproved);
        setCurrentPrice(price);

        // Non-blocking, same pattern as primaryName/resolvedAddress above — resale listing status
        // doesn't need to hold up the rest of the lookup.
        setListingLoading(true);
        getListingForToken(BigInt(domainNode))
          .then(setListing)
          .catch((err) => console.error("Failed to fetch listing status:", err))
          .finally(() => setListingLoading(false));
      } else {
        const fee = await getActivationFee(normalizedInput, domainNode);
        setActivationFee(fee);

        // Only top-level names ever hit this path unwrapped — a subname is always created
        // already-wrapped via registerSubname, so it'd never reach "not activated" in the first
        // place unless something else is very wrong, in which case skip this check rather than
        // asserting anything about it.
        if (!subname) {
          const alreadyWrapped = await isWrapped(domainNode);
          if (!alreadyWrapped) {
            const isApproved = await isBaseRegistrarApproved(wallet.account);
            setBaseRegistrarApproved(isApproved);
          }
        }
      }
    } catch (err) {
      console.error("Name lookup failed:", err);
      setLookupError(err?.reason || err?.message || "Lookup failed");
    } finally {
      setLookupLoading(false);
    }
  };

  // Only reachable for top-level names (see the "Only top-level names ever hit this path
  // unwrapped" comment in handleLookup below) — always the gold "namespace" template, same as
  // RegistrationFlow.jsx's generateNftAndLink for a fresh registration. Fire-and-forget: a
  // failure here doesn't mean activation itself failed, just that the image isn't generated yet
  // (the "View NFT Image" link will 404 until it is — can be recovered later via
  // backend/scripts/backfillNftImages.js).
  const generateNftAndLink = async (fullName, nodeHex, signer) => {
    try {
      const { timestamp, signature } = await signNftGenerationRequest(signer, nodeHex);
      await fetch(`${BACKEND_IMAGE_URL}/api/generate-nft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, nodeHex, template: "namespace", timestamp, signature }),
      });
    } catch (err) {
      console.error("NFT generation request failed:", err);
    }
  };

  const handleActivate = async () => {
    setActivationError(null);
    setActivationLoading(true);
    try {
      const signer = await wallet.getSigner();
      await activateDomain(node, verifiedName, activationFee, signer);
      setActivated(true);
      generateNftAndLink(`${verifiedName}.etn`, node, signer);

      const [isApproved, price] = await Promise.all([
        isMarketplaceApproved(wallet.account),
        getSubnamePricePerYear(node),
      ]);
      setApproved(isApproved);
      setCurrentPrice(price);
    } catch (err) {
      console.error("Activation failed:", err);
      setActivationError(err?.reason || err?.message || "Activation failed");
    } finally {
      setActivationLoading(false);
    }
  };

  const handleApproveBaseRegistrar = async () => {
    setBaseRegistrarApproveError(null);
    setBaseRegistrarApproveLoading(true);
    try {
      const signer = await wallet.getSigner();
      await approveBaseRegistrar(signer);
      setBaseRegistrarApproved(true);
    } catch (err) {
      console.error("BaseRegistrar approval failed:", err);
      setBaseRegistrarApproveError(err?.reason || err?.message || "Approval failed");
    } finally {
      setBaseRegistrarApproveLoading(false);
    }
  };

  const handleApprove = async () => {
    setApproveError(null);
    setApproveLoading(true);
    try {
      const signer = await wallet.getSigner();
      await approveMarketplace(signer);
      setApproved(true);
    } catch (err) {
      console.error("Approval failed:", err);
      setApproveError(err?.reason || err?.message || "Approval failed");
    } finally {
      setApproveLoading(false);
    }
  };

  const submitPrice = async (turnOff = false) => {
    setPriceError(null);
    setPriceSuccess(false);

    const priceWei = turnOff ? 0n : ethers.parseEther(priceInput || "0");
    if (!turnOff && priceWei < MIN_SUBNAME_PRICE_PER_YEAR_WEI) {
      setPriceError(`Minimum price is ${MIN_SUBNAME_PRICE_PER_YEAR_ETN} ETN/year`);
      return;
    }

    setPriceLoading(true);
    try {
      const signer = await wallet.getSigner();
      await setSubnamePricePerYear(node, priceWei, signer);
      setCurrentPrice(priceWei);
      setPriceSuccess(true);
      if (turnOff) setPriceInput("");
    } catch (err) {
      console.error("Setting subname price failed:", err);
      setPriceError(err?.reason || err?.message || "Setting price failed");
    } finally {
      setPriceLoading(false);
    }
  };

  const handleSetPrimaryName = async () => {
    setSetPrimaryError(null);
    setSetPrimarySuccess(false);
    setSetPrimaryLoading(true);
    try {
      const signer = await wallet.getSigner();
      const fullName = `${verifiedName}.etn`;
      await setReverseName(fullName, signer);
      setPrimaryNameState(fullName);
      setSetPrimarySuccess(true);
    } catch (err) {
      console.error("Setting primary name failed:", err);
      setSetPrimaryError(err?.reason || err?.message || "Setting primary name failed");
    } finally {
      setSetPrimaryLoading(false);
    }
  };

  const handleSetAddr = async () => {
    setSetAddrError(null);
    setSetAddrSuccess(false);
    setSetAddrLoading(true);
    try {
      const signer = await wallet.getSigner();
      await setAddr(node, wallet.account, signer);
      setResolvedAddress(wallet.account);
      setSetAddrSuccess(true);
    } catch (err) {
      console.error("Setting address failed:", err);
      setSetAddrError(err?.reason || err?.message || "Setting address failed");
    } finally {
      setSetAddrLoading(false);
    }
  };

  const handleSendSubname = async () => {
    setSendError(null);
    setSendSuccess(false);

    const trimmedAddress = sendAddress.trim();
    if (!ethers.isAddress(trimmedAddress)) {
      setSendError("Enter a valid wallet address");
      return;
    }
    if (trimmedAddress.toLowerCase() === wallet.account.toLowerCase()) {
      setSendError("That's already your own wallet");
      return;
    }

    setSendLoading(true);
    try {
      const signer = await wallet.getSigner();
      const result = await transferSubname(node, wallet.account, trimmedAddress, signer);
      setSendTxHash(result.txHash);
      setSendSuccess(true);
    } catch (err) {
      console.error("Sending subname failed:", err);
      setSendError(err?.reason || err?.message || "Sending subname failed");
    } finally {
      setSendLoading(false);
    }
  };

  // Lists the currently-looked-up name for resale. Requires domain activation + marketplace
  // approval (same NameWrapper.setApprovalForAll the Subname Pricing section above already gets
  // the owner to grant), both already gated by this section only rendering when
  // activated && approved are true.
  const handleListForResale = async () => {
    setResellError(null);

    const priceWei = ethers.parseEther(resellPriceInput || "0");
    if (priceWei <= 0n) {
      setResellError("Enter a price greater than 0");
      return;
    }

    setResellLoading(true);
    try {
      const signer = await wallet.getSigner();
      await listName(BigInt(node), priceWei, signer);
      setResellPriceInput("");
      const updated = await getListingForToken(BigInt(node));
      setListing(updated);
    } catch (err) {
      console.error("Listing for resale failed:", err);
      setResellError(err?.reason || err?.message || "Listing failed");
    } finally {
      setResellLoading(false);
    }
  };

  const handleCancelListing = async () => {
    setCancelListingError(null);
    setCancelListingLoading(true);
    try {
      const signer = await wallet.getSigner();
      await cancelListing(listing.listingId, signer);
      setListing(null);
    } catch (err) {
      console.error("Cancelling listing failed:", err);
      setCancelListingError(err?.reason || err?.message || "Cancelling failed");
    } finally {
      setCancelListingLoading(false);
    }
  };

  const handleRenew = async () => {
    setRenewError(null);
    setRenewSuccess(false);
    setRenewLoading(true);

    try {
      const { totalPrice } = await quoteRenewal(verifiedName, DEFAULT_DURATION_SECONDS);
      const signer = await wallet.getSigner();
      const result = await renewName(verifiedName, DEFAULT_DURATION_SECONDS, ethers.ZeroHash, totalPrice, signer);

      setRenewTxHash(result.txHash);
      setRenewSuccess(true);

      const newExpiry = await getCurrentExpiry(verifiedName);
      setExpiry(newExpiry);
    } catch (err) {
      console.error("Renewal failed:", err);
      setRenewError(err?.reason || err?.message || "Renewal failed");
    } finally {
      setRenewLoading(false);
    }
  };

  const expiryDate = expiry ? new Date(Number(expiry) * 1000) : null;
  const daysRemaining = expiry ? Math.floor((Number(expiry) * 1000 - Date.now()) / (1000 * 60 * 60 * 24)) : null;

  // Live 80/20 seller/burn-pool breakdown as the resell price is typed — mirrors the contract's
  // own SELLER_BPS/BURN_BPS split exactly (_settleSale), not just descriptive copy. null while the
  // input is empty/invalid so the preview only shows once there's a real number to split.
  let resellSplit = null;
  if (resellPriceInput) {
    try {
      const priceWei = ethers.parseEther(resellPriceInput);
      if (priceWei > 0n) {
        const sellerAmount = (priceWei * 8000n) / 10000n;
        resellSplit = { sellerAmount, burnAmount: priceWei - sellerAmount };
      }
    } catch {
      // Invalid/incomplete number while typing — no preview, not an error.
    }
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
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: muted,
          marginBottom: 10,
        }}>
          {intent === "retro" ? "Retro Register" : "Manage"}
        </div>
        <h2 style={{
          fontSize: 28,
          fontWeight: 900,
          margin: "0 0 12px 0",
          color: "#fff",
          textShadow: `0 0 16px ${greenGlow}`,
        }}>
          {intent === "retro" ? "Earn Fees on Subnames" : "Manage & Resell"}
        </h2>
        <div style={{
          width: 40,
          height: 2,
          background: green,
          margin: "0 auto",
          borderRadius: 2,
          boxShadow: `0 0 8px ${greenGlow}`,
        }} />
        {intent === "retro" && (
          <p style={{ fontSize: 12, color: mutedLight, marginTop: 14, lineHeight: 1.6 }}>
            Already registered your name directly through Electroneum? Look it up below to
            activate it in the marketplace, then set a price and start earning fees whenever
            someone registers a subname under it.
          </p>
        )}
      </div>

      {/* Lookup */}
      <div style={{ marginBottom: 24 }}>
        <input
          type="text"
          placeholder="your-name"
          value={nameInput}
          onChange={(e) => {
            setNameInput(e.target.value.toLowerCase().trim());
            setVerifiedName(null);
          }}
          style={{
            width: "100%",
            padding: "14px 16px",
            borderRadius: 12,
            border: `1px solid ${border}`,
            background: panel2,
            color: "#fff",
            fontSize: 16,
            fontWeight: 600,
            boxSizing: "border-box",
            outline: "none",
            marginBottom: 12,
          }}
        />
        <NeonButton
          variant="green"
          onClick={handleLookup}
          disabled={lookupLoading || !nameInput}
          loading={lookupLoading}
          style={{ width: "100%", justifyContent: "center" }}
        >
          {lookupLoading ? "Checking..." : "Look Up"}
        </NeonButton>
        {lookupError && (
          <div style={{ fontSize: 12, color: error, marginTop: 8, textAlign: "center" }}>
            {lookupError}
          </div>
        )}
      </div>

      {verifiedName && (
        <div style={{
          padding: 16,
          borderRadius: 12,
          background: panel2,
          border: `1px solid ${border}`,
        }}>
          {sendSuccess ? (
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: green, marginBottom: 10 }}>
                ✓ {verifiedName}.etn sent
              </div>
              <div style={{ fontSize: 12, color: mutedLight, marginBottom: 12 }}>
                Now owned by {sendAddress.slice(0, 6)}...{sendAddress.slice(-4)} — you no longer
                control this subname.
              </div>
              {sendTxHash && (
                <div style={{ fontSize: 11, color: mutedLight }}>
                  tx: {sendTxHash.slice(0, 10)}...{sendTxHash.slice(-8)}
                </div>
              )}
            </div>
          ) : (
          <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>
              {verifiedName}.etn
            </div>
            <a
              href={computeNftImageUrl(node)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11, fontWeight: 700, color: green, whiteSpace: "nowrap" }}
              title="Only resolves if this name's NFT image was generated during registration"
            >
              View NFT Image ↗
            </a>
          </div>

          <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: muted,
              marginBottom: 12,
            }}>
              Primary Name
            </div>

            <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
              {primaryNameLoading
                ? "Checking your current primary name..."
                : primaryName === `${verifiedName}.etn`
                ? `This is your wallet's primary name — it's what apps show for your address.`
                : primaryName
                ? `Your wallet's primary name is currently "${primaryName}".`
                : "Your wallet doesn't have a primary name set yet."}
            </div>

            {setPrimaryError && (
              <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{setPrimaryError}</div>
            )}
            {setPrimarySuccess && (
              <div style={{ fontSize: 12, color: green, marginBottom: 10 }}>
                ✓ Set as your primary name
              </div>
            )}

            <NeonButton
              variant="green"
              onClick={handleSetPrimaryName}
              disabled={setPrimaryLoading || primaryNameLoading || primaryName === `${verifiedName}.etn`}
              loading={setPrimaryLoading}
              style={{ width: "100%", justifyContent: "center" }}
            >
              {setPrimaryLoading
                ? "Setting..."
                : primaryName === `${verifiedName}.etn`
                ? "Already Your Primary Name"
                : `Set as Primary Name`}
            </NeonButton>
          </div>

          <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: muted,
              marginBottom: 12,
            }}>
              Wallet Address
            </div>

            <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
              {resolvedAddressLoading
                ? "Checking what address this name currently resolves to..."
                : resolvedAddress && resolvedAddress.toLowerCase() === wallet.account.toLowerCase()
                ? `This name resolves to your connected wallet — apps/wallets looking up "${verifiedName}.etn" will find you.`
                : resolvedAddress
                ? `This name currently resolves to ${resolvedAddress.slice(0, 6)}...${resolvedAddress.slice(-4)}.`
                : "This name doesn't resolve to any address yet."}
            </div>

            {setAddrError && (
              <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{setAddrError}</div>
            )}
            {setAddrSuccess && (
              <div style={{ fontSize: 12, color: green, marginBottom: 10 }}>
                ✓ Now resolves to your wallet
              </div>
            )}

            <NeonButton
              variant="green"
              onClick={handleSetAddr}
              disabled={
                setAddrLoading ||
                resolvedAddressLoading ||
                (resolvedAddress && resolvedAddress.toLowerCase() === wallet.account.toLowerCase())
              }
              loading={setAddrLoading}
              style={{ width: "100%", justifyContent: "center" }}
            >
              {setAddrLoading
                ? "Setting..."
                : resolvedAddress && resolvedAddress.toLowerCase() === wallet.account.toLowerCase()
                ? "Already Resolves to Your Wallet"
                : "Assign to My Wallet"}
            </NeonButton>
          </div>

          <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: muted,
              marginBottom: 12,
            }}>
              Subname Pricing
            </div>

            {activated === null && (
              <div style={{ fontSize: 12, color: mutedLight }}>Loading...</div>
            )}

            {activated === false && (
              <div>
                <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
                  This name was registered outside the marketplace and needs to be activated before
                  you can price subnames.
                </div>

                {baseRegistrarApproved === false && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
                      This name hasn't been wrapped yet — activating wraps it for you, but first
                      approve the marketplace to move it into NameWrapper on your behalf. One-time,
                      applies to all names you own.
                    </div>
                    {baseRegistrarApproveError && (
                      <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{baseRegistrarApproveError}</div>
                    )}
                    <NeonButton
                      variant="dark"
                      onClick={handleApproveBaseRegistrar}
                      disabled={baseRegistrarApproveLoading}
                      loading={baseRegistrarApproveLoading}
                      style={{ width: "100%", justifyContent: "center" }}
                    >
                      {baseRegistrarApproveLoading ? "Approving..." : "Approve BaseRegistrar"}
                    </NeonButton>
                  </div>
                )}

                {activationError && (
                  <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{activationError}</div>
                )}
                <NeonButton
                  variant="dark"
                  onClick={handleActivate}
                  disabled={activationLoading || !activationFee || baseRegistrarApproved === false}
                  loading={activationLoading}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  {activationLoading
                    ? "Activating..."
                    : activationFee
                    ? `Activate (${formatEth(activationFee)} ETN)`
                    : "Loading fee..."}
                </NeonButton>
              </div>
            )}

            {activated === true && approved === false && (
              <div>
                <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
                  Approve the marketplace to create subnames on your behalf when they're purchased.
                  One-time, applies to all names you own.
                </div>
                {approveError && (
                  <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{approveError}</div>
                )}
                <NeonButton
                  variant="dark"
                  onClick={handleApprove}
                  disabled={approveLoading}
                  loading={approveLoading}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  {approveLoading ? "Approving..." : "Approve Marketplace"}
                </NeonButton>
              </div>
            )}

            {activated === true && approved === true && (
              <div>
                <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
                  {currentPrice && currentPrice > 0n
                    ? `Currently selling subnames for ${formatEth(currentPrice)} ETN/year.`
                    : "Not currently selling subnames."}
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={`Price per year in ETN (min ${MIN_SUBNAME_PRICE_PER_YEAR_ETN})`}
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    borderRadius: 10,
                    border: `1px solid ${border}`,
                    background: panel2,
                    color: "#fff",
                    fontSize: 14,
                    fontWeight: 600,
                    boxSizing: "border-box",
                    outline: "none",
                    marginBottom: 6,
                  }}
                />
                <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10 }}>
                  Minimum {MIN_SUBNAME_PRICE_PER_YEAR_ETN} ETN/year, or 0 to turn sales off.
                </div>
                {priceError && (
                  <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{priceError}</div>
                )}
                {priceSuccess && (
                  <div style={{ fontSize: 12, color: green, marginBottom: 10 }}>✓ Price updated</div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <NeonButton
                    variant="green"
                    onClick={() => submitPrice(false)}
                    disabled={priceLoading || !priceInput}
                    loading={priceLoading}
                    style={{ flex: 1, justifyContent: "center" }}
                  >
                    {priceLoading ? "Setting..." : "Set Price"}
                  </NeonButton>
                  {currentPrice > 0n && (
                    <NeonButton
                      variant="dark"
                      onClick={() => submitPrice(true)}
                      disabled={priceLoading}
                      style={{ flex: 1, justifyContent: "center" }}
                    >
                      Turn Off
                    </NeonButton>
                  )}
                </div>
              </div>
            )}
          </div>

          {expiryDate && (
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: "uppercase",
                color: muted,
                marginBottom: 12,
              }}>
                Renewal
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Expires</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: daysRemaining < 30 ? "#ffb366" : "#fff" }}>
                  {expiryDate.toLocaleDateString()} ({daysRemaining} days remaining)
                </div>
                {isSubname && (
                  <div style={{ fontSize: 11, color: mutedLight, marginTop: 4 }}>
                    Set when this subname was registered, capped by the parent name's own expiry.
                    Subnames aren't renewed independently — renew the parent name instead.
                  </div>
                )}
              </div>

              {!isSubname && (
                <>
                  <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10 }}>
                    Optional — extends your current expiry by another year, on top of whatever time
                    you already have left. You don't need to do this until you're actually close to
                    expiring.
                  </div>
                  <div style={{
                    padding: 14,
                    borderRadius: 10,
                    background: "rgba(0,0,0,0.2)",
                    border: `1px solid ${border}`,
                    marginBottom: 14,
                  }}>
                    {renewQuoteLoading ? (
                      <div style={{ fontSize: 12, color: muted, textAlign: "center" }}>Loading price...</div>
                    ) : renewQuote ? (
                      <>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: mutedLight, marginBottom: 4 }}>
                          <span>Extend by 1 year — paid to Electroneum</span>
                          <span>{formatEth(renewQuote.basePrice)} ETN</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: mutedLight, marginBottom: 8 }}>
                          <span>Brokerage fee</span>
                          <span>{formatEth(renewQuote.brokerageFee)} ETN</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 900, color: green, paddingTop: 8, borderTop: `1px solid ${border}` }}>
                          <span>Total</span>
                          <span>{formatEth(renewQuote.totalPrice)} ETN</span>
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 12, color: error, textAlign: "center" }}>
                        Couldn't load renewal price
                      </div>
                    )}
                  </div>

                  {renewError && (
                    <div style={{ fontSize: 12, color: error, marginBottom: 12 }}>
                      {renewError}
                    </div>
                  )}
                  {renewSuccess && (
                    <div style={{ fontSize: 12, color: green, marginBottom: 12 }}>
                      ✓ Renewed successfully
                    </div>
                  )}

                  <NeonButton
                    variant="green"
                    onClick={handleRenew}
                    disabled={renewLoading || renewQuoteLoading || !renewQuote}
                    loading={renewLoading}
                    style={{ width: "100%", justifyContent: "center" }}
                  >
                    {renewLoading
                      ? "Renewing..."
                      : renewQuote
                      ? `Renew Early (+1 year) for ${formatEth(renewQuote.totalPrice)} ETN`
                      : "Renew Early (+1 year)"}
                  </NeonButton>

                  {renewTxHash && renewSuccess && (
                    <div style={{ marginTop: 12, textAlign: "center", fontSize: 11, color: mutedLight }}>
                      tx: {renewTxHash.slice(0, 10)}...{renewTxHash.slice(-8)}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {activated === true && (
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: "uppercase",
                color: muted,
                marginBottom: 12,
              }}>
                Resell
              </div>

              {listingLoading ? (
                <div style={{ fontSize: 12, color: mutedLight }}>Checking listing status...</div>
              ) : listing ? (
                <div>
                  <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
                    Listed for sale at <strong style={{ color: green }}>{formatEth(listing.price)} ETN</strong>.
                    A buyer who pays this receives the name immediately.
                  </div>
                  <div style={{
                    padding: 10,
                    borderRadius: 8,
                    background: "rgba(0,0,0,0.2)",
                    border: `1px solid ${border}`,
                    marginBottom: 10,
                    fontSize: 12,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", color: mutedLight, marginBottom: 4 }}>
                      <span>You receive (80%)</span>
                      <span style={{ color: green, fontWeight: 700 }}>{formatEth((listing.price * 8000n) / 10000n)} ETN</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", color: mutedLight }}>
                      <span>Burn pool (20%)</span>
                      <span>{formatEth(listing.price - (listing.price * 8000n) / 10000n)} ETN</span>
                    </div>
                  </div>
                  {cancelListingError && (
                    <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{cancelListingError}</div>
                  )}
                  <NeonButton
                    variant="danger"
                    onClick={handleCancelListing}
                    disabled={cancelListingLoading}
                    loading={cancelListingLoading}
                    style={{ width: "100%", justifyContent: "center" }}
                  >
                    {cancelListingLoading ? "Cancelling..." : "Cancel Listing"}
                  </NeonButton>
                </div>
              ) : !approved ? (
                <div>
                  <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
                    Approve the marketplace to list this name for resale — same one-time approval
                    Subname Pricing above needs, so you only need to do this once. Every resale
                    splits 80% to you, 20% into the burn pool.
                  </div>
                  {approveError && (
                    <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{approveError}</div>
                  )}
                  <NeonButton
                    variant="dark"
                    onClick={handleApprove}
                    disabled={approveLoading}
                    loading={approveLoading}
                    style={{ width: "100%", justifyContent: "center" }}
                  >
                    {approveLoading ? "Approving..." : "Approve Marketplace"}
                  </NeonButton>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
                    List {verifiedName}.etn for sale. A buyer who pays your price receives it
                    immediately — every resale splits 80% to you, 20% into the burn pool, same
                    split as subname sales.
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Price in ETN"
                    value={resellPriceInput}
                    onChange={(e) => setResellPriceInput(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "12px 14px",
                      borderRadius: 10,
                      border: `1px solid ${border}`,
                      background: panel2,
                      color: "#fff",
                      fontSize: 14,
                      fontWeight: 600,
                      boxSizing: "border-box",
                      outline: "none",
                      marginBottom: 10,
                    }}
                  />
                  {resellSplit && (
                    <div style={{
                      padding: 10,
                      borderRadius: 8,
                      background: "rgba(0,0,0,0.2)",
                      border: `1px solid ${border}`,
                      marginBottom: 10,
                      fontSize: 12,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", color: mutedLight, marginBottom: 4 }}>
                        <span>You'd receive (80%)</span>
                        <span style={{ color: green, fontWeight: 700 }}>{formatEth(resellSplit.sellerAmount)} ETN</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", color: mutedLight }}>
                        <span>Burn pool (20%)</span>
                        <span>{formatEth(resellSplit.burnAmount)} ETN</span>
                      </div>
                    </div>
                  )}
                  {resellError && (
                    <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{resellError}</div>
                  )}
                  <NeonButton
                    variant="green"
                    onClick={handleListForResale}
                    disabled={resellLoading || !resellPriceInput}
                    loading={resellLoading}
                    style={{ width: "100%", justifyContent: "center" }}
                  >
                    {resellLoading ? "Listing..." : "List for Resale"}
                  </NeonButton>
                </div>
              )}
            </div>
          )}

          {isSubname && (
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: "uppercase",
                color: muted,
                marginBottom: 12,
              }}>
                Send Subname
              </div>

              <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10 }}>
                Transfer {verifiedName}.etn to another wallet. This is irreversible — the
                recipient becomes the new owner and you lose all control over it, including
                pricing or managing its own sub-subnames.
              </div>

              <input
                type="text"
                placeholder="Recipient wallet address (0x...)"
                value={sendAddress}
                onChange={(e) => setSendAddress(e.target.value)}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: `1px solid ${border}`,
                  background: panel2,
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 600,
                  boxSizing: "border-box",
                  outline: "none",
                  marginBottom: 10,
                }}
              />

              {sendError && (
                <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{sendError}</div>
              )}

              <NeonButton
                variant="danger"
                onClick={handleSendSubname}
                disabled={sendLoading || !sendAddress.trim()}
                loading={sendLoading}
                style={{ width: "100%", justifyContent: "center" }}
              >
                {sendLoading ? "Sending..." : "Send Subname"}
              </NeonButton>
            </div>
          )}
          </>
          )}
        </div>
      )}
    </div>
  );
}
