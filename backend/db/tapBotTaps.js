import { query } from "./pool.js";

// Stats are null when DATABASE_URL isn't configured (query() returns null in that case), so the
// tap bot still taps without a database — it just omits the counters and leaderboard.
export async function recordTap({ txHash, chatId, userId, username, firstName }) {
  await query(
    `INSERT INTO tap_bot_taps (tx_hash, chat_id, user_id, username, first_name)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tx_hash) DO NOTHING`,
    [txHash, chatId, userId, username || null, firstName || null]
  );
}

export async function setTapGas(txHash, gasWei) {
  await query(`UPDATE tap_bot_taps SET gas_wei = $2 WHERE tx_hash = $1`, [txHash, gasWei]);
}

/** { taps, burnedWei } — burnedWei is only the gas of taps whose receipts have been recorded. */
export async function getTapStats() {
  const res = await query(
    `SELECT COUNT(*)::int AS taps, COALESCE(SUM(gas_wei), 0)::text AS burned_wei FROM tap_bot_taps`
  );
  if (!res) return null;
  const row = res.rows[0];
  return { taps: row.taps, burnedWei: row.burned_wei };
}

export async function getLeaderboard(limit = 10) {
  const res = await query(
    `SELECT MAX(COALESCE(username, first_name, user_id::text)) AS name, COUNT(*)::int AS taps
     FROM tap_bot_taps GROUP BY user_id ORDER BY taps DESC LIMIT $1`,
    [limit]
  );
  return res ? res.rows : null;
}
