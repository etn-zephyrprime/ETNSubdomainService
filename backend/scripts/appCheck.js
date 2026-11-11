// backend/scripts/appCheck.js — run App Check from the command line.
//
// Usage (from backend/):  node scripts/appCheck.js <url | domain | app name> [...]          Core result
//                         node scripts/appCheck.js --free <...>                              free (lookalike) result
//                         node scripts/appCheck.js --no-rdap <...>                           skip the RDAP lookup
//                         node scripts/appCheck.js --scan <url>                               + the site scan (fetches
//                                                                                              the site's page and scripts)
// Never point this at a suspected phishing site's real domain unless you mean to: the Core result queries
// the domain's registry (RDAP), and --scan fetches the site itself (through safeFetch.js).
import dotenv from "dotenv";
import { checkApp } from "../services/appCheck/appCheck.js";

dotenv.config();
const args = process.argv.slice(2);
const core = !args.includes("--free");
const noRdap = args.includes("--no-rdap");
const scan = args.includes("--scan");
const inputs = args.filter((a) => !a.startsWith("--"));
const offlineFetch = async () => {
  throw new Error("RDAP skipped (--no-rdap)");
};

for (const input of inputs) {
  const r = await checkApp(input, { core, scan: core && scan, fetchImpl: noRdap ? offlineFetch : undefined });
  console.log(JSON.stringify(r, null, 2));
}
process.exit(0);
