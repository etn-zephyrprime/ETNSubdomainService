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

/** Child node one level below parentNode — same construction as computeNode, generalized. */
export function computeSubnode(parentNode, label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([parentNode, labelHash]));
}

/**
 * Decodes the first (leftmost) label out of a DNS-wire-encoded name, as returned by
 * NameWrapper.names(node) — e.g. "\x05alice\x03etn\x00" -> "alice". Same parsing the contract's
 * own _firstLabelMatches does in Solidity, just reading instead of comparing.
 */
export function decodeFirstLabel(dnsEncodedHex) {
  const bytes = ethers.getBytes(dnsEncodedHex);
  if (bytes.length < 1) return null;
  const len = bytes[0];
  if (bytes.length < 1 + len) return null;
  return ethers.toUtf8String(bytes.slice(1, 1 + len));
}
