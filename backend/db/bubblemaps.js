import { query } from "./pool.js";
import { supplyShare } from "../services/bubblemaps/analysis.js";

export async function getBubblemapCatalog() {
  const result = await query(
    `SELECT token_address, name, symbol, decimals, map_json, map_updated_at,
            holders_refreshed_at, transfer_backfill_complete
     FROM bubblemap_tokens
     ORDER BY COALESCE(symbol, name, token_address)`
  );
  return (result?.rows || []).map((row) => ({
    token: row.token_address,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    map_ready: Boolean(row.map_json),
    holders_ready: Boolean(row.holders_refreshed_at),
    transfers_ready: Boolean(row.transfer_backfill_complete),
    map_updated_at: row.map_updated_at,
    score: row.map_json?.score ?? null,
    band: row.map_json?.band ?? null,
    score_parts: row.map_json?.score_parts ?? null,
    summary: row.map_json?.summary ?? null,
    computed_at_block: row.map_json?.computed_at_block ?? null,
  }));
}

export async function getBubblemap(tokenAddress) {
  const result = await query(
    `SELECT map_json, total_supply FROM bubblemap_tokens WHERE token_address = $1 AND map_json IS NOT NULL`,
    [tokenAddress.toLowerCase()]
  );
  const row = result?.rows?.[0];
  if (!row?.map_json) return null;
  return {
    ...row.map_json,
    nodes: row.map_json.nodes.map((node) => ({
      ...node,
      supply_share: supplyShare(node.balance, row.total_supply),
    })),
  };
}

export async function listBubblemapOverrides() {
  const result = await query(
    `SELECT address, override_type AS type, label, updated_by, updated_at
     FROM bubblemap_admin_overrides ORDER BY address`
  );
  return result?.rows || [];
}

export async function upsertBubblemapOverride({ address, type, label, updatedBy }) {
  return query(
    `INSERT INTO bubblemap_admin_overrides (address, override_type, label, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (address) DO UPDATE SET override_type = EXCLUDED.override_type, label = EXCLUDED.label,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING address, override_type AS type, label, updated_by, updated_at`,
    [address.toLowerCase(), type, label || null, updatedBy?.toLowerCase() || null]
  );
}

export async function deleteBubblemapOverride(address) {
  return query("DELETE FROM bubblemap_admin_overrides WHERE address = $1 RETURNING address", [address.toLowerCase()]);
}
