// Same signed-message pattern as telegramLinkAuth.js, for the SEPARATE Planet Zephyros Notis bot
// (Core tier alerts) — see backend/utils/notisLinkRouter.js's own header comment for why this
// isn't the same bot/link as telegramLinkAuth.js's ETN Subdomain Service one.
//
// buildNotisLinkMessage() must stay byte-for-byte in sync with the "Planet Zephyros alerts"
// `purpose` passed to createTelegramLinkRouter.js in backend/utils/notisLinkRouter.js — changing
// either side alone breaks every request.
export function buildNotisLinkMessage(address, timestamp) {
  return `Link Planet Zephyros alerts for wallet ${address.toLowerCase()} at ${timestamp}`;
}

export async function signNotisLinkRequest(signer, address) {
  const timestamp = Date.now();
  const message = buildNotisLinkMessage(address, timestamp);
  const signature = await signer.signMessage(message);
  return { timestamp, signature };
}
