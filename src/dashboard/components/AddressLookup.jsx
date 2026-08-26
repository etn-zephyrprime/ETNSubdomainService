import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { green, mutedLight, muted, panel2, border, error as errorColor } from "../../styles/theme.js";
import { useBlockscout } from "../hooks/useBlockscout.js";
import { usePayment } from "../../hooks/usePayment.js";
import { formatCompact, formatTokenAmount, formatEtnBalance, shortHash } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import NeonButton from "../../components/NeonButton.jsx";

const inputStyle = {
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
};

// Session-only single wallet lookup (free tier) — accepts either a raw 0x address or a .etn name,
// reusing usePayment.js's existing resolveName() rather than re-implementing name resolution a
// second time. Nothing here is persisted; re-searching starts fresh, same as the brief's "not
// persisted" free-tier spec.
export default function AddressLookup({ initialAddress = null }) {
  const { getAddress, getAddressCounters, getAddressTokenBalances } = useBlockscout();
  const { resolveName } = usePayment();

  const [input, setInput] = useState(initialAddress || "");
  const [resolvedAddress, setResolvedAddress] = useState(initialAddress || null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);

  const [addressInfo, setAddressInfo] = useState(null);
  const [counters, setCounters] = useState(null);
  const [tokenBalances, setTokenBalances] = useState([]);
  const [loadError, setLoadError] = useState(null);

  const handleLookup = async () => {
    setResolveError(null);
    setAddressInfo(null);
    setLoadError(null);

    const trimmed = input.trim();
    if (!trimmed) return;

    setResolving(true);
    try {
      const address = ethers.isAddress(trimmed) ? trimmed : await resolveName(trimmed);
      setResolvedAddress(address);
    } catch (err) {
      setResolveError(err.message || "Couldn't resolve that address or name");
      setResolvedAddress(null);
    } finally {
      setResolving(false);
    }
  };

  useEffect(() => {
    if (!resolvedAddress) return;
    let cancelled = false;
    (async () => {
      try {
        const [info, counterRes, balances] = await Promise.all([
          getAddress(resolvedAddress),
          getAddressCounters(resolvedAddress),
          getAddressTokenBalances(resolvedAddress),
        ]);
        if (cancelled) return;
        setAddressInfo(info);
        setCounters(counterRes);
        setTokenBalances(Array.isArray(balances) ? balances : []);
      } catch (err) {
        console.error("Failed to load address detail:", err);
        if (!cancelled) setLoadError("Couldn't load this wallet's data — try again shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [resolvedAddress, getAddress, getAddressCounters, getAddressTokenBalances]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          type="text"
          placeholder="0x... or a .etn name"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleLookup(); }}
          style={{ ...inputStyle, flex: 1 }}
        />
        <NeonButton variant="green" onClick={handleLookup} loading={resolving} style={{ padding: "12px 20px" }}>
          Look Up
        </NeonButton>
      </div>

      {resolveError && (
        <div style={{ fontSize: 12, color: errorColor, marginBottom: 16 }}>{resolveError}</div>
      )}
      {loadError && (
        <div style={{ fontSize: 12, color: errorColor, marginBottom: 16 }}>{loadError}</div>
      )}

      {resolvedAddress && addressInfo && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: "#fff" }}>
              {addressInfo.ens_domain_name || "Wallet"}
            </div>
            <a
              href={`${EXPLORER_BASE_URL}/address/${resolvedAddress}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: mutedLight, fontFamily: "monospace", textDecoration: "none", borderBottom: `1px solid ${border}` }}
            >
              {resolvedAddress}
            </a>
            {addressInfo.is_contract && (
              <div style={{ fontSize: 11, color: muted, marginTop: 4 }}>Contract{addressInfo.is_verified ? " · Verified" : ""}</div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }}>
            <div style={{ padding: 14, borderRadius: 10, background: panel2, border: `1px solid ${border}` }}>
              <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", marginBottom: 4 }}>ETN Balance</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: green }}>{formatEtnBalance(addressInfo.coin_balance)} ETN</div>
            </div>
            {counters && (
              <>
                <div style={{ padding: 14, borderRadius: 10, background: panel2, border: `1px solid ${border}` }}>
                  <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", marginBottom: 4 }}>Transactions</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{formatCompact(counters.transactions_count)}</div>
                </div>
                <div style={{ padding: 14, borderRadius: 10, background: panel2, border: `1px solid ${border}` }}>
                  <div style={{ fontSize: 11, color: muted, textTransform: "uppercase", marginBottom: 4 }}>Token Transfers</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{formatCompact(counters.token_transfers_count)}</div>
                </div>
              </>
            )}
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: mutedLight, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Token Holdings
          </div>
          {tokenBalances.length === 0 ? (
            <div style={{ fontSize: 12, color: muted }}>No token balances.</div>
          ) : (
            tokenBalances.slice(0, 25).map((tb, i) => (
              <div key={`${tb.token?.address}-${i}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}` }}>
                <span style={{ fontSize: 12, color: "#fff" }}>
                  {tb.token?.name || "Unknown Token"} <span style={{ color: mutedLight }}>{tb.token?.symbol}</span>
                </span>
                <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>{formatTokenAmount(tb.value, tb.token?.decimals)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
