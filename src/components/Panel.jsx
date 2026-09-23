import React from "react";
import { green, blue, orange } from "../styles/theme.js";

// "Glass & Gradient" card shell — a thin gradient-color ring (the site's own navy/blue/orange
// accents) wrapping a frosted, semi-transparent fill, so the page's own background glow (see
// pageBackground in theme.js) shows softly through every panel instead of sitting behind flat
// opaque cards. Every existing `<Panel style={{...}}>` caller only ever passes layout properties
// (width/maxWidth/margin/boxSizing — confirmed across every current usage), so `style` applies to
// this OUTER wrapper (where layout has to live for it to affect page flow), and must never include
// `padding` — that would thicken the 1.5px gradient ring itself. Content-level overrides (custom
// padding, textAlign, etc.) go through `innerStyle`, which merges onto the frosted inner fill.
export default function Panel({ children, style = {}, innerStyle = {} }) {
  return (
    <div
      style={{
        borderRadius: 20,
        padding: 1.5,
        background: `linear-gradient(135deg, ${green}, ${blue}80, ${orange}60)`,
        boxSizing: "border-box",
        ...style,
      }}
    >
      <div
        style={{
          borderRadius: 18.5,
          background: "rgba(10,18,28,0.6)",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
          padding: 16,
          boxSizing: "border-box",
          ...innerStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}