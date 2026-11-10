import React, { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { Search, KeyRound, RefreshCw, FileSearch, Loader2 } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import { useContractCard } from "./ContractCard.jsx";
import { useContractCheck } from "../../hooks/useContractCheck.js";
import { OverallBadge, KnownBadge, shortAddr } from "../../components/ContractCheckBits.jsx";
import { green, gold, muted, mutedLight, border, panel2, monoFont, error as errorColor } from "../../theme.js";

// Contract Check panel: find any contract without copy-pasting from an explorer (search by symbol,
// project, name.etn or address), see every contract your wallets have used, and your live approvals —
// with a Revoke you sign in your own wallet. Every row opens the contract card (ContractCard.jsx).
const AUTH_PURPOSE = "Premium Dashboard";
const REVOKE_ABI = ["function approve(address spender, uint256 amount) returns (bool)", "function setApprovalForAll(address operator, bool approved)"];

const rowStyle = { display: "flex", alignItems: "center", gap: 10, width: "100%", background: panel2, border: `1px solid ${border}`, borderRadius: 6, padding: "10px 12px", color: "#fff", textAlign: "left", cursor: "pointer", boxSizing: "border-box" };
const sectionTitle = (Icon, text) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: monoFont, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: mutedLight, margin: "20px 0 10px" }}>
    <Icon size={14} color={green} /> {text}
  </div>
);
const ago = (iso) => {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  return d < 1 ? "today" : d < 2 ? "yesterday" : d < 60 ? `${Math.floor(d)} days ago` : new Date(iso).toLocaleDateString();
};
const rowName = (r) => r.known?.label || (r.symbol && r.name ? `${r.name} (${r.symbol})` : r.name) || shortAddr(r.address);

function SearchBox() {
  const { search } = useContractCheck();
  const card = useContractCard();
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return undefined;
    }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await search(term);
        if (seq.current === mine) setResults(r);
      } catch {
        if (seq.current === mine) setResults([]);
      } finally {
        if (seq.current === mine) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, search]);

  const pick = (r) => {
    card.open(r.address, r.label);
    setQ("");
    setResults([]);
  };

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, background: panel2, border: `1px solid ${border}`, borderRadius: 6, padding: "0 12px" }}>
        <Search size={16} color={muted} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && results[0] && pick(results[0])}
          placeholder="Token symbol, project, name.etn or address"
          aria-label="Search for a contract"
          style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "#fff", padding: "12px 0", fontSize: 14 }}
        />
        {loading && <Loader2 size={16} color={muted} />}
      </div>
      {results.length > 0 && (
        <div role="listbox" style={{ position: "absolute", zIndex: 20, left: 0, right: 0, top: "calc(100% + 4px)", background: "#0b0b0b", border: `1px solid ${border}`, borderRadius: 6, overflow: "hidden" }}>
          {results.map((r) => (
            <button key={r.address} type="button" role="option" onClick={() => pick(r)} style={{ ...rowStyle, border: "none", borderBottom: `1px solid ${border}`, borderRadius: 0, background: "transparent" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, overflowWrap: "anywhere" }}>{r.label}</div>
                <div style={{ fontFamily: monoFont, fontSize: 11, color: muted }}>
                  {r.sub && r.sub !== r.address ? `${r.sub} · ` : ""}
                  {shortAddr(r.address)}
                </div>
              </div>
              {r.kind === "known" && <KnownBadge known={{ label: r.label }} small />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UsedContracts({ wallet, getAuthParams }) {
  const { getUsedContracts } = useContractCheck();
  const card = useContractCard();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const authRef = useRef(getAuthParams);
  authRef.current = getAuthParams;

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await getUsedContracts(await authRef.current(AUTH_PURPOSE)));
    } catch (e) {
      setError(e.message);
    }
  }, [getUsedContracts]);
  useEffect(() => {
    if (wallet.account) load();
  }, [wallet.account, load]);

  if (error) return <div style={{ color: errorColor, fontSize: 13 }}>{error}</div>;
  if (!rows) return <div style={{ color: mutedLight, fontSize: 13 }}>Loading the contracts your wallets have used…</div>;
  if (!rows.length) return <div style={{ color: mutedLight, fontSize: 13 }}>No contract activity found for your wallets yet.</div>;
  const unknown = rows.filter((r) => !r.known);
  const known = rows.filter((r) => r.known);
  const list = (items) => (
    <div style={{ display: "grid", gap: 6 }}>
      {items.map((r) => (
        <button key={r.address} type="button" onClick={() => card.open(r.address, rowName(r))} style={rowStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, overflowWrap: "anywhere" }}>{rowName(r)}</div>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: muted }}>
              {shortAddr(r.address)} · last used {ago(r.lastAt)}
            </div>
          </div>
          <OverallBadge overall={r.overall} small />
        </button>
      ))}
    </div>
  );
  return (
    <>
      {unknown.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: gold, margin: "0 0 6px" }}>Not in our registry ({unknown.length}) — worth a look</div>
          {list(unknown)}
        </>
      )}
      {known.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: mutedLight, margin: "14px 0 6px" }}>Known contracts ({known.length})</div>
          {list(known)}
        </>
      )}
    </>
  );
}

function fmtAllowance(a) {
  if (a.kind === "nft-all") return "All NFTs in this collection";
  if (a.kind === "nft-one") return `NFT #${a.tokenId}`;
  if (a.unlimited) return "Unlimited";
  try {
    return `${Number(ethers.formatUnits(a.allowance, a.tokenDecimals ?? 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${a.tokenSymbol || ""}`.trim();
  } catch {
    return a.allowance;
  }
}

function Approvals({ wallet, getAuthParams }) {
  const { getApprovals } = useContractCheck();
  const card = useContractCard();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // key being revoked
  const [txError, setTxError] = useState(null);
  const authRef = useRef(getAuthParams);
  authRef.current = getAuthParams;

  const load = useCallback(async (refresh = false) => {
    setError(null);
    try {
      setData(await getApprovals(await authRef.current(AUTH_PURPOSE), refresh));
    } catch (e) {
      setError(e.message);
    }
  }, [getApprovals]);
  useEffect(() => {
    if (wallet.account) load();
  }, [wallet.account, load]);

  // Prepares the revoke and hands it to the member's own wallet to sign — nothing is sent for them.
  const revoke = async (a) => {
    const key = `${a.token}|${a.spender}|${a.kind}`;
    setBusy(key);
    setTxError(null);
    try {
      await wallet.ensureCorrectNetwork();
      const signer = await wallet.getSigner();
      const c = new ethers.Contract(a.token, REVOKE_ABI, signer);
      const call = a.kind === "nft-all" ? ["setApprovalForAll", [a.spender, false]] : a.kind === "nft-one" ? ["approve", [ethers.ZeroAddress, BigInt(a.tokenId)]] : ["approve", [a.spender, 0n]];
      await c[call[0]].staticCall(...call[1]); // dry run: surfaces a revert before the wallet asks for gas
      const tx = await c[call[0]](...call[1]);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction failed on-chain");
      await load(true);
    } catch (e) {
      setTxError(e.shortMessage || e.reason || e.message || "Revoke failed");
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div style={{ color: errorColor, fontSize: 13 }}>{error}</div>;
  if (!data) return <div style={{ color: mutedLight, fontSize: 13 }}>Checking your wallet's approvals — this reads your whole transaction history, so the first check can take a minute…</div>;
  const items = data.approvals || [];
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1, fontSize: 12, color: mutedLight }}>
          {items.length ? `${items.length} live approval${items.length === 1 ? "" : "s"} from ${shortAddr(wallet.account)}` : "No live approvals found for this wallet."}
          {!data.complete && " (only your most recent transactions were checked)"}
        </div>
        <button type="button" onClick={() => load(true)} aria-label="Refresh approvals" style={{ background: "transparent", border: `1px solid ${border}`, color: mutedLight, borderRadius: 6, padding: 6, cursor: "pointer" }}>
          <RefreshCw size={14} />
        </button>
      </div>
      {txError && <div style={{ color: errorColor, fontSize: 12, marginBottom: 8 }}>{txError}</div>}
      <div style={{ display: "grid", gap: 6 }}>
        {items.map((a) => {
          const key = `${a.token}|${a.spender}|${a.kind}`;
          const spender = a.spenderKnown?.label || a.spenderName || shortAddr(a.spender);
          return (
            <div key={key} style={{ ...rowStyle, cursor: "default", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, overflowWrap: "anywhere" }}>
                  {a.tokenSymbol || a.tokenName || shortAddr(a.token)} <span style={{ color: muted, fontWeight: 400 }}>→</span>{" "}
                  <button type="button" onClick={() => card.open(a.spender, spender)} style={{ background: "transparent", border: "none", padding: 0, color: green, fontWeight: 700, fontSize: 13, cursor: "pointer", textDecoration: "underline" }}>
                    {spender}
                  </button>
                </div>
                <div style={{ fontSize: 12, color: a.unlimited ? gold : mutedLight, marginTop: 2 }}>{fmtAllowance(a)}</div>
              </div>
              <OverallBadge overall={a.spenderOverall} small />
              <button type="button" disabled={busy === key} onClick={() => revoke(a)} style={{ background: "transparent", border: `1px solid ${errorColor}`, color: errorColor, borderRadius: 6, padding: "6px 10px", fontFamily: monoFont, fontWeight: 800, fontSize: 11, textTransform: "uppercase", cursor: busy === key ? "wait" : "pointer", opacity: busy === key ? 0.6 : 1 }}>
                {busy === key ? "Revoking…" : "Revoke"}
              </button>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: muted, marginTop: 8 }}>Approvals given by signature (permit) don't show up as your own transactions and aren't listed here.</div>
    </>
  );
}

export default function CoreTierContracts({ wallet, getAuthParams, coreTierAccess }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, checkAccessOnce } = coreTierAccess;
  return (
    <CollapsibleCoreTierPanel title="Contract Check" icon={FileSearch} defaultCollapsed={false}>
      <CoreTierGate wallet={wallet} hasAccess={hasAccess} accessError={accessError} awaitingActivation={awaitingActivation} manualCheckLoading={manualCheckLoading} checkAccessOnce={checkAccessOnce} featureDescription="check any contract your wallet touches in plain English">
        <div style={{ fontSize: 13, color: mutedLight, marginBottom: 12, lineHeight: 1.5 }}>
          Argus reads a contract's code and on-chain settings and tells you what its owner can do — no copying from an explorer. Tap any contract for the details.
        </div>
        <SearchBox />
        {sectionTitle(FileSearch, "Contracts you've used")}
        <UsedContracts wallet={wallet} getAuthParams={getAuthParams} />
        {sectionTitle(KeyRound, "Your approvals")}
        <Approvals wallet={wallet} getAuthParams={getAuthParams} />
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}
