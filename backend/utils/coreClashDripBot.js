// backend/utils/coreClashDripBot.js
//
// Ported from CoreClashGame/backend/utils/dripBot.js. Unlike the other Core Clash watchers, this
// one doesn't just watch and notify — every CHECK_INTERVAL_MS it checks the drip contract's own
// timer and, when due, SIGNS AND SENDS an on-chain transaction with CORE_CLASH_BACKEND_PRIVATE_KEY
// (the Core Clash treasury/admin wallet — a *different* wallet from this repo's own
// BACKEND_PRIVATE_KEY, hence the distinct name) to release the next scheduled CORE drip to
// staking rewards. The Telegram message is just a report on what already happened on-chain.
//
// This means CORE_CLASH_BACKEND_PRIVATE_KEY now needs to be set here too — see
// coreClashConfig.js's DRIP_FUNDER_ADDRESS. Moving this was a deliberate choice (not the default
// "just move the Telegram part" option) because leaving execution in CoreClashGame means drips
// silently stop firing at all whenever that Render free-tier instance is asleep, not just a
// stale notification — see the PR description for the decision.
//
// Safe to run alongside CoreClashGame's own dripBot.js during a transition: the contract's
// nextDripIn() gate means only one caller can actually succeed per interval regardless of how
// many processes are polling it, so this doesn't risk a double-drip. Disable/remove
// startDripBot() in CoreClashGame once this is confirmed working so only one process holds that
// key long-term.
import { ethers } from "ethers";
import { sendZephyrosMessage, zephyrosBotConfigured, GENERAL_THREAD_ID } from "./coreClashTelegram.js";
import { EXPLORER_BASE_URL, DRIP_FUNDER_ADDRESS } from "./coreClashConfig.js";
import { createRpcProvider } from "./rpcProvider.js";

// Was a hardcoded 5 minutes (same as the original) — bumped to 15 and made overridable as part of
// cutting this backend's overall RPC volume (see rpcProvider.js). This one actually signs and
// sends a transaction when due, unlike the other watchers here, so kept less aggressive than
// their 5-minute bump: worst case this delays firing an overdue drip by up to 15 minutes, not a
// meaningful difference against a multi-hour drip schedule.
const CHECK_INTERVAL_MS = process.env.COREBOT_DRIP_CHECK_INTERVAL_MS
  ? parseInt(process.env.COREBOT_DRIP_CHECK_INTERVAL_MS, 10)
  : 15 * 60 * 1000;

const DRIP_ABI = [
  "function owner() view returns (address)",
  "function nextDripIn() view returns (uint256)",
  "function drip()",
  "function totalDripped() view returns (uint256)",
  "function remainingDrips() view returns (uint256)",
];

async function sendDripNotification(contract, txHash) {
  try {
    const [totalDripped, remainingDrips] = await Promise.all([contract.totalDripped(), contract.remainingDrips()]);

    const text =
      `💧 <b>CORE Reward Pool Drip</b>\n\n` +
      `✅ <b>500 CORE</b> added to staking rewards\n` +
      `📊 Remaining to drip: <b>${remainingDrips} × 500 CORE</b>\n` +
      `📈 Total dripped so far: <b>${(Number(totalDripped) / 1e18).toLocaleString()} CORE</b>\n\n` +
      `🔗 <a href="${EXPLORER_BASE_URL}/tx/${txHash}">View Transaction on Explorer</a>`;

    await sendZephyrosMessage(text, { threadId: GENERAL_THREAD_ID });
    console.log("💧 Drip notification sent");
  } catch (err) {
    console.error("⚠️  Failed to send drip notification:", err.message);
    // Don't throw — a failed notification shouldn't be treated as a failed drip.
  }
}

export async function startCoreClashDripBot() {
  if (!process.env.CORE_CLASH_BACKEND_PRIVATE_KEY) {
    console.log("ℹ️  CORE_CLASH_BACKEND_PRIVATE_KEY not set — Core Clash drip bot disabled");
    return;
  }
  if (!zephyrosBotConfigured()) {
    console.log("ℹ️  Zephyros bot not configured — Core Clash drip bot disabled (execution needs a working notification path too, to avoid silent on-chain-only drips)");
    return;
  }

  const provider = createRpcProvider();
  const wallet = new ethers.Wallet(process.env.CORE_CLASH_BACKEND_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(DRIP_FUNDER_ADDRESS, DRIP_ABI, provider);
  const contractWithSigner = contract.connect(wallet);

  console.log("💧 Core Clash drip bot initializing...");
  console.log("   Bot wallet:", wallet.address);
  console.log("   Drip contract:", DRIP_FUNDER_ADDRESS);

  try {
    const owner = await contract.owner();
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error("❌ CRITICAL: bot wallet is NOT the drip contract's owner — drip() calls will revert");
    } else {
      console.log("✅ Owner verification passed");
    }
  } catch (err) {
    console.error("❌ Failed to read drip contract owner:", err.message);
  }

  const check = async () => {
    try {
      const nextDripIn = await contract.nextDripIn();

      if (Number(nextDripIn) !== 0) {
        const hoursLeft = (Number(nextDripIn) / 3600).toFixed(1);
        console.log(`💧 Next drip in ~${hoursLeft}h`);
        return;
      }

      console.log("💧 Time to drip — executing...");
      const tx = await contractWithSigner.drip({ gasLimit: 400000 });
      console.log(`📤 Drip tx sent: ${tx.hash}`);

      const receipt = await tx.wait();
      console.log(`✅ Drip succeeded (block ${receipt.blockNumber})`);

      await sendDripNotification(contract, tx.hash);
    } catch (err) {
      console.error("❌ Drip bot check failed:", err.message);
      if (err.data) console.error("   Raw data:", err.data);
    }
  };

  console.log(`💧 Core Clash drip bot started (checking every ${CHECK_INTERVAL_MS / 60000}min)`);
  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
