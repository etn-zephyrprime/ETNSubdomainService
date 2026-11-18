// Candidate tokens configured by the app; Bubblemaps further filters this list by active locks.
export const ELECTROSWAP_LISTED_TOKENS = [
  { symbol: "BOLT", address: "0x043faa1b5c5fc9a7dc35171f290c29ecde0ccff1", decimals: 18 },
  { symbol: "CORE", address: "0x309b916b3a90cb3e071697ea9680e9217a30066f", decimals: 18 },
  { symbol: "DYNO", address: "0xee432c220273e4f949007b4c1946562826efa055", decimals: 18 },
  { symbol: "PDY", address: "0xc20d02538368d8f7debeaeb99d9a8b4d4d1ddc1c", decimals: 18 },
  { symbol: "FUGAZI", address: "0x075533ab8eec6a6999f07c8bc2f1900eb8312e25", decimals: 18 },
  { symbol: "USDC", address: "0x3187dead7a2bd6770f5fe81495d1b715926aae6e", decimals: 6 },
  { symbol: "USDT", address: "0x48e722f1458b253c2fb0e573f939318d7dbd54e7", decimals: 6 },
  { symbol: "CLUB", address: "0xc9fc4ab00911793d99b5c7bd01f01203c21d4131", decimals: 18 },
  { symbol: "DCNT", address: "0xe74e4e7a064310466f3bdbd3f3ce4e8c8f7cf1d5", decimals: 18 },
];

export function hasActiveLiquidityLock(summary, now = Date.now()) {
  const count = Number(summary?.count);
  if (!Number.isFinite(count) || count <= 0) return false;
  if (Number(summary.permanentCount) > 0) return true;
  const latestUnlockAt = Date.parse(summary.latestUnlockAt || "");
  return Number.isFinite(latestUnlockAt) && latestUnlockAt > now;
}

export function getElectroSwapTokensWithActiveLocks(locksByAddress, now = Date.now()) {
  return ELECTROSWAP_LISTED_TOKENS.filter(({ address }) =>
    hasActiveLiquidityLock(locksByAddress?.[address], now)
  );
}
