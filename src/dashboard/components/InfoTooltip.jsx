import React, { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { mutedLight, border, panel2 } from "../theme.js";

// Small "what does this mean, how do I use it" popover attached to a section header — hover on a
// device with a mouse, tap to toggle on touch (hover alone doesn't exist there, and CSS-only
// :hover tooltips are the classic way a mobile visitor gets stuck unable to dismiss one at all).
// Click-outside closes it on touch too, same as any other lightweight popover in this app.
//
// Plain text only, not markup — every explanation this app writes is a sentence or two, matching
// this component's own size; reach for something richer only if a caller genuinely needs it.
export default function InfoTooltip({ text, align = "left" }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <span
      ref={containerRef}
      style={{ position: "relative", display: "inline-flex", verticalAlign: "middle" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label="More information"
        style={{ display: "inline-flex", background: "none", border: "none", padding: 0, margin: "0 0 0 6px", cursor: "pointer", color: mutedLight }}
      >
        <Info size={13} />
      </button>
      {open && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            [align]: 0,
            zIndex: 20,
            width: 240,
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${border}`,
            background: panel2,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            fontSize: 11,
            fontWeight: 400,
            lineHeight: 1.5,
            color: mutedLight,
            textTransform: "none",
            letterSpacing: "normal",
          }}
        >
          {text}
        </div>
      )}
    </span>
  );
}
