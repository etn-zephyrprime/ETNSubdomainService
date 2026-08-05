import { ethers } from "ethers";
import { ETN_NODE } from "../config.js";

/**
 * Computes the ENS-style node (namehash) for a top-level ".etn" name.
 * Matches ethers.namehash(`${label}.etn`) but built from the confirmed-correct
 * ETN_NODE root directly, avoiding any assumption about the exact TLD string ethers'
 * own namehash() would need.
 */
export function computeNode(label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([ETN_NODE, labelHash]));
}

/** Raw BaseRegistrarImplementation tokenId for a label — keccak256(label), not the full node. */
export function computeTokenId(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}
