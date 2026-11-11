// "Was this right?" verdicts (migrations/029). One row per person per thing — a second tap replaces the first.
import { query } from "./pool.js";

export async function saveFeedback({ source, owner, kind, ref, verdict, note = null, snapshot = null }) {
  await query(
    `INSERT INTO watch_feedback (source, owner_wallet, kind, ref, verdict, note, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_wallet, kind, ref) DO UPDATE SET verdict = EXCLUDED.verdict, note = COALESCE(EXCLUDED.note, watch_feedback.note),
       snapshot = EXCLUDED.snapshot, source = EXCLUDED.source, created_at = now()`,
    [source, owner ? owner.toLowerCase() : null, kind, String(ref).toLowerCase(), verdict, note ? String(note).slice(0, 500) : null, snapshot ? JSON.stringify(snapshot) : null]
  );
}

/** Counts per kind and verdict since `since`, and the latest "wrong" ones (newest first). */
export async function feedbackSummary(since, limit = 20) {
  const counts = await query(`SELECT kind, verdict, COUNT(*)::int AS n FROM watch_feedback WHERE created_at >= $1 GROUP BY kind, verdict ORDER BY kind, verdict`, [since]);
  const wrong = await query(`SELECT created_at, source, owner_wallet, kind, ref, note, snapshot FROM watch_feedback WHERE verdict = 'wrong' AND created_at >= $1 ORDER BY created_at DESC LIMIT $2`, [since, limit]);
  return { counts: counts?.rows || [], wrong: wrong?.rows || [] };
}
