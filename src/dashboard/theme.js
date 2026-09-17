// Planet Zephyros-branded palette for the dashboard — deliberately separate from
// ../styles/theme.js, which stays exactly as-is for the ETN Subdomain Service site. The two apps
// share a build (see ../main.jsx) but not a brand: this file is the dashboard's own, so a color
// change here can never accidentally touch the main site and vice versa.
//
// mutedLight/error aren't part of the palette the dashboard brand was handed — carried over
// unchanged from ../styles/theme.js's values since nothing else was specified for them.
export const green = "#18bb1a";
export const greenGlow = "rgba(24,187,26,0.35)";
export const orange = "#ff8a3d";
export const orangeGlow = "rgba(255,122,0,0.25)";
export const blue = "#3ea6ff";
export const blueGlow = "rgba(0,198,255,0.25)";
// Reserved for marking something as premium/paid specifically — deliberately not reused for
// anything else, so gold keeps meaning "premium" everywhere it appears rather than becoming just
// another accent color in the mix (DashboardNav.jsx's Premium tab is the first user).
export const gold = "#e8bf4c";
export const goldGlow = "rgba(232,191,76,0.35)";
// Same "reserved, not a general accent color" convention as gold above — DashboardNav.jsx's PnL
// Statement tab is the first user, styled with gold's exact visual treatment (border/background/
// glow/font-weight pattern) but in silver, so it reads as its own distinct paid feature rather
// than looking like a second Core Tier entry point.
export const silver = "#c0c5cc";
export const silverGlow = "rgba(192,197,204,0.35)";
export const panel = "#0f0f0f";
export const panel2 = "#111";
export const border = "#333";
export const muted = "#888";
export const mutedLight = "#9a9a9a";
export const error = "#ff6b6b";
export const errorGlow = "rgba(255,107,107,0.35)"; // same alpha as greenGlow — SparklineChart's colorBySign mode

// Page background — same dark, desaturated green hue as before (kept intentionally, so the bright
// accent green above still reads as "on brand" instead of clashing), but as a subtle radial
// gradient rather than one flat fill: a touch lighter behind the header, easing down to a near-black
// green at the edges. Reads as a deliberately designed surface instead of a flat placeholder color,
// without introducing a second hue.
export const background = "radial-gradient(ellipse 1200px 800px at 50% -10%, #0d2b10 0%, #081c0a 45%, #05130a 100%)";

// Fixed, validator-identity palette — deliberately distinct from any intensity/heat scale (which
// encodes a quantity, not identity) so the two color dimensions never get visually confused.
// Shared by CalendarHeatmap.jsx and ValidatorLineChart.jsx, the dashboard's two components that
// color-code the same real validator addresses — kept here (not local to either) so the same
// validator reads as the same color in both places rather than each picking independently.
export const VALIDATOR_PALETTE = [blue, orange, "#c792ea", "#ff6b9d", "#4dd0e1", "#ffd54f", "#81c784", "#ba68c8", "#90a4ae"];
