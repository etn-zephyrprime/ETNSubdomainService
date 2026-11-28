import { query } from "./pool.js";

/** Records that a user found the word at wordIndex. Returns { isNew, distinct }, or null without a database. */
export async function recordHuntFind(userId, wordIndex) {
  const res = await query(
    `INSERT INTO tap_hunt_finds (user_id, word_index) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, wordIndex]
  );
  if (!res) return null;
  const distinct = await userDistinctCount(userId);
  return { isNew: res.rowCount === 1, distinct };
}

export async function userDistinctCount(userId) {
  const res = await query(`SELECT COUNT(*)::int AS n FROM tap_hunt_finds WHERE user_id = $1`, [userId]);
  return res ? res.rows[0].n : null;
}

/** The most distinct words held by any single player; drives the drop-rate stage. Null without a database. */
export async function leaderDistinctCount() {
  const res = await query(
    `SELECT COALESCE(MAX(n), 0)::int AS n FROM (SELECT COUNT(*) AS n FROM tap_hunt_finds GROUP BY user_id) t`
  );
  return res ? res.rows[0].n : null;
}
