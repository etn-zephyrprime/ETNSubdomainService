import { ethers } from "ethers";

// Minimal subset of src/abis/NameWrapperABI.json (frontend) — ownerOf(id) where id is the node
// itself, treated as uint256 (NameWrapper is ERC1155-style; the token id is the node).
const NAME_WRAPPER_ABI = ["function ownerOf(uint256 id) view returns (address owner)"];

// Must point at the same chain the frontend actually registers names on (see RPC_URL /
// NAME_WRAPPER_ADDRESS in src/config.js) — otherwise every legitimate request gets rejected
// because ownerOf() is being checked on the wrong chain entirely.
const RPC_URL = process.env.RPC_URL || "https://rpc.ankr.com/electroneum";
const NAME_WRAPPER_ADDRESS =
  process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";

// Bounds how long a captured signature could be replayed for. Wide enough for normal request
// latency, narrow enough to matter.
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
// Small allowance for clock skew between the caller's machine and this server.
const MAX_CLOCK_SKEW_MS = 30 * 1000;

const NODE_HEX_RE = /^0x[0-9a-fA-F]{64}$/;

export class OwnershipVerificationError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

let cachedNameWrapper = null;
function getNameWrapper() {
  if (cachedNameWrapper) return cachedNameWrapper;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  cachedNameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);
  return cachedNameWrapper;
}

// Must stay byte-for-byte in sync with buildNftGenerationMessage() in
// src/utils/backendAuth.js (frontend) — changing either side alone breaks every request.
function buildMessage(nodeHex, timestamp) {
  return `Generate NFT image for node ${nodeHex.toLowerCase()} at ${timestamp}`;
}

/**
 * Verifies the caller actually owns `nodeHex` on-chain (via NameWrapper.ownerOf), proven by a
 * wallet signature over a message binding the node + a timestamp — not just a claimed address,
 * since anyone could otherwise claim to be any address. Also doubles as strict input validation
 * for nodeHex (only hex digits — no path/traversal characters make it past this into the
 * generated filename / storage key).
 *
 * Throws OwnershipVerificationError (carrying an HTTP status) on any failure. Callers should
 * catch and respond with err.status/err.message rather than let a raw error reach the client.
 */
export async function verifyOwnership({ nodeHex, timestamp, signature }) {
  if (!nodeHex || !NODE_HEX_RE.test(nodeHex)) {
    throw new OwnershipVerificationError("Invalid nodeHex", 400);
  }
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new OwnershipVerificationError("Invalid timestamp", 400);
  }
  if (!signature || typeof signature !== "string") {
    throw new OwnershipVerificationError("Missing signature", 400);
  }

  const now = Date.now();
  if (timestamp > now + MAX_CLOCK_SKEW_MS || now - timestamp > MAX_SIGNATURE_AGE_MS) {
    throw new OwnershipVerificationError("Signature expired — try again", 401);
  }

  const message = buildMessage(nodeHex, timestamp);

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    throw new OwnershipVerificationError("Invalid signature", 401);
  }

  let owner;
  try {
    owner = await getNameWrapper().ownerOf(nodeHex);
  } catch {
    // ownerOf reverts for a node that was never wrapped/registered at all.
    throw new OwnershipVerificationError("Name not found", 404);
  }

  if (owner === ethers.ZeroAddress || owner.toLowerCase() !== recovered.toLowerCase()) {
    throw new OwnershipVerificationError("You don't own this name", 403);
  }

  return recovered;
}
