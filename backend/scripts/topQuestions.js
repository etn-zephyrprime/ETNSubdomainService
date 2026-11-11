// backend/scripts/topQuestions.js
//
// What Core Tier members ask Contract Check in their own words (contract_questions, no wallets kept) — by theme
// and by exact wording — to decide which questions to add to the card's quick-question dropdown. A theme marked
// ★ has no quick question yet. The same summary is in the monthly admin note on Telegram.
//
// Usage (from backend/):
//   node scripts/topQuestions.js            the last 30 days
//   node scripts/topQuestions.js --days 90
import dotenv from "dotenv";
import { topQuestions } from "../db/contractCheckAi.js";
import { formatTopQuestions } from "../services/contractCheck/questionThemes.js";

dotenv.config();
const i = process.argv.indexOf("--days");
const days = i > 0 ? Number(process.argv[i + 1]) || 30 : 30;
const top = await topQuestions(new Date(Date.now() - days * 86400000).toISOString(), 30);
console.log(`\nMembers' own questions — last ${days} days\n`);
console.log(formatTopQuestions(top, { limit: 15 }).join("\n") + "\n");
process.exit(0);
