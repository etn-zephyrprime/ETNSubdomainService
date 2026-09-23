import React, { useState } from "react";
import { ethers } from "ethers";
import { Flame } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import { PNL_BACKEND_URL, EXPLORER_BASE_URL } from "../../../config.js";
import { green, orange, muted, mutedLight, border, panel, error as errorColor } from "../../theme.js";

// Admin-only "Split & Burn" for PremiumSubscription.executeSplitForPeriod — the manual version of
// what subscriptionRevenueSweepScheduler.js does on a timer. Renders nothing for anyone but the
// admin wallet. That check is UI-only: the real gates are (1) the backend quote route, which needs a
// signature from this wallet, and (2) the contract itself, which only accepts the call from
// operator() — if the connected admin wallet isn't the operator this refuses up front instead of
// sending a transaction that would revert.
//
// Two steps on purpose: fetch a quote (nothing sent), review the numbers, then execute. The
// (amount, minCoreOut, deadline) triple comes from backend/utils/adminSplitRouter.js; its deadline is
// only valid ~10 minutes, so an old quote must be refreshed rather than reused.
const ADMIN_ADDRESS = "0xa48Bc549a329EEd01E491C7CD950857A8ae56E73";
const AUTH_PURPOSE = "Premium Dashboard";
const SPLIT_GAS_LIMIT = 500000;
const ABI = ["function executeSplitForPeriod(uint256 amount, uint256 minCoreOut, uint256 deadline) external"];

const rowStyle = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, padding: "4px 0" };

function fmtEtn(wei) {
  return Number(ethers.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function AdminSplitPanel({ wallet, getAuthParams }) {
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [txHash, setTxHash] = useState(null);

  if (!wallet?.account || wallet.account.toLowerCase() !== ADMIN_ADDRESS.toLowerCase()) return null;

  const loadQuote = async () => {
    setLoading(true);
    setError(null);
    setTxHash(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const params = new URLSearchParams({ wallet: wallet.account, signature, timestamp });
      const res = await fetch(`${PNL_BACKEND_URL}/api/admin/split-quote?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setQuote(data);
    } catch (err) {
      setQuote(null);
      setError(err.message || "Couldn't load the quote");
    } finally {
      setLoading(false);
    }
  };

  const operatorMatches = quote ? quote.operator.toLowerCase() === wallet.account.toLowerCase() : false;
  const amount = quote ? BigInt(quote.amount) : 0n;

  const execute = async () => {
    if (!quote) return;
    setError(null);
    if (Number(quote.deadline) <= Math.floor(Date.now() / 1000) + 30) {
      setError("This quote's deadline has passed (or is about to) — refresh the quote and try again.");
      return;
    }
    setSending(true);
    try {
      await wallet.ensureCorrectNetwork();
      const signer = await wallet.getSigner();
      const contract = new ethers.Contract(quote.contractAddress, ABI, signer);
      const args = [BigInt(quote.amount), BigInt(quote.minCoreOut), BigInt(quote.deadline)];
      // Dry run first — surfaces a revert reason (wrong operator, deadline, slippage, ...) without
      // spending gas on a transaction that was never going to succeed.
      await contract.executeSplitForPeriod.staticCall(...args);
      const tx = await contract.executeSplitForPeriod(...args, { gasLimit: SPLIT_GAS_LIMIT });
      setTxHash(tx.hash);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction failed on-chain");
      setQuote(null); // spent — the balance/owed figures it was based on no longer hold
    } catch (err) {
      console.error("Admin split failed:", err);
      setError(err.shortMessage || err.reason || err.message || "Transaction failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <DashboardPanel accent={orange} style={{ border: `1px solid ${orange}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <Flame size={18} color={orange} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Admin — Split &amp; Burn
        </div>
      </div>
      <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.6, marginBottom: 12 }}>
        Manually runs <code>executeSplitForPeriod</code> on the Premium Subscription contract with the safe amount (contract balance
        − ETN still owed to PnL requests − a small margin) and a 5%-slippage <code>minCoreOut</code>. Sent from your connected wallet, which must be the contract's operator.
      </div>

      {quote && (
        <div style={{ padding: "8px 12px", borderRadius: 10, background: panel, border: `1px solid ${border}`, marginBottom: 12 }}>
          <div style={rowStyle}><span style={{ color: muted }}>Contract balance</span><span style={{ color: "#fff" }}>{fmtEtn(quote.balance)} ETN</span></div>
          <div style={rowStyle}><span style={{ color: muted }}>Owed to PnL requests</span><span style={{ color: "#fff" }}>{fmtEtn(quote.owed)} ETN</span></div>
          {BigInt(quote.owedUnrecorded) > 0n && (
            <div style={{ ...rowStyle, paddingTop: 0 }}>
              <span style={{ color: muted, fontSize: 11 }}>↳ incl. on-chain purchases not yet recorded</span>
              <span style={{ color: mutedLight, fontSize: 11 }}>{fmtEtn(quote.owedUnrecorded)} ETN</span>
            </div>
          )}
          <div style={rowStyle}><span style={{ color: muted }}>Safety margin</span><span style={{ color: "#fff" }}>{fmtEtn(quote.safetyMargin)} ETN</span></div>
          <div style={{ ...rowStyle, borderTop: `1px solid ${border}`, marginTop: 4, paddingTop: 8 }}>
            <span style={{ color: mutedLight, fontWeight: 700 }}>amount</span>
            <span style={{ color: green, fontWeight: 800 }}>{fmtEtn(quote.amount)} ETN</span>
          </div>
          <div style={rowStyle}><span style={{ color: muted }}>minCoreOut</span><span style={{ color: "#fff" }}>{Number(ethers.formatEther(quote.minCoreOut)).toLocaleString(undefined, { maximumFractionDigits: 4 })} CORE</span></div>
          <div style={rowStyle}><span style={{ color: muted }}>deadline</span><span style={{ color: "#fff" }}>{new Date(Number(quote.deadline) * 1000).toLocaleTimeString()} (10 min from quote)</span></div>
          {!operatorMatches && (
            <div style={{ fontSize: 11, color: errorColor, marginTop: 8 }}>
              Your wallet isn't this contract's operator ({quote.operator}) — the call would revert, so execution is disabled.
            </div>
          )}
          {amount === 0n && <div style={{ fontSize: 11, color: orange, marginTop: 8 }}>Nothing safe to split right now.</div>}
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12, wordBreak: "break-word" }}>{error}</div>}
      {txHash && (
        <div style={{ fontSize: 12, color: green, marginBottom: 12, wordBreak: "break-all" }}>
          {sending ? "Submitted, waiting for confirmation… " : "Split executed. "}
          <a href={`${EXPLORER_BASE_URL}/tx/${txHash}`} target="_blank" rel="noreferrer" style={{ color: green }}>{txHash}</a>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <DashboardButton onClick={loadQuote} loading={loading} disabled={sending} style={{ background: "transparent", color: green, border: `1px solid ${green}`, boxShadow: "none" }}>
          {quote ? "Refresh quote" : "Get quote"}
        </DashboardButton>
        {quote && (
          <DashboardButton onClick={execute} loading={sending} disabled={!operatorMatches || amount === 0n} style={{ background: orange }}>
            Execute Split &amp; Burn
          </DashboardButton>
        )}
      </div>
    </DashboardPanel>
  );
}
