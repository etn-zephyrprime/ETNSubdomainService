// backend/utils/tokenTransferTax.js
//
// Transfer taxes on tokens whose contract charges them on DEX trades — read from the token contract
// itself, never assumed. Written against CORE (Planet Zephyros, 0x309b…066f, verified source):
//
//   - The tax applies ONLY when the sender or recipient is the token's own `pairAddress()` — its
//     CORE/WETN ElectroSwap V2 pair. Trades through any other pool (e.g. a V3 pool) and wallet-to-
//     wallet transfers are untaxed.
//   - Rates are dynamic: currentSellBps() / currentBuyBps(), both a function of totalSupply vs the
//     1M initial supply (they step down as supply is burned). taxesPaused() turns both off, and
//     isExemptFromTax(address) exempts a sender/recipient.
//   - On a sell, the pair receives amount x (1 - sellBps/10000); the rest is split 80% burned / 20%
//     to a tax wallet. The V2 router's getAmountsOut knows nothing about this, so a quote must
//     shrink the input by the tax first (the router's "SupportingFeeOnTransferTokens" swap path is
//     what actually executes such a sale).
//
// Any token exposing the same currentSellBps()/currentBuyBps()/pairAddress() interface is handled
// the same way. A token without them is treated as untaxed — and the caller says so only when it
// matters (a token that taxes some other way would need its own reader here).
import { ethers } from "ethers";

const TAX_ABI = [
  "function currentSellBps() view returns (uint256)",
  "function currentBuyBps() view returns (uint256)",
  "function pairAddress() view returns (address)",
  "function taxesPaused() view returns (bool)",
  "function isExemptFromTax(address) view returns (bool)",
];
const CACHE_MS = 60_000; // rates only move as supply burns — a minute is plenty fresh for a quote
const cache = new Map(); // token -> { at, value }

/** { pairAddress, sellBps, buyBps } for a token with a CORE-style trade tax, or null if it has none
 * (no such interface, or taxes paused). Never throws. */
export async function getTradeTax(provider, tokenAddress) {
  const key = String(tokenAddress).toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value = null;
  try {
    const c = new ethers.Contract(key, TAX_ABI, provider);
    const [sellBps, buyBps, pair] = await Promise.all([c.currentSellBps(), c.currentBuyBps(), c.pairAddress()]);
    const paused = await c.taxesPaused().catch(() => false);
    if (!paused && pair && pair !== ethers.ZeroAddress) {
      value = { pairAddress: pair.toLowerCase(), sellBps: Number(sellBps), buyBps: Number(buyBps) };
    }
  } catch {
    value = null; // no tax interface — an ordinary token
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Whether `wallet` is exempt from `tokenAddress`'s trade tax (false when unknown). */
export async function isTaxExempt(provider, tokenAddress, wallet) {
  if (!wallet) return false;
  try {
    return await new ethers.Contract(tokenAddress, TAX_ABI, provider).isExemptFromTax(wallet);
  } catch {
    return false;
  }
}
