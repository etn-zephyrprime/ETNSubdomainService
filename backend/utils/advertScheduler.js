// backend/utils/advertScheduler.js
//
// Generic engine behind every rotating-advert Telegram bot in this repo
// (coreClashAdvertScheduler.js, subdomainAdvertScheduler.js): posts one of N messages once per
// `cycleDays`-day cycle, at a randomized time spread across that cycle, with at least
// `minGapHours` between any two sends in the same cycle and never repeating the previous cycle's
// first pick. Unlike most small helpers in this codebase (duplicated per file on purpose — see
// e.g. queryLogsChunked's "fine to drift independently" convention elsewhere), this scheduling
// logic is shared because it's genuinely non-trivial (epoch-aligned cycle keys for restart
// safety, the gap/no-repeat retry loop) and every caller needs to stay in sync if it's ever
// fixed — same reasoning as primaryNameResolver.js.
//
// `buildMessage(index)` is called at the moment a slot actually fires, not when the cycle's
// queue is first built — callers with dynamic content (e.g. subdomainAdvertScheduler.js's
// "current listings" advert) get data as of send time, not stale data from up to a full cycle
// ago.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TICK_INTERVAL_MS = 60 * 1000;

/**
 * @param {object} opts
 * @param {(key: string) => Promise<any>} opts.getState
 * @param {(key: string, value: any) => Promise<void>} opts.setState
 * @param {string} opts.stateKey - storage key this scheduler's queue/cursor is persisted under.
 * @param {number} opts.advertCount - number of distinct adverts in rotation.
 * @param {(index: number) => Promise<string>} opts.buildMessage - builds advert `index`'s text,
 *   called fresh at send time.
 * @param {(text: string) => Promise<any>} opts.sendMessage
 * @param {() => boolean} opts.isConfigured
 * @param {string} opts.notConfiguredLog - logged (and scheduler skipped entirely) if !isConfigured().
 * @param {string} opts.startedLog - log line prefix used for the startup/tick/error messages.
 * @param {number} [opts.cycleDays=1]
 * @param {number} [opts.minGapHours=3]
 * @returns {() => Promise<void>} start() — call once at boot.
 */
export function createAdvertScheduler({
  getState,
  setState,
  stateKey,
  advertCount,
  buildMessage,
  sendMessage,
  isConfigured,
  notConfiguredLog,
  startedLog,
  cycleDays = 1,
  minGapHours = 3,
}) {
  const CYCLE_MS = cycleDays * ONE_DAY_MS;
  const MIN_GAP_MS = minGapHours * 60 * 60 * 1000;

  const DEFAULT_STATE = {
    firstStartupSent: false,
    scheduleCycle: null,
    cycleQueue: [],
    lastSentAt: null,
    lastSentIndex: null,
  };

  async function readAdvertState() {
    const saved = await getState(stateKey);
    return { ...DEFAULT_STATE, ...saved, cycleQueue: Array.isArray(saved?.cycleQueue) ? saved.cycleQueue : [] };
  }

  async function writeAdvertState(state) {
    await setState(stateKey, state);
  }

  // Epoch-aligned rather than calendar-aligned (CYCLE_MS doesn't evenly divide a month/year the
  // way a single day does) — still deterministic and restart-safe: recomputing this from wall
  // clock always lands on the same cycle boundary.
  function getCycleKey(date) {
    return Math.floor(date.getTime() / CYCLE_MS).toString();
  }

  function shuffle(arr) {
    return [...arr].sort(() => Math.random() - 0.5);
  }

  function randomDelayWithinCycleMs() {
    return Math.floor(Math.random() * CYCLE_MS);
  }

  function buildCycleQueue(date, lastSentIndex) {
    const cycleStartMs = Math.floor(date.getTime() / CYCLE_MS) * CYCLE_MS;
    let scheduled = [];

    for (let attempts = 0; attempts < 1000; attempts++) {
      const indexes = shuffle(Array.from({ length: advertCount }, (_, i) => i));

      scheduled = indexes
        .map((index) => ({ index, sendAtMs: cycleStartMs + randomDelayWithinCycleMs(), sent: false }))
        .sort((a, b) => a.sendAtMs - b.sendAtMs);

      const hasGap = scheduled.every((item, idx) => idx === 0 || item.sendAtMs - scheduled[idx - 1].sendAtMs >= MIN_GAP_MS);
      const avoidsRepeat = lastSentIndex == null || scheduled[0]?.index !== lastSentIndex;

      if (hasGap && avoidsRepeat) break;
    }

    return scheduled.map((item) => ({ index: item.index, sendAt: new Date(item.sendAtMs).toISOString(), sent: false }));
  }

  async function sendByIndex(index) {
    const text = await buildMessage(index);
    return sendMessage(text);
  }

  async function tick() {
    const fresh = await readAdvertState();
    const currentCycleKey = getCycleKey(new Date());

    if (fresh.scheduleCycle !== currentCycleKey) {
      await writeAdvertState({ ...fresh, scheduleCycle: currentCycleKey, cycleQueue: buildCycleQueue(new Date(), fresh.lastSentIndex) });
      return;
    }

    const now = Date.now();
    let dirty = false;
    let sentIndex = null;

    for (const item of fresh.cycleQueue) {
      if (!item.sent && new Date(item.sendAt).getTime() <= now) {
        await sendByIndex(item.index);
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

  return async function start() {
    if (!isConfigured()) {
      console.log(notConfiguredLog);
      return;
    }

    let state = await readAdvertState();
    const currentCycleKey = getCycleKey(new Date());

    if (!state.firstStartupSent) {
      console.log(`${startedLog}: first startup → sending first advert immediately`);
      try {
        await sendByIndex(0);
        state = await readAdvertState();
        await writeAdvertState({ ...state, firstStartupSent: true, lastSentAt: new Date().toISOString(), lastSentIndex: 0 });
      } catch (err) {
        console.error(`⚠️  ${startedLog}: initial send failed:`, err.message);
      }
    }

    if (!state.scheduleCycle || state.scheduleCycle !== currentCycleKey) {
      await writeAdvertState({ ...state, scheduleCycle: currentCycleKey, cycleQueue: buildCycleQueue(new Date(), state.lastSentIndex) });
    }

    console.log(startedLog);
    setInterval(() => tick().catch((err) => console.error(`⚠️  ${startedLog} tick failed:`, err.message)), TICK_INTERVAL_MS);
    tick().catch((err) => console.error(`⚠️  ${startedLog} initial tick failed:`, err.message));
  };
}
