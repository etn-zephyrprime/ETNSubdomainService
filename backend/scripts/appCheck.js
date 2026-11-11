// backend/scripts/appCheck.js — run App Check from the command line.
//
// Usage (from backend/):  node scripts/appCheck.js <url | domain | app name> [...]          Core result
//                         node scripts/appCheck.js --free <...>                              free (lookalike) result
//                         node scripts/appCheck.js --no-rdap <...>                           skip the RDAP lookup
// Never point this at a suspected phishing site's real domain unless you mean to: the Core result queries
// the domain's registry (RDAP) — never the site itself in this phase.
import dotenv from "dotenv";
import { checkApp } from "../services/appCheck/appCheck.js";

dotenv.config();
const args = process.argv.slice(2);
const core = !args.includes("--free");
const noRdap = args.includes("--no-rdap");
const inputs = args.filter((a) => !a.startsWith("--"));
const offlineFetch = async () => {
  throw new Error("RDAP skipped (--no-rdap)");
};

for (const input of inputs) {
  const r = await checkApp(input, { core, fetchImpl: noRdap ? offlineFetch : fetch });
  console.log(JSON.stringify(r, null, 2));
}
process.exit(0);
