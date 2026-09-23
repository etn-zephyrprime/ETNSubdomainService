// Named "green"/"greenGlow" for historical reasons (every component imports these names) —
// the actual color is the brand blue below. Rename is a bigger, purely-cosmetic diff across ~10
// files; flagged as an easy follow-up rather than bundled into this color swap.
export const green = "#125683";
export const greenGlow = "rgba(18,86,131,0.35)";
export const orange = "#ff8a3d";
export const orangeGlow = "rgba(255,122,0,0.25)";
export const blue = "#3ea6ff";
export const blueGlow = "rgba(0,198,255,0.25)";
// Soft brand-color glows over the old flat #011528 — same navy base, just less like a single
// unbroken slab of color behind every page. Radial gradients only (no fixed attachment): this
// container's own height grows with page content, and a fixed background looks static/detached
// once a page scrolls past one viewport. The third (orange) pool ties this to the same
// green/blue/orange trio Panel.jsx/NeonButton.jsx now use for their own gradient borders — one
// consistent "Glass & Gradient" palette site-wide, not just an accent on the cards themselves.
export const pageBackground = `
  radial-gradient(ellipse 900px 600px at 12% -10%, rgba(18,86,131,0.35), transparent 60%),
  radial-gradient(ellipse 700px 500px at 100% 15%, rgba(62,166,255,0.14), transparent 55%),
  radial-gradient(ellipse 800px 550px at 50% 100%, rgba(18,86,131,0.28), transparent 60%),
  radial-gradient(ellipse 600px 500px at 85% 80%, rgba(255,138,61,0.10), transparent 55%),
  #011528
`;
export const panel = "#0f0f0f";
export const panel2 = "#111";
export const border = "#333";
export const muted = "#888";
export const mutedLight = "#9a9a9a";
export const error = "#ff6b6b";