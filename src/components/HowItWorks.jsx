import React from "react";
import { Tag, Users, Coins } from "lucide-react";
import { green, blue, orange, mutedLight, muted } from "../styles/theme.js";
import Panel from "./Panel.jsx";

// Each step's own accent — cycling through the same green/blue/orange trio Panel.jsx's gradient
// border and the page background's glow pools already use, so the icon badges read as part of
// one palette rather than a fourth color introduced just for this section.
const STEPS = [
  {
    icon: Tag,
    accent: green,
    title: "Register a name",
    body: "Pick a .etn name and register it for 1–5 years. It's wrapped as an NFT straight into your wallet — you own it outright.",
  },
  {
    icon: Users,
    accent: blue,
    title: "Set a subname price",
    body: "As the owner, set a price per year for subnames under your name (e.g. shop.yourname.etn). Anyone can then self-register one by paying it — no listing, no waiting, and each one is wrapped as its own NFT straight into the buyer's wallet.",
  },
  {
    icon: Coins,
    accent: orange,
    title: "Earn fees automatically",
    body: "Every subname sale pays you 80% instantly in ETN, straight to your wallet. No claiming, no manual payouts.",
  },
];

// Homepage explainer — what the service does and, specifically, how a name owner earns fees by
// letting others self-register subnames underneath it.
export default function HowItWorks() {
  return (
    <div style={{ width: "100%", maxWidth: 900, margin: "40px auto 0", padding: "0 16px" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: muted,
          marginBottom: 10,
        }}>
          How It Works
        </div>
        <h3 style={{ fontSize: 22, fontWeight: 900, color: "#fff", margin: 0 }}>
          Own a name. Rent out its subnames. Get paid.
        </h3>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "center" }}>
        {STEPS.map(({ icon: Icon, accent, title, body }, i) => (
          <Panel key={title} style={{ flex: "1 1 260px", maxWidth: 280 }} innerStyle={{ padding: 20 }}>
            <div style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: `${accent}22`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 14,
            }}>
              <Icon size={18} color={accent} />
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: accent, marginBottom: 6, letterSpacing: 0.5 }}>
              STEP {i + 1}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 8 }}>
              {title}
            </div>
            <div style={{ fontSize: 13, color: mutedLight, lineHeight: 1.6 }}>
              {body}
            </div>
          </Panel>
        ))}
      </div>

      <Panel style={{ marginTop: 24 }} innerStyle={{ padding: 18, textAlign: "center" }}>
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 6 }}>Example</div>
        <div style={{ fontSize: 14, color: "#fff", fontWeight: 600, lineHeight: 1.6 }}>
          Set <span style={{ color: green }}>shop.yourname.etn</span> at 1000 ETN/year &rarr; someone registers it
          &rarr; you keep <span style={{ color: green, fontWeight: 900 }}>800 ETN</span> instantly.
        </div>
      </Panel>
    </div>
  );
}
