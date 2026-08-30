import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { FileText, ExternalLink } from "lucide-react";
import Panel from "../../components/Panel.jsx";
import NeonButton from "../../components/NeonButton.jsx";
import { usePnlPurchase } from "../../hooks/usePnlPurchase.js";
import { useOwnedNames } from "../../hooks/useOwnedNames.js";
import { computeNodeForName } from "../../utils/ens.js";
import { PNL_BACKEND_URL } from "../../config.js";
import { green, greenGlow, muted, mutedLight, border, panel2, error as errorColor } from "../../styles/theme.js";

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

const labelStyle = { fontSize: 11, color: mutedLight, display: "block", marginBottom: 6 };

function parseAddressList(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Purchases one or more 12-month PnL statement periods for a tracked wallet, then hands the
// resulting request(s) off to the backend to actually generate. Generation itself (ingestion +
// FIFO replay + PDF) happens server-side and can take a while for a wallet's first-ever request —
// see backend/services/pnlStatementGenerator.js — so this only kicks it off and links to the
// viewer, which is where the user watches it move from PENDING_GENERATION to GENERATED.
export default function PnlStatementRequest({ wallet }) {
  const { isConfigured, getPnlPricePerPeriod, getFreeAccessInfo, purchasePnlPeriods, waitForStatementRequests, loading, error } = usePnlPurchase();
  const { getNamesOwnedBy } = useOwnedNames();

  const [pricePerPeriod, setPricePerPeriod] = useState(null);
  const [freeInfo, setFreeInfo] = useState({ free: false, reason: null });
  const [activatedDomainNode, setActivatedDomainNode] = useState(null);
  const [activatedDomainName, setActivatedDomainName] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [trackedWallet, setTrackedWallet] = useState("");
  const [selfOwnedRaw, setSelfOwnedRaw] = useState("");
  const [yearEndMarkDate, setYearEndMarkDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [numPeriods, setNumPeriods] = useState(1);

  const [stage, setStage] = useState("idle"); // idle | purchasing | waiting-for-backend | requesting | done
  const [stageError, setStageError] = useState(null);
  const [createdRequests, setCreatedRequests] = useState([]);

  useEffect(() => {
    if (wallet?.account && !trackedWallet) setTrackedWallet(wallet.account);
  }, [wallet?.account, trackedWallet]);

  // Finds one activated domain the connected wallet owns, if any, and computes its on-chain node
  // — this is what purchasePnlPeriods can be given as proof of free access via activated-domain
  // ownership (see PremiumSubscription.sol's isActivatedDomainOwner). Any ONE qualifying domain is
  // enough; the first one found is used. The contract independently re-verifies this at purchase
  // time, so a stale/wrong guess here just falls through to the paid path, never a bad free grant.
  const findActivatedDomain = useCallback(async (address) => {
    try {
      const owned = await getNamesOwnedBy(address);
      const activated = owned.find((n) => n.activated === true);
      if (!activated) return { node: null, name: null };
      return { node: computeNodeForName(activated.name), name: activated.name };
    } catch (err) {
      console.warn("Failed to look up activated domains for free-access check:", err.message);
      return { node: null, name: null };
    }
  }, [getNamesOwnedBy]);

  const refresh = useCallback(async () => {
    if (!isConfigured) return;
    try {
      const price = await getPnlPricePerPeriod();
      setPricePerPeriod(price);
      if (wallet?.account) {
        const { node, name } = await findActivatedDomain(wallet.account);
        setActivatedDomainNode(node);
        setActivatedDomainName(name);
        setFreeInfo(await getFreeAccessInfo(wallet.account, node));
      }
      setLoadError(null);
    } catch (err) {
      console.error("Failed to load PnL pricing:", err);
      setLoadError("Couldn't load pricing");
    }
  }, [isConfigured, getPnlPricePerPeriod, getFreeAccessInfo, findActivatedDomain, wallet?.account]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!isConfigured) {
    return (
      <Panel style={{ width: "100%", maxWidth: 600, margin: "0 auto" }}>
        <div style={{ fontSize: 13, color: mutedLight }}>PnL statements aren't available yet — check back soon.</div>
      </Panel>
    );
  }

  const requiredValueWei = freeInfo.free ? 0n : (pricePerPeriod ?? 0n) * BigInt(numPeriods);

  const handlePurchase = async () => {
    setStageError(null);
    setCreatedRequests([]);

    if (!wallet.isConnected) {
      await wallet.connectWallet();
      return;
    }
    if (!ethers.isAddress(trackedWallet)) {
      setStageError("Enter a valid wallet address to generate a statement for.");
      return;
    }
    const selfOwnedAddresses = parseAddressList(selfOwnedRaw);
    for (const addr of selfOwnedAddresses) {
      if (!ethers.isAddress(addr)) {
        setStageError(`"${addr}" isn't a valid address in your self-owned addresses list.`);
        return;
      }
    }

    try {
      await wallet.ensureCorrectNetwork();
      const signer = await wallet.getSigner();

      setStage("purchasing");
      const { txHash } = await purchasePnlPeriods(trackedWallet, numPeriods, activatedDomainNode, requiredValueWei, signer);

      setStage("waiting-for-backend");
      const requests = await waitForStatementRequests(txHash, numPeriods);

      setStage("requesting");
      const submitted = [];
      for (const request of requests) {
        const res = await fetch(`${PNL_BACKEND_URL}/api/pnl/statement/${request.id}/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ yearEndMarkDate, selfOwnedAddresses }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Failed to submit period ${request.periodIndex}`);
        }
        submitted.push(await res.json());
      }

      setCreatedRequests(submitted);
      setStage("done");
    } catch (err) {
      console.error("PnL statement request failed:", err);
      setStageError(err?.message || "Something went wrong");
      setStage("idle");
    }
  };

  const busy = loading || stage === "purchasing" || stage === "waiting-for-backend" || stage === "requesting";
  const stageLabel = {
    purchasing: "Confirming purchase on-chain…",
    "waiting-for-backend": "Waiting for the backend to record your purchase…",
    requesting: "Starting statement generation…",
  }[stage];

  return (
    <Panel style={{ width: "100%", maxWidth: 600, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <FileText size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Request a PnL Statement
        </div>
      </div>

      {loadError && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{loadError}</div>}

      <div style={{ fontSize: 13, color: mutedLight, marginBottom: 6 }}>
        Price per 12-month period: {pricePerPeriod != null ? (
          freeInfo.free ? (
            <b style={{ color: green }}>Free — {freeInfo.reason}</b>
          ) : (
            <b style={{ color: "#fff" }}>{ethers.formatEther(pricePerPeriod)} ETN</b>
          )
        ) : "Loading…"}
      </div>
      {!freeInfo.free && activatedDomainName && (
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10 }}>
          ({activatedDomainName} looked activated, but couldn't be verified on-chain just now — using the paid price. It'll still be checked again when you submit.)
        </div>
      )}
      <div style={{ marginBottom: 16 }} />

      <label style={labelStyle}>Tracked wallet address</label>
      <input style={{ ...inputStyle, marginBottom: 14 }} value={trackedWallet} onChange={(e) => setTrackedWallet(e.target.value.trim())} placeholder="0x..." />

      <label style={labelStyle}>
        Your other addresses (comma or newline separated) — transfers between these and the tracked wallet won't be counted as a sale
      </label>
      <textarea
        style={{ ...inputStyle, marginBottom: 14, minHeight: 60, resize: "vertical", fontFamily: "inherit" }}
        value={selfOwnedRaw}
        onChange={(e) => setSelfOwnedRaw(e.target.value)}
        placeholder="0xabc..., 0xdef..."
      />

      <label style={labelStyle}>Fiscal year-end date (anchors this and every future period)</label>
      <input
        type="date"
        style={{ ...inputStyle, marginBottom: 14 }}
        value={yearEndMarkDate}
        onChange={(e) => setYearEndMarkDate(e.target.value)}
      />

      <label style={labelStyle}>Number of 12-month periods to purchase now</label>
      <input
        type="number"
        min={1}
        style={{ ...inputStyle, marginBottom: 16 }}
        value={numPeriods}
        onChange={(e) => setNumPeriods(Math.max(1, parseInt(e.target.value, 10) || 1))}
      />

      {pricePerPeriod != null && !freeInfo.free && (
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
          Total: <b style={{ color: "#fff" }}>{ethers.formatEther(requiredValueWei)} ETN</b>
        </div>
      )}

      {(error || stageError) && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{stageError || error}</div>}
      {stageLabel && <div style={{ fontSize: 12, color: mutedLight, marginBottom: 12 }}>{stageLabel}</div>}

      {stage === "done" && createdRequests.length > 0 && (
        <div style={{ fontSize: 12, color: green, marginBottom: 16 }}>
          ✓ {createdRequests.length} period{createdRequests.length > 1 ? "s" : ""} submitted. Generation can take a while for a wallet's
          first-ever statement — check back on each link below:
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {createdRequests.map((r) => (
              <a
                key={r.id}
                href={`/statement/${r.id}`}
                style={{ color: green, display: "flex", alignItems: "center", gap: 6, fontWeight: 700, textDecoration: "none" }}
              >
                <ExternalLink size={12} /> Period {r.periodIndex + 1} statement
              </a>
            ))}
          </div>
        </div>
      )}

      <NeonButton
        variant="green"
        onClick={handlePurchase}
        disabled={busy || pricePerPeriod == null}
        loading={busy}
        style={{ width: "100%", justifyContent: "center" }}
      >
        {!wallet.isConnected ? "Connect Wallet" : "Purchase & Generate"}
      </NeonButton>
    </Panel>
  );
}
