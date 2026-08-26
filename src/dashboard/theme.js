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
export const panel = "#0f0f0f";
export const panel2 = "#111";
export const border = "#333";
export const muted = "#888";
export const mutedLight = "#9a9a9a";
export const error = "#ff6b6b";
