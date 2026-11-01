// backend/services/etnFastTrigger.js
//
// When the ETN accumulator bot's fast watcher should run a full check early. The full check (every
// mode's quotes, then at most one trade) runs every ETN_BOT_INTERVAL_MS (60s); between those, a cheap
// watcher reads just the two USD pools' prices every block or so, and KuCoin's every few seconds, and
// asks this whether something worth acting on has happened. Confirmed live (1 Nov 2026, 20:00 UTC): a
// $200 buy put the USDC pool ~25% above KuCoin and the USDT pool; other traders worked that for about 4
// minutes while the bot, on its 60s clock and one action per check, only got to it late.
//
// Pure — no I/O — so the rules are unit-tested (tests/etnFastTrigger.test.js).

export const FAST_DEFAULTS = {
  movePct: 1, // a pool moved this much since the last full check: always worth a look
  gapPct: 1.5, // the pools this far apart (the gap trade's own bar)
  lagPct: 3, // a pool this far from KuCoin (the catch-up mode's own bar)
  // A standing gap/lag only re-triggers if the last full check traded (keep working it — one action per
  // check) or something has moved since; otherwise a gap the bot can't use (e.g. no stablecoin on that
  // side) would wake it every few seconds for nothing.
  changePct: 0.1,
  kucoinChangePct: 0.3,
};

const pctApart = (a, b) => Math.abs(a / b - 1) * 100;

/**
 * A reason to run a full check now, or null.
 * @param mids  { USDT, USDC } — each pool's ETN price now (USD)
 * @param kMid  KuCoin's ETN price now, or null if unavailable
 * @param last  the last full check: { mids, kMid, acted } (null before the first one)
 */
export function fastTriggerReason({ mids, kMid = null, last }, cfg = FAST_DEFAULTS) {
  if (!(mids?.USDT > 0) || !(mids?.USDC > 0) || !(last?.mids?.USDT > 0) || !(last?.mids?.USDC > 0)) return null;
  const moved = Math.max(pctApart(mids.USDT, last.mids.USDT), pctApart(mids.USDC, last.mids.USDC));
  if (moved >= cfg.movePct) return { reason: `a pool moved ${moved.toFixed(1)}%`, urgent: true };

  const gap = (Math.max(mids.USDT, mids.USDC) / Math.min(mids.USDT, mids.USDC) - 1) * 100;
  const lag = kMid > 0 ? Math.max(pctApart(mids.USDT, kMid), pctApart(mids.USDC, kMid)) : 0;
  const standing = gap >= cfg.gapPct ? `pools ${gap.toFixed(1)}% apart` : lag >= cfg.lagPct ? `ElectroSwap ${lag.toFixed(1)}% off KuCoin` : null;
  if (!standing) return null;

  const kMoved = kMid > 0 && last.kMid > 0 ? pctApart(kMid, last.kMid) : 0;
  const fresh = last.acted || moved >= cfg.changePct || kMoved >= cfg.kucoinChangePct;
  return fresh ? { reason: standing, urgent: false } : null;
}
