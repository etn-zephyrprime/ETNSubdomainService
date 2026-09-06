import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { Wallet as WalletIcon, Lock, X as XIcon } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import { useWalletAuthSignature } from "../../../hooks/useWalletAuthSignature.js";
import { useTrackedWallets } from "../../hooks/useTrackedWallets.js";
import { useCombinedPortfolio } from "../../hooks/useCombinedPortfolio.js";
import { useTokenChart } from "../../hooks/useTokenChart.js";
import { formatTokenAmount, formatUsdPrice, formatEtnBalance, isSpamTokenName, shortHash } from "../../utils/format.js";
import { green, greenGlow, muted, mutedLight, border, panel2, error as errorColor } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const MAX_TRACKED_WALLETS = 3;
const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);
const MAX_PRICED_HOLDINGS = 25; // matches AddressLookup.jsx's own cap

// Same "no known price yet -> omit the $ figure, never fake one" convention as AddressLookup.jsx's
// own tokenUsdValue.
function tokenUsdValue(rawValue, decimals, priceUsd) {
  if (priceUsd == null) return null;
  try {
    const amount = parseFloat(ethers.formatUnits(rawValue, decimals == null ? 18 : Number(decimals)));
    return Number.isFinite(amount) ? amount * priceUsd : null;
  } catch {
    return null;
  }
}

const smallInputStyle = {
  flex: 1,
  padding: "10px 12px",
  borderRadius: 10,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  boxSizing: "border-box",
  outline: "none",
  fontFamily: "monospace",
};

// Core tier's flagship feature: track up to MAX_TRACKED_WALLETS wallets (your own, cold storage,
// a friend's — anything; no ownership proof is required of the *tracked* wallets, only of the
// member's own connected one) and see their combined ETN + token balances as one merged
// portfolio. Always mounted regardless of wallet/membership state — same "decide what to show
// internally, don't gate at the call site" pattern as PnlStatementRequest.jsx.
export default function CoreTierPortfolio({ wallet }) {
  const getAuthParams = useWalletAuthSignature(wallet);
  const { getTrackedWallets, setTrackedWallets } = useTrackedWallets();
  const { getCombinedPortfolio } = useCombinedPortfolio();
  const { getTokenChart } = useTokenChart();

  // null = not checked yet (or wallet not connected), true/false once known — reset on every
  // account change so a previous account's answer never leaks into the new one for even one
  // render.
  const [hasAccess, setHasAccess] = useState(null);
  const [accessError, setAccessError] = useState(null);

  const [trackedWallets, setSavedWallets] = useState([]); // the saved list, from the backend
  const [editedWallets, setEditedWallets] = useState([]); // draft list the editor below mutates
  const [editing, setEditing] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [addInput, setAddInput] = useState("");
  const [addError, setAddError] = useState(null);

  const [portfolio, setPortfolio] = useState(null); // null = loading/nothing to show yet
  const [portfolioError, setPortfolioError] = useState(null);
  const [tokenPrices, setTokenPrices] = useState({}); // lowercased token address -> USD price

  // Load Core tier access + the saved tracked-wallet list whenever the connected account
  // changes — also drops any in-progress edit, since a draft list built for the previous account
  // has no business surviving a disconnect/account switch.
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
    setAddInput("");
    setAddError(null);

    if (!wallet.isConnected || !wallet.account) {
      setHasAccess(null);
      setSavedWallets([]);
      return;
    }
    let cancelled = false;
    setHasAccess(null);
    setAccessError(null);
    (async () => {
      try {
        const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
        const res = await getTrackedWallets(wallet.account, signature, timestamp);
        if (cancelled) return;
        setHasAccess(true);
        setSavedWallets(res.wallets || []);
      } catch (err) {
        if (cancelled) return;
        if (err.message === "CORE_ACCESS_REQUIRED") {
          setHasAccess(false);
        } else {
          console.error("Failed to load tracked wallets:", err);
          setAccessError(err.message || "Couldn't check Core tier access");
          setHasAccess(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [wallet.isConnected, wallet.account, getAuthParams, getTrackedWallets]);

  // Combined portfolio loads whenever the *saved* tracked-wallet list changes (editing a draft
  // doesn't refetch anything until it's actually saved).
  useEffect(() => {
    if (!hasAccess || trackedWallets.length === 0) {
      setPortfolio(null);
      return;
    }
    let cancelled = false;
    setPortfolio(null);
    setPortfolioError(null);
    setTokenPrices({});
    getCombinedPortfolio(trackedWallets)
      .then((res) => { if (!cancelled) setPortfolio(res); })
      .catch((err) => {
        console.error("Failed to load combined portfolio:", err);
        if (!cancelled) setPortfolioError("Couldn't load portfolio data — try again shortly.");
      });
    return () => { cancelled = true; };
  }, [hasAccess, trackedWallets, getCombinedPortfolio]);

  // USD price per merged token — one small independent request each, same pattern (and the same
  // MAX_PRICED_HOLDINGS cap) as AddressLookup.jsx's own price-fetching effect.
  useEffect(() => {
    if (!portfolio) return;
    const fungible = portfolio.tokens.filter((t) => t.token?.address && !NFT_TOKEN_TYPES.has(t.token?.type));
    if (fungible.length === 0) return;
    let cancelled = false;
    fungible.slice(0, MAX_PRICED_HOLDINGS).forEach((t) => {
      const addr = t.token.address.toLowerCase();
      getTokenChart(t.token.address, "7")
        .then((res) => {
          if (cancelled || !res?.hasData || !res.candles?.length) return;
          setTokenPrices((prev) => ({ ...prev, [addr]: res.candles[res.candles.length - 1].close }));
        })
        .catch((err) => console.error(`Failed to load price for ${addr}:`, err.message));
    });
    return () => { cancelled = true; };
  }, [portfolio, getTokenChart]);

  const startEditing = () => {
    setEditedWallets(trackedWallets);
    setAddInput("");
    setAddError(null);
    setSaveError(null);
    setEditing(true);
  };

  const handleAddWallet = () => {
    setAddError(null);
    const trimmed = addInput.trim();
    if (!trimmed) return;
    if (!ethers.isAddress(trimmed)) {
      setAddError("Enter a valid wallet address");
      return;
    }
    if (editedWallets.length >= MAX_TRACKED_WALLETS) {
      setAddError(`You can track up to ${MAX_TRACKED_WALLETS} wallets`);
      return;
    }
    if (editedWallets.some((w) => w.toLowerCase() === trimmed.toLowerCase())) {
      setAddError("Already tracking that wallet");
      return;
    }
    setEditedWallets((prev) => [...prev, trimmed]);
    setAddInput("");
  };

  const handleTrackMine = () => {
    setAddError(null);
    if (editedWallets.some((w) => w.toLowerCase() === wallet.account.toLowerCase())) return;
    if (editedWallets.length >= MAX_TRACKED_WALLETS) {
      setAddError(`You can track up to ${MAX_TRACKED_WALLETS} wallets`);
      return;
    }
    setEditedWallets((prev) => [...prev, wallet.account]);
  };

  const handleRemoveWallet = (address) => {
    setEditedWallets((prev) => prev.filter((w) => w.toLowerCase() !== address.toLowerCase()));
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaveLoading(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await setTrackedWallets(wallet.account, signature, timestamp, editedWallets);
      setSavedWallets(res.wallets || editedWallets);
      setEditing(false);
    } catch (err) {
      console.error("Failed to save tracked wallets:", err);
      setSaveError(err.message || "Couldn't save your tracked wallets");
    } finally {
      setSaveLoading(false);
    }
  };

  // Raw on-chain amounts aren't comparable across tokens with different decimals, so this only
  // sorts biggest-holding-of-its-own-token first within a fixed rendering position, not by any
  // notion of relative value — same caveat as AddressLookup.jsx's own (unsorted) holdings list,
  // just made deterministic here since merging can reorder tokens run to run otherwise.
  const visibleTokens = portfolio
    ? portfolio.tokens
        .filter((t) => !isSpamTokenName(t.token?.name))
        .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
    : [];

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <WalletIcon size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Core Tier — Portfolio
        </div>
      </div>

      {!wallet.isConnected ? (
        <div>
          <div style={{ fontSize: 12, color: mutedLight, marginBottom: 12 }}>
            Connect your wallet to track up to {MAX_TRACKED_WALLETS} wallets and see their combined ETN + token balances in one view.
          </div>
          <DashboardButton onClick={wallet.connectWallet} style={{ width: "100%", justifyContent: "center" }}>
            Connect Wallet
          </DashboardButton>
        </div>
      ) : hasAccess === null ? (
        <div style={{ fontSize: 12, color: mutedLight }}>Checking Core tier access…</div>
      ) : accessError ? (
        <div style={{ fontSize: 12, color: errorColor }}>{accessError}</div>
      ) : hasAccess === false ? (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Lock size={16} color={muted} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
            Core tier membership required — track up to {MAX_TRACKED_WALLETS} wallets and see their
            combined portfolio in one view. Subscribe (monthly or annual — either works) below to
            unlock it.
          </div>
        </div>
      ) : (
        <div>
          {!editing ? (
            <>
              {trackedWallets.length === 0 ? (
                <div style={{ fontSize: 12, color: mutedLight, marginBottom: 14 }}>
                  No wallets tracked yet — add up to {MAX_TRACKED_WALLETS} to see your combined portfolio.
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                  {trackedWallets.map((w) => (
                    <div
                      key={w}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: `1px solid ${border}`,
                        background: panel2,
                        color: mutedLight,
                        fontSize: 11,
                        fontFamily: "monospace",
                      }}
                    >
                      {w.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                      {shortHash(w)}
                    </div>
                  ))}
                </div>
              )}
              <DashboardButton onClick={startEditing} style={{ width: "100%", justifyContent: "center" }}>
                {trackedWallets.length === 0 ? "Add Wallets" : "Manage Tracked Wallets"}
              </DashboardButton>
            </>
          ) : (
            <div>
              <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10 }}>
                Any address works — your own, cold storage, or anyone else's you want to watch. You
                only ever prove ownership of your own connected wallet, never of the ones you track.
              </div>

              {editedWallets.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {editedWallets.map((w) => (
                    <div
                      key={w}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: `1px solid ${border}`,
                        background: panel2,
                      }}
                    >
                      <span style={{ fontSize: 12, fontFamily: "monospace", color: "#fff" }}>
                        {w.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                        {shortHash(w, 8)}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveWallet(w)}
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
                        aria-label={`Stop tracking ${w}`}
                      >
                        <XIcon size={14} color={errorColor} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {editedWallets.length < MAX_TRACKED_WALLETS && (
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <input
                    type="text"
                    placeholder="0x... wallet address"
                    value={addInput}
                    onChange={(e) => setAddInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddWallet(); }}
                    style={smallInputStyle}
                  />
                  <button
                    type="button"
                    onClick={handleAddWallet}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: `1px solid ${green}`,
                      background: "rgba(24,187,26,0.12)",
                      color: green,
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Add
                  </button>
                </div>
              )}

              {editedWallets.length < MAX_TRACKED_WALLETS &&
                !editedWallets.some((w) => w.toLowerCase() === wallet.account?.toLowerCase()) && (
                <button
                  type="button"
                  onClick={handleTrackMine}
                  style={{
                    display: "block",
                    background: "none",
                    border: "none",
                    color: green,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: "pointer",
                    padding: "2px 0 10px",
                  }}
                >
                  + Track my connected wallet
                </button>
              )}

              {addError && <div style={{ fontSize: 11, color: errorColor, marginBottom: 10 }}>{addError}</div>}
              {saveError && <div style={{ fontSize: 11, color: errorColor, marginBottom: 10 }}>{saveError}</div>}

              <div style={{ display: "flex", gap: 8 }}>
                <DashboardButton onClick={handleSave} disabled={saveLoading} loading={saveLoading} style={{ flex: 1, justifyContent: "center" }}>
                  Save
                </DashboardButton>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  disabled={saveLoading}
                  style={{
                    flex: 1,
                    padding: "12px 16px",
                    borderRadius: 12,
                    border: `1px solid ${border}`,
                    background: panel2,
                    color: mutedLight,
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: saveLoading ? "not-allowed" : "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!editing && trackedWallets.length > 0 && (
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
              {portfolioError ? (
                <div style={{ fontSize: 12, color: errorColor }}>{portfolioError}</div>
              ) : !portfolio ? (
                <div style={{ fontSize: 12, color: mutedLight }}>Loading combined portfolio…</div>
              ) : (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
                      Combined ETN Balance
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", textShadow: `0 0 10px ${greenGlow}` }}>
                      {formatEtnBalance(portfolio.totalCoinBalance)} ETN
                    </div>
                    <div style={{ fontSize: 11, color: mutedLight, marginTop: 4 }}>
                      Across {trackedWallets.length} tracked wallet{trackedWallets.length === 1 ? "" : "s"}
                    </div>
                  </div>

                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
                    Combined Holdings
                  </div>
                  {visibleTokens.length === 0 ? (
                    <div style={{ fontSize: 12, color: muted }}>No token balances across your tracked wallets.</div>
                  ) : (
                    visibleTokens.slice(0, 25).map((t, i) => {
                      const usdValue = tokenUsdValue(t.value, t.token?.decimals, tokenPrices[t.token?.address?.toLowerCase()]);
                      return (
                        <div
                          key={`${t.token?.address}-${i}`}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            padding: "8px 0",
                            borderBottom: `1px solid ${border}`,
                          }}
                        >
                          <span style={{ fontSize: 12, color: "#fff" }}>
                            {t.token?.name || "Unknown"} <span style={{ color: mutedLight }}>{t.token?.symbol}</span>
                            {t.heldBy.length > 1 && (
                              <span style={{ display: "block", fontSize: 10, color: muted }}>
                                Held in {t.heldBy.length} of {trackedWallets.length} wallets
                              </span>
                            )}
                          </span>
                          <span style={{ textAlign: "right" }}>
                            <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>{formatTokenAmount(t.value, t.token?.decimals)}</span>
                            {usdValue != null && (
                              <span style={{ display: "block", fontSize: 11, color: mutedLight }}>{formatUsdPrice(usdValue)}</span>
                            )}
                          </span>
                        </div>
                      );
                    })
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
