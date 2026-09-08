// backend/scripts/addCexAddress.js
//
// Adds (or relabels) an entry in cex_addresses — the manually-maintained list of known exchange/
// bridge counterparty addresses ingestion treats specially (see cexAddresses.js's own header
// comment: Blockscout has no address tagging on Electroneum at all, so this app maintains its own).
// Despite the table's name, `label` is free text and nothing enforces "must be a CEX" — a bridge
// contract address belongs here too, for the identical reason: ingestion's isCex check really means
// "a known non-personal counterparty, not an ordinary wallet-to-wallet transfer", and a bridge
// deposit/withdrawal fits that exactly as well as an exchange hot wallet does.
//
// No admin HTTP route exists for this yet (addCexAddress itself had zero callers before this
// script) — this is the only way to add one short of raw SQL.
//
// Usage:
//   node backend/scripts/addCexAddress.js <address> <label>   # add or relabel one entry
//   node backend/scripts/addCexAddress.js --list              # show everything currently recorded
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getPool } from "../db/pool.js";
import { addCexAddress, listCexAddresses } from "../db/cexAddresses.js";

dotenv.config();

async function main() {
  if (!getPool()) {
    throw new Error("DATABASE_URL not set — nothing to do.");
  }

  const args = process.argv.slice(2);

  if (args[0] === "--list") {
    const rows = await listCexAddresses();
    if (rows.length === 0) {
      console.log("No CEX/bridge addresses recorded yet.");
    } else {
      for (const r of rows) console.log(`${r.address}  ${r.label}`);
    }
    await getPool().end();
    return;
  }

  const [address, ...labelParts] = args;
  const label = labelParts.join(" ").trim();
  if (!address || !ethers.isAddress(address)) {
    throw new Error("Usage: node backend/scripts/addCexAddress.js <address> <label>  (or --list)");
  }
  if (!label) {
    throw new Error("A label is required — e.g. node backend/scripts/addCexAddress.js 0x... \"HTX\"");
  }

  await addCexAddress(address, label, "manual-script");
  console.log(`✅ ${address.toLowerCase()} -> "${label}"`);
  await getPool().end();
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exitCode = 1;
});
