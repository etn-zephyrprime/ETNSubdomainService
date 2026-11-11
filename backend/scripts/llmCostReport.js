// backend/scripts/llmCostReport.js
//
// What Argus's Claude calls cost in a month (llm_usage_log), set against the Core Tier revenue swept from the
// contract that month — services/llmCost.js. The same summary goes to the admins on Telegram on the 1st.
//
// Usage (from backend/):
//   node scripts/llmCostReport.js                  this month so far
//   node scripts/llmCostReport.js --month 2026-11
import dotenv from "dotenv";
import { llmUsageBetween, revenueSweptBetween } from "../db/contractCheckAi.js";
import { getAllActiveMemberWallets } from "../db/premiumMemberships.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { formatCostReport, monthRange } from "../services/llmCost.js";

dotenv.config();
const i = process.argv.indexOf("--month");
const month = i > 0 ? process.argv[i + 1] : new Date().toISOString().slice(0, 7);
const { from, to } = monthRange(month);
const [rows, revenueEtn, members, etn] = await Promise.all([llmUsageBetween(from, to), revenueSweptBetween(from, to).catch(() => null), getAllActiveMemberWallets().catch(() => []), getEtnPriceCache().catch(() => null)]);
console.log("\n" + formatCostReport({ month, rows, revenueEtn, etnUsd: etn?.usd ?? null, activeMembers: members.length }).replace(/[*_]/g, "") + "\n");
process.exit(0);
