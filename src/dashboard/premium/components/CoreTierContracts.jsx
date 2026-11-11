import React, { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { Search, KeyRound, RefreshCw, FileSearch, Loader2, Globe } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import CoreTierAppCheck from "./CoreTierAppCheck.jsx";
import { useContractCard } from "./ContractCard.jsx";
import { useContractCheck } from "../../hooks/useContractCheck.js";
import { OverallBadge, KnownBadge, shortAddr } from "../../components/ContractCheckBits.jsx";
import { green, gold, muted, mutedLight, border, panel2, monoFont, error as errorColor } from "../../theme.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { addPendingRevoke, getPendingRevokes, isPendingRevoke, removePendingRevoke, subscribePendingRevokes } from "../../utils/pendingRevokes.js";

// Contract Check panel: find any contract without copy-pasting from an explorer (search by symbol,
// project, name.etn or address), see every contract your wallets have used (last 30 days, older behind "Show more"),
// and the live approvals of your own and your tracked wallets — with a Revoke signed by the wallet that gave
// the approval (a tracked wallet's is queued here, then signed after switching to it: pendingRevokes.js). Every row opens the contract card (ContractCard.jsx).
// "Check an app" (CoreTierAppCheck.jsx) does the same starting from a website: Argus App Check.
const AUTH_PURPOSE = "Premium Dashboard";
const LIVE_ABI = ["function allowance(address owner, address spender) view returns (uint256)", "function isApprovedForAll(address owner, address operator) view returns (bool)", "function getApproved(uint256 tokenId) view returns (address)"];
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

function SearchBox({ getAuthParams }) {
  const { search } = useContractCheck();
  const authRef = useRef(getAuthParams);
  authRef.current = getAuthParams;
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
        const r = await search(await authRef.current(AUTH_PURPOSE), term);
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

const RECENT_DAYS = 30;

function UsedContracts({ wallet, getAuthParams }) {
  const { getUsedContracts } = useContractCheck();
  const card = useContractCard();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);
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
  // The last 30 days by default; older ones behind "Show more".
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  const recent = rows.filter((r) => r.lastAt && new Date(r.lastAt).getTime() >= cutoff);
  const olderCount = rows.length - recent.length;
  const shown = showAll ? rows : recent;
  const unknown = shown.filter((r) => !r.known);
  const known = shown.filter((r) => r.known);
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
      {!showAll && recent.length === 0 && <div style={{ color: mutedLight, fontSize: 13 }}>No contracts used in the last {RECENT_DAYS} days.</div>}
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
      {olderCount > 0 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} style={{ marginTop: 10, background: "transparent", border: `1px solid ${border}`, color: mutedLight, borderRadius: 6, padding: "8px 14px", fontFamily: monoFont, fontSize: 11, fontWeight: 800, textTransform: "uppercase", cursor: "pointer" }}>
          {showAll ? `Show the last ${RECENT_DAYS} days only` : `Show ${olderCount} more (older than ${RECENT_DAYS} days)`}
        </button>
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

const sameAddr = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** Prepares the revoke and hands it to the connected wallet to sign — nothing is sent for anyone. The
 * connected wallet must BE the approval's owner (approvals can only be changed by the wallet that gave them). */
async function signRevoke(wallet, a) {
  await wallet.ensureCorrectNetwork();
  const signer = await wallet.getSigner();
  const c = new ethers.Contract(a.token, REVOKE_ABI, signer);
  const call = a.kind === "nft-all" ? ["setApprovalForAll", [a.spender, false]] : a.kind === "nft-one" ? ["approve", [ethers.ZeroAddress, BigInt(a.tokenId)]] : ["approve", [a.spender, 0n]];
  await c[call[0]].staticCall(...call[1]); // dry run: surfaces a revert before the wallet asks for gas
  const tx = await c[call[0]](...call[1]);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Transaction failed on-chain");
}

/** Whether an approval is still live, read on-chain through the connected wallet's provider. */
async function stillLive(provider, r) {
  const c = new ethers.Contract(r.token, LIVE_ABI, provider);
  if (r.kind === "nft-all") return c.isApprovedForAll(r.owner, r.spender);
  if (r.kind === "nft-one") return sameAddr(await c.getApproved(BigInt(r.tokenId)), r.spender);
  return (await c.allowance(r.owner, r.spender)) > 0n;
}

function Approvals({ wallet, getAuthParams, trackedWallets }) {
  const { getApprovals } = useContractCheck();
  const card = useContractCard();
  const own = wallet.account;
  const owners = [own, ...trackedWallets.filter((a) => !sameAddr(a, own))].filter(Boolean);
  const { resolve: nameOf } = useDisplayNames(owners);
  const [owner, setOwner] = useState(own);
  const [byOwner, setByOwner] = useState({}); // lowercased owner -> approvals response
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // key being revoked
  const [txError, setTxError] = useState(null);
  const [, setTick] = useState(0);
  const authRef = useRef(getAuthParams);
  authRef.current = getAuthParams;
  const selected = owners.find((a) => sameAddr(a, owner)) || own;
  const isOwn = sameAddr(selected, own);

  useEffect(() => subscribePendingRevokes(() => setTick((t) => t + 1)), []);

  const load = useCallback(
    async (who, refresh = false) => {
      setError(null);
      try {
        const res = await getApprovals(await authRef.current(AUTH_PURPOSE), refresh, sameAddr(who, own) ? null : who);
        setByOwner((m) => ({ ...m, [who.toLowerCase()]: res }));
      } catch (e) {
        setError(e.message);
      }
    },
    [getApprovals, own]
  );
  useEffect(() => {
    if (selected && !byOwner[selected.toLowerCase()]) load(selected);
  }, [selected, byOwner, load]);

  const revoke = async (a) => {
    const key = `${a.token}|${a.spender}|${a.kind}`;
    setBusy(key);
    setTxError(null);
    try {
      await signRevoke(wallet, a);
      await load(selected, true);
    } catch (e) {
      setTxError(e.shortMessage || e.reason || e.message || "Revoke failed");
    } finally {
      setBusy(null);
    }
  };

  const data = selected ? byOwner[selected.toLowerCase()] : null;
  const items = data?.approvals || [];
  const queued = getPendingRevokes(selected);
  return (
    <>
      {owners.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {owners.map((a) => {
            const active = sameAddr(a, selected);
            return (
              <button
                key={a}
                type="button"
                onClick={() => setOwner(a)}
                style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${active ? green : border}`, background: active ? "rgba(24,187,26,0.12)" : panel2, color: active ? green : mutedLight, fontFamily: monoFont, fontSize: 11, fontWeight: 700, cursor: "pointer" }}
              >
                {nameOf(a)}
                {sameAddr(a, own) ? " (connected)" : ""}
              </button>
            );
          })}
        </div>
      )}
      {!isOwn && (
        <div style={{ fontSize: 12, color: mutedLight, background: panel2, border: `1px solid ${border}`, borderRadius: 6, padding: "8px 10px", marginBottom: 8, lineHeight: 1.5 }}>
          Only {nameOf(selected)} itself can revoke its approvals. Tap <b>Queue revoke</b>, then switch your wallet app to {nameOf(selected)} — the revoke will be waiting at the top of this panel, ready to sign.
          {queued.length > 0 && <span style={{ color: gold }}> {queued.length} queued.</span>}
        </div>
      )}
      {error && <div style={{ color: errorColor, fontSize: 13 }}>{error}</div>}
      {!error && !data && <div style={{ color: mutedLight, fontSize: 13 }}>Checking {isOwn ? "your wallet's" : `${nameOf(selected)}'s`} approvals — this reads the whole transaction history, so the first check can take a minute…</div>}
      {data && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1, fontSize: 12, color: mutedLight }}>
              {items.length ? `${items.length} live approval${items.length === 1 ? "" : "s"} from ${nameOf(selected)}` : "No live approvals found for this wallet."}
              {!data.complete && " (only the most recent transactions were checked)"}
            </div>
            <button type="button" onClick={() => load(selected, true)} aria-label="Refresh approvals" style={{ background: "transparent", border: `1px solid ${border}`, color: mutedLight, borderRadius: 6, padding: 6, cursor: "pointer" }}>
              <RefreshCw size={14} />
            </button>
          </div>
          {txError && <div style={{ color: errorColor, fontSize: 12, marginBottom: 8 }}>{txError}</div>}
          <div style={{ display: "grid", gap: 6 }}>
            {items.map((a) => {
              const key = `${a.token}|${a.spender}|${a.kind}`;
              const spender = a.spenderKnown?.label || a.spenderName || shortAddr(a.spender);
              const pending = { owner: selected, token: a.token, spender: a.spender, kind: a.kind, tokenId: a.tokenId ?? null };
              const isQueued = !isOwn && isPendingRevoke(pending);
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
                  {isOwn ? (
                    <button type="button" disabled={busy === key} onClick={() => revoke(a)} style={revokeBtn(busy === key)}>
                      {busy === key ? "Revoking…" : "Revoke"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => (isQueued ? removePendingRevoke(pending) : addPendingRevoke({ ...pending, tokenLabel: a.tokenSymbol || a.tokenName || shortAddr(a.token), spenderLabel: spender, allowanceLabel: fmtAllowance(a) }))}
                      style={{ ...revokeBtn(false), borderColor: isQueued ? gold : errorColor, color: isQueued ? gold : errorColor }}
                    >
                      {isQueued ? "Queued ✓" : "Queue revoke"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      <div style={{ fontSize: 11, color: muted, marginTop: 8 }}>Approvals given by signature (permit) don't show up as the wallet's own transactions and aren't listed here.</div>
    </>
  );
}

const revokeBtn = (busy) => ({ background: "transparent", border: `1px solid ${errorColor}`, color: errorColor, borderRadius: 6, padding: "6px 10px", fontFamily: monoFont, fontWeight: 800, fontSize: 11, textTransform: "uppercase", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 });

// Revokes queued (from a member's Core view) for the wallet that's connected NOW — usually a tracked wallet,
// which doesn't have Core Tier of its own. Sits outside the Core gate and calls no Argus API: the queue is
// on this device, and each entry is re-checked on-chain before it's offered.
function PendingRevokes({ wallet }) {
  const account = wallet.account;
  const [, setTick] = useState(0);
  const [live, setLive] = useState({}); // key -> true | false (checked)
  const [busy, setBusy] = useState(null);
  const [txError, setTxError] = useState(null);
  useEffect(() => subscribePendingRevokes(() => setTick((t) => t + 1)), []);
  const list = account ? getPendingRevokes(account) : [];
  const keyOf = (r) => `${r.token}|${r.spender}|${r.kind}|${r.tokenId ?? ""}`;
  const listKey = list.map(keyOf).join(",");

  // Drop the ones that are already gone (revoked elsewhere, or used up) before offering them.
  useEffect(() => {
    if (!list.length) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const provider = (await wallet.getSigner()).provider;
        for (const r of list) {
          const ok = await stillLive(provider, r).catch(() => true); // unreadable -> still offer it
          if (cancelled) return;
          if (!ok) removePendingRevoke(r);
          else setLive((m) => ({ ...m, [keyOf(r)]: true }));
        }
      } catch {
        // no signer yet — offer them as they are
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, listKey]);

  if (!list.length) return null;
  const revoke = async (r) => {
    setBusy(keyOf(r));
    setTxError(null);
    try {
      await signRevoke(wallet, r);
      removePendingRevoke(r);
    } catch (e) {
      setTxError(e.shortMessage || e.reason || e.message || "Revoke failed");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div style={{ border: `1px solid ${gold}`, borderRadius: 6, padding: 12, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: monoFont, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: gold, marginBottom: 8 }}>
        <KeyRound size={14} /> Revokes waiting for this wallet ({list.length})
      </div>
      {txError && <div style={{ color: errorColor, fontSize: 12, marginBottom: 8 }}>{txError}</div>}
      <div style={{ display: "grid", gap: 6 }}>
        {list.map((r) => (
          <div key={keyOf(r)} style={{ ...rowStyle, cursor: "default", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, overflowWrap: "anywhere" }}>
                {r.tokenLabel} <span style={{ color: muted, fontWeight: 400 }}>→</span> {r.spenderLabel}
              </div>
              <div style={{ fontSize: 12, color: mutedLight, marginTop: 2 }}>
                {r.allowanceLabel}
                {live[keyOf(r)] ? " · still live" : ""}
              </div>
            </div>
            <button type="button" onClick={() => removePendingRevoke(r)} style={{ background: "transparent", border: `1px solid ${border}`, color: mutedLight, borderRadius: 6, padding: "6px 10px", fontFamily: monoFont, fontWeight: 800, fontSize: 11, textTransform: "uppercase", cursor: "pointer" }}>
              Dismiss
            </button>
            <button type="button" disabled={busy === keyOf(r)} onClick={() => revoke(r)} style={revokeBtn(busy === keyOf(r))}>
              {busy === keyOf(r) ? "Revoking…" : "Revoke"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CoreTierContracts({ wallet, getAuthParams, coreTierAccess, linkedApp = null }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, checkAccessOnce, active } = coreTierAccess;
  const trackedWallets = (active || []).map((w) => w.address);
  return (
    <CollapsibleCoreTierPanel title="Contract Check" icon={FileSearch} defaultCollapsed={false}>
      <PendingRevokes wallet={wallet} />
      <CoreTierGate wallet={wallet} hasAccess={hasAccess} accessError={accessError} awaitingActivation={awaitingActivation} manualCheckLoading={manualCheckLoading} checkAccessOnce={checkAccessOnce} featureDescription="check any contract your wallet touches in plain English">
        <div style={{ fontSize: 13, color: mutedLight, marginBottom: 12, lineHeight: 1.5 }}>
          Argus reads a contract's code and on-chain settings and tells you what its owner can do — no copying from an explorer. Tap any contract for the details.
        </div>
        <SearchBox getAuthParams={getAuthParams} />
        {sectionTitle(Globe, "Check an app")}
        <CoreTierAppCheck getAuthParams={getAuthParams} initialInput={linkedApp} />
        {sectionTitle(FileSearch, "Contracts you've used")}
        <UsedContracts wallet={wallet} getAuthParams={getAuthParams} />
        {sectionTitle(KeyRound, "Approvals")}
        <Approvals wallet={wallet} getAuthParams={getAuthParams} trackedWallets={trackedWallets} />
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}
