// The Argus admin wallets: the App Check registry panel, the Members tab and admin-only alerts (Blockscout
// watch) all use this set. APP_REGISTRY_ADMINS (comma-separated addresses) overrides it. Addresses, never
// names: a name can change hands, and its next owner mustn't inherit admin rights.
export const ADMIN_WALLET = (process.env.ARGUS_ADMIN_WALLET || "0xa48Bc549a329EEd01E491C7CD950857A8ae56E73").toLowerCase();
const DEFAULT_ADMINS = [
  ADMIN_WALLET,
  "0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099", // planetzephyros.etn
  "0x696a7b9ea5c86da15d569d99d75ed788cce4db2e", // mav-browney.electroswap.etn
];
export const parseAdminList = (raw) => new Set(raw.split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
export const ARGUS_ADMINS = process.env.APP_REGISTRY_ADMINS ? parseAdminList(process.env.APP_REGISTRY_ADMINS) : new Set(DEFAULT_ADMINS);
