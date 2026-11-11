import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { X, ExternalLink, MessageCircleQuestion, Loader2, Sparkles, ThumbsUp, ThumbsDown } from "lucide-react";
import { useContractCheck } from "../../hooks/useContractCheck.js";
import { OverallBadge, KnownBadge, VerificationLine, RiskFlagList, contractLabel, shortAddr } from "../../components/ContractCheckBits.jsx";
import { EXPLORER_BASE_URL } from "../../../config.js";
import { green, gold, muted, mutedLight, border, panel, panel2, monoFont, error as errorColor } from "../../theme.js";

// Contract Check card — "what is this contract and what can its owner do", for any contract a member's
// wallet touches, without copying anything from an explorer. Facts (flags, badge) load for everyone; the
// plain-English summary, the instant chip answers and free-text questions are Core Tier. Opened from
// anywhere inside the Core Tier section through ContractCardProvider / useContractCard (the "Ask" buttons).
const AUTH_PURPOSE = "Premium Dashboard";
const CHIPS = [
  { id: "whatDoesItDo", question: "What does this contract do?" },
  { id: "canOwnerTakeTokens", question: "Can the owner take my tokens?" },
  { id: "canChangeFees", question: "Can they change fees?" },
  { id: "canPauseOrFreeze", question: "Can they pause or freeze transfers?" },
  { id: "isUpgradeable", question: "Is it upgradeable?" },
  { id: "whoControlsIt", question: "Who controls it?" },
];

const ContractCardContext = createContext(null);

/** Wraps the Core Tier section; `open(address, hint?)` shows the card for a contract. */
export function ContractCardProvider({ wallet, getAuthParams, hasAccess, initialAddress = null, initialHint = null, children }) {
  // initialAddress: a card to open straight away (the ?contract= link in Telegram alerts and /check)
  const [target, setTarget] = useState(initialAddress ? { address: initialAddress, hint: initialHint } : null); // { address, hint }
  const open = useCallback((address, hint) => address && setTarget({ address, hint }), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <ContractCardContext.Provider value={value}>
      {children}
      {target && <ContractCard key={target.address} address={target.address} hint={target.hint} wallet={wallet} getAuthParams={getAuthParams} hasAccess={hasAccess} onClose={() => setTarget(null)} />}
    </ContractCardContext.Provider>
  );
}

export const useContractCard = () => useContext(ContractCardContext);

/** A small "Ask" button that opens the card for `address` — renders nothing outside the provider. */
export function AskButton({ address, hint, style = {} }) {
  const ctx = useContractCard();
  if (!ctx || !address) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        // rows can be links (Recent Activity) or toggles (positions): open the card, nothing else
        e.preventDefault();
        e.stopPropagation();
        ctx.open(address, hint);
      }}
      title="Ask about this contract"
      style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "transparent", border: `1px solid ${border}`, color: green, borderRadius: 999, padding: "2px 8px", fontFamily: monoFont, fontSize: 10, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", cursor: "pointer", flexShrink: 0, ...style }}
    >
      <MessageCircleQuestion size={11} /> Ask
    </button>
  );
}

const sectionLabel = { fontFamily: monoFont, fontSize: 10, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: muted, margin: "16px 0 8px" };
const explorerLink = (a) => `${EXPLORER_BASE_URL}/address/${a}`;

/** "Was this right?" — a 👍 / 👎 on this card's badge and flags (a 👎 can say why). Kept as labelled data so
 * false positives show up early (backend db/watchFeedback.js). */
function WasThisRight({ address, authRef }) {
  const { sendFeedback } = useContractCheck();
  const [state, setState] = useState(null); // null | "asking" (👎, waiting for a note) | "sending" | "done" | error text
  const [note, setNote] = useState("");
  const send = async (verdict, why = null) => {
    setState("sending");
    try {
      await sendFeedback(await authRef.current(AUTH_PURPOSE), address, verdict, why);
      setState("done");
    } catch (e) {
      setState(e.message || "Couldn't send that");
    }
  };
  const btn = { display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", border: `1px solid ${border}`, color: mutedLight, borderRadius: 999, padding: "6px 12px", fontSize: 12, cursor: "pointer" };
  if (state === "done") return <div style={{ fontSize: 12, color: green, marginTop: 16 }}>Thanks — noted.</div>;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 12, color: mutedLight, marginBottom: 6 }}>Was this check right?</div>
      {state === "asking" ? (
        <form onSubmit={(e) => { e.preventDefault(); send("wrong", note.trim() || null); }} style={{ display: "flex", gap: 6 }}>
          <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} placeholder="What's wrong? (optional)" aria-label="What's wrong with this check" style={{ flex: 1, minWidth: 0, background: panel2, border: `1px solid ${border}`, borderRadius: 6, color: "#fff", padding: "8px 10px", fontSize: 13 }} />
          <button type="submit" style={{ ...btn, color: "#fff" }}>Send</button>
        </form>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={state === "sending"} onClick={() => send("right")} style={btn}><ThumbsUp size={14} /> Right</button>
          <button type="button" disabled={state === "sending"} onClick={() => setState("asking")} style={btn}><ThumbsDown size={14} /> Wrong</button>
        </div>
      )}
      {state && !["asking", "sending", "done"].includes(state) && <div style={{ fontSize: 12, color: errorColor, marginTop: 6 }}>{state}</div>}
    </div>
  );
}

export default function ContractCard({ address, hint, wallet, getAuthParams, hasAccess, onClose }) {
  const { getFacts, explain } = useContractCheck();
  const [facts, setFacts] = useState(null);
  const [factsError, setFactsError] = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [explainError, setExplainError] = useState(null);
  const [explaining, setExplaining] = useState(false);
  const [chip, setChip] = useState(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [asking, setAsking] = useState(false);
  const [quota, setQuota] = useState(null); // questions left: 5 a day, 20 a week, 50 a month (backend questionQuota.js)
  const authRef = useRef(getAuthParams);
  authRef.current = getAuthParams; // latest, without re-running effects for it (it changes every render)

  // Facts — then the cached summary. Both are Core tier only.
  useEffect(() => {
    if (!hasAccess) return undefined;
    let cancelled = false;
    setFacts(null);
    setFactsError(null);
    (async () => {
      try {
        const d = await getFacts(await authRef.current(AUTH_PURPOSE), address);
        if (!cancelled) setFacts(d.facts);
      } catch (e) {
        if (!cancelled) setFactsError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, hasAccess, getFacts]);

  useEffect(() => {
    if (!facts || !hasAccess || facts.identity?.isContract === false) return undefined;
    let cancelled = false;
    setExplaining(true);
    setExplainError(null);
    (async () => {
      try {
        const auth = await authRef.current(AUTH_PURPOSE);
        const d = await explain(auth, facts.address);
        if (!cancelled) {
          setExplanation(d);
          if (d.questions) setQuota(d.questions);
        }
      } catch (e) {
        if (!cancelled) setExplainError(e.message);
      } finally {
        if (!cancelled) setExplaining(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [facts, hasAccess, explain]);

  // Close on Escape; lock the page behind the sheet.
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const ask = async () => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setAnswer(null);
    try {
      const auth = await authRef.current(AUTH_PURPOSE);
      const d = await explain(auth, facts.address, q);
      setAnswer(d);
      if (d.questions) setQuota(d.questions);
    } catch (e) {
      setAnswer({ error: e.message });
      if (e.questions) setQuota(e.questions);
    } finally {
      setAsking(false);
    }
  };

  const summary = explanation?.summary;
  const title = facts ? contractLabel(facts, hint) : hint || shortAddr(address);
  const links = facts
    ? [
        { label: "Contract", address: facts.address },
        facts.proxy?.implementation && { label: "Implementation", address: facts.proxy.implementation },
        facts.ownership?.owner && facts.ownership.ownerStatus !== "renounced" && { label: "Owner", address: facts.ownership.owner },
        facts.creation?.deployer && { label: "Deployer", address: facts.creation.deployer },
      ].filter(Boolean)
    : [];

  return (
    <div role="dialog" aria-modal="true" aria-label={`Contract check: ${title}`} onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <style>{`@media (min-width:720px){.contract-card-sheet{margin:auto!important;border-radius:8px!important;max-height:85vh!important}}`}</style>
      <div
        className="contract-card-sheet"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 560, maxHeight: "92vh", overflowY: "auto", background: panel, border: `1px solid ${border}`, borderRadius: "12px 12px 0 0", padding: "16px 16px 24px", boxSizing: "border-box" }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 800, overflowWrap: "anywhere" }}>{title}</div>
            <div style={{ fontFamily: monoFont, fontSize: 11, color: muted, marginTop: 2 }}>{shortAddr(address)}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: mutedLight, cursor: "pointer", padding: 4 }}>
            <X size={20} />
          </button>
        </div>

        {!hasAccess && (
          <div style={{ marginTop: 16, background: panel2, border: `1px solid ${border}`, borderRadius: 6, padding: 12, fontSize: 13, color: mutedLight }}>
            <Sparkles size={14} color={gold} style={{ verticalAlign: -2, marginRight: 6 }} />
            Contract Check is part of Core Tier: risk flags, what the owner can do, a plain-English explanation and your own questions.
          </div>
        )}
        {factsError && <div style={{ color: errorColor, fontSize: 13, marginTop: 12 }}>{factsError}</div>}
        {hasAccess && !facts && !factsError && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: mutedLight, fontSize: 13, marginTop: 16 }}>
            <Loader2 size={16} className="spin" /> Reading the contract…
          </div>
        )}

        {facts && (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "12px 0 6px" }}>
              <OverallBadge overall={facts.overall} />
              <KnownBadge known={facts.identity?.known} />
            </div>
            <VerificationLine facts={facts} />
            {facts.incomplete && <div style={{ fontSize: 12, color: gold, marginTop: 6 }}>Some sources couldn't be reached just now, so parts of this check may be missing.</div>}

            <div style={sectionLabel}>Risk flags</div>
            <RiskFlagList flags={facts.riskFlags} />

            {hasAccess && facts.identity?.isContract !== false && (
              <>
                <div style={sectionLabel}>What it is</div>
                {explaining && !summary && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: mutedLight, fontSize: 13 }}>
                    <Loader2 size={16} /> Writing a plain-English summary…
                  </div>
                )}
                {explainError && <div style={{ color: errorColor, fontSize: 13 }}>{explainError}</div>}
                {summary && (
                  <>
                    <div style={{ fontSize: 14, lineHeight: 1.5 }}>{summary.oneLiner}</div>
                    {summary.overallSummary && <div style={{ fontSize: 13, color: mutedLight, marginTop: 6 }}>{summary.overallSummary}</div>}
                    <div style={sectionLabel}>What the owner can do</div>
                    {summary.ownerPowers?.length ? (
                      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 13, lineHeight: 1.45 }}>
                        {summary.ownerPowers.map((p, i) => (
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    ) : (
                      <div style={{ fontSize: 13, color: mutedLight }}>{summary.ownerPowersNote || "No owner or admin powers over holders were found."}</div>
                    )}

                    <div style={sectionLabel}>Quick questions</div>
                    {/* A dropdown, so the list can grow (backend scripts/topQuestions.js shows what members ask) */}
                    <select
                      value={chip || ""}
                      onChange={(e) => setChip(e.target.value || null)}
                      aria-label="Choose a quick question"
                      style={{ width: "100%", background: panel2, color: chip ? "#fff" : mutedLight, border: `1px solid ${chip ? green : border}`, borderRadius: 6, padding: "10px 12px", fontSize: 14, cursor: "pointer" }}
                    >
                      <option value="">Choose a question…</option>
                      {CHIPS.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.question}
                        </option>
                      ))}
                    </select>
                    {chip && summary.chipAnswers?.[chip] && <div style={{ marginTop: 10, background: panel2, border: `1px solid ${border}`, borderRadius: 6, padding: 12, fontSize: 13, lineHeight: 1.5 }}>{summary.chipAnswers[chip]}</div>}
                  </>
                )}

                <div style={sectionLabel}>Ask your own question</div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    ask();
                  }}
                  style={{ display: "flex", gap: 6 }}
                >
                  <input
                    value={question}
                    onChange={(e) => setQuestion(e.target.value.slice(0, 500))}
                    placeholder="e.g. Can the owner mint more tokens?"
                    aria-label="Your question about this contract"
                    style={{ flex: 1, minWidth: 0, background: panel2, border: `1px solid ${border}`, borderRadius: 6, color: "#fff", padding: "10px 12px", fontSize: 14 }}
                  />
                  <button type="submit" disabled={asking || !question.trim() || quota?.remaining === 0} style={{ background: green, color: "#000", border: "none", borderRadius: 6, padding: "0 14px", fontFamily: monoFont, fontWeight: 800, fontSize: 12, cursor: asking ? "wait" : "pointer", opacity: asking || !question.trim() || quota?.remaining === 0 ? 0.55 : 1 }}>
                    {asking ? "…" : "Ask"}
                  </button>
                </form>
                {quota && (
                  <div style={{ fontSize: 11, color: quota.remaining === 0 ? gold : muted, marginTop: 4 }}>
                    {quota.remaining === 0
                      ? quota.message
                      : `Questions left: ${quota.remainingBy.day} today · ${quota.remainingBy.week} this week · ${quota.remainingBy.month} this month`}
                  </div>
                )}
                {answer && (
                  <div style={{ marginTop: 10, background: panel2, border: `1px solid ${border}`, borderRadius: 6, padding: 12, fontSize: 13, lineHeight: 1.5, color: answer.error ? errorColor : undefined }}>
                    {answer.error || answer.answer}
                  </div>
                )}
              </>
            )}

            {(explanation?.notice || ["unverified", "unknown"].includes(facts.verification?.status)) && (
              <div style={{ fontSize: 12, color: gold, marginTop: 14 }}>{explanation?.notice || "Source code isn't published, so we can only see limited signals."}</div>
            )}

            <div style={sectionLabel}>Check it yourself</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {links.map((l) => (
                <a key={l.label} href={explorerLink(l.address)} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: mutedLight, fontSize: 12, textDecoration: "none", border: `1px solid ${border}`, borderRadius: 999, padding: "4px 10px" }}>
                  {l.label} {shortAddr(l.address)} <ExternalLink size={11} />
                </a>
              ))}
            </div>

            {hasAccess && facts.identity?.isContract !== false && <WasThisRight address={facts.address} authRef={authRef} />}

            <div style={{ fontSize: 11, color: muted, marginTop: 18, borderTop: `1px solid ${border}`, paddingTop: 10 }}>Automated analysis, not financial advice.</div>
          </>
        )}
      </div>
    </div>
  );
}
