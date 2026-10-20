import React from "react";
import { green, greenGlow, gold, goldGlow, monoFont } from "../theme.js";

// The dashboard's top-level split: Core Tier/PnL Statements (the wallet-requiring paid features) vs
// the free, walletless Electroneum Dashboard (Overview, Tokens, Address Lookup, etc. — see
// DashboardNav.jsx, nested one level under this). Square tiles with an illustration each, so the two
// entry points read as the page's main actions rather than another row of tabs: gold for Core Tier
// (same "this is the paid product" colour as everywhere else), green for the free dashboard.

/** Money bag — Core Tier. Inline SVG so it's crisp at any size and identical on every OS. */
function MoneyBagArt({ color }) {
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">
      <path d="M24 10h16l-4 9H28z" fill={color} opacity="0.85" />
      <path d="M26 19h12" stroke={color} strokeWidth="3" strokeLinecap="round" />
      <path
        d="M27 21C16 27 9 37 9 45c0 7 6 11 13 11h20c7 0 13-4 13-11 0-8-7-18-18-24z"
        fill={color}
        fillOpacity="0.18"
        stroke={color}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <text x="32" y="48" textAnchor="middle" fontFamily="Orbitron, monospace" fontWeight="900" fontSize="20" fill={color}>
        $
      </text>
    </svg>
  );
}

/** Rising chart — Electroneum Dashboard. */
function ChartArt({ color }) {
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">
      <rect x="6" y="8" width="52" height="48" rx="6" fill={color} fillOpacity="0.12" stroke={color} strokeWidth="2.5" />
      <rect x="14" y="38" width="7" height="12" rx="1.5" fill={color} opacity="0.55" />
      <rect x="25" y="32" width="7" height="18" rx="1.5" fill={color} opacity="0.7" />
      <rect x="36" y="26" width="7" height="24" rx="1.5" fill={color} opacity="0.85" />
      <path d="M13 31l11-8 9 5 15-13" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M41 14h8v8" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const SECTIONS = [
  { id: "coretier", label: "Core Tier & PnL Statements", color: gold, glow: goldGlow, tint: "232,191,76", Art: MoneyBagArt },
  { id: "electroneum", label: "Electroneum Dashboard", color: green, glow: greenGlow, tint: "24,187,26", Art: ChartArt },
];

function SectionTile({ s, isActive, onChange }) {
  const { Art } = s;
  return (
    <button
      type="button"
      onClick={() => onChange(s.id)}
      aria-pressed={isActive}
      className="main-section-tile"
      style={{
        aspectRatio: "1 / 1",
        width: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 14,
        borderRadius: 10,
        border: `2px solid ${s.color}`,
        background: isActive ? `rgba(${s.tint},0.22)` : `rgba(${s.tint},0.07)`,
        boxShadow: isActive ? `0 0 22px ${s.glow}, inset 0 0 18px rgba(${s.tint},0.12)` : `0 0 8px rgba(${s.tint},0.15)`,
        color: isActive ? "#fff" : s.color,
        cursor: "pointer",
        transition: "background 0.15s, box-shadow 0.15s, transform 0.15s",
      }}
    >
      <div style={{ width: "46%", maxWidth: 84, aspectRatio: "1 / 1" }}>
        <Art color={s.color} />
      </div>
      <div
        style={{
          fontFamily: monoFont,
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          lineHeight: 1.35,
          textAlign: "center",
        }}
      >
        {s.label}
      </div>
    </button>
  );
}

export default function MainSectionNav({ active, onChange }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <style>{`
        .main-section-nav{display:grid;grid-template-columns:repeat(2,minmax(0,200px));justify-content:center;gap:14px;}
        .main-section-tile:hover{transform:translateY(-2px);}
        @media (max-width:420px){
          .main-section-nav{gap:10px;}
          .main-section-tile{padding:10px !important;gap:8px !important;}
        }
      `}</style>
      <div className="main-section-nav">
        {SECTIONS.map((s) => (
          <SectionTile key={s.id} s={s} isActive={s.id === active} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}
