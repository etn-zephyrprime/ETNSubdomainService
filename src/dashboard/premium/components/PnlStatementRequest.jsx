import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { FileText, ExternalLink, Plus, X } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import { usePnlPurchase } from "../../../hooks/usePnlPurchase.js";
import { useOwnedNames } from "../../../hooks/useOwnedNames.js";
import { computeNodeForName } from "../../../utils/ens.js";
import { PERIOD_TYPES, computePeriodBoundaries, isPeriodElapsed } from "../../../utils/periodTypes.js";
import { PNL_BACKEND_URL } from "../../../config.js";
import { green, mutedLight, border, panel2, error as errorColor } from "../../theme.js";

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
const CURRENT_YEAR = new Date().getUTCFullYear();

// Permanent, already-generated request used as a live example — Calendar Year 2025 for
// planetzephyros.etn, generated during this feature's own end-to-end testing. Links to the
// existing /statement/:id viewer route rather than the raw R2 PDF URL, same as createdRequests
// links below, so it opens in-app (new tab) instead of a bare file download.
const DEMO_STATEMENT_REQUEST_ID = "830724ea-c676-4f17-8de1-e675e45fc995";

function parseAddressList(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Purchases one or more of the four fixed PnL reporting periods for a tracked wallet, then hands
// the resulting request(s) off to the backend to actually generate. Generation itself (ingestion +
// FIFO replay + PDF) happens server-side and can take a while for a wallet's first-ever request —
// see backend/services/pnlStatementGenerator.js — so this only kicks it off and links to the
// viewer, which is where the user watches it move from PENDING_GENERATION to GENERATED.
export default function PnlStatementRequest({ wallet }) {
  const { isConfigured, getPnlPricePerPeriod, getDiscountInfo, computePeriodPrices, purchasePnlPeriods, waitForStatementRequests, loading, error } = usePnlPurchase();
  const { getNamesOwnedBy } = useOwnedNames();

  const [pricePerPeriod, setPricePerPeriod] = useState(null);
  const [discountInfo, setDiscountInfo] = useState({ discounted: false, reason: null });
  const [activatedDomainNode, setActivatedDomainNode] = useState(null);
  const [activatedDomainName, setActivatedDomainName] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [trackedWallet, setTrackedWallet] = useState("");
  const [selfOwnedRaw, setSelfOwnedRaw] = useState("");
  const [selectedPeriods, setSelectedPeriods] = useState([]); // [{ periodType, year }]
  const [newPeriodType, setNewPeriodType] = useState(0);
  const [newYear, setNewYear] = useState(CURRENT_YEAR - 1);
  const [addPeriodError, setAddPeriodError] = useState(null);

  const [stage, setStage] = useState("idle"); // idle | purchasing | waiting-for-backend | requesting | done
  const [stageError, setStageError] = useState(null);
  const [createdRequests, setCreatedRequests] = useState([]);

  useEffect(() => {
    if (wallet?.account && !trackedWallet) setTrackedWallet(wallet.account);
  }, [wallet?.account, trackedWallet]);

  // Finds one activated domain the connected wallet owns, if any, and computes its on-chain node
  // — this is what purchasePnlPeriods can be given as proof of the activated-domain discount (see
  // PremiumSubscription.sol's isActivatedDomainOwner). Any ONE qualifying domain is enough; the
  // first one found is used. The contract independently re-verifies this at purchase time, so a
  // stale/wrong guess here just falls through to the full/multi-buy price, never a bad discount.
  const findActivatedDomain = useCallback(async (address) => {
    try {
      const owned = await getNamesOwnedBy(address);
      const activated = owned.find((n) => n.activated === true);
      if (!activated) return { node: null, name: null };
      return { node: computeNodeForName(activated.name), name: activated.name };
    } catch (err) {
      console.warn("Failed to look up activated domains for the discount check:", err.message);
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
        setDiscountInfo(await getDiscountInfo(wallet.account, node));
      }
      setLoadError(null);
    } catch (err) {
      console.error("Failed to load PnL pricing:", err);
      setLoadError("Couldn't load pricing");
    }
  }, [isConfigured, getPnlPricePerPeriod, getDiscountInfo, findActivatedDomain, wallet?.account]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!isConfigured) {
    return (
      <DashboardPanel>
        <div style={{ fontSize: 13, color: mutedLight }}>PnL statements aren't available yet — check back soon.</div>
      </DashboardPanel>
    );
  }

  const periodPrices = pricePerPeriod != null ? computePeriodPrices(pricePerPeriod, selectedPeriods.length, discountInfo.discounted) : [];
  const totalValueWei = periodPrices.reduce((sum, p) => sum + p, 0n);

  const handleAddPeriod = () => {
    setAddPeriodError(null);
    if (!isPeriodElapsed(newPeriodType, newYear)) {
      setAddPeriodError("That period hasn't fully ended yet — pick an earlier year.");
      return;
    }
    if (selectedPeriods.some((p) => p.periodType === newPeriodType && p.year === newYear)) {
      setAddPeriodError("That exact period is already in this order.");
      return;
    }
    if (selectedPeriods.length >= 12) {
      setAddPeriodError("Up to 12 periods per order.");
      return;
    }
    setSelectedPeriods([...selectedPeriods, { periodType: newPeriodType, year: newYear }]);
  };

  const handleRemovePeriod = (index) => {
    setSelectedPeriods(selectedPeriods.filter((_, i) => i !== index));
  };

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
    if (selectedPeriods.length === 0) {
      setStageError("Add at least one reporting period to purchase.");
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

      const periodsWithEnds = selectedPeriods.map((p) => ({
        ...p,
        periodEnd: computePeriodBoundaries(p.periodType, p.year).periodEnd,
      }));

      setStage("purchasing");
      const { txHash } = await purchasePnlPeriods(trackedWallet, periodsWithEnds, activatedDomainNode, totalValueWei, signer);

      setStage("waiting-for-backend");
      const requests = await waitForStatementRequests(txHash, selectedPeriods.length);

      setStage("requesting");
      const submitted = [];
      for (const request of requests) {
        const res = await fetch(`${PNL_BACKEND_URL}/api/pnl/statement/${request.id}/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selfOwnedAddresses }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Failed to submit request ${request.id}`);
        }
        submitted.push(await res.json());
      }

      setCreatedRequests(submitted);
      setSelectedPeriods([]);
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
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <FileText size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Request a PnL Statement
        </div>
      </div>

      {loadError && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{loadError}</div>}

      <a
        href={`/statement/${DEMO_STATEMENT_REQUEST_ID}`}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: green, display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 12, textDecoration: "none", marginBottom: 14 }}
      >
        <ExternalLink size={12} /> View a demo statement
      </a>

      <div style={{ fontSize: 13, color: mutedLight, marginBottom: 6 }}>
        Price per period: {pricePerPeriod != null ? (
          discountInfo.discounted ? (
            <><b style={{ color: green }}>{ethers.formatEther(pricePerPeriod / 2n)} ETN</b> <span style={{ color: mutedLight }}>(50% off — {discountInfo.reason})</span></>
          ) : (
            <><b style={{ color: "#fff" }}>{ethers.formatEther(pricePerPeriod)} ETN</b> <span style={{ color: mutedLight }}>(first period; each additional period in the same order is {ethers.formatEther((pricePerPeriod * 2n) / 3n)} ETN)</span></>
          )
        ) : "Loading…"}
      </div>
      {!discountInfo.discounted && activatedDomainName && (
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10 }}>
          ({activatedDomainName} looked activated, but couldn't be verified on-chain just now — using the standard price. It'll still be checked again when you submit.)
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

      <label style={labelStyle}>Add a reporting period (must have already ended)</label>
      <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10, lineHeight: 1.5 }}>
        Price data for older transactions may be incomplete — free-tier price sources only cover a recent
        rolling window (roughly the past several months to a year), not full history back to any fixed date.
        Every USD figure shown is a real historical price; anything outside that window is clearly marked
        "price unavailable" on the statement rather than estimated or guessed.
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <select
          value={newPeriodType}
          onChange={(e) => setNewPeriodType(Number(e.target.value))}
          style={{ ...inputStyle, flex: 2 }}
        >
          {PERIOD_TYPES.map((p) => (
            <option key={p.id} value={p.id}>{p.label} ({p.range})</option>
          ))}
        </select>
        <input
          type="number"
          value={newYear}
          onChange={(e) => setNewYear(parseInt(e.target.value, 10) || CURRENT_YEAR)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <DashboardButton onClick={handleAddPeriod} style={{ padding: "0 14px", background: panel2, color: green, border: `1px solid ${border}`, boxShadow: "none" }}>
          <Plus size={16} />
        </DashboardButton>
      </div>
      {addPeriodError && <div style={{ fontSize: 11, color: errorColor, marginBottom: 8 }}>{addPeriodError}</div>}

      {selectedPeriods.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {selectedPeriods.map((p, i) => {
            const type = PERIOD_TYPES.find((t) => t.id === p.periodType);
            return (
              <div key={`${p.periodType}-${p.year}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderRadius: 8, background: panel2, border: `1px solid ${border}`, marginBottom: 6 }}>
                <div style={{ fontSize: 12, color: "#fff" }}>{type.label} {p.year}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ fontSize: 12, color: mutedLight }}>{periodPrices[i] != null ? `${ethers.formatEther(periodPrices[i])} ETN` : ""}</div>
                  <button onClick={() => handleRemovePeriod(i)} style={{ background: "none", border: "none", color: mutedLight, cursor: "pointer", display: "flex" }}>
                    <X size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedPeriods.length > 0 && (
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
          Total: <b style={{ color: "#fff" }}>{ethers.formatEther(totalValueWei)} ETN</b>
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
                <ExternalLink size={12} /> {r.periodTypeLabel} {r.year} statement
              </a>
            ))}
          </div>
        </div>
      )}

      <DashboardButton
        onClick={handlePurchase}
        disabled={busy || pricePerPeriod == null || selectedPeriods.length === 0}
        loading={busy}
        style={{ width: "100%", justifyContent: "center" }}
      >
        {!wallet.isConnected ? "Connect Wallet" : "Purchase & Generate"}
      </DashboardButton>
    </DashboardPanel>
  );
}
