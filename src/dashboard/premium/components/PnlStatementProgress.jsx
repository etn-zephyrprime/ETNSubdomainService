import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { ExternalLink } from "lucide-react";
import { PNL_BACKEND_URL } from "../../../config.js";
import { green, mutedLight, muted, border, panel2, error as errorColor } from "../../theme.js";
import DashboardButton from "./DashboardButton.jsx";
import { useWalletAuthSignature } from "../../../hooks/useWalletAuthSignature.js";

// "N of M ready" progress tracker for a wallet's own order history — pulls from
// GET /api/pnl/statements?payerWallet=..., not from PnlStatementRequest's own createdRequests
// state, specifically so this survives a page reload/reconnect mid-generation (generation for a
// wallet with a lot of history can genuinely run over an hour — see pnlStatementGenerator.js).
// Polls only while at least one request is still PAID/PENDING_GENERATION; stops once everything in
// the list has resolved (GENERATED/FINALIZED/REFUNDED), so a fully-settled order history costs one
// fetch, not an indefinite background poll.
const ACTIVE_STATUSES = new Set(["PAID", "PENDING_GENERATION"]);
const POLL_INTERVAL_MS = 20000;
const READY_STATUSES = new Set(["GENERATED", "FINALIZED"]);

function parseAddressList(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// PAID rows can get stuck here forever with no self-service way out: PnlStatementRequest.jsx's own
// "Purchase & Generate" flow submits this same self-owned-addresses step automatically right after
// the purchase confirms, but a closed tab / network blip / wallet disconnect between those two
// steps leaves the request paid-for but never actually started — confirmed live, twice, both times
// requiring a manual DB intervention to unstick. Worse, PAID rendered identically to
// PENDING_GENERATION below ("Generating…"), so a permanently-stuck request looked exactly like one
// that was actively working, with nothing on screen suggesting anything needed the user's
// attention. This inline "Finish setup" form re-submits the exact same
// POST /pnl/statement/:id/request the original purchase flow already calls — the backend endpoint
// itself was always safe to call again for a still-PAID request (see pnlStatementRouter.js's own
// comment: it only 409s if the request is already past PAID), the gap was purely that nothing in
// this UI ever gave a returning user the chance to.
function FinishSetupForm({ request, onDone }) {
  const [selfOwnedRaw, setSelfOwnedRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const handleSubmit = async () => {
    setFormError(null);
    const selfOwnedAddresses = parseAddressList(selfOwnedRaw);
    for (const addr of selfOwnedAddresses) {
      if (!ethers.isAddress(addr)) {
        setFormError(`"${addr}" isn't a valid address.`);
        return;
      }
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${PNL_BACKEND_URL}/api/pnl/statement/${request.id}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selfOwnedAddresses }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to start generation");
      }
      onDone();
    } catch (err) {
      setFormError(err.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${border}` }}>
      <div style={{ fontSize: 11, color: mutedLight, marginBottom: 6 }}>
        Your other addresses (comma or newline separated) — transfers between these and the tracked wallet won't be counted as a sale. Leave blank if none.
      </div>
      <textarea
        value={selfOwnedRaw}
        onChange={(e) => setSelfOwnedRaw(e.target.value)}
        placeholder="0xabc..., 0xdef..."
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px solid ${border}`,
          background: "#0a0a0a",
          color: "#fff",
          fontSize: 12,
          minHeight: 50,
          resize: "vertical",
          fontFamily: "inherit",
          boxSizing: "border-box",
          outline: "none",
          marginBottom: 8,
        }}
      />
      {formError && <div style={{ fontSize: 11, color: errorColor, marginBottom: 8 }}>{formError}</div>}
      <DashboardButton onClick={handleSubmit} loading={submitting} style={{ padding: "8px 14px", fontSize: 12 }}>
        Start Generation
      </DashboardButton>
    </div>
  );
}

export default function PnlStatementProgress({ wallet, refreshToken }) {
  const walletAddress = wallet?.account;
  const [requests, setRequests] = useState(null); // null = not loaded yet; [] = loaded, no orders
  const [loadError, setLoadError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  // GET /pnl/statements is the one endpoint on this API that requires proof of wallet ownership
  // (see backend/utils/walletAuth.js for why) -- everything else here is keyed by a request ID or
  // tx hash, this one was keyed on nothing but the address itself, which isn't a secret.
  const getAuthParams = useWalletAuthSignature(wallet);

  const fetchRequests = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const { signature, timestamp } = await getAuthParams();
      const url = `${PNL_BACKEND_URL}/api/pnl/statements?payerWallet=${walletAddress}&signature=${encodeURIComponent(signature)}&timestamp=${timestamp}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to load your statement orders (${res.status})`);
      }
      setRequests(await res.json());
      setLoadError(null);
    } catch (err) {
      console.error("Failed to load PnL statement progress:", err);
      setLoadError(err.message || "Failed to load your statement orders");
    }
  }, [walletAddress, getAuthParams]);

  // refreshToken deliberately unused inside the effect body — bumping it from the purchase flow
  // (see PnlStatementRequest.jsx) is what forces an immediate re-fetch right after a new order is
  // submitted, instead of waiting up to POLL_INTERVAL_MS for it to show up here.
  useEffect(() => {
    setRequests(null);
    setLoadError(null);
    fetchRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchRequests, refreshToken]);

  useEffect(() => {
    const hasActive = Array.isArray(requests) && requests.some((r) => ACTIVE_STATUSES.has(r.status));
    if (!hasActive) return;
    const id = setInterval(fetchRequests, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [requests, fetchRequests]);

  if (!walletAddress || !Array.isArray(requests) || requests.length === 0) return null;

  const total = requests.length;
  const readyCount = requests.filter((r) => READY_STATUSES.has(r.status)).length;
  const allReady = readyCount === total;

  return (
    <div style={{ marginBottom: 16, padding: 12, borderRadius: 10, border: `1px solid ${border}`, background: panel2 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: allReady ? green : "#fff", marginBottom: 8 }}>
        {allReady
          ? `✓ All ${total} of your statement${total > 1 ? "s are" : " is"} ready`
          : `Generating your statements — ${readyCount} of ${total} ready`}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {requests.map((r, i) => (
          <div key={r.id} style={{ fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span style={{ color: mutedLight }}>
                {i + 1} of {total} — {r.periodTypeLabel} {r.year}
              </span>
              {READY_STATUSES.has(r.status) ? (
                <a
                  href={`/statement/${r.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: green, display: "flex", alignItems: "center", gap: 4, textDecoration: "none", fontWeight: 700, flexShrink: 0 }}
                >
                  <ExternalLink size={12} /> View
                </a>
              ) : r.status === "REFUNDED" ? (
                <span style={{ color: mutedLight, flexShrink: 0 }}>Refunded</span>
              ) : r.status === "PAID" ? (
                <button
                  onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                  style={{ background: "none", border: "none", color: green, cursor: "pointer", fontWeight: 700, fontSize: 12, padding: 0, flexShrink: 0 }}
                >
                  {expandedId === r.id ? "Cancel" : "Finish setup"}
                </button>
              ) : (
                <span style={{ color: mutedLight, flexShrink: 0 }}>Generating…</span>
              )}
            </div>
            {r.status === "PAID" && (
              <div style={{ fontSize: 10, color: muted, marginTop: 2 }}>
                Paid, but generation was never started — finish setup to continue.
              </div>
            )}
            {expandedId === r.id && (
              <FinishSetupForm
                request={r}
                onDone={() => {
                  setExpandedId(null);
                  fetchRequests();
                }}
              />
            )}
          </div>
        ))}
      </div>
      {loadError && <div style={{ fontSize: 11, color: errorColor, marginTop: 6 }}>{loadError}</div>}
    </div>
  );
}
