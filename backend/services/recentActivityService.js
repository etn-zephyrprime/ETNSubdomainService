// backend/services/recentActivityService.js
//
// Core Tier's "Recent Activity" feed — a chronological, filterable glance at what's actually
// happened in a wallet lately (ETN moved, tokens sent/received/swapped, NFTs traded, liquidity
// added/removed, yield-farm/staking events), as opposed to the cost-basis/valuation views every
// other Core Tier panel already provides. Reads the SAME already-ingested data those panels use
// (ingested_transfers/swap_trades/defi_activity) — this never triggers ingestion itself, it relies
// on CoreTierPortfolio.jsx's own /premium/pnl-snapshot call (rendered earlier on the page) having
// already kicked it off, exactly the same assumption CoreTierNftPnl.jsx's panel already makes.
//
// CATEGORIZATION — confirmed against pnlIngestion.js's own synthetic-row conventions, not guessed:
//  - native: asset_type = 'native' (excludes the pure gas-fee marker row, which carries
//    amount_decimal = 0 and exists only to record gasFeeWei — see ingestTransactionsGasAndSwaps'
//    own `logIndex: -1` row; a real native transfer always has amount_decimal > 0).
//  - nft: asset_type IN ('erc721', 'erc1155').
//  - liquidity: asset_type = 'erc20' AND log_index <= -2000 — pnlIngestion.js decomposes both V2
//    LP mint/burn (logIndex -(2000+n)) and V3 position mint/increase/decrease/collect
//    (logIndex -(4000+n) and beyond) into synthetic erc20-shaped rows reusing this exact table; a
//    genuine plain transfer or swap leg always keeps its own real on-chain log_index (>= 0), so
//    this threshold cleanly separates the two without needing a pool-address registry lookup.
//  - tokens: every other asset_type = 'erc20' row, PLUS every swap_trades row (a swap always
//    involves at least one token leg — there's no "ETN swapped for ETN" case — so bucketing every
//    swap under Tokens rather than splitting it is the one choice that's always representative).
//  - farm: every defi_activity row (farm_deposit/farm_withdraw/core_staked/core_withdrawn/
//    reward_paid) — yield farm and staking activity, kept as its own category per the request this
//    was built for rather than folded into "tokens".
//
// LIQUIDITY GROUPING: a single real add/remove produces 2-3 ingested_transfers rows (V2: 2
// underlying legs + 1 LP-token leg; V3: up to 5 across increase/decrease/collect legs) that would
// otherwise show as several confusing near-duplicate feed entries for one real action. Grouped by
// tx_hash into one item instead. The LP/position "lot" leg within a group is identified two ways,
// both confirmed directly from pnlIngestion.js's own row-construction code, not inferred:
//   - V2: its token_address IS its own counterparty_address (the pool contract IS the LP token
//     contract in a V2 AMM) — the underlying legs' token_address is a real token, never equal to
//     their own counterparty (the pool).
//   - V3: its token_address is the synthetic "<positionManagerAddress>:<tokenId>" key
//     (v3PositionAssetKey in pnlIngestion.js), which always contains a ':' — a real token address
//     never does.
// That lot leg's own `direction` ("in" = minted/increased = Added, "out" = burned/decreased =
// Removed) is authoritative; a group with NO lot leg at all (a V3 collect-only tx, just claiming
// accrued fees with no liquidity change) is labeled "Collected Fees" instead — collect always
// nets tokens INTO the wallet, so this case is always "in".
import { getAllTransfersBefore } from "../db/ingestedTransfers.js";
import { getAllSwapTradesBefore } from "../db/swapTrades.js";
import { getAllDefiActivityBefore } from "../db/defiActivity.js";

const LP_LOG_INDEX_CEILING = -2000;

const FARM_EVENT_LABELS = {
  farm_deposit: "Farm Deposit",
  farm_withdraw: "Farm Withdraw",
  core_staked: "Staked",
  core_withdrawn: "Unstaked",
  reward_paid: "Reward Claimed",
};
// Deposit/stake locks real tokens away from the wallet (shown like an outflow); withdraw/unstake
// and a reward both bring something back to the wallet (shown like an inflow) — same "what
// actually left or returned to this wallet" convention the rest of this feed uses for direction.
const FARM_EVENT_DIRECTIONS = {
  farm_deposit: "out",
  core_staked: "out",
  farm_withdraw: "in",
  core_withdrawn: "in",
  reward_paid: "in",
};

function isPureGasMarkerRow(row) {
  return row.asset_type === "native" && Number(row.amount_decimal) === 0;
}

function categorizeTransferRow(row) {
  if (row.asset_type === "native") return "native";
  if (row.asset_type === "erc721" || row.asset_type === "erc1155") return "nft";
  if (row.asset_type === "erc20") return Number(row.log_index) <= LP_LOG_INDEX_CEILING ? "liquidity" : "tokens";
  return "tokens"; // defensive — every real asset_type is covered above
}

function isPositionLotLeg(row) {
  return row.token_address === row.counterparty_address || (typeof row.token_address === "string" && row.token_address.includes(":"));
}

function summarizeLiquidityGroup(txHash, legs) {
  const lotLeg = legs.find(isPositionLotLeg);
  const underlyingLegs = legs.filter((l) => !isPositionLotLeg(l));
  const tokenAddresses = [...new Set(underlyingLegs.map((l) => l.token_address).filter(Boolean))];
  const usdTotal = underlyingLegs.reduce((sum, l) => sum + (l.usd_value != null ? Number(l.usd_value) : 0), 0);
  const direction = lotLeg ? lotLeg.direction : "in";
  const label = !lotLeg ? "Collected Fees" : direction === "in" ? "Added Liquidity" : "Removed Liquidity";
  const timestamp = legs[0].timestamp;
  const blockNumber = legs[0].block_number;
  return {
    id: `lp:${txHash}`,
    category: "liquidity",
    kind: "liquidity",
    label,
    direction,
    txHash,
    tokenAddresses,
    usdValue: underlyingLegs.some((l) => l.usd_value == null) ? null : usdTotal,
    timestamp,
    blockNumber,
  };
}

/** Every recent activity item for ONE wallet, newest first, capped to `limit` (a transport-size
 * safeguard, not a real pagination boundary — the frontend filters/paginates within whatever this
 * returns). Never triggers ingestion — see this file's own header comment. */
export async function getRecentActivity(trackedWallet, asOf = new Date(), limit = 300) {
  const [transfers, swaps, defiActivity] = await Promise.all([
    getAllTransfersBefore(trackedWallet, asOf),
    getAllSwapTradesBefore(trackedWallet, asOf),
    getAllDefiActivityBefore(trackedWallet, asOf),
  ]);

  const items = [];
  const liquidityGroups = new Map(); // txHash -> raw legs, combined into one item after the loop

  for (const row of transfers) {
    if (isPureGasMarkerRow(row)) continue;
    const category = categorizeTransferRow(row);
    if (category === "liquidity") {
      const legs = liquidityGroups.get(row.tx_hash) || [];
      legs.push(row);
      liquidityGroups.set(row.tx_hash, legs);
      continue;
    }
    items.push({
      id: `t:${row.tx_hash}:${row.log_index}`,
      category,
      kind: "transfer",
      direction: row.direction,
      txHash: row.tx_hash,
      counterpartyAddress: row.counterparty_address,
      isSelfTransfer: row.is_self_transfer,
      isCex: row.is_cex,
      tokenAddress: row.token_address,
      tokenId: row.token_id,
      amount: row.amount_decimal,
      usdValue: row.usd_value != null ? Number(row.usd_value) : null,
      timestamp: row.timestamp,
      blockNumber: row.block_number,
    });
  }

  for (const row of swaps) {
    const usdValue =
      row.price_usd_bought_leg != null
        ? Number(row.price_usd_bought_leg) * Number(row.amount_bought)
        : row.price_usd_sold_leg != null
        ? Number(row.price_usd_sold_leg) * Number(row.amount_sold)
        : null;
    items.push({
      id: `s:${row.tx_hash}:${row.log_index}`,
      category: "tokens",
      kind: "swap",
      txHash: row.tx_hash,
      soldTokenAddress: row.token_sold_address,
      soldAmount: row.amount_sold,
      boughtTokenAddress: row.token_bought_address,
      boughtAmount: row.amount_bought,
      usdValue,
      timestamp: row.timestamp,
      blockNumber: row.block_number,
    });
  }

  for (const row of defiActivity) {
    items.push({
      id: `d:${row.tx_hash}:${row.log_index}`,
      category: "farm",
      kind: "defi",
      eventType: row.event_type,
      label: FARM_EVENT_LABELS[row.event_type] || row.event_type,
      direction: FARM_EVENT_DIRECTIONS[row.event_type] || "out",
      txHash: row.tx_hash,
      contractAddress: row.contract_address,
      farmId: row.farm_id,
      timestamp: row.timestamp,
      blockNumber: row.block_number,
    });
  }

  for (const [txHash, legs] of liquidityGroups) {
    items.push(summarizeLiquidityGroup(txHash, legs));
  }

  items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return items.slice(0, limit);
}
