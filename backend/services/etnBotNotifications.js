import { totalAccruedEtn } from "./etnAccumulatorStrategy.js";

export const DEFAULT_ETN_BOT_ALERT_WALLET = "0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099";

export function etnBotAlertWallets(value = process.env.ETN_BOT_ALERT_WALLETS) {
  const list = value == null ? DEFAULT_ETN_BOT_ALERT_WALLET : value;
  return new Set(String(list).split(",").map((address) => address.trim().toLowerCase()).filter(Boolean));
}

export function formatEtnBotNotification(text, mode, state) {
  const opportunity = mode === "opportunity";
  const total = !opportunity && state ? totalAccruedEtn(state) : null;
  const accrued = total == null ? "unavailable" : `${total >= 0 ? "+" : "−"}${Math.round(Math.abs(total)).toLocaleString("en-US")} ETN`;
  const label = opportunity ? "MARKET OPPORTUNITY" : mode.toUpperCase();
  const footer = opportunity ? "" : `\n\n*Realized ETN accrued: ${accrued}*${mode === "paper" ? "\n\n_ETN strategy trades are simulated in PAPER mode._" : ""}`;
  return `*ETN Accumulator Bot — ${label}*\n\n${text}${footer}`;
}
