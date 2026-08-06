import React from "react";
import { Tag, Users, Coins } from "lucide-react";
import { green, mutedLight, muted, panel2, border } from "../styles/theme.js";

const STEPS = [
  {
    icon: Tag,
    title: "Register a name",
    body: "Pick a .etn name and register it for 1–5 years. It's wrapped as an NFT straight into your wallet — you own it outright.",
  },
  {
    icon: Users,
    title: "Set a subname price",
    body: "As the owner, set a price per year for subnames under your name (e.g. shop.yourname.etn). Anyone can then self-register one by paying it — no listing, no waiting.",
  },
  {
    icon: Coins,
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
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <div
            key={title}
            style={{
              flex: "1 1 260px",
              maxWidth: 280,
              padding: 20,
              borderRadius: 14,
              background: panel2,
              border: `1px solid ${border}`,
            }}
          >
            <div style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "rgba(24,187,26,0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 14,
            }}>
              <Icon size={18} color={green} />
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: green, marginBottom: 6, letterSpacing: 0.5 }}>
              STEP {i + 1}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 8 }}>
              {title}
            </div>
            <div style={{ fontSize: 13, color: mutedLight, lineHeight: 1.6 }}>
              {body}
            </div>
          </div>
        ))}
      </div>

      <div style={{
        marginTop: 24,
        padding: 18,
        borderRadius: 14,
        background: "rgba(24,187,26,0.06)",
        border: `1px solid ${border}`,
        textAlign: "center",
      }}>
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 6 }}>Example</div>
        <div style={{ fontSize: 14, color: "#fff", fontWeight: 600, lineHeight: 1.6 }}>
          Set <span style={{ color: green }}>shop.yourname.etn</span> at 5 ETN/year &rarr; someone registers it
          &rarr; you keep <span style={{ color: green, fontWeight: 900 }}>4 ETN</span> instantly.
        </div>
      </div>
    </div>
  );
}
