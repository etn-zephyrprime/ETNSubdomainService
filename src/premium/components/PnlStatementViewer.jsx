import React, { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Download, FileJson } from "lucide-react";
import Panel from "../../components/Panel.jsx";
import NeonButton from "../../components/NeonButton.jsx";
import { PNL_BACKEND_URL } from "../../config.js";
import { green, greenGlow, muted, mutedLight, border, panel2, error as errorColor } from "../../styles/theme.js";

// tx-hash/request-ID based access — no login (see the build plan's confirmed decision). Reachable
// either via the /statement/:requestId deep link (see App.jsx) or by pasting a request ID/tx hash
// into the lookup form below, so a shared link works for anyone regardless of whether they have a
// wallet connected.
export default function PnlStatementViewer({ initialRequestId = null, wallet, onBack = null }) {
  const [lookupInput, setLookupInput] = useState(initialRequestId || "");
  const [requests, setRequests] = useState(null); // array — a tx-hash lookup can return several periods
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null);
  const [viewedRequestId, setViewedRequestId] = useState(null);

  const lookup = useCallback(async (value) => {
    setLoading(true);
    setLoadError(null);
    setRequests(null);
    setPdfBlobUrl(null);
    try {
      // A tx hash is 66 chars (0x + 64 hex); anything else is treated as a request ID (UUID).
      const isTxHash = /^0x[0-9a-fA-F]{64}$/.test(value.trim());
      const url = isTxHash
        ? `${PNL_BACKEND_URL}/api/pnl/statement/by-tx/${value.trim()}`
        : `${PNL_BACKEND_URL}/api/pnl/statement/${value.trim()}`;
      const res = await fetch(url);
      if (!res.ok) {
        setLoadError(res.status === 404 ? "No statement found for that ID or transaction hash." : "Couldn't load statement.");
        return;
      }
      const data = await res.json();
      setRequests(isTxHash ? data : [data]);
    } catch (err) {
      console.error("Statement lookup failed:", err);
      setLoadError("Couldn't reach the backend — try again shortly.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialRequestId) lookup(initialRequestId);
  }, [initialRequestId, lookup]);

  // Fires the finalize-on-view trigger the moment the PDF's actual bytes have been fetched — not
  // on mount, not on a bare download-link click. Uses sendBeacon so the POST survives even if the
  // user navigates away before the fetch below fully resolves in a slow-connection edge case;
  // falls back to a keepalive fetch if sendBeacon isn't available.
  const markViewed = useCallback((requestId) => {
    const url = `${PNL_BACKEND_URL}/api/pnl/statement/${requestId}/view`;
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([], { type: "application/json" }));
    } else {
      fetch(url, { method: "POST", keepalive: true }).catch(() => {});
    }
  }, []);

  const openStatement = useCallback(async (request) => {
    if (!request.pdfUrl) return;
    setLoading(true);
    try {
      const res = await fetch(request.pdfUrl);
      if (!res.ok) throw new Error(`Failed to load PDF (${res.status})`);
      const blob = await res.blob();
      setPdfBlobUrl(URL.createObjectURL(blob));
      setViewedRequestId(request.id);
      // Fires only once this fetch has actually succeeded — "the user received the content" is
      // the whole point of the trigger, not merely requesting it.
      markViewed(request.id);
    } catch (err) {
      console.error("Failed to open statement PDF:", err);
      setLoadError("Couldn't load the statement PDF.");
    } finally {
      setLoading(false);
    }
  }, [markViewed]);

  return (
    <div style={{ width: "100%", maxWidth: 700, margin: "0 auto", padding: "0 16px" }}>
      {onBack && (
        <div style={{ marginBottom: 20 }}>
          <button
            onClick={onBack}
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: green, background: "rgba(18,86,131,0.06)", border: `1px solid ${border}`, borderRadius: 10, cursor: "pointer", padding: "8px 14px" }}
          >
            <ArrowLeft size={14} /> Back
          </button>
        </div>
      )}

      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
          PnL Statement
        </div>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 12px 0", color: "#fff", textShadow: `0 0 16px ${greenGlow}` }}>
          View / Download
        </h2>
      </div>

      {!initialRequestId && (
        <Panel style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 11, color: mutedLight, display: "block", marginBottom: 6 }}>Request ID or transaction hash</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ flex: 1, padding: "12px 14px", borderRadius: 10, border: `1px solid ${border}`, background: panel2, color: "#fff", fontSize: 14, boxSizing: "border-box" }}
              value={lookupInput}
              onChange={(e) => setLookupInput(e.target.value)}
              placeholder="0x... or request ID"
            />
            <NeonButton variant="green" onClick={() => lookup(lookupInput)} disabled={loading || !lookupInput.trim()} loading={loading}>
              Look Up
            </NeonButton>
          </div>
        </Panel>
      )}

      {loadError && <div style={{ fontSize: 13, color: errorColor, marginBottom: 16, textAlign: "center" }}>{loadError}</div>}

      {requests && requests.length === 0 && (
        <div style={{ fontSize: 13, color: mutedLight, textAlign: "center" }}>No periods found for that transaction.</div>
      )}

      {requests && requests.map((request) => (
        <Panel key={request.id} style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Period {request.periodIndex + 1}</div>
              <div style={{ fontSize: 11, color: mutedLight }}>{request.trackedWallet}</div>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: request.status === "GENERATED" || request.status === "FINALIZED" ? green : mutedLight, textTransform: "uppercase" }}>
              {request.status.replace(/_/g, " ")}
            </div>
          </div>

          {request.status === "PAID" && (
            <div style={{ fontSize: 12, color: mutedLight }}>Waiting for period metadata to be submitted.</div>
          )}
          {request.status === "PENDING_GENERATION" && (
            <div style={{ fontSize: 12, color: mutedLight }}>Generating — this can take a while for a wallet's first-ever statement. Refresh to check again.</div>
          )}
          {(request.status === "GENERATED" || request.status === "FINALIZED") && (
            <div style={{ display: "flex", gap: 8 }}>
              <NeonButton variant="green" onClick={() => openStatement(request)} disabled={loading}>
                <Download size={14} style={{ marginRight: 6, verticalAlign: "text-bottom" }} /> View / Download PDF
              </NeonButton>
              {request.jsonUrl && (
                <a href={request.jsonUrl} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: mutedLight, textDecoration: "none" }}>
                  <FileJson size={14} /> Raw data (JSON)
                </a>
              )}
            </div>
          )}
          {request.status === "REFUNDED" && (
            <div style={{ fontSize: 12, color: mutedLight }}>This request was refunded.</div>
          )}

          {pdfBlobUrl && viewedRequestId === request.id && (
            <div style={{ marginTop: 16, border: `1px solid ${border}`, borderRadius: 10, overflow: "hidden" }}>
              <embed src={pdfBlobUrl} type="application/pdf" style={{ width: "100%", height: 500, border: "none" }} />
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}
