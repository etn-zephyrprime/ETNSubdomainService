// How much of a token's ElectroSwap liquidity is actually locked — read from the two ElectroSwap lockers
// on-chain, pool by pool, instead of counting locks (one tiny lock on a side pool used to count as
// "locked", and an expired lock whose LP still sits in the locker as "unlocked" — or worse, the reverse).
//
// The pools are the token's holders the explorer labels as ElectroSwap pools (V2 "ElectroSwap LP", V3
// "ElectroSwapV3Pool"), and the holder balance is how many of the token each pool holds — so each pool's
// weight is its share of the token's pooled supply. Per pool, locked = share of the pool's liquidity:
//   V2: LP tokens in active ElectroSwapLockerV2 locks, plus LP burned (0xdead / 0x0), over LP totalSupply.
//       A lock past created + duration can be withdrawn by its owner at any time, so it counts as expired,
//       not locked, even though its LP is still in the locker.
//   V3: the token's lockedAmount in active ElectroSwapLockerV3 locks over the pool's token balance.
//       (V3 positions burned by sending the NFT to 0xdead aren't counted — that needs per-position tick
//       maths; it under-counts locked, never over-counts.)
import { ethers } from "ethers";

export const LOCKER_V2 = "0x16ca736c8B181772009e598F37f137e9cD36AFAE";
export const LOCKER_V3 = "0xfdB0d62Fc929fD53D266B969Bfe4250b205D0899";
const BURN = ["0x000000000000000000000000000000000000dEaD", ethers.ZeroAddress];
const MAX_POOLS = 6; // the deepest pools hold all but dust; bounds RPC calls per analysis
const PERMANENT_AFTER_YEARS = 100; // a lock ending further out than this is treated as permanent

const V2_LOCKER_ABI = ["function getLockIDsByPairAddress(address) view returns (uint256[])", "function getLockById(uint256) view returns (tuple(uint256 lockID,address pair,address owner,uint256 initial,uint256 amount,uint256 created,uint256 duration))"];
const V3_LOCKER_ABI = ["function getLockIdsByPool(address) view returns (uint256[])", "function getLockById(uint256) view returns (tuple(uint256 tokenId,address owner,uint256 created,uint256 duration,bool active,address token0,address token1,uint24 fee,uint256 lockedAmount0,uint256 lockedAmount1,address pool,uint256 poolAmount0,uint256 poolAmount1))"];
const ERC20_ABI = ["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"];

/** The token's ElectroSwap pools among its explorer holders: [{ address, version, tokenAmount (bigint) }], deepest first. */
export function poolsFromHolders(holders) {
  return (holders || [])
    .filter((h) => h?.address?.is_contract)
    .map((h) => {
      const name = h.address.name || "";
      const version = /V3Pool/i.test(name) ? 3 : /^ElectroSwap LP$/i.test(name) ? 2 : null;
      return version ? { address: h.address.hash, version, tokenAmount: BigInt(h.value || 0) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.tokenAmount > a.tokenAmount ? 1 : b.tokenAmount < a.tokenAmount ? -1 : 0))
    .slice(0, MAX_POOLS);
}

const unlockOf = (created, duration) => {
  const end = Number(created) + Number(duration);
  return !Number.isFinite(end) || end > Date.now() / 1000 + PERMANENT_AFTER_YEARS * 365.25 * 86400 ? null : end * 1000;
};
const share = (part, whole) => (whole > 0n ? Number((part * 1000000n) / whole) / 1000000 : 0);

/**
 * Lock state of each pool: [{ address, version, tokenAmount (string), lockedShare, expiredShare, locks:
 * [{ share, unlockAt (ISO, null = permanent) }] }] — shares are 0..1 of that pool's liquidity. Throws on an
 * RPC failure (the caller marks the facts incomplete rather than guessing).
 */
export async function readPoolLocks(provider, tokenAddress, holders, now = Date.now()) {
  const token = tokenAddress.toLowerCase();
  const v2 = new ethers.Contract(LOCKER_V2, V2_LOCKER_ABI, provider);
  const v3 = new ethers.Contract(LOCKER_V3, V3_LOCKER_ABI, provider);
  const out = [];
  for (const pool of poolsFromHolders(holders)) {
    const locks = [];
    let lockedShare = 0;
    let expiredShare = 0;
    if (pool.version === 2) {
      const lp = new ethers.Contract(pool.address, ERC20_ABI, provider);
      const supply = await lp.totalSupply();
      let burned = 0n;
      for (const b of BURN) burned += await lp.balanceOf(b);
      if (burned > 0n) locks.push({ share: share(burned, supply), unlockAt: null, burned: true });
      for (const id of await v2.getLockIDsByPairAddress(pool.address)) {
        const l = await v2.getLockById(id);
        if (l.amount === 0n) continue; // withdrawn
        const unlockAt = unlockOf(l.created, l.duration);
        if (unlockAt !== null && unlockAt <= now) expiredShare += share(l.amount, supply);
        else locks.push({ share: share(l.amount, supply), unlockAt: unlockAt === null ? null : new Date(unlockAt).toISOString() });
      }
    } else {
      for (const id of await v3.getLockIdsByPool(pool.address)) {
        const l = await v3.getLockById(id);
        if (!l.active) continue;
        const amount = l.token0.toLowerCase() === token ? l.lockedAmount0 : l.lockedAmount1;
        const unlockAt = unlockOf(l.created, l.duration);
        if (unlockAt !== null && unlockAt <= now) expiredShare += share(amount, pool.tokenAmount);
        else locks.push({ share: share(amount, pool.tokenAmount), unlockAt: unlockAt === null ? null : new Date(unlockAt).toISOString() });
      }
    }
    lockedShare = Math.min(1, locks.reduce((s, l) => s + l.share, 0));
    out.push({ address: pool.address.toLowerCase(), version: pool.version, tokenAmount: pool.tokenAmount.toString(), lockedShare, expiredShare: Math.min(1, expiredShare), locks });
  }
  return out;
}
