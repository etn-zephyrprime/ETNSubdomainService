import { query } from "./pool.js";

// See migrations/012_resolved_token_pools.sql and wetnPoolResolver.js's own header comment — the
// durable layer behind the shared "which pool is this token's best WETN-paired pool" resolution
// both dexPriceQuote.js and pnlPricing.js now read through.

export async function getResolvedPool(tokenAddress) {
  const res = await query("SELECT * FROM resolved_token_pools WHERE token_address = $1", [tokenAddress]);
  return res?.rows[0] || null;
}

export async function upsertResolvedPool(tokenAddress, { wetnPoolAddress, wetnPoolIsBase, bestPoolAddress, bestPoolIsBase }) {
  await query(
    `INSERT INTO resolved_token_pools (token_address, wetn_pool_address, wetn_pool_is_base, best_pool_address, best_pool_is_base, resolved_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (token_address) DO UPDATE SET
       wetn_pool_address = EXCLUDED.wetn_pool_address,
       wetn_pool_is_base = EXCLUDED.wetn_pool_is_base,
       best_pool_address = EXCLUDED.best_pool_address,
       best_pool_is_base = EXCLUDED.best_pool_is_base,
       resolved_at = now()`,
    [tokenAddress, wetnPoolAddress, wetnPoolIsBase, bestPoolAddress, bestPoolIsBase]
  );
}
