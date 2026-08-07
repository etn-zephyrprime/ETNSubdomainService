// Proves to the backend that the caller actually owns a node on-chain before it will
// generate/persist NFT art for that node (see security fix for the unauthenticated
// /api/generate-nft endpoint). The wallet signs a message binding the node + a timestamp, which
// the backend recovers the signer address from and checks against NameWrapper.ownerOf(node).
//
// buildNftGenerationMessage() must stay byte-for-byte in sync with the identical function in
// backend/utils/verifyOwnership.js — changing either side alone breaks every request.
export function buildNftGenerationMessage(nodeHex, timestamp) {
  return `Generate NFT image for node ${nodeHex.toLowerCase()} at ${timestamp}`;
}

export async function signNftGenerationRequest(signer, nodeHex) {
  const timestamp = Date.now();
  const message = buildNftGenerationMessage(nodeHex, timestamp);
  const signature = await signer.signMessage(message);
  return { timestamp, signature };
}
