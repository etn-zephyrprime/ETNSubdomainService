import React from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { green, gold, muted, mutedLight, border, panel2, monoFont, blue } from "../theme.js";
import CornerBrackets from "./CornerBrackets.jsx";
import { EXPLORER_BASE_URL } from "../config.js";

// /about — "How Argus works" and "Verify us": the principle behind the AI watcher, what it checks, where the
// data comes from, what it can't do, and how to check that you're on the real thing (official channels and
// our verified contracts, each linked to the explorer). Free and static: no wallet, no API calls.
// The contract list mirrors backend/services/contractCheck/knownContracts.js's "Planet Zephyros" entries.

const OUR_CONTRACTS = [
  { label: "Core Tier / PnL Statements (subscription)", address: "0x05Cc5a4Cbf18113f7e9c1675a0Ffc702BA7876E1" },
  { label: "CORE token", address: "0x309B916b3A90cb3E071697Ea9680e9217A30066f" },
  { label: "ETN Subdomain Service (marketplace)", address: "0xFD8944132Cf464Fb756F98D1d203Edf74A2B7aD5" },
  { label: "Core Ascension Vault", address: "0x200a9b5fe78d4cb5232a3a0c52b510f961c51cd6" },
];
const CHANNELS = [
  { label: "Telegram", href: "https://t.me/PlanetZephyros", text: "t.me/PlanetZephyros" },
  { label: "X", href: "https://x.com/ETNSubdomain", text: "x.com/ETNSubdomain" },
  { label: "Alerts bot", href: "https://t.me/PlanetZephyrosNotisBot", text: "@PlanetZephyrosNotisBot — the only bot that sends Argus alerts" },
];

const h2 = { fontFamily: monoFont, fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: green, margin: "0 0 10px" };
const p = { fontSize: 14, color: mutedLight, lineHeight: 1.6, margin: "0 0 10px" };
const li = { fontSize: 14, color: mutedLight, lineHeight: 1.55, marginBottom: 6 };

function Panel({ children }) {
  return (
    <section style={{ position: "relative", padding: 18, borderRadius: 4, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
      <CornerBrackets color={green} />
      {children}
    </section>
  );
}

export default function AboutArgus({ onBack }) {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <button type="button" onClick={onBack} style={{ background: "transparent", border: "none", color: mutedLight, fontSize: 13, cursor: "pointer", padding: 0, marginBottom: 14 }}>
        ← Back to Argus
      </button>
      <h1 style={{ fontFamily: monoFont, fontSize: 22, color: "#fff", margin: "0 0 16px" }}>How Argus works</h1>

      <Panel>
        <div style={h2}>The principle</div>
        <p style={{ ...p, color: "#fff" }}>
          <b>Facts come from code that reads the chain; Claude only explains them.</b> Every Claude answer is checked in code before anyone sees it —
          no addresses or numbers that aren't in the facts, no "safe" or "scam" verdicts, no financial advice, no links — and if a check fails, a
          plain template is used instead. Claude doesn't learn from use; Argus gets better as we add rules.
        </p>
      </Panel>

      <Panel>
        <div style={h2}>What it checks</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li style={li}>
            <b>Contract Check</b> — for any contract: whether its source is published, whether it can be upgraded and by whom, who controls it
            (owner, admin and custom roles, read live), what that control allows (minting, pausing, blacklisting, fees, moving tokens), how much of
            its ElectroSwap liquidity is locked or farmed, holder concentration and age. Each finding is a rule with a set severity, rolled into a
            🟢 / 🟡 / 🔴 badge.
          </li>
          <li style={li}>
            <b>Plain-English explanations</b> (Core Tier) — Claude explains those facts and answers questions about them, within the checks above.
          </li>
          <li style={li}>
            <b>Watching</b> (Core Tier, on Telegram) — new approvals to unknown or flagged contracts, changes to tokens you hold (owner, code,
            upgrades), owners or multisigs using their powers on those tokens, and a daily wallet check for risky approvals, address poisoning and
            bait airdrops.
          </li>
        </ul>
      </Panel>

      <Panel>
        <div style={h2}>Where the data comes from</div>
        <p style={p}>
          The Electroneum blockchain itself (its RPC and the Blockscout explorer), ElectroSwap, CoinGecko, GeckoTerminal, KuCoin and Hyperlane. Claude
          (by Anthropic) only writes the wording — it never decides a badge or a flag.
        </p>
      </Panel>

      <Panel>
        <div style={h2}>What it can't do</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li style={li}>It warns; it can't block anything, and it only sees what has already reached the chain.</li>
          <li style={li}>Signatures made off-chain (permits) aren't visible until they're used.</li>
          <li style={li}>It can't tell a deliberate action from a stolen key.</li>
          <li style={li}>It's automated analysis of public data — not financial advice, and not a guarantee about any contract.</li>
        </ul>
      </Panel>

      <Panel>
        <div style={{ ...h2, display: "flex", alignItems: "center", gap: 8 }}>
          <ShieldCheck size={15} color={green} /> Verify us
        </div>
        <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
          <li style={li}>
            The real site is <b style={{ color: "#fff" }}>dashboard.planetzephyros.xyz</b>. Check the address bar before connecting a wallet.
          </li>
          <li style={{ ...li, color: gold }}>
            Argus never asks for your seed phrase or private key. Connecting a wallet only asks you to sign a free message (no gas, no access to your
            funds); a transaction is only sent when you choose to buy something.
          </li>
          {CHANNELS.map((c) => (
            <li key={c.label} style={li}>
              {c.label}:{" "}
              <a href={c.href} target="_blank" rel="noreferrer" style={{ color: blue }}>
                {c.text}
              </a>
            </li>
          ))}
        </ul>
        <div style={{ fontSize: 12, color: muted, marginBottom: 8 }}>Our contracts on Electroneum — each verified on the explorer, so you can read the code:</div>
        <div style={{ display: "grid", gap: 6 }}>
          {OUR_CONTRACTS.map((c) => (
            <a
              key={c.address}
              href={`${EXPLORER_BASE_URL}/address/${c.address}`}
              target="_blank"
              rel="noreferrer"
              style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 10px", padding: "8px 10px", border: `1px solid ${border}`, borderRadius: 6, textDecoration: "none" }}
            >
              <span style={{ fontSize: 13, color: "#fff", fontWeight: 700 }}>{c.label}</span>
              <span style={{ fontFamily: monoFont, fontSize: 11, color: mutedLight, overflowWrap: "anywhere" }}>{c.address}</span>
              <ExternalLink size={12} color={mutedLight} />
            </a>
          ))}
        </div>
      </Panel>
    </div>
  );
}
