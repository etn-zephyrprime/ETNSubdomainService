// Blockscout v12 (Electroneum's explorer upgraded to backend v12.0.4, Nov 2026) renamed two fields
// on every token object — the /tokens list, /tokens/:address, and the `token` nested inside
// token-balances, token-transfers, nft, etc.:
//   address  -> address_hash
//   holders  -> holders_count
// Everything in this codebase was written against the old names, so rather than touching dozens of
// call sites, each Blockscout fetch runs its JSON through this: any token-shaped object (has a
// string `address_hash` plus `holders_count` or `decimals`) gets the old names added back as
// aliases. Old-shape responses pass through untouched, so this is safe either side of the upgrade.
export function normalizeBlockscoutTokens(value) {
  if (Array.isArray(value)) {
    for (const item of value) normalizeBlockscoutTokens(item);
  } else if (value && typeof value === "object") {
    if (typeof value.address_hash === "string" && ("holders_count" in value || "decimals" in value)) {
      if (value.address == null) value.address = value.address_hash;
      if (value.holders == null && value.holders_count != null) value.holders = value.holders_count;
    }
    for (const key in value) {
      const child = value[key];
      if (child && typeof child === "object") normalizeBlockscoutTokens(child);
    }
  }
  return value;
}
