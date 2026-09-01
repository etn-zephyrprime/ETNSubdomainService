import React, { useState, useEffect, useCallback } from "react";
import { ExternalLink } from "lucide-react";
import { PNL_BACKEND_URL } from "../../../config.js";
import { green, mutedLight, border, panel2, error as errorColor } from "../../theme.js";

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

export default function PnlStatementProgress({ walletAddress, refreshToken }) {
  const [requests, setRequests] = useState(null); // null = not loaded yet; [] = loaded, no orders
  const [loadError, setLoadError] = useState(null);

  const fetchRequests = useCallback(async () => {
    if (!walletAddress) return;
    try {
      const res = await fetch(`${PNL_BACKEND_URL}/api/pnl/statements?payerWallet=${walletAddress}`);
      if (!res.ok) throw new Error(`Failed to load your statement orders (${res.status})`);
      setRequests(await res.json());
      setLoadError(null);
    } catch (err) {
      console.error("Failed to load PnL statement progress:", err);
      setLoadError(err.message);
    }
  }, [walletAddress]);

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
          <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, gap: 10 }}>
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
            ) : (
              <span style={{ color: mutedLight, flexShrink: 0 }}>Generating…</span>
            )}
          </div>
        ))}
      </div>
      {loadError && <div style={{ fontSize: 11, color: errorColor, marginTop: 6 }}>{loadError}</div>}
    </div>
  );
}
