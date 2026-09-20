// Token and NFT-collection logo lookup for the dashboard. Fungible-token logos live in
// /public/token-logos/, NFT-collection logos in /public/nft-logos/ (both served from the site root).
//
// Keyed by CONTRACT ADDRESS, never by symbol or name. The dashboard lists whatever tokens a wallet
// happens to hold, and anyone can deploy a token calling itself "CORE" — matching on the symbol would
// hand the real CORE logo to an impostor. An address can't be spoofed.
//
// Adding a logo: drop the file in public/token-logos/ and add its lowercased address below. The
// filename must match exactly (the host is case-sensitive: "Bolt.svg" is not "BOLT.svg").
const LOGO_BASE = "/token-logos/";
const NFT_LOGO_BASE = "/nft-logos/";

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

// NFT collections, keyed by the COLLECTION's contract address (same reasoning as above — anyone can
// deploy a collection called "Electro Bulls"). Where two collections share a name (Electro Bulls,
// ElectroPunks and Galactic Sports League Football each have a second, near-empty duplicate) the logo
// is mapped to the established one (the one with real holders), not the duplicate.
const NFT_LOGOS_BY_ADDRESS = {
  "0xac620b1a3de23f4eb0a69663613babf73f6c535d": "AetherScions_Logo.webp", // Aether Scions
  "0xab7ad6b7a272b52c752d5087fa0fe238cc9bfadf": "BabyPandasPFP.webp", // Baby Pandas
  "0x947321143e176dc02fd4ac82d5688759dcab83ed": "BoltJarPFP.webp", // BOLT Jar
  "0x8c9a0d62f194d7595e7e68373b0678e109aa3cd3": "BullsLogo.webp", // Electro Bulls
  "0x9b852bd6965f050e9ab8eed4c900742b1d01fdd1": "ClubWatchesLogo.webp", // Club Watches
  "0xd3ec30829eb7db12e96488c70ef715d96b2cce42": "ETNRockLogo.webp", // ETN Rock
  "0xf91290684eb728f6715eff0b50018105b6b31658": "ElectricEelsLogo.webp", // Electric Eels
  "0x31cbb613d14cc85cf3a8889007562e4b5ce9518b": "ElectricLegends_Logo.webp", // Electric Legends
  "0xd7195e3c956be88ba28dc0cbf65829dd7db6ea8a": "ElectroFoxPFP.webp", // ElectroFox
  "0xcff0d88ed5311bab09178b6ec19a464100880984": "ElectroGemsLogo.webp", // ElectroGems
  "0x0dd500d9edef4d0c4b0c50fa0c4faccb711fda43": "ElectroPunk-Logo.gif", // ElectroPunks
  "0x17c70a504a925968ebb0b7e6a0d813d3da019f7b": "GSL_Logo.webp", // Galactic Sports League Football
  "0xe76b450ee07ce833e10f9227f1fbbc96e5f9514d": "HoneyBadgerLogo.webp", // HoneyBadgers
  "0x56b33d971afc1d2cea35f20599e8ef5094ffd399": "MegaOgPFP.webp", // MEGA OGs
  "0xc107c97710972e964d59000f610c07262638b508": "NFComrades.gif", // Non-Fungible Comrades
  "0x3fc7665b1f6033ff901405cddf31c2e04b8a2ab4": "VerdantKin_Logo2.webp", // Verdant Kin
  "0x077bdbd567f9e50f756fb72dce5a4abcaec4a17c": "clubCarsLogo.webp", // CLUB CARS
  "0x9d4e0280b3732fceaeeecd870613ab30bcda7a31": "planetEtnAePFP.gif", // Planet ETN AE
};


/** Logo URL for a token or NFT-collection contract address (or the native-ETN sentinel), or null if
 * there isn't one — the caller decides whether to show a placeholder, never a broken image. */
export function getTokenLogoUrl(address) {
  if (!address) return null;
  const key = String(address).toLowerCase();
  if (NATIVE_KEYS.has(key)) return `${LOGO_BASE}${NATIVE_LOGO}`;
  if (LOGOS_BY_ADDRESS[key]) return `${LOGO_BASE}${LOGOS_BY_ADDRESS[key]}`;
  if (NFT_LOGOS_BY_ADDRESS[key]) return `${NFT_LOGO_BASE}${NFT_LOGOS_BY_ADDRESS[key]}`;
  return null;
}
