import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Globe, ChevronDown, ChevronRight } from "lucide-react";
import Panel from "./Panel.jsx";
import { useActivatedDomains } from "../hooks/useActivatedDomains.js";
import { formatTimeLeft, isExpired, shortAddress } from "../utils/format.js";
import { green, mutedLight, muted, error as errorColor, panel2, border } from "../styles/theme.js";

// Just a fresh re-fetch of the small published JSON, not an RPC poll — the underlying data only
// actually changes as often as activatedDomainsCache.js's own refresh cycle (5 min by default), so
// polling much faster than that would just be wasted requests for the same content.
const POLL_INTERVAL_MS = 60000;

function ownerLabel(node) {
  return node.ownerPrimaryName || shortAddress(node.owner);
}

function Row({ label, timeLeft, ownerText, expired, depth, expandable, expanded, onToggle, childCount }) {
  return (
    <div
      onClick={expandable ? onToggle : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 12px",
        paddingLeft: 12 + depth * 20,
        borderRadius: depth === 0 ? 10 : 0,
        background: depth === 0 ? panel2 : "transparent",
        border: depth === 0 ? `1px solid ${border}` : "none",
        borderBottom: depth > 0 ? `1px solid ${border}` : undefined,
        cursor: expandable ? "pointer" : "default",
        opacity: expired ? 0.55 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {expandable ? (
          expanded ? <ChevronDown size={14} color={mutedLight} /> : <ChevronRight size={14} color={mutedLight} />
        ) : (
          <span style={{ width: 14, display: "inline-block" }} />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: depth === 0 ? 14 : 13, fontWeight: depth === 0 ? 700 : 500, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {label}
          </div>
          <div style={{ fontSize: 11, color: mutedLight, marginTop: 1 }}>
            {ownerText}
            {expandable ? ` · ${childCount} subname${childCount === 1 ? "" : "s"}` : ""}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: expired ? errorColor : mutedLight, whiteSpace: "nowrap", flexShrink: 0 }}>
        {timeLeft}
      </div>
    </div>
  );
}

export default function ActivatedDomainsTable() {
  const [domains, setDomains] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [showExpired, setShowExpired] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState(() => new Set());

  const { getActivatedDomains } = useActivatedDomains();

  const refresh = useCallback(async () => {
    try {
      const result = await getActivatedDomains();
      setDomains(result);
      setLoadError(null);
    } catch (err) {
      console.error("Failed to load activated domains:", err);
      setLoadError("Couldn't load activated domains right now — try again shortly.");
    }
  }, [getActivatedDomains]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const visibleDomains = useMemo(() => {
    if (!domains) return [];
    return domains
      .filter((d) => showExpired || !isExpired(d.expiry))
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [domains, showExpired]);

  const toggle = (node) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });
  };

  return (
    <Panel style={{ width: "100%", maxWidth: 600, margin: "16px auto 0", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Globe size={18} color={green} />
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
            Activated Domains
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: mutedLight, cursor: "pointer" }}>
          <input type="checkbox" checked={showExpired} onChange={(e) => setShowExpired(e.target.checked)} />
          Show expired
        </label>
      </div>

      {domains === null && !loadError && (
        <div style={{ fontSize: 13, color: mutedLight, textAlign: "center", padding: "20px 0" }}>
          Loading activated domains...
        </div>
      )}

      {loadError && (
        <div style={{ fontSize: 13, color: errorColor, textAlign: "center", padding: "20px 0" }}>
          {loadError}
        </div>
      )}

      {domains !== null && !loadError && visibleDomains.length === 0 && (
        <div style={{ fontSize: 13, color: mutedLight, textAlign: "center", padding: "20px 0", lineHeight: 1.6 }}>
          {showExpired ? "No activated domains yet." : "No active (non-expired) domains right now — try “Show expired”."}
        </div>
      )}

      {domains !== null && !loadError && visibleDomains.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visibleDomains.map((domain) => {
            const expanded = expandedNodes.has(domain.node);
            const subnames = domain.subnames
              .filter((s) => showExpired || !isExpired(s.expiry))
              .slice()
              .sort((a, b) => a.label.localeCompare(b.label));

            return (
              <div key={domain.node}>
                <Row
                  label={`${domain.label}.etn`}
                  timeLeft={formatTimeLeft(domain.expiry)}
                  ownerText={ownerLabel(domain)}
                  expired={isExpired(domain.expiry)}
                  depth={0}
                  expandable
                  expanded={expanded}
                  onToggle={() => toggle(domain.node)}
                  childCount={domain.subnames.length}
                />
                {expanded && (
                  <div style={{ background: panel2, border: `1px solid ${border}`, borderTop: "none", borderRadius: "0 0 10px 10px", overflow: "hidden" }}>
                    {subnames.length === 0 ? (
                      <div style={{ fontSize: 12, color: muted, padding: "10px 12px", paddingLeft: 32 }}>
                        No subnames registered yet.
                      </div>
                    ) : (
                      subnames.map((sub) => (
                        <Row
                          key={sub.node}
                          label={`${sub.label}.${domain.label}.etn`}
                          timeLeft={formatTimeLeft(sub.expiry)}
                          ownerText={ownerLabel(sub)}
                          expired={isExpired(sub.expiry)}
                          depth={1}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
