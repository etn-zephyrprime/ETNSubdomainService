import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { QRCodeSVG } from "qrcode.react";
import { ArrowLeft, Copy, Check } from "lucide-react";
import { green, greenGlow, muted, mutedLight, error, panel2, border, orange } from "../styles/theme.js";
import { usePayment, calculateFeeDisplay } from "../hooks/usePayment.js";
import { useReverseRecord } from "../hooks/useReverseRecord.js";
import NeonButton from "./NeonButton.jsx";
import { EXPLORER_BASE_URL } from "../config.js";

// Centered inside the Receive QR code below — public/ so Vite serves it at this exact path in
// both dev and the built site, no import/bundling needed. Square (186x186 viewBox) and high
// contrast, which is what keeps a logo-in-QR readable: qrcode.react's excavate option clears the
// modules directly behind it and level="H" (30% error correction, the max the spec allows)
// covers the loss, but a busy/low-contrast image would still degrade scans.
const QR_LOGO_SRC = "/electroneum-logo-symbol.svg";

const MODES = [
  { id: "send", label: "Send" },
  { id: "receive", label: "Receive" },
];

const TABS = [
  { id: "etn", label: "Send ETN" },
  { id: "token", label: "Send Token" },
  { id: "nft", label: "Send NFT" },
];

const inputStyle = {
  width: "100%",
  padding: "14px 16px",
  borderRadius: 12,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontSize: 15,
  fontWeight: 600,
  boxSizing: "border-box",
  outline: "none",
};

const labelStyle = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: muted,
  marginBottom: 8,
};

// First-of-its-kind on Electroneum: pay a .etn name directly instead of a raw address, for
// native ETN, any ERC-20 token, or any ERC-721 NFT. Recipient resolution is shared across all
// three tabs; the asset-specific fields (amount / contract address / token id) are not.
export default function PayFlow({ wallet, onBack = null, initialRecipient = null }) {
  const [mode, setMode] = useState("send");
  const [tab, setTab] = useState("etn");

  const [recipientInput, setRecipientInput] = useState(
    () => (initialRecipient || "").toLowerCase().trim()
  );
  const [resolvedAddress, setResolvedAddress] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);

  const [etnAmount, setEtnAmount] = useState("");

  const [tokenAddress, setTokenAddress] = useState("");
  const [tokenAmount, setTokenAmount] = useState("");
  const [tokenInfo, setTokenInfo] = useState(null); // { symbol, decimals }
  const [tokenLookupLoading, setTokenLookupLoading] = useState(false);
  const [tokenLookupError, setTokenLookupError] = useState(null);

  const [nftAddress, setNftAddress] = useState("");
  const [nftTokenId, setNftTokenId] = useState("");
  const [nftOwner, setNftOwner] = useState(null);
  const [nftLookupLoading, setNftLookupLoading] = useState(false);
  const [nftLookupError, setNftLookupError] = useState(null);

  const [sendLoading, setSendLoading] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const [feeTxHash, setFeeTxHash] = useState(null);
  const [success, setSuccess] = useState(false);

  const { resolveName, sendEtn, getTokenInfo, sendToken, getNftOwner, sendNft } = usePayment();
  const { getPrimaryName } = useReverseRecord();

  // Receive tab — the connected wallet's own primary name (same record Header.jsx and
  // ManageSubdomain.jsx's "Primary Name" section use) is what a /pay/<name> link is built from,
  // since that's the one name that's unambiguously "yours" without a fresh on-chain ownership
  // lookup for whatever else the wallet might hold.
  const [primaryName, setPrimaryName] = useState(null);
  const [primaryNameLoading, setPrimaryNameLoading] = useState(false);
  const [copyLinkStatus, setCopyLinkStatus] = useState(null); // null | "copied" | "error"

  useEffect(() => {
    let cancelled = false;
    if (mode !== "receive" || !wallet.account) return;

    setPrimaryNameLoading(true);
    getPrimaryName(wallet.account)
      .then((name) => { if (!cancelled) setPrimaryName(name); })
      .catch((err) => {
        console.error("Failed to fetch primary name:", err);
        if (!cancelled) setPrimaryName(null);
      })
      .finally(() => { if (!cancelled) setPrimaryNameLoading(false); });

    return () => { cancelled = true; };
  }, [mode, wallet.account, getPrimaryName]);

  const payLinkFor = (name) => `${window.location.origin}/pay/${name}`;

  const handleCopyPayLink = async () => {
    try {
      await navigator.clipboard.writeText(payLinkFor(primaryName));
      setCopyLinkStatus("copied");
      setTimeout(() => setCopyLinkStatus(null), 2000);
    } catch (err) {
      console.error("Copying pay link failed:", err);
      setCopyLinkStatus("error");
    }
  };

  // Debounced recipient resolution — same 500ms pattern as SearchBar's availability check.
  useEffect(() => {
    setResolvedAddress(null);
    setResolveError(null);
    if (!recipientInput.trim()) return;

    setResolving(true);
    const timer = setTimeout(async () => {
      try {
        const address = await resolveName(recipientInput);
        setResolvedAddress(address);
      } catch (err) {
        setResolveError(err.message);
      } finally {
        setResolving(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [recipientInput, resolveName]);

  // Token metadata lookup, debounced the same way — only fires once the address looks complete.
  useEffect(() => {
    setTokenInfo(null);
    setTokenLookupError(null);
    if (!ethers.isAddress(tokenAddress)) return;

    setTokenLookupLoading(true);
    const timer = setTimeout(async () => {
      try {
        const info = await getTokenInfo(tokenAddress);
        setTokenInfo(info);
      } catch (err) {
        console.error("Token lookup failed:", err);
        setTokenLookupError("Couldn't read this contract as an ERC-20 token");
      } finally {
        setTokenLookupLoading(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [tokenAddress, getTokenInfo]);

  // NFT ownership lookup — confirms the connected wallet actually holds the token before Send is
  // enabled, so a mistyped id or address fails fast with a clear message.
  useEffect(() => {
    setNftOwner(null);
    setNftLookupError(null);
    if (!ethers.isAddress(nftAddress) || nftTokenId.trim() === "") return;

    setNftLookupLoading(true);
    const timer = setTimeout(async () => {
      try {
        const owner = await getNftOwner(nftAddress, nftTokenId.trim());
        setNftOwner(owner);
      } catch (err) {
        console.error("NFT lookup failed:", err);
        setNftLookupError("Couldn't find this token — check the contract address and token id");
      } finally {
        setNftLookupLoading(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [nftAddress, nftTokenId, getNftOwner]);

  const resetAssetFields = () => {
    setEtnAmount("");
    setTokenAddress(""); setTokenAmount(""); setTokenInfo(null); setTokenLookupError(null);
    setNftAddress(""); setNftTokenId(""); setNftOwner(null); setNftLookupError(null);
    setSendError(null);
  };

  const handleTabChange = (id) => {
    setTab(id);
    resetAssetFields();
  };

  const etnFee = tab === "etn" ? calculateFeeDisplay(etnAmount) : null;
  const tokenFee = tab === "token" && tokenInfo ? calculateFeeDisplay(tokenAmount, tokenInfo.decimals) : null;

  const nftOwnedByWallet =
    nftOwner && wallet.account && nftOwner.toLowerCase() === wallet.account.toLowerCase();

  const canSend =
    !!resolvedAddress &&
    !sendLoading &&
    (tab === "etn"
      ? Number(etnAmount) > 0
      : tab === "token"
      ? !!tokenInfo && Number(tokenAmount) > 0
      : !!nftOwnedByWallet);

  const handleSend = async () => {
    if (!wallet.isConnected) {
      await wallet.connectWallet();
      return;
    }
    setSendError(null);
    setSendLoading(true);
    try {
      await wallet.ensureCorrectNetwork();
      const signer = await wallet.getSigner();

      let result;
      if (tab === "etn") {
        result = await sendEtn(resolvedAddress, etnAmount, signer);
      } else if (tab === "token") {
        result = await sendToken(tokenAddress, resolvedAddress, tokenAmount, tokenInfo.decimals, signer);
      } else {
        result = await sendNft(nftAddress, resolvedAddress, nftTokenId.trim(), wallet.account, signer);
      }

      setTxHash(result.txHash);
      setFeeTxHash(result.feeTxHash ?? null);
      setSuccess(true);
    } catch (err) {
      console.error("Payment failed:", err);
      setSendError(err?.reason || err?.message || "Send failed");
    } finally {
      setSendLoading(false);
    }
  };

  const handleSendAnother = () => {
    setSuccess(false);
    setTxHash(null);
    setFeeTxHash(null);
    setSendError(null);
    resetAssetFields();
  };

  if (success) {
    return (
      <div style={{ width: "100%", maxWidth: 600, margin: "0 auto", padding: "0 16px" }}>
        <div style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
          <h2 style={{ fontSize: 28, fontWeight: 900, color: green, marginBottom: 8 }}>Sent!</h2>
          <p style={{ fontSize: 13, color: mutedLight, marginBottom: 24, lineHeight: 1.6 }}>
            {tab === "etn" && <>Sent <strong>{etnAmount} ETN</strong> to <strong>{recipientInput.replace(/\.etn$/, "")}.etn</strong></>}
            {tab === "token" && <>Sent <strong>{tokenAmount} {tokenInfo?.symbol}</strong> to <strong>{recipientInput.replace(/\.etn$/, "")}.etn</strong></>}
            {tab === "nft" && <>Sent token id <strong>{nftTokenId}</strong> to <strong>{recipientInput.replace(/\.etn$/, "")}.etn</strong></>}
          </p>

          {feeTxHash && (
            <p style={{ fontSize: 11, color: mutedLight, marginTop: -16, marginBottom: 24 }}>
              Platform fee (0.3%, on top of the amount above) sent as a separate transaction.
            </p>
          )}

          {(txHash || feeTxHash) && (
            <div style={{ display: "flex", justifyContent: "center", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
              {txHash && (
                <a
                  href={`${EXPLORER_BASE_URL}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12, color: green, textDecoration: "none", borderBottom: `1px solid ${green}` }}
                >
                  View Transaction →
                </a>
              )}
              {feeTxHash && (
                <a
                  href={`${EXPLORER_BASE_URL}/tx/${feeTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12, color: green, textDecoration: "none", borderBottom: `1px solid ${green}` }}
                >
                  View Fee Transaction →
                </a>
              )}
            </div>
          )}

          <NeonButton variant="green" onClick={handleSendAnother} style={{ width: "100%" }}>
            Send Another
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
          Pay
        </div>
        <h2 style={{ fontSize: 28, fontWeight: 900, margin: "0 0 12px 0", color: "#fff", textShadow: `0 0 16px ${greenGlow}` }}>
          {mode === "send" ? "Send to a Name" : "Get Paid to a Name"}
        </h2>
        <div style={{ width: 40, height: 2, background: green, margin: "0 auto", borderRadius: 2, boxShadow: `0 0 8px ${greenGlow}` }} />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            style={{
              flex: 1,
              padding: "12px 8px",
              borderRadius: 10,
              border: `1px solid ${m.id === mode ? green : border}`,
              background: m.id === mode ? "rgba(18,86,131,0.12)" : panel2,
              color: m.id === mode ? green : mutedLight,
              fontSize: 14,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "receive" ? (
        <div style={{
          padding: 20,
          borderRadius: 12,
          background: panel2,
          border: `1px solid ${border}`,
          textAlign: "center",
        }}>
          {!wallet.isConnected ? (
            <>
              <div style={{ fontSize: 13, color: mutedLight, marginBottom: 16 }}>
                Connect your wallet to get your personal Pay link.
              </div>
              <NeonButton variant="green" onClick={wallet.connectWallet} style={{ width: "100%", justifyContent: "center" }}>
                Connect Wallet
              </NeonButton>
            </>
          ) : primaryNameLoading ? (
            <div style={{ fontSize: 13, color: mutedLight }}>Checking your primary name...</div>
          ) : primaryName ? (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
                Your Pay Link
              </div>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#fff", marginBottom: 16 }}>
                {primaryName}
              </div>

              {/* White card — QR scanners rely on high contrast, and this panel's own dark
                  background isn't reliably that regardless of module color. */}
              <div style={{
                display: "inline-block",
                padding: 16,
                borderRadius: 16,
                background: "#fff",
                boxShadow: `0 0 20px ${greenGlow}`,
                marginBottom: 16,
              }}>
                <QRCodeSVG
                  value={payLinkFor(primaryName)}
                  size={200}
                  level="H"
                  bgColor="#ffffff"
                  fgColor="#0a0a0a"
                  imageSettings={{
                    src: QR_LOGO_SRC,
                    height: 40,
                    width: 40,
                    excavate: true,
                  }}
                />
              </div>

              <div style={{
                fontSize: 12,
                color: mutedLight,
                marginBottom: 16,
                wordBreak: "break-all",
                fontFamily: "monospace",
              }}>
                {payLinkFor(primaryName)}
              </div>
              <NeonButton
                variant="green"
                onClick={handleCopyPayLink}
                style={{ width: "100%", justifyContent: "center", display: "flex", alignItems: "center", gap: 8 }}
              >
                {copyLinkStatus === "copied" ? <Check size={16} /> : <Copy size={16} />}
                {copyLinkStatus === "copied" ? "Copied!" : "Copy Pay Link"}
              </NeonButton>
              {copyLinkStatus === "error" && (
                <div style={{ fontSize: 12, color: error, marginTop: 8 }}>
                  Couldn't copy automatically — copy the link above manually.
                </div>
              )}
              <div style={{ fontSize: 11, color: mutedLight, marginTop: 16, lineHeight: 1.6 }}>
                Anyone who opens this link lands straight on the Send screen with{" "}
                <strong>{primaryName}</strong> as the recipient.
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: mutedLight, lineHeight: 1.6 }}>
              You don't have a primary name set yet — set one from "Your Names" on the home
              screen to get a personal Pay link.
            </div>
          )}
        </div>
      ) : (
      <>
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => handleTabChange(t.id)}
            style={{
              flex: 1,
              padding: "10px 8px",
              borderRadius: 10,
              border: `1px solid ${t.id === tab ? green : border}`,
              background: t.id === tab ? "rgba(18,86,131,0.12)" : panel2,
              color: t.id === tab ? green : mutedLight,
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 20 }}>
        <div style={labelStyle}>Recipient name</div>
        <input
          type="text"
          placeholder="alice or shop.alice"
          value={recipientInput}
          onChange={(e) => setRecipientInput(e.target.value.toLowerCase().trim())}
          style={{
            ...inputStyle,
            borderColor: resolveError ? error : resolvedAddress ? green : border,
          }}
        />
        {resolving && (
          <div style={{ fontSize: 12, color: mutedLight, marginTop: 8 }}>Resolving...</div>
        )}
        {!resolving && resolvedAddress && (
          <div style={{ fontSize: 12, color: green, marginTop: 8 }}>
            ✓ Resolves to {resolvedAddress.slice(0, 6)}...{resolvedAddress.slice(-4)}
          </div>
        )}
        {!resolving && resolveError && (
          <div style={{ fontSize: 12, color: error, marginTop: 8 }}>{resolveError}</div>
        )}
      </div>

      {tab === "etn" && (
        <div style={{ marginBottom: 24 }}>
          <div style={labelStyle}>Amount (ETN)</div>
          <input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            value={etnAmount}
            onChange={(e) => setEtnAmount(e.target.value)}
            style={inputStyle}
          />
          {etnFee && (
            <div style={{ fontSize: 12, color: mutedLight, marginTop: 8 }}>
              +0.3% platform fee: {etnFee.fee} ETN — total {etnFee.total} ETN
            </div>
          )}
        </div>
      )}

      {tab === "token" && (
        <div style={{ marginBottom: 24 }}>
          <div style={labelStyle}>Token contract address</div>
          <input
            type="text"
            placeholder="0x..."
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value.trim())}
            style={{ ...inputStyle, marginBottom: 12 }}
          />
          {tokenLookupLoading && <div style={{ fontSize: 12, color: mutedLight, marginBottom: 12 }}>Looking up token...</div>}
          {tokenLookupError && <div style={{ fontSize: 12, color: error, marginBottom: 12 }}>{tokenLookupError}</div>}
          {tokenInfo && (
            <div style={{ fontSize: 12, color: green, marginBottom: 12 }}>
              ✓ {tokenInfo.symbol} ({tokenInfo.decimals} decimals)
            </div>
          )}

          <div style={labelStyle}>Amount {tokenInfo ? `(${tokenInfo.symbol})` : ""}</div>
          <input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            value={tokenAmount}
            onChange={(e) => setTokenAmount(e.target.value)}
            disabled={!tokenInfo}
            style={{ ...inputStyle, opacity: tokenInfo ? 1 : 0.5 }}
          />
          {tokenFee && (
            <div style={{ fontSize: 12, color: mutedLight, marginTop: 8 }}>
              +0.3% platform fee: {tokenFee.fee} {tokenInfo.symbol} — total {tokenFee.total} {tokenInfo.symbol}
            </div>
          )}
        </div>
      )}

      {tab === "nft" && (
        <div style={{ marginBottom: 24 }}>
          <div style={labelStyle}>NFT contract address</div>
          <input
            type="text"
            placeholder="0x..."
            value={nftAddress}
            onChange={(e) => setNftAddress(e.target.value.trim())}
            style={{ ...inputStyle, marginBottom: 12 }}
          />

          <div style={labelStyle}>Token ID</div>
          <input
            type="text"
            inputMode="numeric"
            placeholder="1234"
            value={nftTokenId}
            onChange={(e) => setNftTokenId(e.target.value.replace(/[^0-9]/g, ""))}
            style={{ ...inputStyle, marginBottom: 12 }}
          />

          {nftLookupLoading && <div style={{ fontSize: 12, color: mutedLight }}>Checking ownership...</div>}
          {nftLookupError && <div style={{ fontSize: 12, color: error }}>{nftLookupError}</div>}
          {nftOwner && !nftLookupLoading && (
            <div style={{ fontSize: 12, color: nftOwnedByWallet ? green : orange }}>
              {nftOwnedByWallet
                ? "✓ You own this token"
                : `Owned by ${nftOwner.slice(0, 6)}...${nftOwner.slice(-4)}, not your connected wallet`}
            </div>
          )}
        </div>
      )}

      {sendError && (
        <div style={{ fontSize: 12, color: error, marginBottom: 12, textAlign: "center" }}>
          {sendError}
        </div>
      )}

      <NeonButton
        variant="green"
        onClick={handleSend}
        disabled={!wallet.isConnected ? false : !canSend}
        loading={sendLoading}
        style={{ width: "100%", justifyContent: "center" }}
      >
        {!wallet.isConnected
          ? "Connect Wallet"
          : sendLoading
          ? "Sending..."
          : tab === "etn"
          ? "Send ETN"
          : tab === "token"
          ? "Send Token"
          : "Send NFT"}
      </NeonButton>
      </>
      )}
    </div>
  );
}
