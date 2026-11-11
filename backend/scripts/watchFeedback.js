// backend/scripts/watchFeedback.js
//
// "Was this right?" verdicts on Contract Check cards and the watcher's Telegram alerts (db/watchFeedback.js):
// counts per kind and the latest 👎 ones with what was judged — the place to spot false positives early.
//
// Usage (from backend/):
//   node scripts/watchFeedback.js            the last 30 days
//   node scripts/watchFeedback.js --days 7
import dotenv from "dotenv";
import { feedbackSummary } from "../db/watchFeedback.js";

dotenv.config();
const i = process.argv.indexOf("--days");
const days = i > 0 ? Number(process.argv[i + 1]) || 30 : 30;
const since = new Date(Date.now() - days * 86400000).toISOString();
const { counts, wrong } = await feedbackSummary(since, 30);

console.log(`\n"Was this right?" — last ${days} days\n`);
if (!counts.length) console.log("  no feedback yet");
const byKind = {};
for (const r of counts) (byKind[r.kind] ||= { right: 0, wrong: 0 })[r.verdict] = r.n;
for (const [kind, v] of Object.entries(byKind)) {
  const total = v.right + v.wrong;
  console.log(`  ${kind.padEnd(9)} 👍 ${String(v.right).padStart(4)}   👎 ${String(v.wrong).padStart(4)}   (${Math.round((v.right / total) * 100)}% right)`);
}
if (wrong.length) {
  console.log("\nLatest 👎:");
  for (const w of wrong) {
    const snap = w.snapshot ? ` · was ${w.snapshot.overall || "?"}${w.snapshot.flags?.length ? ` [${w.snapshot.flags.join(", ")}]` : ""}` : "";
    console.log(`  ${new Date(w.created_at).toISOString().slice(0, 16)}  ${w.kind.padEnd(8)} ${w.ref}${snap}${w.note ? `\n      "${w.note}"` : ""}`);
  }
}
process.exit(0);
