// backend/utils/fxRateRouter.js
//
// Live USD -> GBP/EUR exchange rates for the dashboard's currency selector (src/dashboard/
// hooks/useCurrency.js) — every USD figure across the dashboard (Core Tier Portfolio/PnL/NFT PnL,
// Address Lookup, Overview, etc.) already flows through formatUsdPrice, so this is the one place
// that needs a live rate rather than threading currency conversion through every call site.
//
// Frankfurter (frankfurter.app) — ECB reference rates, free, no API key/signup required. Public,
// no auth on this route (same "no wallet needed" spirit as the rest of the free-tier dashboard).
// Cached in memory for CACHE_TTL_MS (forex doesn't need to be fresher than this) with a stale-
// serve-on-failure fallback — a transient upstream hiccup shouldn't blank out a value viewers were
// already looking at.
import express from "express";

const FX_API_URL = "https://api.frankfurter.app/latest?from=USD&to=GBP,EUR";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 10000;

let cache = null; // { rates: { GBP, EUR }, updatedAt: ISOString, expiresAt: epoch ms }

async function fetchRates() {
  const res = await fetch(FX_API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Frankfurter API returned HTTP ${res.status}`);
  const json = await res.json();
  const gbp = Number(json?.rates?.GBP);
  const eur = Number(json?.rates?.EUR);
  if (!Number.isFinite(gbp) || !Number.isFinite(eur)) {
    throw new Error("Frankfurter response missing a usable GBP/EUR rate");
  }
  return { GBP: gbp, EUR: eur };
}

async function getRates() {
  if (cache && cache.expiresAt > Date.now()) return cache;
  try {
    const rates = await fetchRates();
    cache = { rates, updatedAt: new Date().toISOString(), expiresAt: Date.now() + CACHE_TTL_MS };
  } catch (err) {
    console.warn("⚠️  FX rate fetch failed:", err.message);
    if (cache) return cache; // serve the last good rates rather than fail a viewer entirely over a transient hiccup
    throw err;
  }
  return cache;
}

const router = express.Router();

router.get("/fx-rates", async (req, res) => {
  try {
    const { rates, updatedAt } = await getRates();
    res.json({ rates: { USD: 1, ...rates }, updatedAt });
  } catch (err) {
    res.status(502).json({ error: "Couldn't fetch exchange rates right now" });
  }
});

export default router;
