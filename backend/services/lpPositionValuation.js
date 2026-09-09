// backend/services/lpPositionValuation.js
//
// Live USD value of a wallet's directly-held liquidity positions — V2 LP pool tokens (valued via
// the pool's own live reserves) and V3 concentrated-liquidity positions (valued via the standard
// Uniswap V3 "amount from liquidity" math, ported and verified here since nothing in this codebase
// computed it generally before now — defiPositionValuation.js's own YieldFarm valuation uses a
// SIMPLIFIED version of this same formula that only holds for a full-range position (see that
// file's own header comment); a V3 NonfungiblePositionManager position can have an arbitrary
// range, so the simplification doesn't apply here and the exact formula is used instead.
//
// Deliberately separate from defiPositionValuation.js: that file values positions LOCKED in a
// farm/staking contract (discovered via defi_activity, a position the wallet doesn't directly
// hold); this values LP/V3 tokens the wallet holds DIRECTLY in its own balance — no overlap, no
// double-counting between the two.
//
// TickMath.getSqrtRatioAtTick below is a hand-ported, hand-verified copy of Uniswap v3-core's own
// TickMath.sol (the exact same magic-constant bit-shift algorithm every V3 fork uses) — verified
// against real live pool state before this shipped: fed a real pool's own current tick back into
// this implementation and confirmed it reproduces that pool's own live sqrtPriceX96 to within
// 0.004% (the tiny remaining gap is expected — a live price floats within a tick's range, it
// doesn't sit exactly on the tick's own lower boundary), cross-checked reciprocal symmetry
// (sqrtRatio(tick) * sqrtRatio(-tick) ~= Q96) and monotonicity across a range spanning zero, and
// validated the full amount0/amount1 pipeline end-to-end against a real, large open position: the
// computed amounts came out to exactly the position's proportional share of the pool's own total
// token balances (94.12% for both token0 and token1, matching to 4 decimal places) — not assumed.
//
// PRICING IS DEDUPLICATED — confirmed live this matters, not just theoretical: a first version that
// priced each position's own legs independently hit BOTH ethers' "batch size too large" RPC error
// (Ankr rejected a request with too many calls batched together — same failure mode
// defiPositionValuation.js's own getProvider() already works around via batchMaxCount:1, applied
// here too) AND GeckoTerminal's rate limit (a wallet holding many positions in the SAME pool — a
// perfectly normal thing to do — was re-resolving that SAME token pair's price once per position
// instead of once total). resolvePriceMap below prices every DISTINCT token address exactly once
// per call, however many positions reference it.
import { ethers } from "ethers";
import Decimal from "decimal.js";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { fetchBlockscoutJson } from "../utils/blockscoutClient.js";
import { getTokenEtnPrice } from "../utils/dexPriceQuote.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { getTokenMetadata, POSITION_MANAGER_ADDRESS } from "./pnlIngestion.js";

const V3_FACTORY_ADDRESS = "0xbf6bcbe2be545135391777f3b4698be92e2eb8ca";
// Same wrapped-ETN address dexPriceQuote.js/pnlPricing.js both already use — ETN/WETN are 1:1
// pegged. getTokenEtnPrice(WETN) is a structurally pointless lookup (it looks for a pool pairing
// WETN against ITSELF, which can't exist) that still costs a real GeckoTerminal round-trip before
// coming back null — resolvePriceMap below substitutes the direct ETN/USD rate for this address
// instead of ever calling it.
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const Q96 = 2n ** 96n;
const MAX_TICK = 887272n;

let sharedProvider = null;
function getProvider() {
  // batchMaxCount:1 — see this file's own header comment on the real "batch size too large" RPC
  // error this avoids when valuing many positions at once (same fix defiPositionValuation.js's own
  // getProvider() already applies, for the same reason).
  if (!sharedProvider) sharedProvider = createRpcProvider({ batchMaxCount: 1 });
  return sharedProvider;
}

/** Prices every DISTINCT address in `tokenAddresses` exactly once (deduplicated — see this file's
 * own header comment on why), returning a Map of lowercased address -> USD price | null. WETN is
 * special-cased to the direct ETN/USD rate rather than routed through getTokenEtnPrice (see
 * WETN_ADDRESS's own comment). */
async function resolvePriceMap(tokenAddresses) {
  const distinct = [...new Set(tokenAddresses.map((a) => a.toLowerCase()))];
  const priceMap = new Map();
  const etnUsdCache = await getEtnPriceCache();
  const etnUsd = etnUsdCache?.usd;
  const haveEtnUsd = Number.isFinite(etnUsd) && etnUsd > 0;

  await Promise.all(
    distinct.map(async (address) => {
      if (address === WETN_ADDRESS) {
        priceMap.set(address, haveEtnUsd ? etnUsd : null);
        return;
      }
      try {
        const etnPrice = await getTokenEtnPrice(getProvider(), address);
        priceMap.set(address, etnPrice != null && haveEtnUsd ? etnPrice * etnUsd : null);
      } catch (err) {
        console.warn(`⚠️  LP position valuation: could not price ${address}:`, err.message);
        priceMap.set(address, null);
      }
    })
  );
  return priceMap;
}

const decimalsCache = new Map(); // address (lowercase) -> number
async function decimalsFor(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  let decimals = 18;
  try {
    const token = new ethers.Contract(tokenAddress, ["function decimals() view returns (uint8)"], getProvider());
    decimals = Number(await token.decimals());
  } catch {
    // same fallback convention as the rest of this app's token-amount formatting
  }
  decimalsCache.set(key, decimals);
  return decimals;
}

// ---------------------------------------------------------------------------------------------
// V2 LP — probe a candidate address for the standard UniswapV2Pair interface (token0/token1/
// getReserves/totalSupply); if all four succeed, it's a real pool. A pool's IDENTITY (token0/
// token1) never changes post-deploy, so a CONFIRMED positive is cached indefinitely. A negative
// (any call reverts/fails) is deliberately NOT cached — same reasoning as
// defiPositionValuation.js's own getFarmMeta: this app has no reliable way here to tell "this
// genuinely isn't a pool" apart from "that was a transient RPC hiccup," and caching the latter as
// a permanent negative would silently and permanently hide a real LP token's value. Re-probing a
// genuinely-non-pool token costs a few RPC calls, bounded by how many distinct tokens a wallet
// holds — not a hot path.
const v2PoolCache = new Map(); // address (lowercase) -> { token0, token1 } (only ever set on success)
const V2_PAIR_IFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
]);
async function probeV2Pool(address) {
  const key = address.toLowerCase();
  if (v2PoolCache.has(key)) return v2PoolCache.get(key);
  try {
    const pair = new ethers.Contract(address, V2_PAIR_IFACE, getProvider());
    const [token0, token1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
    if (reserves.reserve0 === 0n && reserves.reserve1 === 0n) return null; // technically a pair, but nothing in it to value
    const meta = { token0: token0.toLowerCase(), token1: token1.toLowerCase() };
    v2PoolCache.set(key, meta);
    return meta;
  } catch {
    return null; // not a V2 pair (or a transient failure) — either way, nothing cached
  }
}

/** Resolves everything about one candidate held token EXCEPT its legs' USD price (that's filled in
 * afterward from the shared, deduplicated priceMap — see resolvePriceMap) — reserves/wallet-share/
 * amounts, which is safe to do per-candidate since it's all pure on-chain reads, none of it hits
 * GeckoTerminal or gets batched into the "too many calls" failure mode pricing did. Returns null if
 * this address isn't confirmed to be a real ElectroSwap V2 pair. */
async function resolveV2LpCandidate(tokenAddress, rawBalance, decimals) {
  const meta = await probeV2Pool(tokenAddress);
  if (!meta) return null;

  const pair = new ethers.Contract(tokenAddress, V2_PAIR_IFACE, getProvider());
  const [reserves, totalSupply] = await Promise.all([pair.getReserves(), pair.totalSupply()]);
  if (totalSupply === 0n) return null;

  const walletBalance = new Decimal(ethers.formatUnits(rawBalance, decimals));
  const totalSupplyDec = new Decimal(ethers.formatUnits(totalSupply, decimals));
  if (walletBalance.lte(0)) return null;
  const share = walletBalance.div(totalSupplyDec);

  const [decimals0, decimals1] = await Promise.all([decimalsFor(meta.token0), decimalsFor(meta.token1)]);
  const amount0 = share.times(new Decimal(ethers.formatUnits(reserves.reserve0, decimals0)));
  const amount1 = share.times(new Decimal(ethers.formatUnits(reserves.reserve1, decimals1)));

  return { tokenAddress: tokenAddress.toLowerCase(), quantity: walletBalance.toString(), token0: meta.token0, token1: meta.token1, amount0, amount1 };
}

/** Turns a resolveV2LpCandidate result into the final priced row, using the shared priceMap. */
async function finalizeV2LpPosition(candidate, priceMap) {
  const [meta0, meta1] = await Promise.all([getTokenMetadata(candidate.token0), getTokenMetadata(candidate.token1)]);
  const price0 = priceMap.get(candidate.token0) ?? null;
  const price1 = priceMap.get(candidate.token1) ?? null;
  const usd0 = price0 != null ? candidate.amount0.times(price0) : null;
  const usd1 = price1 != null ? candidate.amount1.times(price1) : null;

  return {
    kind: "v2_lp",
    tokenAddress: candidate.tokenAddress,
    quantity: candidate.quantity,
    legs: [
      { tokenAddress: candidate.token0, symbol: meta0?.symbol || null, amount: candidate.amount0.toString(), usdValue: usd0?.toString() ?? null },
      { tokenAddress: candidate.token1, symbol: meta1?.symbol || null, amount: candidate.amount1.toString(), usdValue: usd1?.toString() ?? null },
    ],
    totalUsd: usd0 != null && usd1 != null ? usd0.plus(usd1).toString() : null,
    hasUnpriced: usd0 == null || usd1 == null,
  };
}

// ---------------------------------------------------------------------------------------------
// V3 — TickMath.getSqrtRatioAtTick, hand-ported from Uniswap v3-core (see this file's own header
// comment for how this was verified against real live data before shipping).
function getSqrtRatioAtTick(tick) {
  tick = BigInt(tick);
  const absTick = tick < 0n ? -tick : tick;
  if (absTick > MAX_TICK) throw new Error("tick out of range");
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0n) ratio = (2n ** 256n - 1n) / ratio;
  const shifted = ratio >> 32n;
  return ratio % (1n << 32n) === 0n ? shifted : shifted + 1n;
}

// Standard Uniswap v3-periphery LiquidityAmounts.sol formulas — native BigInt has arbitrary
// precision, so unlike the Solidity original this needs no FullMath 512-bit-overflow trick.
function getAmount0ForLiquidity(sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (liquidity << 96n) * (sqrtB - sqrtA) / sqrtB / sqrtA;
}
function getAmount1ForLiquidity(sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return liquidity * (sqrtB - sqrtA) / Q96;
}
function getAmountsForLiquidity(sqrtCurrent, sqrtLower, sqrtUpper, liquidity) {
  if (sqrtLower > sqrtUpper) [sqrtLower, sqrtUpper] = [sqrtUpper, sqrtLower];
  if (sqrtCurrent <= sqrtLower) return { amount0: getAmount0ForLiquidity(sqrtLower, sqrtUpper, liquidity), amount1: 0n };
  if (sqrtCurrent < sqrtUpper) {
    return {
      amount0: getAmount0ForLiquidity(sqrtCurrent, sqrtUpper, liquidity),
      amount1: getAmount1ForLiquidity(sqrtLower, sqrtCurrent, liquidity),
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(sqrtLower, sqrtUpper, liquidity) };
}

const V3_POSITIONS_IFACE = new ethers.Interface([
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
const V3_POOL_IFACE = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);
const V3_FACTORY_IFACE = new ethers.Interface(["function getPool(address,address,uint24) view returns (address)"]);

const v3PoolAddressCache = new Map(); // "token0:token1:fee" -> address | null — a pool's own address for a given pair+fee never changes
async function getV3PoolAddress(token0, token1, fee) {
  const key = `${token0}:${token1}:${fee}`;
  if (v3PoolAddressCache.has(key)) return v3PoolAddressCache.get(key);
  let result = null;
  try {
    const factory = new ethers.Contract(V3_FACTORY_ADDRESS, V3_FACTORY_IFACE, getProvider());
    const pool = await factory.getPool(token0, token1, fee);
    if (pool && pool !== ethers.ZeroAddress) result = pool.toLowerCase();
  } catch {
    // left null — caller skips this position rather than guessing
  }
  v3PoolAddressCache.set(key, result);
  return result;
}

/** Every V3 position tokenId `walletAddress` currently owns, via Blockscout's per-holder NFT
 * instance listing scoped to the position manager contract — confirmed live (not assumed) this
 * endpoint returns each instance's own `id` (tokenId) and `token.address` (the collection), paged
 * the same keyset way every other Blockscout v2 listing in this app is. A wallet holding zero V3
 * positions (the overwhelmingly common case) costs exactly one page fetch that comes back empty. */
async function getHeldV3TokenIds(walletAddress) {
  const tokenIds = [];
  let cursorQuery = "";
  for (;;) {
    const json = await fetchBlockscoutJson(
      `/addresses/${walletAddress}/nft?type=ERC-721&token_contract_address_hash=${POSITION_MANAGER_ADDRESS}${cursorQuery}`
    );
    for (const item of json.items || []) {
      if (String(item.token?.address).toLowerCase() === POSITION_MANAGER_ADDRESS) tokenIds.push(item.id);
    }
    if (!json.next_page_params) break;
    cursorQuery = "&" + new URLSearchParams(json.next_page_params).toString();
  }
  return tokenIds;
}

/** Resolves everything about one V3 position EXCEPT its legs' USD price (see
 * resolveV2LpCandidate's own comment on why this split exists) — position/pool state and the
 * amount0/amount1 math, all pure on-chain reads. Returns null if fully withdrawn or any read
 * fails. Never throws — a single bad position shouldn't blank the rest of a wallet's valuation. */
async function resolveV3Candidate(tokenId) {
  try {
    const npm = new ethers.Contract(POSITION_MANAGER_ADDRESS, V3_POSITIONS_IFACE, getProvider());
    const pos = await npm.positions(tokenId);
    if (pos.liquidity === 0n) return null; // fully withdrawn, nothing left to value

    const token0 = pos.token0.toLowerCase();
    const token1 = pos.token1.toLowerCase();
    const poolAddr = await getV3PoolAddress(token0, token1, Number(pos.fee));
    if (!poolAddr) return null;

    const pool = new ethers.Contract(poolAddr, V3_POOL_IFACE, getProvider());
    const slot0 = await pool.slot0();
    if (slot0.sqrtPriceX96 === 0n) return null; // uninitialized pool

    const sqrtLower = getSqrtRatioAtTick(pos.tickLower);
    const sqrtUpper = getSqrtRatioAtTick(pos.tickUpper);
    const { amount0, amount1 } = getAmountsForLiquidity(BigInt(slot0.sqrtPriceX96), sqrtLower, sqrtUpper, pos.liquidity);

    const [decimals0, decimals1] = await Promise.all([decimalsFor(token0), decimalsFor(token1)]);
    const amt0 = new Decimal(ethers.formatUnits(amount0, decimals0));
    const amt1 = new Decimal(ethers.formatUnits(amount1, decimals1));
    const inRange = Number(pos.tickLower) <= Number(slot0.tick) && Number(slot0.tick) < Number(pos.tickUpper);

    return { tokenId: String(tokenId), token0, token1, amount0: amt0, amount1: amt1, inRange };
  } catch (err) {
    console.warn(`⚠️  LP position valuation: failed for V3 position #${tokenId}:`, err.message);
    return null;
  }
}

/** Turns a resolveV3Candidate result into the final priced row, using the shared priceMap. */
async function finalizeV3Position(candidate, priceMap) {
  const [meta0, meta1] = await Promise.all([getTokenMetadata(candidate.token0), getTokenMetadata(candidate.token1)]);
  const price0 = priceMap.get(candidate.token0) ?? null;
  const price1 = priceMap.get(candidate.token1) ?? null;
  const usd0 = price0 != null ? candidate.amount0.times(price0) : null;
  const usd1 = price1 != null ? candidate.amount1.times(price1) : null;

  return {
    kind: "v3_position",
    tokenId: candidate.tokenId,
    inRange: candidate.inRange,
    legs: [
      { tokenAddress: candidate.token0, symbol: meta0?.symbol || null, amount: candidate.amount0.toString(), usdValue: usd0?.toString() ?? null },
      { tokenAddress: candidate.token1, symbol: meta1?.symbol || null, amount: candidate.amount1.toString(), usdValue: usd1?.toString() ?? null },
    ],
    totalUsd: usd0 != null && usd1 != null ? usd0.plus(usd1).toString() : null,
    hasUnpriced: usd0 == null || usd1 == null,
  };
}

/**
 * Live USD value of every liquidity position `walletAddress` directly holds — V2 LP pool tokens
 * (checked against `heldFungibleTokens`, the wallet's own regular token-balance list, same shape
 * as portfolioValuation.js's own token list: `[{ address, decimals, rawBalance }]`) and V3
 * concentrated-liquidity positions (discovered live via Blockscout, see getHeldV3TokenIds).
 *
 * Every candidate's on-chain state is resolved FIRST, then every distinct underlying token across
 * ALL of them is priced exactly ONCE (see resolvePriceMap and this file's own header comment on
 * why that split exists), then results are assembled — so a wallet with many positions sharing the
 * same pool/tokens pays for that pricing once, not once per position.
 *
 * Returns `{ v2Positions, v3Positions, totalUsd, hasUnpriced, lpTokenAddresses }` —
 * `lpTokenAddresses` is the lowercased Set of `heldFungibleTokens` addresses CONFIRMED to be real
 * V2 pools, so a caller building a "regular tokens" list can exclude them (a pool token has no
 * price feed of its own — so leaving it in a generic token list would just show it unpriced, which
 * is worse than this dedicated valuation). Never throws — one bad position/probe is skipped, not
 * fatal to the rest.
 */
export async function getLiquidityPositionsUsd(walletAddress, heldFungibleTokens = []) {
  const [v2Candidates, v3TokenIds] = await Promise.all([
    Promise.all(
      heldFungibleTokens.map((t) => resolveV2LpCandidate(t.address, BigInt(t.rawBalance), t.decimals ?? 18).catch(() => null))
    ),
    getHeldV3TokenIds(walletAddress).catch((err) => {
      console.warn(`⚠️  LP position valuation: could not list V3 positions for ${walletAddress}:`, err.message);
      return [];
    }),
  ]);
  const v2CandidatesResolved = v2Candidates.filter((c) => c != null);
  const v3Candidates = (await Promise.all(v3TokenIds.map((id) => resolveV3Candidate(id)))).filter((c) => c != null);

  if (v2CandidatesResolved.length === 0 && v3Candidates.length === 0) {
    return { v2Positions: [], v3Positions: [], totalUsd: null, hasUnpriced: false, lpTokenAddresses: new Set() };
  }

  const priceMap = await resolvePriceMap([
    ...v2CandidatesResolved.flatMap((c) => [c.token0, c.token1]),
    ...v3Candidates.flatMap((c) => [c.token0, c.token1]),
  ]);

  const v2Positions = await Promise.all(v2CandidatesResolved.map((c) => finalizeV2LpPosition(c, priceMap)));
  const v3Positions = await Promise.all(v3Candidates.map((c) => finalizeV3Position(c, priceMap)));

  let totalUsd = null;
  let hasUnpriced = false;
  for (const p of [...v2Positions, ...v3Positions]) {
    if (p.hasUnpriced) hasUnpriced = true;
    if (p.totalUsd != null) totalUsd = (totalUsd ?? new Decimal(0)).plus(p.totalUsd);
  }

  return {
    v2Positions,
    v3Positions,
    totalUsd: totalUsd?.toString() ?? null,
    hasUnpriced,
    lpTokenAddresses: new Set(v2Positions.map((p) => p.tokenAddress)),
  };
}
