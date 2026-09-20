// Token logo lookup for the dashboard. Logos live in /public/token-logos/ (served from the site root).
//
// Keyed by CONTRACT ADDRESS, never by symbol or name. The dashboard lists whatever tokens a wallet
// happens to hold, and anyone can deploy a token calling itself "CORE" — matching on the symbol would
// hand the real CORE logo to an impostor. An address can't be spoofed.
//
// Adding a logo: drop the file in public/token-logos/ and add its lowercased address below. The
// filename must match exactly (the host is case-sensitive: "Bolt.svg" is not "BOLT.svg").
const LOGO_BASE = "/token-logos/";

// Same fixed sentinel string as backend/services/pnlEventBuilder.js's NATIVE_SENTINEL — a native ETN
// row carries this literal instead of a real address (see useTokenNames.js's own comment).
const NATIVE_KEYS = new Set(["native", "etn"]);

const LOGOS_BY_ADDRESS = {
  "0x043faa1b5c5fc9a7dc35171f290c29ecde0ccff1": "Bolt.svg", // BOLT
  "0x309b916b3a90cb3e071697ea9680e9217a30066f": "CORE.png", // CORE
  "0xee432c220273e4f949007b4c1946562826efa055": "DYNO.svg", // DYNO
  "0xc20d02538368d8f7debeaeb99d9a8b4d4d1ddc1c": "PDY.png", // PDY
  "0x075533ab8eec6a6999f07c8bc2f1900eb8312e25": "FUGAZI.png", // FUGAZI
  "0x3187dead7a2bd6770f5fe81495d1b715926aae6e": "USDC.svg", // USDC
  "0x48e722f1458b253c2fb0e573f939318d7dbd54e7": "USDT.svg", // USDT
  "0xc9fc4ab00911793d99b5c7bd01f01203c21d4131": "CLUB.png", // CLUB
  "0xe74e4e7a064310466f3bdbd3f3ce4e8c8f7cf1d5": "DCNT.png", // DCNT
  "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77": "ETN.svg", // WETN — wrapped ETN, same mark as ETN itself
};
const NATIVE_LOGO = "ETN.svg";

/** Logo URL for a token contract address (or the native-ETN sentinel), or null if there isn't one —
 * the caller shows a placeholder in that case, never a broken image. */
export function getTokenLogoUrl(address) {
  if (!address) return null;
  const key = String(address).toLowerCase();
  const file = NATIVE_KEYS.has(key) ? NATIVE_LOGO : LOGOS_BY_ADDRESS[key];
  return file ? `${LOGO_BASE}${file}` : null;
}
