import React, { useState } from "react";
import { ethers } from "ethers";
import { ArrowLeft } from "lucide-react";
import { green, greenGlow, muted, mutedLight, error, panel2, border } from "../styles/theme.js";
import { useRenewal } from "../hooks/useRenewal.js";
import { useSubnamePricing } from "../hooks/useSubnamePricing.js";
import { useReverseRecord } from "../hooks/useReverseRecord.js";
import { computeNode, computeSubnode } from "../utils/ens.js";
import { formatEth } from "../utils/format.js";
import NeonButton from "./NeonButton.jsx";
import { DEFAULT_DURATION_SECONDS, MIN_SUBNAME_PRICE_PER_YEAR_ETN } from "../config.js";

const MIN_SUBNAME_PRICE_PER_YEAR_WEI = ethers.parseEther(MIN_SUBNAME_PRICE_PER_YEAR_ETN);

// "Your Names" — look up a name you own, view its expiry, renew it, and set a price for
// self-serve subname registration under it (activation/approval handled inline as needed).
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

  const { getOwner, getOwnerByNode, getCurrentExpiry, getNameWrapperExpiry, quoteRenewal, renewName } = useRenewal();
  const {
    isDomainActivated,
    getActivationFee,
    activateDomain,
    isMarketplaceApproved,
    approveMarketplace,
    getSubnamePricePerYear,
    setSubnamePricePerYear,
  } = useSubnamePricing();
  const { getPrimaryName, setName: setReverseName } = useReverseRecord();

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
    setApproved(null);
    setApproveError(null);
    setCurrentPrice(null);
    setPriceInput("");
    setPriceError(null);
    setPriceSuccess(false);
    setPrimaryNameState(null);
    setSetPrimaryError(null);
    setSetPrimarySuccess(false);

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
      } else {
        const fee = await getActivationFee(normalizedInput, domainNode);
        setActivationFee(fee);
      }
    } catch (err) {
      console.error("Name lookup failed:", err);
      setLookupError(err?.reason || err?.message || "Lookup failed");
    } finally {
      setLookupLoading(false);
    }
  };

  const handleActivate = async () => {
    setActivationError(null);
    setActivationLoading(true);
    try {
      const signer = await wallet.getSigner();
      await activateDomain(node, verifiedName, activationFee, signer);
      setActivated(true);

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
            background: "rgba(0, 255, 140, 0.06)",
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
          {intent === "retro" ? "Earn Fees on Subnames" : "Your Names"}
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
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 12 }}>
            {verifiedName}.etn
          </div>

          {expiryDate && (
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
          )}

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
              {isSubname ? "Sub-subname Pricing" : "Subname Pricing"}
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
                {activationError && (
                  <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{activationError}</div>
                )}
                <NeonButton
                  variant="dark"
                  onClick={handleActivate}
                  disabled={activationLoading || !activationFee}
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
        </div>
      )}
    </div>
  );
}
