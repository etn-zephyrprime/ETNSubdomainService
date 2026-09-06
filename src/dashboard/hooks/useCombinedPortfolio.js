import { useCallback } from "react";
import { useBlockscout } from "./useBlockscout.js";

// Combines native ETN balance + token holdings across up to MAX_TRACKED_WALLETS tracked wallets
// into one merged view — reuses the exact same Blockscout calls AddressLookup.jsx already makes
// for a single address (getAddress for coin_balance, getAddressTokenBalances for holdings), just
// fanned out across N addresses and summed. No new backend endpoint needed for the balances
// themselves — only the tracked-wallet *list* is server-stored (see useTrackedWallets.js);
// Blockscout is still called directly, client-side, same as every other read in this app.
//
// Tokens are merged by contract address, lowercased — same address-casing lesson learned the hard
// way in pnlStatementGenerator.js's aggregateRealizedGains (raw-case addresses as a Map key
// silently produced duplicate rows for the same token). Without this, a token held across two of
// the tracked wallets would show as two separate rows here instead of one summed one.
export function useCombinedPortfolio() {
  const { getAddress, getAddressTokenBalances } = useBlockscout();

  const getCombinedPortfolio = useCallback(async (wallets) => {
    const perWallet = await Promise.all(
      wallets.map(async (address) => {
        const [info, balances] = await Promise.all([
          getAddress(address).catch((err) => {
            console.error(`Failed to load address info for ${address}:`, err.message);
            return null;
          }),
          getAddressTokenBalances(address).catch((err) => {
            console.error(`Failed to load token balances for ${address}:`, err.message);
            return [];
          }),
        ]);
        return { address, info, balances: Array.isArray(balances) ? balances : [] };
      })
    );

    const totalCoinBalance = perWallet.reduce(
      (sum, w) => sum + BigInt(w.info?.coin_balance || 0),
      0n
    );

    // lowercased token address -> { token, value, heldBy: [address, ...] }
    const tokensByAddress = new Map();
    for (const w of perWallet) {
      for (const tb of w.balances) {
        const tokenAddr = tb.token?.address?.toLowerCase();
        if (!tokenAddr) continue;
        const value = BigInt(tb.value || 0);
        const existing = tokensByAddress.get(tokenAddr);
        if (existing) {
          existing.value += value;
          existing.heldBy.push(w.address);
        } else {
          tokensByAddress.set(tokenAddr, { token: tb.token, value, heldBy: [w.address] });
        }
      }
    }

    return {
      perWallet,
      totalCoinBalance,
      tokens: [...tokensByAddress.values()],
    };
  }, [getAddress, getAddressTokenBalances]);

  return { getCombinedPortfolio };
}
