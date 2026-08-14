import React from "react";
import { green, greenGlow } from "../styles/theme.js";

// Small reusable loading spinner — a rotating partial ring in the app's accent color, so a
// "loading..." state reads as active/working rather than possibly stuck. Self-contained <style>+
// @keyframes tag, same pattern RegistrationFlow.jsx's CommitmentRing already uses, rather than a
// shared global stylesheet rule — keeps this a drop-in component with no other file to touch.
export default function Spinner({ size = 20, style = {} }) {
  return (
    <span style={{ display: "inline-flex", ...style }}>
      <style>{`@keyframes etn-spinner-rotate { to { transform: rotate(360deg); } }`}</style>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{
          animation: "etn-spinner-rotate 0.8s linear infinite",
          filter: `drop-shadow(0 0 4px ${greenGlow})`,
        }}
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke={green}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="34 100"
        />
      </svg>
    </span>
  );
}
