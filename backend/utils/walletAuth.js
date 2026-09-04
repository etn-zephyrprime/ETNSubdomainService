// backend/utils/walletAuth.js
//
// Short-lived signed proof of wallet ownership — for the one endpoint that needs it right now
// (GET /api/pnl/statements?payerWallet=...), not a general auth system. Everything else on the
// PnL statement API (backend/utils/pnlStatementRouter.js) stays deliberately unauthenticated —
// tx-hash/request-ID access is an intentional "anyone with the link can view" design, confirmed
// decision. What this closes is different: GET /pnl/statements took a bare `payerWallet` query
// param and returned that wallet's entire order history (both wallets involved, PDF/JSON links)
// to anyone who could name/guess the address — no link or tx hash needed at all, since wallet
// addresses are always public. This makes the caller prove they actually control the address
// they're asking about.
//
// Message format MUST match src/utils/walletAuth.js (frontend) byte-for-byte, or every signature
// fails verification.
import { ethers } from "ethers";

// Signatures older than this are rejected — bounds how long a leaked/logged signature+timestamp
// pair stays replayable. Frontend (useWalletAuthSignature.js) re-signs with a minute of buffer
// left, so this is "how long a cached signature survives", not just a network-latency allowance.
export const AUTH_MAX_SKEW_MS = 5 * 60 * 1000;

export function buildWalletAuthMessage(address, timestamp) {
  return `Verify wallet ownership for Planet Zephyros PnL Statements.\n\nWallet: ${address}\nTimestamp: ${timestamp}\n\nThis signature does not grant any transaction permissions.`;
}

/**
 * Throws a short, safe-to-return-to-the-client message on any failure. On success, returns
 * nothing — the caller already knows the (now-verified) address.
 */
export function verifyWalletOwnership(address, signature, timestampRaw) {
  if (!address || !ethers.isAddress(address)) {
    throw new Error("Invalid wallet address");
  }
  if (!signature || typeof signature !== "string") {
    throw new Error("Missing signature");
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Missing or invalid timestamp");
  }
  if (Math.abs(Date.now() - timestamp) > AUTH_MAX_SKEW_MS) {
    throw new Error("Signature expired — please try again");
  }

  const message = buildWalletAuthMessage(address, timestamp);

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    throw new Error("Invalid signature");
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new Error("Signature does not match the claimed wallet");
  }
}
