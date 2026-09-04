// src/utils/walletAuth.js
//
// Frontend half of the signed wallet-ownership proof — see backend/utils/walletAuth.js for the
// full reasoning on what this is for and why only one endpoint needs it. Message format here
// MUST match that file's buildWalletAuthMessage() byte-for-byte, or every signature the backend
// receives fails verification.
export function buildWalletAuthMessage(address, timestamp) {
  return `Verify wallet ownership for Planet Zephyros PnL Statements.\n\nWallet: ${address}\nTimestamp: ${timestamp}\n\nThis signature does not grant any transaction permissions.`;
}

/** Signs a fresh ownership proof for `address` using `signer` (from wallet.getSigner()). Returns
 * { signature, timestamp } ready to append as query params. */
export async function signWalletAuth(signer, address) {
  const timestamp = Date.now();
  const message = buildWalletAuthMessage(address, timestamp);
  const signature = await signer.signMessage(message);
  return { signature, timestamp };
}
