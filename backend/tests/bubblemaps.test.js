import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBubblemap, findHubAddresses, hasNftTransfer } from "../services/bubblemaps/analysis.js";
import { bubblemapKnownContractTag, cursorQuery, isTokenCatalogFresh, splitTransfersAtBlock } from "../services/bubblemaps/worker.js";
import { ELECTROSWAP_LISTED_TOKENS, getElectroSwapTokensWithActiveLocks, hasActiveLiquidityLock } from "../utils/electroSwapTokens.js";

const address = (number) => `0x${number.toString(16).padStart(40, "0")}`;
const holder = (number, value = "100") => ({ address: address(number), value });
const baseInput = (holders, extra = {}) => ({
  token: address(999),
  holders,
  totalSupply: String(holders.length * 100),
  tokenPriceUsd: 1,
  coinPriceUsd: 10,
  decimals: 18,
  launch: { timestamp: "2025-01-01T00:00:00.000Z", blockNumber: 100 },
  addresses: new Map(),
  entities: new Map(),
  overrides: new Map(),
  tokenTransfers: [],
  etnTransfers: [],
  interactions: [],
  ...extra,
});
const config = {
  holdersTopN: 250,
  hubDegree: 25,
  minLinkValueUsd: 5,
  largeEtnUsd: 200,
  bundleBlocks: 3,
  launchWindowHours: 24,
  minTokenTransferShare: 0.1,
  clusterThreshold: 0.8,
  maxClusterHolderShare: 0.2,
  maxMapBytes: 100000,
  maxMapEdges: 300,
  edgeWeights: {
    SAME_FUNDER: 1,
    BUNDLED_BUY: 0.8,
    TOKEN_TRANSFER: 0.7,
    ETN_TRANSFER_REPEATED: 0.5,
    ETN_TRANSFER_SINGLE: 0.15,
    SHARED_COUNTERPARTY: 0.1,
  },
};

test("hub detection uses distinct counterparties and a strict greater-than threshold", () => {
  const counterparties = new Map([
    [address(1), [address(2), address(2), address(3)]],
    [address(4), [address(5), address(6), address(7)]],
  ]);
  assert.deepEqual(findHubAddresses(counterparties, 2), new Set([address(4)]));
});

test("token catalog freshness forces refresh for legacy state, expired syncs, or incomplete syncs", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const state = {
    catalog_key: "electroswap-listed-addresses",
    synced_at: new Date(now - 60 * 60 * 1000).toISOString(),
  };
  assert.equal(isTokenCatalogFresh(state, "electroswap-listed-addresses", now), true);
  assert.equal(isTokenCatalogFresh({ ...state, catalog_key: undefined }, "electroswap-listed-addresses", now), false);
  assert.equal(isTokenCatalogFresh({ ...state, started_at: "2026-01-01T11:00:00.000Z" }, "electroswap-listed-addresses", now), false);
  assert.equal(isTokenCatalogFresh({ ...state, synced_at: "2025-12-30T12:00:00.000Z" }, "electroswap-listed-addresses", now), false);
});

test("Bubblemaps includes only currently active or permanent liquidity locks", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  assert.equal(hasActiveLiquidityLock({ count: 1, permanentCount: 0, latestUnlockAt: "2026-01-02T00:00:00.000Z" }, now), true);
  assert.equal(hasActiveLiquidityLock({ count: 1, permanentCount: 1, latestUnlockAt: null }, now), true);
  assert.equal(hasActiveLiquidityLock({ count: 1, permanentCount: 0, latestUnlockAt: "2026-01-01T00:00:00.000Z" }, now), false);
  assert.equal(hasActiveLiquidityLock({ count: 0, permanentCount: 0, latestUnlockAt: null }, now), false);
  assert.equal(hasActiveLiquidityLock(null, now), false);
});

test("locked-liquidity catalog excludes listed tokens without a current lock", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const eligible = getElectroSwapTokensWithActiveLocks({
    [ELECTROSWAP_LISTED_TOKENS[0].address]: { count: 1, permanentCount: 0, latestUnlockAt: "2026-01-02T00:00:00.000Z" },
    [ELECTROSWAP_LISTED_TOKENS[3].address]: { count: 0, permanentCount: 0, latestUnlockAt: null },
  }, now);
  assert.deepEqual(eligible.map(({ symbol }) => symbol), ["BOLT"]);
});

test("NFT activity in an ETN transaction does not produce an ETN link", () => {
  const transaction = {
    token_transfers: [{ token_type: "ERC-721" }],
    value: "1000000000000000000",
  };
  assert.equal(hasNftTransfer(transaction), true);
  const result = analyzeBubblemap(baseInput([holder(1), holder(2)], {
    etnTransfers: [{ from: address(1), to: address(2), value: transaction.value, token_transfers: transaction.token_transfers }],
  }), config);
  assert.equal(result.edges.length, 0);
});

test("same-funder links are ignored when the funder is a hub", () => {
  const funder = address(50);
  const addresses = new Map([
    [funder, { degree: 26, degree_complete: true }],
    [address(1), { first_funder: funder }],
    [address(2), { first_funder: funder }],
  ]);
  const result = analyzeBubblemap(baseInput([holder(1), holder(2)], { addresses }), config);
  assert.equal(result.edges.length, 0);
});

test("bundled buys link first acquisitions within the configured block window", () => {
  const result = analyzeBubblemap(baseInput(Array.from({ length: 12 }, (_, index) => holder(index + 1)), {
    tokenTransfers: [
      { from: address(80), to: address(1), block_number: 101, timestamp: "2025-01-01T00:01:00Z", total: { value: "100000000000000000000" } },
      { from: address(80), to: address(2), block_number: 104, timestamp: "2025-01-01T00:02:00Z", total: { value: "100000000000000000000" } },
    ],
  }), config);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].strong, true);
  assert.equal(result.edges[0].reasons[0].type, "BUNDLED_BUY");
});

test("team wallets cannot join bundled-buy clusters", () => {
  const result = analyzeBubblemap(baseInput([holder(1), holder(2)], {
    entities: new Map([[address(1), { tag: "Team" }]]),
    tokenTransfers: [
      { from: address(80), to: address(1), block_number: 101, timestamp: "2025-01-01T00:01:00Z", total: { value: "100000000000000000000" } },
      { from: address(80), to: address(2), block_number: 102, timestamp: "2025-01-01T00:02:00Z", total: { value: "100000000000000000000" } },
    ],
  }), config);
  assert.equal(result.edges.length, 0);
  assert.equal(result.nodes.find((node) => node.address === address(1)).tags.includes("Team"), true);
});

test("yield farms and liquidity pools are excluded from holder analysis", () => {
  const farmTag = bubblemapKnownContractTag({ category: "farm", label: "ElectroSwap Yield Farms" });
  const lockerTag = bubblemapKnownContractTag({ category: "locker", label: "ElectroSwap Liquidity Locker" });
  const result = analyzeBubblemap(baseInput([holder(1), holder(2), holder(3), holder(4)], {
    entities: new Map([
      [address(1), { tag: farmTag, label: "ElectroSwap Yield Farms" }],
      [address(2), { tag: lockerTag, label: "ElectroSwap Liquidity Locker" }],
    ]),
    addresses: new Map([[address(3), { name: "ElectroSwap V2 Pair", is_contract: false }]]),
  }), config);

  assert.equal(result.nodes.find((node) => node.address === address(1)).exclusion_reason, "Yield farm");
  assert.equal(result.nodes.find((node) => node.address === address(2)).exclusion_reason, "Liquidity pool");
  assert.equal(result.nodes.find((node) => node.address === address(3)).exclusion_reason, "Liquidity pool");
  assert.equal(result.calibration.holders_considered, 1);
  assert.equal(result.supply_considered, "100");
});

test("holder supply shares retain precision for proportional bubble sizing", () => {
  const result = analyzeBubblemap(baseInput([holder(1, "1"), holder(2, "9")], { totalSupply: "10000" }), config);
  const first = result.nodes.find((node) => node.address === address(1));
  const second = result.nodes.find((node) => node.address === address(2));

  assert.equal(first.pct, 0);
  assert.equal(second.pct, 0.1);
  assert.ok(Math.abs(first.supply_share - 0.0001) < 1e-12);
  assert.ok(Math.abs(second.supply_share - 0.0009) < 1e-12);
});

test("dust acquisitions do not create bundled-buy links", () => {
  const result = analyzeBubblemap(baseInput([holder(1), holder(2)], {
    tokenTransfers: [
      { from: address(80), to: address(1), block_number: 101, timestamp: "2025-01-01T00:01:00Z", total: { value: "1000000000000000000" } },
      { from: address(80), to: address(2), block_number: 102, timestamp: "2025-01-01T00:02:00Z", total: { value: "1000000000000000000" } },
    ],
  }), config);
  assert.equal(result.edges.length, 0);
});

test("bidirectional repeated ETN links keep the configured edge weight", () => {
  const result = analyzeBubblemap(baseInput(Array.from({ length: 10 }, (_, index) => holder(index + 1)), {
    etnTransfers: [
      { from: address(1), to: address(2), value: "1000000000000000000" },
      { from: address(1), to: address(2), value: "1000000000000000000" },
      { from: address(2), to: address(1), value: "1000000000000000000" },
    ],
  }), config);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].score, 0.5);
  assert.equal(result.edges[0].strong, false);
});

test("giant-cluster guard raises the threshold and breaks an oversized same-funder cluster", () => {
  const funder = address(50);
  const holders = Array.from({ length: 8 }, (_, index) => holder(index + 1));
  const addresses = new Map([[funder, { degree: 1, degree_complete: true }]]);
  for (const item of holders.slice(0, 4)) addresses.set(item.address, { first_funder: funder });
  const result = analyzeBubblemap(baseInput(holders, { addresses }), config);
  assert.equal(result.calibration.giant_cluster_guard_raised, 2);
  assert.equal(result.calibration.largest_cluster_holder_share_pct, 12.5);
  assert.equal(result.calibration.cluster_count, 8);
});

test("NFT trades and small social tips leave only the four-wallet same-funder cluster", () => {
  const holders = Array.from({ length: 44 }, (_, index) => holder(index + 1));
  const funder = address(50);
  const addresses = new Map([[funder, { degree: 1, degree_complete: true }]]);
  for (const item of holders.slice(0, 4)) addresses.set(item.address, { first_funder: funder });
  const result = analyzeBubblemap(baseInput(holders, {
    addresses,
    etnTransfers: holders.slice(4).map((item, index) => ({
      from: item.address,
      to: holders[4 + ((index + 1) % 40)].address,
      value: "1000000000000000000",
    })),
    interactions: holders.slice(4).map((item, index) => ({
      from: item.address,
      to: holders[4 + ((index + 1) % 40)].address,
      value: "1000000000000000000",
      kind: "etn",
      coin_price_usd: 10,
      has_nft: true,
    })),
  }), config);
  const linkedClusters = result.clusters.filter((cluster) => cluster.members > 1);
  assert.equal(linkedClusters.length, 1);
  assert.equal(linkedClusters[0].members, 4);
  assert.equal(result.clusters.length, 41);
});

test("score uses cluster HHI and applies only the stated penalties", () => {
  const result = analyzeBubblemap(baseInput([holder(1), holder(2), holder(3), holder(4)]), config);
  assert.equal(result.score, 75);
  assert.equal(result.band, "Widely spread");
  assert.deepEqual(result.score_parts, {
    largest_cluster_pct: 25,
    bundled_pct: 0,
    team_pct: 0,
  });
});

test("no eligible holders returns an unavailable score rather than a zero-concentration score", () => {
  const result = analyzeBubblemap(baseInput([
    { address: { hash: address(1), is_contract: true }, value: "100" },
  ], { totalSupply: "100" }), config);
  assert.equal(result.score, null);
  assert.equal(result.supply_considered, "0");
});

test("Blockscout cursors retain their endpoint-provided fields", () => {
  const query = cursorQuery({ name: "Sneeze Token", fiat_value: null, holders_count: 9, is_name_null: false });
  assert.match(query, /name=Sneeze\+Token/);
  assert.match(query, /fiat_value=null/);
  assert.match(query, /is_name_null=false/);
});

test("incremental transfer paging stops at the first previously processed block", () => {
  const page = [
    { block_number: 102 },
    { block_number: 101 },
    { block_number: 100 },
    { block_number: 99 },
  ];
  assert.deepEqual(splitTransfersAtBlock(page, 100), {
    newItems: page.slice(0, 2),
    reachedPreviouslyProcessed: true,
  });
  assert.deepEqual(splitTransfersAtBlock(page.slice(0, 2), 100), {
    newItems: page.slice(0, 2),
    reachedPreviouslyProcessed: false,
  });
});
