// Static extraction from a site's HTML and scripts (never executed): contract addresses, script URLs and
// chunk references. Everything here is site-controlled text — it's only searched, never shown.
import { ethers } from "ethers";
import { SCAN } from "./appCheck.config.js";

// 0x + 40 hex, not part of a longer hex/identifier run (hashes, calldata, longer hex strings)
const ADDRESS_RE = /(?<![0-9A-Za-z_$])0x[0-9a-fA-F]{40}(?![0-9A-Za-z_$])/g;
const IGNORE = new Set(SCAN.ignoreAddresses);

/** Addresses in text: Map(lowercase address -> occurrences). Mixed-case ones must pass EIP-55. */
export function extractAddresses(text, into = new Map()) {
  for (const m of String(text || "").matchAll(ADDRESS_RE)) {
    const raw = m[0];
    const hex = raw.slice(2);
    const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
    if (mixed) {
      try {
        if (ethers.getAddress(raw) !== raw) continue; // a bad checksum: a typo or not an address
      } catch {
        continue;
      }
    }
    const a = raw.toLowerCase();
    if (IGNORE.has(a)) continue;
    if (/^0x0{30}/.test(a) || /^0xf{30}/.test(a)) continue; // precompiles, tiny/max constants: not real contracts
    into.set(a, (into.get(a) || 0) + 1);
  }
  return into;
}

const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"))?.slice(1).find((v) => v !== undefined) ?? null;

/** From a page: { scriptUrls (absolute, in order), inline: [script text] }. Honours <base href>. */
export function pageScripts(html, pageUrl) {
  const scriptUrls = [];
  const inline = [];
  let base = pageUrl;
  const baseTag = html.match(/<base\b[^>]*>/i);
  if (baseTag && attr(baseTag[0], "href")) {
    try {
      base = new URL(attr(baseTag[0], "href"), pageUrl).toString();
    } catch {
      /* keep the page URL */
    }
  }
  const add = (href) => {
    if (!href) return;
    try {
      const u = new URL(href.trim(), base);
      if ((u.protocol === "http:" || u.protocol === "https:") && !scriptUrls.includes(u.toString())) scriptUrls.push(u.toString());
    } catch {
      /* not a URL */
    }
  };
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = attr(`<x ${m[1]}>`, "src");
    if (src) add(src);
    else if (m[2].trim()) inline.push(m[2]);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], "rel") || "").toLowerCase().split(/\s+/);
    const as = (attr(m[0], "as") || "").toLowerCase();
    if (rel.includes("modulepreload") || (rel.includes("preload") && as === "script")) add(attr(m[0], "href"));
  }
  return { scriptUrls, inline };
}

const CHUNK_RE = /["'`]((?:https?:\/\/[^"'`\s]+?|\.{1,2}\/[^"'`\s]+?|\/[^"'`\s]+?|[\w.-]+(?:\/[\w.@-]+)+?)\.m?js)(?:\?[^"'`\s]*)?["'`]/g;

/**
 * Script files a script refers to (Vite/webpack/Next chunk patterns): absolute URLs. `./x.js` and `../x.js`
 * are relative to the script; `/x.js` and bare `assets/x.js` to the site root (bundlers' base), except Next.js's
 * `static/chunks/x.js`, which is relative to its `/_next/` folder.
 */
export function chunkRefs(js, scriptUrl, origin) {
  const out = new Set();
  for (const m of String(js || "").matchAll(CHUNK_RE)) {
    const ref = m[1];
    if (ref.length > 300 || /[<>{}\s\\]/.test(ref)) continue;
    try {
      // Next.js writes chunk paths relative to /_next/ ("static/chunks/x.js")
      const nextBase = /\/_next\//.test(scriptUrl) && ref.startsWith("static/") ? `${scriptUrl.slice(0, scriptUrl.indexOf("/_next/"))}/_next/` : null;
      const u = /^https?:\/\//i.test(ref) || ref.startsWith(".") ? new URL(ref, scriptUrl) : nextBase ? new URL(ref, nextBase) : new URL(ref.startsWith("/") ? ref : `/${ref}`, origin);
      if (u.protocol === "http:" || u.protocol === "https:") out.add(u.toString());
    } catch {
      /* not a URL */
    }
  }
  return [...out];
}
