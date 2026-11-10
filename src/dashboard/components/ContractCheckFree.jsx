import React, { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useContractCheck } from "../hooks/useContractCheck.js";
import { OverallBadge, KnownBadge, VerificationLine, RiskFlagList } from "./ContractCheckBits.jsx";
import { gold, muted, mutedLight, border, panel2, monoFont } from "../theme.js";

// The free tier's view of Contract Check (Address Lookup tab): the overall badge and every risk flag —
// a high-severity warning is never behind the paywall — plus a pointer to Core Tier for the
// plain-English explanation and questions. Wallet-free, like the rest of the free dashboard.
export default function ContractCheckFree({ address }) {
  const { getFacts } = useContractCheck();
  const [facts, setFacts] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFacts(null);
    setFailed(false);
    getFacts(address)
      .then((d) => !cancelled && setFacts(d.facts))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [address, getFacts]);

  if (failed || facts?.identity?.isContract === false) return null;
  return (
    <div style={{ margin: "0 0 20px", background: panel2, border: `1px solid ${border}`, borderRadius: 6, padding: 12 }}>
      <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>Contract Check</div>
      {!facts ? (
        <div style={{ fontSize: 12, color: mutedLight }}>Reading the contract…</div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            <OverallBadge overall={facts.overall} />
            <KnownBadge known={facts.identity?.known} />
          </div>
          <VerificationLine facts={facts} />
          <div style={{ marginTop: 10 }}>
            <RiskFlagList flags={facts.riskFlags} />
          </div>
          <div style={{ fontSize: 12, color: mutedLight, marginTop: 10 }}>
            <Sparkles size={13} color={gold} style={{ verticalAlign: -2, marginRight: 6 }} />
            Core Tier members get a plain-English explanation of what this contract's owner can do, and can ask their own questions.
          </div>
          <div style={{ fontSize: 11, color: muted, marginTop: 8 }}>Automated analysis, not financial advice.</div>
        </>
      )}
    </div>
  );
}
