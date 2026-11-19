function amount(book, stable) {
  const value = Number(book?.[stable] || 0);
  return Number.isFinite(value) ? value : 0;
}

function pendingSpend(state, stable) {
  if (state.hedgeLeg?.dir === "buyOnEs" && state.hedgeLeg.stable === stable) {
    return Number(state.hedgeLeg.esUsd) || 0;
  }
  if (state.gapRebalancePending?.from === stable) {
    return Number(state.gapRebalancePending.usdIn) || 0;
  }
  return 0;
}

export function sharedStableAvailable(state, stable) {
  return Math.max(
    0,
    amount(state.gap?.stables, stable) +
      amount(state.hedgeLive?.stables, stable) -
      pendingSpend(state, stable)
  );
}

export function allocateSharedStable(state, target, stable, required) {
  if (!["USDT", "USDC"].includes(stable) || !Number.isFinite(required) || required < 0 || !["gap", "hedge"].includes(target)) return false;
  if (required === 0) return true;

  const gap = state.gap?.stables;
  const hedge = state.hedgeLive?.stables;
  const recipient = target === "gap" ? gap : hedge;
  const donor = target === "gap" ? hedge : gap;
  if (!recipient || (target === "hedge" && !hedge)) return false;
  if (sharedStableAvailable(state, stable) + 1e-9 < required) return false;

  let gapBalance = amount(gap, stable);
  let hedgeBalance = amount(hedge, stable);
  if (gapBalance < 0 && hedgeBalance > 0) {
    const transfer = Math.min(-gapBalance, hedgeBalance);
    gapBalance += transfer;
    hedgeBalance -= transfer;
  } else if (hedgeBalance < 0 && gapBalance > 0) {
    const transfer = Math.min(-hedgeBalance, gapBalance);
    hedgeBalance += transfer;
    gapBalance -= transfer;
  }

  const recipientBalance = target === "gap" ? gapBalance : hedgeBalance;
  if (recipientBalance < required) {
    const transfer = required - recipientBalance;
    if (target === "gap") {
      if (hedgeBalance < transfer) return false;
      gapBalance += transfer;
      hedgeBalance -= transfer;
    } else {
      if (gapBalance < transfer) return false;
      hedgeBalance += transfer;
      gapBalance -= transfer;
    }
  }

  if (gap) gap[stable] = gapBalance;
  if (hedge) hedge[stable] = hedgeBalance;
  return true;
}
