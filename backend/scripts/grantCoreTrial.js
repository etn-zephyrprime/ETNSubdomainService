// backend/scripts/grantCoreTrial.js
//
// Gives a wallet a free Core Tier trial without going through the PremiumSubscription contract.
// Every Core Tier check on the backend (hasCoreAccess) reads premium_memberships, not the contract,
// so a monthly_expiry row there is all it takes. The row is marked as a trial (last_tx_hash
// "trial:<date>") so it can't be mistaken for a purchase.
//
// What a trial does NOT give: the PnL Statement discount (the contract decides that), and the
// membership box on the page still reads the contract, so it shows the wallet as not subscribed —
// i.e. a Buy prompt. A real purchase during the trial simply overwrites the trial's expiry.
//
// Usage (from backend/):
//   node scripts/grantCoreTrial.js <wallet>            30-day trial
//   node scripts/grantCoreTrial.js <wallet> 14         14-day trial
//   node scripts/grantCoreTrial.js <wallet> --revoke   end a trial now (trials only — never a paid membership)
//
// Refuses to touch a wallet with an active PAID membership (it would only ever shorten or confuse it).
// Granting again to a wallet already on a trial restarts it at <days> from now.
import dotenv from "dotenv";
import { ethers } from "ethers";
import { getPool } from "../db/pool.js";

dotenv.config();

const TRIAL_MARK = "trial";
const isTrialRow = (row) => String(row?.last_tx_hash || "").startsWith(TRIAL_MARK);

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const [walletArg, daysArg] = args.filter((a) => !a.startsWith("--"));
  if (!walletArg || !ethers.isAddress(walletArg)) {
    throw new Error("Usage: node scripts/grantCoreTrial.js <wallet> [days] [--revoke]");
  }
  const wallet = walletArg.toLowerCase();
  const days = daysArg === undefined ? 30 : Number(daysArg);
  if (!revoke && (!Number.isInteger(days) || days < 1 || days > 90)) {
    throw new Error("days must be a whole number from 1 to 90");
  }

  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL not set.");

  const { rows } = await pool.query("SELECT * FROM premium_memberships WHERE wallet_address = $1", [wallet]);
  const row = rows[0] || null;
  const now = Date.now();
  const activeUntil = (t) => (t && new Date(t).getTime() > now ? new Date(t) : null);
  const monthly = activeUntil(row?.monthly_expiry);
  const annual = activeUntil(row?.annual_expiry);

  if (revoke) {
    if (!row || !isTrialRow(row) || !monthly) {
      console.log(`Nothing to revoke: ${wallet} has no active trial.`);
      return;
    }
    await pool.query(
      "UPDATE premium_memberships SET monthly_expiry = now(), updated_at = now() WHERE wallet_address = $1",
      [wallet]
    );
    console.log(`Trial ended for ${wallet}.`);
    return;
  }

  if (annual || (monthly && !isTrialRow(row))) {
    const until = [monthly, annual].filter(Boolean).sort((a, b) => b - a)[0];
    console.log(`Not granted: ${wallet} already has a paid Core Tier membership until ${until.toISOString().slice(0, 10)}.`);
    return;
  }

  const expiry = new Date(now + days * 24 * 60 * 60 * 1000);
  const mark = `${TRIAL_MARK}:${new Date(now).toISOString().slice(0, 10)}`;
  // Only monthly_expiry is written; an (expired) annual_expiry is left as it was.
  await pool.query(
    `INSERT INTO premium_memberships (wallet_address, monthly_expiry, last_tx_hash, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (wallet_address) DO UPDATE
       SET monthly_expiry = EXCLUDED.monthly_expiry, last_tx_hash = EXCLUDED.last_tx_hash, updated_at = now()`,
    [wallet, expiry, mark]
  );
  console.log(
    `${monthly ? "Trial restarted" : "Trial granted"}: ${wallet} has Core Tier until ${expiry.toISOString().replace("T", " ").slice(0, 16)} UTC (${days} days).`
  );
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPool()?.end().catch(() => {});
  });
