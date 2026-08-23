// backend/utils/coreClashAdvertScheduler.js
//
// Ported from CoreClashGame/backend/utils/telegramBot.js's startZephyrosAdvertScheduler() +
// advertSchedulerStore.js. Posts one of three rotating promo messages to the Core Clash bot's
// General topic once a day, at a randomized time with at least a 3h gap from the last post and
// avoiding an immediate repeat of yesterday's pick. Pure timer — no on-chain or CoreClashGame
// app-state dependency, so this is a straightforward move (unlike the chain watchers, there's
// no lastBlock cursor here — just the daily queue, persisted the same way via coreClashState.js
// so a restart doesn't lose today's schedule or re-fire an already-sent slot).
import { sendCoreClashMessage, coreClashBotConfigured } from "./coreClashTelegram.js";
import { getState, setState } from "../state/coreClashState.js";

const STATE_KEY = "advert-scheduler";

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

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MIN_AD_GAP_MS = 3 * 60 * 60 * 1000;
const TICK_INTERVAL_MS = 60 * 1000;

const DEFAULT_STATE = {
  firstStartupSent: false,
  scheduleDate: null,
  dailyQueue: [],
  lastSentAt: null,
  lastSentIndex: null,
};

async function readAdvertState() {
  const saved = await getState(STATE_KEY);
  return { ...DEFAULT_STATE, ...saved, dailyQueue: Array.isArray(saved?.dailyQueue) ? saved.dailyQueue : [] };
}

async function writeAdvertState(state) {
  await setState(STATE_KEY, state);
}

function getDateKey(date = new Date()) {
  return date.toISOString().split("T")[0];
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function randomDelayWithinDayMs() {
  return Math.floor(Math.random() * ONE_DAY_MS);
}

function buildDailyAdvertQueue(date, lastSentIndex) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  let scheduled = [];

  for (let attempts = 0; attempts < 1000; attempts++) {
    const indexes = shuffle(ADVERT_MESSAGES.map((_, index) => index));

    scheduled = indexes
      .map((index) => ({ index, sendAtMs: dayStartMs + randomDelayWithinDayMs(), sent: false }))
      .sort((a, b) => a.sendAtMs - b.sendAtMs);

    const hasGap = scheduled.every((item, idx) => idx === 0 || item.sendAtMs - scheduled[idx - 1].sendAtMs >= MIN_AD_GAP_MS);
    const avoidsRepeat = lastSentIndex == null || scheduled[0]?.index !== lastSentIndex;

    if (hasGap && avoidsRepeat) break;
  }

  return scheduled.map((item) => ({ index: item.index, sendAt: new Date(item.sendAtMs).toISOString(), sent: false }));
}

async function sendAdvertByIndex(index) {
  return sendCoreClashMessage(ADVERT_MESSAGES[index % ADVERT_MESSAGES.length]);
}

async function tick() {
  const fresh = await readAdvertState();
  const currentDateKey = getDateKey(new Date());

  if (fresh.scheduleDate !== currentDateKey) {
    await writeAdvertState({ ...fresh, scheduleDate: currentDateKey, dailyQueue: buildDailyAdvertQueue(new Date(), fresh.lastSentIndex) });
    return;
  }

  const now = Date.now();
  let dirty = false;
  let sentIndex = null;

  for (const item of fresh.dailyQueue) {
    if (!item.sent && new Date(item.sendAt).getTime() <= now) {
      await sendAdvertByIndex(item.index);
      item.sent = true;
      sentIndex = item.index;
      dirty = true;
      break;
    }
  }

  if (dirty) {
    await writeAdvertState({ ...fresh, lastSentAt: new Date().toISOString(), lastSentIndex: sentIndex });
  }
}

export async function startCoreClashAdvertScheduler() {
  if (!coreClashBotConfigured()) {
    console.log("ℹ️  Core Clash bot not configured (COREBOT_TELEGRAM_BOT_TOKEN / COREBOT_TELEGRAM_CHAT_ID) — advert scheduler disabled");
    return;
  }

  let state = await readAdvertState();
  const todayKey = getDateKey(new Date());

  if (!state.firstStartupSent) {
    console.log("📢 Advert scheduler: first startup → sending first advert immediately");
    try {
      await sendAdvertByIndex(0);
      state = await readAdvertState();
      await writeAdvertState({ ...state, firstStartupSent: true, lastSentAt: new Date().toISOString(), lastSentIndex: 0 });
    } catch (err) {
      console.error("⚠️  Advert scheduler: initial send failed:", err.message);
    }
  }

  if (!state.scheduleDate || state.scheduleDate !== todayKey) {
    await writeAdvertState({ ...state, scheduleDate: todayKey, dailyQueue: buildDailyAdvertQueue(new Date(), state.lastSentIndex) });
  }

  console.log("📢 Core Clash advert scheduler started");
  setInterval(() => tick().catch((err) => console.error("⚠️  Advert scheduler tick failed:", err.message)), TICK_INTERVAL_MS);
  tick().catch((err) => console.error("⚠️  Advert scheduler initial tick failed:", err.message));
}
