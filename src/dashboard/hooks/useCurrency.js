import { useEffect, useState } from "react";
import { BACKEND_IMAGE_URL } from "../../config.js";

// Dashboard-wide display currency (USD/GBP/EUR) — module-level shared state + subscriber set, same
// pattern useTokenNames.js/useDisplayNames.js already use for cross-component shared state without
// a React Context provider. format.js's formatUsdPrice reads `currency`/`rates` directly (it's a
// plain function, called from dozens of places, not itself a hook) — CurrencySelector.jsx and
// DashboardApp.jsx both call this hook, so changing currency anywhere notifies every subscriber and
// forces a re-render sweep from the top, which is what makes every formatUsdPrice() call downstream
// pick up the new currency/rate at render time without threading a currency prop through every one
// of them.
const STORAGE_KEY = "dashboardCurrency";
export const SUPPORTED_CURRENCIES = ["USD", "GBP", "EUR"];
const CURRENCY_SYMBOLS = { USD: "$", GBP: "£", EUR: "€" };

function readStoredCurrency() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return SUPPORTED_CURRENCIES.includes(stored) ? stored : "USD";
  } catch {
    return "USD"; // localStorage can throw (private browsing, blocked storage) — default, never crash
  }
}

let currency = readStoredCurrency();
let rates = { USD: 1 }; // GBP/EUR filled in once /api/fx-rates resolves; formatUsdPrice falls back to USD until then
let ratesPromise = null;
const subscribers = new Set();

function notifyAll() {
  subscribers.forEach((fn) => fn());
}

function ensureRatesLoaded() {
  if (rates.GBP != null && rates.EUR != null) return;
  if (ratesPromise) return;
  ratesPromise = fetch(`${BACKEND_IMAGE_URL}/api/fx-rates`)
    .then((res) => res.json())
    .then((data) => {
      if (data?.rates?.GBP != null && data?.rates?.EUR != null) {
        rates = data.rates;
        notifyAll();
      }
    })
    .catch((err) => console.warn("Couldn't load exchange rates:", err.message))
    .finally(() => {
      ratesPromise = null;
    });
}

/** Current display currency/symbol, a setter (persisted to localStorage), and convert() — turns a
 * USD number into the current currency's number (NOT yet formatted/symboled; formatUsdPrice does
 * that). Falls back to a 1:1 USD passthrough for GBP/EUR until the live rate has loaded, same
 * "degrade, don't break" convention as the rest of this app — a viewer sees USD-equivalent numbers
 * labeled with their chosen currency's symbol for a moment, never a blank/broken figure. */
export function useCurrency() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const rerender = () => setTick((n) => n + 1);
    subscribers.add(rerender);
    ensureRatesLoaded();
    return () => subscribers.delete(rerender);
  }, []);

  return {
    currency,
    symbol: CURRENCY_SYMBOLS[currency],
    setCurrency(next) {
      if (!SUPPORTED_CURRENCIES.includes(next) || next === currency) return;
      currency = next;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // localStorage can throw (private browsing, blocked storage) — the in-memory value above
        // still takes effect for the rest of this session, it just won't survive a reload.
      }
      ensureRatesLoaded();
      notifyAll();
    },
    convert(usdAmount) {
      if (!Number.isFinite(usdAmount)) return usdAmount;
      const rate = rates[currency];
      return rate != null ? usdAmount * rate : usdAmount;
    },
  };
}

// Non-hook accessors — format.js's formatUsdPrice is a plain function (not itself a hook, called
// from dozens of non-component call sites), so it reads the current snapshot directly rather than
// calling useCurrency(). Reactivity comes from DashboardApp.jsx's own useCurrency() subscription
// forcing a full re-render sweep on change, per this file's own header comment.
export function getCurrentCurrencySnapshot() {
  const rate = rates[currency];
  return { currency, symbol: CURRENCY_SYMBOLS[currency], rate: rate != null ? rate : 1 };
}
