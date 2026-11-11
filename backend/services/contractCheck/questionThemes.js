// Grouping members' own Contract Check questions, so the most-asked ones can become quick questions. Members
// phrase the same thing many ways ("can the owner mint?", "is there a mint function", "can they print more"),
// so besides exact wording each question is tagged with themes by keyword. Pure.
import { CHIPS } from "./prompts.js";

/** Lower case, no punctuation, single spaces — identical questions group together. */
export function normalizeQuestion(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// theme -> keywords (word starts); `chip` = the quick question that already covers it, if any
export const THEMES = {
  mint: { words: ["mint", "print", "inflat", "new tokens", "more tokens", "supply"], chip: null },
  ownerTakesTokens: { words: ["take my", "steal", "drain", "withdraw my", "move my", "confiscat", "overwrite"], chip: "canOwnerTakeTokens" },
  fees: { words: ["fee", "tax", "slippage"], chip: "canChangeFees" },
  pauseFreeze: { words: ["pause", "freeze", "frozen", "blacklist", "blocked", "block my", "block wallet", "stop trading", "disable trading"], chip: "canPauseOrFreeze" },
  sell: { words: ["sell", "honeypot", "can i exit", "cash out", "swap out"], chip: null },
  liquidity: { words: ["liquidity", "lock", "lp", "pool", "rug", "pull"], chip: null },
  upgrade: { words: ["upgrade", "proxy", "implementation", "change the code"], chip: "isUpgradeable" },
  control: { words: ["owner", "who controls", "admin", "renounce", "multisig", "timelock", "dev", "team"], chip: "whoControlsIt" },
  holders: { words: ["holder", "whale", "concentrat", "top wallet", "distribution"], chip: null },
  whatItDoes: { words: ["what does", "what is this", "explain", "purpose", "how does it work"], chip: "whatDoesItDo" },
  safety: { words: ["safe", "scam", "legit", "trust", "risk", "should i buy", "worth"], chip: null },
  price: { words: ["price", "value", "worth", "market cap", "chart"], chip: null },
};

/** Themes a question touches (may be several, or none). */
export function questionThemes(q) {
  const n = ` ${normalizeQuestion(q)} `;
  return Object.entries(THEMES)
    .filter(([, t]) => t.words.some((w) => n.includes(` ${w}`)))
    .map(([theme]) => theme);
}

/** The quick-question label already covering a theme, or null — so the report shows which themes have no chip. */
export function chipFor(theme) {
  const id = THEMES[theme]?.chip;
  return id ? CHIPS.find((c) => c.id === id)?.question || null : null;
}

const THEME_LABEL = {
  mint: "Minting / supply",
  ownerTakesTokens: "Owner taking or moving tokens",
  fees: "Fees / tax",
  pauseFreeze: "Pausing / freezing / blacklists",
  sell: "Being able to sell (honeypot)",
  liquidity: "Liquidity / locks / rug pulls",
  upgrade: "Upgradeability",
  control: "Who controls it",
  holders: "Holders / whales",
  whatItDoes: "What it does",
  safety: "Is it safe / legit",
  price: "Price / value",
};

/**
 * The most-asked report: themes (★ = no quick question covers it yet — a candidate for the dropdown) and the
 * top exact questions. `top` = db topQuestions(). Telegram-Markdown-safe: members' wording is escaped by `md`.
 */
export function formatTopQuestions(top, { md = (s) => s, limit = 8 } = {}) {
  if (!top.total) return ["No questions asked yet."];
  const lines = [`${top.total} question${top.total === 1 ? "" : "s"} asked${top.untagged ? ` (${top.untagged} matched no theme)` : ""}.`, "", "By theme (★ = no quick question covers it yet):"];
  for (const t of top.themes.slice(0, limit)) {
    const chip = chipFor(t.theme);
    lines.push(`  ${chip ? " " : "★"} ${THEME_LABEL[t.theme] || t.theme}: ${t.n}${chip ? ` — covered by "${chip}"` : ""}`);
  }
  const repeated = top.exact.filter((q) => q.n > 1);
  if (repeated.length) {
    lines.push("", "Asked more than once, word for word:");
    for (const q of repeated.slice(0, limit)) lines.push(`  ${q.n}× "${md(q.example)}"${q.contracts > 1 ? ` (on ${q.contracts} contracts)` : ""}${q.answerable_rate < 0.5 ? " — usually not answerable from the facts" : ""}`);
  }
  return lines;
}
