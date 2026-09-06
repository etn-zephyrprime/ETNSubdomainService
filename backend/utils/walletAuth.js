// backend/utils/walletAuth.js
//
// Short-lived signed proof of wallet ownership — originally for the one endpoint that needed it
// (GET /api/pnl/statements?payerWallet=...), now shared by any premium endpoint that needs the
// same "prove you control this address" check (see premiumDashboardRouter.js). Not a general auth
// system: most of this backend's routes stay deliberately unauthenticated — tx-hash/request-ID
// access on the PnL statement API is an intentional "anyone with the link can view" design,
// confirmed decision. What this closes is different: an endpoint keyed on nothing but a bare
// wallet address (always public) would otherwise let anyone who can name/guess that address pull
// whatever it returns — no link or tx hash needed at all. This makes the caller prove they
// actually control the address they're asking about.
//
// `purpose` is folded into the signed message so what a signature is authorizing is legible to
// whoever's asked to sign it (rather than every caller showing the same fixed wording regardless
// of what it's actually for) — it is NOT a permission scope: a valid signature for one purpose
// proves the same thing (ownership of `address`, recently) as any other. Caller and verifier must
// pass the exact same literal, since it's part of what gets signed.
//
// Message format MUST match src/utils/walletAuth.js (frontend) byte-for-byte, or every signature
// fails verification.
import { ethers } from "ethers";

// Signatures older than this are rejected — bounds how long a leaked/logged signature+timestamp
// pair stays replayable. Frontend (useWalletAuthSignature.js) re-signs with a minute of buffer
// left, so this is "how long a cached signature survives", not just a network-latency allowance.
export const AUTH_MAX_SKEW_MS = 5 * 60 * 1000;

export function buildWalletAuthMessage(address, timestamp, purpose) {
  return `Verify wallet ownership for Planet Zephyros ${purpose}.\n\nWallet: ${address}\nTimestamp: ${timestamp}\n\nThis signature does not grant any transaction permissions.`;
}

/**
 * Throws a short, safe-to-return-to-the-client message on any failure. On success, returns
 * nothing — the caller already knows the (now-verified) address. `purpose` must match exactly
 * what the frontend signed (see buildWalletAuthMessage's own comment above).
 */
export function verifyWalletOwnership(address, signature, timestampRaw, purpose) {
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

  const message = buildWalletAuthMessage(address, timestamp, purpose);

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
