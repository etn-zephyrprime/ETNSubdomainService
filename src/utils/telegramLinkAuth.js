// Proves to the backend that a "link my Telegram" (or "unlink") request actually comes from the
// wallet it claims to, the same way backendAuth.js does for NFT generation — the wallet signs a
// message binding its own address + a timestamp, and the backend recovers the signer address and
// checks it matches. No on-chain ownership check needed here (unlike verifyOwnership.js) since
// this isn't about proving ownership of a specific name, just proving control of the wallet the
// caller claims to be.
//
// buildTelegramLinkMessage() must stay byte-for-byte in sync with the identical function in
// backend/utils/telegramLinkRouter.js — changing either side alone breaks every request.
export function buildTelegramLinkMessage(address, timestamp) {
  return `Link Telegram alerts for wallet ${address.toLowerCase()} at ${timestamp}`;
}

export async function signTelegramLinkRequest(signer, address) {
  const timestamp = Date.now();
  const message = buildTelegramLinkMessage(address, timestamp);
  const signature = await signer.signMessage(message);
  return { timestamp, signature };
}
