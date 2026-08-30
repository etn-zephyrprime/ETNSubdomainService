import React from "react";
import { green, greenGlow } from "../../theme.js";

// Same reasoning as DashboardPanel.jsx — this app has no shared button component (DashboardNav.jsx
// inlines its own button styles directly); factored out here since the premium section needs a
// consistent "primary action" button in several places.
export default function DashboardButton({ children, onClick, disabled = false, loading = false, style = {} }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        padding: "12px 16px",
        borderRadius: 12,
        fontSize: 14,
        fontWeight: 800,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled || loading ? 0.55 : 1,
        background: green,
        color: "#000",
        boxShadow: `0 0 12px ${greenGlow}`,
        border: "none",
        transition: "opacity 0.2s ease",
        ...style,
      }}
    >
      {loading ? "Processing..." : children}
    </button>
  );
}
