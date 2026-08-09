import "dotenv/config";
import { ethers } from "ethers";
import { generateNftImage } from "../utils/imageGenerator.js";
import { uploadNftToR2, objectExistsInR2 } from "../utils/R2Upload.js";

// Retroactively generates + uploads NFT images for names that were registered/activated before
// image generation existed (or whose /api/generate-nft request never happened/failed) — anything
// on-chain today that isn't already sitting in R2 under its node's key.
//
// Usage:
//   node scripts/backfillNftImages.js              # generate + upload everything missing
//   node scripts/backfillNftImages.js --dry-run     # report what would happen, touch nothing
//   node scripts/backfillNftImages.js --force       # regenerate/overwrite even if already in R2
//   node scripts/backfillNftImages.js --only=alice.etn   # limit to one name, for a first test run

// Must point at the same chain/deployment as the frontend (see src/config.js) — otherwise this
// scans/derives nodes for names that don't exist on whatever chain it's actually pointed at.
const RPC_URL = process.env.RPC_URL || "https://rpc.ankr.com/electroneum";
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0x392fd031910e5D58650160f41a501ccc29B1eD13";
const MARKETPLACE_DEPLOY_BLOCK = process.env.MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(process.env.MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15207471;
const NAME_WRAPPER_ADDRESS = process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";
// namehash("etn") — same value as ETN_NODE in src/config.js, needed here to derive a node from
// an event's plain label (events don't carry the node itself for top-level registrations).
const ETN_NODE = "0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd";

// Minimal event-only ABI subset — this script only reads logs + two NameWrapper view calls, no
// need to pull in the frontend's full src/abis/*.json.
// indexed-ness must match src/abis/MarketplaceABI.json exactly — get it wrong and ethers
// computes the wrong topic/data split and silently fails to decode every log (args comes back
// undefined rather than throwing), which is what happened here on the first pass.
const MARKETPLACE_ABI = [
  "event NameRegistered(address indexed buyer, string label, uint256 basePrice, uint256 brokerageFee, address wrappedTo, uint16 fuses)",
  "event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid)",
  "event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, uint256 price, uint256 sellerAmount, uint256 burnAmount)",
];
const NAME_WRAPPER_ABI = [
  "function ownerOf(uint256 id) view returns (address owner)",
  "function names(bytes32 node) view returns (bytes)",
];

function computeNode(label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([ETN_NODE, labelHash]));
}

function computeSubnode(parentNode, label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([parentNode, labelHash]));
}

// Decodes a full DNS-wire-encoded name (all labels, not just the first) — e.g.
// "\x02hi\x05test6\x03etn\x00" -> "hi.test6.etn". Confirmed against a real subname on-chain
// (NameWrapper.names() stores the whole chain at every level, not just the owning label).
function decodeDnsName(hex) {
  const bytes = ethers.getBytes(hex);
  const labels = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i];
    if (len === 0) break;
    if (i + 1 + len > bytes.length) break; // malformed — bail rather than read out of bounds
    labels.push(ethers.toUtf8String(bytes.slice(i + 1, i + 1 + len)));
    i += 1 + len;
  }
  return labels.join(".");
}

// Same RPC block-range flakiness as src/hooks/useSubnameRegistration.js's queryLogsChunked —
// duplicated here rather than shared since this script intentionally doesn't depend on the
// frontend's src/ tree.
async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize = 1000, minChunkSize = 50) {
  const events = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      const chunk = await contract.queryFilter(filter, start, end);
      events.push(...chunk);
      start = end + 1;
    } catch (err) {
      const message = err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || "";
      const isRangeError = /block range/i.test(message) || /range is too large/i.test(message);
      if (isRangeError && chunkSize > minChunkSize) {
        chunkSize = Math.max(minChunkSize, Math.floor(chunkSize / 2));
        continue;
      }
      throw err;
    }
  }
  return events;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const onlyArg = args.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length).trim() : null;

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);

  const latestBlock = await provider.getBlockNumber();
  console.log(`Scanning blocks ${MARKETPLACE_DEPLOY_BLOCK} -> ${latestBlock} on ${RPC_URL}...`);

  const [registered, activated, subnamesRegistered] = await Promise.all([
    queryLogsChunked(marketplace, marketplace.filters.NameRegistered(), MARKETPLACE_DEPLOY_BLOCK, latestBlock),
    queryLogsChunked(marketplace, marketplace.filters.DomainActivated(), MARKETPLACE_DEPLOY_BLOCK, latestBlock),
    queryLogsChunked(marketplace, marketplace.filters.SubnameRegistered(), MARKETPLACE_DEPLOY_BLOCK, latestBlock),
  ]);

  // Dedupe by node — e.g. a name registered through this app also gets a DomainActivated event,
  // so it'd otherwise show up from both NameRegistered and DomainActivated. Template is "namespace"
  // (gold) for any top-level name, "default" (blue) for subnames — same split RegistrationFlow.jsx
  // / SubnameSearch.jsx use live.
  const candidates = new Map(); // node -> { template }
  for (const event of registered) {
    if (!event.args) { console.warn(`⚠️  Undecoded NameRegistered log at tx ${event.transactionHash}, skipping`); continue; }
    candidates.set(computeNode(event.args.label), { template: "namespace" });
  }
  for (const event of activated) {
    if (!event.args) { console.warn(`⚠️  Undecoded DomainActivated log at tx ${event.transactionHash}, skipping`); continue; }
    candidates.set(event.args.node, { template: "namespace" });
  }
  for (const event of subnamesRegistered) {
    if (!event.args) { console.warn(`⚠️  Undecoded SubnameRegistered log at tx ${event.transactionHash}, skipping`); continue; }
    const node = computeSubnode(event.args.parentNode, event.args.label);
    candidates.set(node, { template: "default" });
  }

  console.log(`Found ${candidates.size} distinct name(s) on-chain.`);

  let generated = 0, skipped = 0, failed = 0, notOwned = 0;

  for (const [node, { template }] of candidates) {
    let fullName;
    try {
      const [owner, dnsEncoded] = await Promise.all([
        nameWrapper.ownerOf(node),
        nameWrapper.names(node),
      ]);
      if (owner === ethers.ZeroAddress) {
        notOwned++;
        continue; // unwrapped (e.g. never-activated retro name) or otherwise ownerless — nothing to image yet
      }
      fullName = decodeDnsName(dnsEncoded);
      if (!fullName) {
        console.warn(`⚠️  ${node}: NameWrapper.names() returned nothing, skipping`);
        failed++;
        continue;
      }
    } catch (err) {
      console.warn(`⚠️  ${node}: failed to resolve owner/name (${err.message}), skipping`);
      failed++;
      continue;
    }

    if (only && fullName !== only) continue;

    const filename = `${node.replace(/^0x/, "")}.png`;

    if (!force) {
      let exists;
      try {
        exists = await objectExistsInR2(filename);
      } catch (err) {
        console.warn(`⚠️  ${fullName}: couldn't check R2 (${err.message}), skipping`);
        failed++;
        continue;
      }
      if (exists) {
        skipped++;
        continue;
      }
    }

    if (dryRun) {
      console.log(`[dry-run] would generate + upload ${fullName} (${filename}, ${template})`);
      generated++;
      continue;
    }

    try {
      const { buffer } = await generateNftImage(fullName, node, template);
      await uploadNftToR2(buffer, filename);
      console.log(`✅ ${fullName} -> ${filename}`);
      generated++;
    } catch (err) {
      console.error(`❌ ${fullName}: ${err.message}`);
      failed++;
    }
  }

  console.log(
    `\nDone. ${generated} generated${dryRun ? " (dry-run)" : ""}, ${skipped} already had an image, ` +
    `${notOwned} not wrapped/owned, ${failed} failed.`
  );
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
