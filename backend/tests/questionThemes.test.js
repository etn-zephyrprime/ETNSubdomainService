// Members' own questions (services/contractCheck/questionThemes.js): grouping, theme tags, and the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeQuestion, questionThemes, chipFor, formatTopQuestions } from "../services/contractCheck/questionThemes.js";

test("identical questions group together whatever the punctuation or case", () => {
  assert.equal(normalizeQuestion("  Can the OWNER mint more tokens?!  "), "can the owner mint more tokens");
  assert.equal(normalizeQuestion("can the owner mint more tokens"), normalizeQuestion("Can the owner mint more tokens?"));
});

test("themes: different wordings of the same worry land together", () => {
  assert.ok(questionThemes("Can they mint more?").includes("mint"));
  assert.ok(questionThemes("Is there a way to print new tokens").includes("mint"));
  assert.ok(questionThemes("is this a honeypot? can I sell?").includes("sell"));
  assert.ok(questionThemes("Is the LP locked or can they rug?").includes("liquidity"));
  assert.ok(questionThemes("can they blacklist my wallet").includes("pauseFreeze"));
  assert.ok(!questionThemes("Is this on the blockchain?").includes("pauseFreeze")); // "block" alone doesn't count
  assert.deepEqual(questionThemes("hello there"), []);
});

test("chips: which themes a quick question already covers", () => {
  assert.equal(chipFor("fees"), "Can they change fees?");
  assert.equal(chipFor("mint"), null); // no quick question for minting yet
});

test("report: themes with ★ where no quick question exists, and repeated questions", () => {
  const top = {
    total: 12,
    untagged: 1,
    themes: [{ theme: "mint", n: 5 }, { theme: "fees", n: 4 }, { theme: "sell", n: 2 }],
    exact: [{ normalized: "can they mint", n: 3, contracts: 2, example: "Can they mint?", answerable_rate: 1 }, { normalized: "price tomorrow", n: 2, contracts: 1, example: "What's the price tomorrow?", answerable_rate: 0 }, { normalized: "x", n: 1, contracts: 1, example: "x", answerable_rate: 1 }],
  };
  const text = formatTopQuestions(top).join("\n");
  assert.match(text, /12 questions asked \(1 matched no theme\)/);
  assert.match(text, /★ Minting \/ supply: 5/);
  assert.match(text, /  Fees \/ tax: 4 — covered by "Can they change fees\?"/);
  assert.match(text, /3× "Can they mint\?" \(on 2 contracts\)/);
  assert.match(text, /2× "What's the price tomorrow\?" — usually not answerable from the facts/);
  assert.ok(!/1× "x"/.test(text)); // asked once: not listed
  assert.deepEqual(formatTopQuestions({ total: 0, themes: [], exact: [] }), ["No questions asked yet."]);
});
