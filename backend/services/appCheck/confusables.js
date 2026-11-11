// Lookalike helpers: a "skeleton" of a domain label (what it looks like, not what it's spelled with) and
// Damerau-Levenshtein distance. A curated map of the confusables phishing domains actually use (Cyrillic and
// Greek letters that render like Latin ones, plus digit/letter swaps) — not the full Unicode confusables table.
// Mixed-script labels are caught separately (normaliseInput.js labelScripts), whatever letters they use.

const UNICODE_TO_LATIN = {
  // Cyrillic
  а: "a", в: "b", с: "c", ԁ: "d", е: "e", ё: "e", һ: "h", і: "i", ї: "i", ј: "j", к: "k", ӏ: "l", м: "m", н: "h",
  о: "o", р: "p", ԛ: "q", г: "r", ѕ: "s", т: "t", у: "y", ү: "y", х: "x", ԝ: "w", ѡ: "w", ь: "b", з: "3", ч: "4",
  // Greek
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w", γ: "y", μ: "u",
  // Latin lookalikes that NFKD doesn't fold
  ı: "i", ȷ: "j", ł: "l", ø: "o", đ: "d", ħ: "h", ŧ: "t", ß: "ss", æ: "ae", œ: "oe", ɡ: "g", ɑ: "a", ʀ: "r", ɪ: "i",
};

/** A label's look-alike skeleton: "e1ectr0-swap" and "еlectroswap" (Cyrillic е) both become "electroswap"'s. */
export function skeleton(label) {
  let s = String(label || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  s = [...s].map((ch) => UNICODE_TO_LATIN[ch] ?? ch).join("");
  return s
    .replace(/[-_.]/g, "")
    .replace(/0/g, "o")
    .replace(/[1i|!]/g, "l")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/cl/g, "d")
    .replace(/5/g, "s")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/8/g, "b")
    .replace(/9/g, "g")
    .replace(/7/g, "t");
}

/** Damerau-Levenshtein distance (optimal string alignment: insert, delete, substitute, swap neighbours). */
export function editDistance(a, b) {
  a = [...String(a)];
  b = [...String(b)];
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** True if `rest` is made only of the given words (greedy-free: tries every split). */
export function madeOfWords(rest, words) {
  if (!rest) return true;
  const memo = new Map();
  const go = (i) => {
    if (i === rest.length) return true;
    if (memo.has(i)) return memo.get(i);
    let ok = false;
    for (const w of words) if (w && rest.startsWith(w, i) && go(i + w.length)) { ok = true; break; }
    memo.set(i, ok);
    return ok;
  };
  return go(0);
}
