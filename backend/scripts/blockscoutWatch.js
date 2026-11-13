// Runs one Blockscout watch cycle now (version + field checks) and prints the result.
// Usage: node scripts/blockscoutWatch.js          — check only, no state written, no alerts
//        node scripts/blockscoutWatch.js --record — full cycle: records state + sends alerts (as the scheduler does)
import dotenv from "dotenv";
dotenv.config();
const { runSchemaChecks, fetchBackendVersion, runBlockscoutWatch } = await import("../utils/blockscoutWatch.js");

if (process.argv.includes("--record")) {
  const s = await runBlockscoutWatch();
  console.log(JSON.stringify(s, null, 2));
} else {
  const version = await fetchBackendVersion();
  const result = await runSchemaChecks();
  console.log(`Blockscout ${version ?? "(version unavailable)"}`);
  console.log(result.ok ? "✅ all field checks pass" : "❌ field checks failing:");
  for (const f of result.failures) console.log(`  ${f.name}: missing ${f.missing.join(", ")}`);
  for (const s of result.skipped) console.log(`  skipped ${s}`);
}
process.exit(0);
