// backend/utils/coreClashAdvertScheduler.js
//
// Ported from CoreClashGame/backend/utils/telegramBot.js's startZephyrosAdvertScheduler() +
// advertSchedulerStore.js. Posts one of three rotating promo messages to the Core Clash bot's
// General topic once per cycle — originally once per calendar day, widened to every 3 days on
// request. Scheduling mechanics (randomized time within the cycle, minimum gap between sends,
// no immediate repeat, restart-safe persisted queue) live in advertScheduler.js, shared with
// subdomainAdvertScheduler.js.
import { sendCoreClashMessage, coreClashBotConfigured } from "./coreClashTelegram.js";
import { getState, setState } from "../state/coreClashState.js";
import { createAdvertScheduler } from "./advertScheduler.js";

const ADVERT_MESSAGES = [
  `🎮 <b>Core Clash</b>\n\n` +
    `Ready for another battle?\n\n` +
    `Stake, Reveal, Battle, Win with your playable cards.`,

  `🧬 <b>Mint Aether Scions</b>\n\n` +
    `Aether Scions are playable cards in Core Clash.\n\n` +
    `Build your team, test your matchups, and bring them into battle.\n\n` +
    `🌍 <a href="https://app.electroswap.io/nfts/collection/0xAc620b1A3dE23F4EB0A69663613baBf73F6C535D">Mint Now</a>`,

  `🔥 <b>Build Your XP</b>\n\n` +
    `Keep playing Core Clash to build XP and climb the ranks.\n\n` +
    `XP helps you work toward earning $CORE and <b>Guardians of Erevos</b> playable cards.`,
];

const start = createAdvertScheduler({
  getState,
  setState,
  stateKey: "advert-scheduler",
  advertCount: ADVERT_MESSAGES.length,
  buildMessage: async (index) => ADVERT_MESSAGES[index % ADVERT_MESSAGES.length],
  sendMessage: (text) => sendCoreClashMessage(text),
  isConfigured: coreClashBotConfigured,
  notConfiguredLog: "ℹ️  Core Clash bot not configured (COREBOT_TELEGRAM_BOT_TOKEN / COREBOT_TELEGRAM_CHAT_ID) — advert scheduler disabled",
  startedLog: "📢 Core Clash advert scheduler",
  cycleDays: 3,
  minGapHours: 3,
});

export async function startCoreClashAdvertScheduler() {
  await start();
}
