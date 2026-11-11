// The known-contracts registry: labels for contracts we recognise (a "Known contract" badge). Labels only
// — riskFlags.js never reads this, so a known contract's flags are exactly what its facts say.
// Seed list from the repo's own configs (src/config.js, backend/utils/*, backend/services/*); written to
// Supabase by scripts/seedKnownContracts.js. lookupKnownContract prefers the table and falls back to this
// list when the database isn't reachable (e.g. a local CLI run).
import { getKnownContract } from "../../db/knownContracts.js";

const OURS = { project: "Planet Zephyros", verifiedByUs: true };
const ENS = { project: "Electroneum Name Service (.etn)", category: "name-service", verifiedByUs: false };
const ES = { project: "ElectroSwap", verifiedByUs: false };

export const KNOWN_CONTRACTS_SEED = [
  // Our own contracts
  { address: "0xFD8944132Cf464Fb756F98D1d203Edf74A2B7aD5", label: "ETN Subdomain Service (marketplace)", category: "marketplace", ...OURS },
  { address: "0x2ac8363A60CB054A948CFdf8b34F3813E4528AE7", label: "ETN Subdomain Service (marketplace V5, paused)", category: "marketplace", ...OURS, notes: "Paused 2026-09-17" },
  { address: "0xfE95DdE1832453D2A73E48C737aBFA21463C63d2", label: "ETN Subdomain Service (marketplace V4, paused)", category: "marketplace", ...OURS, notes: "Paused 2026-09-17" },
  { address: "0x392fd031910e5D58650160f41a501ccc29B1eD13", label: "ETN Subdomain Service (marketplace V3, paused)", category: "marketplace", ...OURS, notes: "Paused 2026-09-17" },
  { address: "0x05Cc5a4Cbf18113f7e9c1675a0Ffc702BA7876E1", label: "Planet Zephyros PnL Statements / Core Tier subscription", category: "subscription", ...OURS },
  { address: "0x200a9b5fe78d4cb5232a3a0c52b510f961c51cd6", label: "Core Ascension Vault", category: "vault", ...OURS },
  { address: "0x309B916b3A90cb3E071697Ea9680e9217A30066f", label: "CORE (Planet Zephyros)", category: "token", ...OURS },
  // Official .etn name service
  { address: "0x6F311F2212593165988Dff84977e24C1005dBb85", label: ".etn Registry", ...ENS },
  { address: "0x5207496C1248BbD2AeeDd57Bde44dd9d4E9F1b59", label: ".etn Base Registrar", ...ENS },
  { address: "0x5cD5CEFDc5925cA6A9A38D2AA810d5aeD360b21C", label: ".etn Registrar Controller", ...ENS },
  { address: "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64", label: ".etn Name Wrapper", ...ENS },
  { address: "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A", label: ".etn Reverse Registrar", ...ENS },
  { address: "0xDb4A3Abb6703232e20a118a104e7f4EbB3e2738D", label: ".etn Public Resolver", ...ENS },
  // ElectroSwap
  { address: "0x2c12c8f15637b7a182dec202816148a5e767dcec", label: "ElectroSwap Universal Router", category: "dex-router", ...ES },
  { address: "0x072D4706f9A383D5608BD14B09b41683cb95fFd7", label: "ElectroSwap V2 Router", category: "dex-router", ...ES },
  { address: "0x203D550ed6fA9dAB8A4190720CF9F65138abd15B", label: "ElectroSwap V2 Factory", category: "dex-factory", ...ES },
  { address: "0x5A3AB7e9f405250B36e7e0a4654c1052EADC1F07", label: "ElectroSwap V3 Swap Router", category: "dex-router", ...ES },
  { address: "0xbF6Bcbe2be545135391777F3B4698be92E2EB8cA", label: "ElectroSwap V3 Factory", category: "dex-factory", ...ES },
  { address: "0x3a7f64c57433555b23dac4409a0ac7e84275398d", label: "ElectroSwap V3 Position Manager", category: "dex-positions", ...ES },
  { address: "0xba3CAfCc197E71b9d114E515E75c037dA09A6312", label: "ElectroSwap V3 Quoter", category: "dex-quoter", ...ES },
  { address: "0x16ca736c8B181772009e598F37f137e9cD36AFAE", label: "ElectroSwap Liquidity Locker", category: "locker", ...ES },
  { address: "0xe653ac16b732876f58a1722d24801230fa96bc82", label: "ElectroSwap Yield Farms", category: "farm", ...ES },
  { address: "0x98F19ba7fD60B4FfcbBE01eac336e7C0B73a93b8", label: "ElectroSwap Yield Farms (2)", category: "farm", ...ES },
  { address: "0xfdB0d62Fc929fD53D266B969Bfe4250b205D0899", label: "ElectroSwap Liquidity Locker V3", category: "locker", ...ES },
  // the Universal Router's approval contract — deployed by the same address as the V2 Router (0xD6Cf…9D0)
  { address: "0x012ff228aa9fec4dbee6cd704072749af077b617", label: "ElectroSwap Permit2", category: "dex-approvals", ...ES },
  // NFT marketplaces (Seaport) move approved NFTs through this conduit
  { address: "0x2941cba4dd14b2c67b0802107f23144c70ed680f", label: "Seaport Conduit (NFT marketplace)", category: "nft-marketplace", project: "Seaport", verifiedByUs: false },
  // Listed tokens (src/config.js's token list)
  { address: "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77", label: "WETN (Wrapped ETN)", category: "token", ...ES },
  { address: "0x043fAa1b5C5FC9a7dc35171f290c29ECDE0cCff1", label: "BOLT", category: "token", project: null, verifiedByUs: false },
  { address: "0xEe432C220273e4F949007B4c1946562826Efa055", label: "DYNO", category: "token", project: null, verifiedByUs: false },
  { address: "0xc20d02538368D8F7deBeAeB99D9a8b4d4D1DDC1C", label: "PDY", category: "token", project: null, verifiedByUs: false },
  { address: "0x075533AB8EeC6A6999F07C8bc2f1900eB8312e25", label: "FUGAZI", category: "token", project: null, verifiedByUs: false },
  { address: "0x3187deAd7A2Bd6770F5Fe81495D1B715926AAe6e", label: "USDC (Hyperlane bridged)", category: "token", project: "Hyperlane", verifiedByUs: false },
  { address: "0x48E722f1458b253c2FB0E573F939318D7Dbd54e7", label: "USDT (Hyperlane bridged)", category: "token", project: "Hyperlane", verifiedByUs: false },
  { address: "0xC9FC4AB00911793D99b5c7Bd01f01203C21D4131", label: "CLUB", category: "token", project: null, verifiedByUs: false },
  { address: "0xE74e4E7A064310466f3bdBd3F3Ce4e8c8F7CF1d5", label: "DCNT", category: "token", project: null, verifiedByUs: false },
];

const seedByAddress = new Map(KNOWN_CONTRACTS_SEED.map((k) => [k.address.toLowerCase(), { ...k, address: k.address.toLowerCase(), notes: k.notes || null }]));

/** The registry entry for an address, or null. Never throws. */
export async function lookupKnownContract(address) {
  const key = String(address).toLowerCase();
  try {
    const row = await getKnownContract(key);
    if (row) return row;
  } catch {
    // database unreachable -> the seed list below
  }
  return seedByAddress.get(key) || null;
}
