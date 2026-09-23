import React from "react";
import { green, greenGlow, blue } from "../styles/theme.js";

// "Glass & Gradient" buttons — fully-rounded (pill) shape, gradient fills on every colored
// variant (matching Panel.jsx's own gradient-ring treatment) instead of a flat color, "dark" as a
// frosted glass secondary action rather than a plain dark box.
export default function NeonButton({
  children,
  onClick,
  variant = "green",
  disabled = false,
  style = {},
  loading = false
}) {
  const styles = {
    green: {
      background: `linear-gradient(90deg, ${blue}, ${green})`,
      color: "#04101c",
      boxShadow: `0 0 12px ${greenGlow}`,
      border: "none",
    },
    orange: {
      background: "linear-gradient(90deg, #ff7a00, #ff3d00)",
      color: "#fff",
      boxShadow: "0 0 12px rgba(255,122,0,0.25)",
      border: "none",
    },
    blue: {
      background: "linear-gradient(90deg, #1affb3, #00c6ff)",
      color: "#111",
      boxShadow: "0 0 12px rgba(0,198,255,0.25)",
      border: "none",
    },
    dark: {
      background: "rgba(255,255,255,0.05)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      color: blue,
      boxShadow: "0 0 8px rgba(0,0,0,0.35)",
      border: "1px solid rgba(62,166,255,0.35)",
    },
    danger: {
      background: "rgba(255,77,77,0.14)",
      color: "#ff6b6b",
      boxShadow: "0 0 10px rgba(255,77,77,0.12)",
      border: "1px solid rgba(255,77,77,0.35)",
    },
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        padding: "12px 20px",
        borderRadius: 999,
        fontSize: 14,
        fontWeight: 800,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled || loading ? 0.55 : 1,
        transition: "all 0.2s ease",
        whiteSpace: "nowrap",
        ...styles[variant],
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled && !loading && variant === "dark") {
          e.currentTarget.style.borderColor = blue;
          e.currentTarget.style.boxShadow = `0 0 12px ${greenGlow}`;
        }
      }}
      onMouseLeave={(e) => {
        if (!disabled && !loading && variant === "dark") {
          e.currentTarget.style.borderColor = "rgba(62,166,255,0.35)";
          e.currentTarget.style.boxShadow = "0 0 8px rgba(0,0,0,0.35)";
        }
      }}
    >
      {loading ? "Processing..." : children}
    </button>
  );
}