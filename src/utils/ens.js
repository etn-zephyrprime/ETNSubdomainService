import { ethers } from "ethers";
import { ETN_NODE, R2_PUBLIC_URL } from "../config.js";

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
 * Computes the node for an arbitrary dotted name — "alice", "alice.etn", or a subname like
 * "shop.alice"/"shop.alice.etn" — by folding labels onto ETN_NODE right-to-left, same algorithm
 * as computeNode/computeSubnode above just generalized to any depth (the Pay flow needs to
 * resolve names that may be top-level or a subname, unlike the callers of computeNode/
 * computeSubnode, which each already know which one they have). Returns null for empty input.
 */
export function computeNodeForName(fullName) {
  let name = fullName.trim().toLowerCase();
  if (name.endsWith(".etn")) name = name.slice(0, -".etn".length);
  const labels = name.split(".").filter(Boolean);
  if (labels.length === 0) return null;

  let node = ETN_NODE;
  for (let i = labels.length - 1; i >= 0; i--) {
    node = computeSubnode(node, labels[i]);
  }
  return node;
}

/**
 * Public URL of a name's generated NFT image, if one has been generated — backend/utils/
 * imageGenerator.js uploads to R2 under exactly this key (the node, 0x-stripped, + ".png"),
 * the same node passed to NameWrapper.ownerOf/safeTransferFrom elsewhere in this app. Not every
 * name has one: image generation only happens as part of registering through this app (see
 * RegistrationFlow.jsx / SubnameSearch.jsx), so a name registered directly through Electroneum,
 * or one whose generation request failed/was skipped, will 404 here.
 */
export function computeNftImageUrl(node) {
  return `${R2_PUBLIC_URL}/${node.replace(/^0x/, "")}.png`;
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
