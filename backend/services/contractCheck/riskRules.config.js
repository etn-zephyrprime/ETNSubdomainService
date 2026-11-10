// Contract Check risk rules — the one place to tune what gets flagged and how loudly. Each rule's
// logic lives in riskFlags.js under the same id; here you set whether it's on, its severity
// ("info" | "caution" | "high") and any threshold. Rules only ever read ContractFacts — never the
// known-contracts registry, which labels a contract but must not soften a flag.

export const RISK_THRESHOLDS = {
  youngContractDays: 7, // younger than this -> young_contract
  top10ConcentrationPct: 80, // top-10 holders above this -> concentrated_holders
  // Leave liquidity pools (contracts the explorer labels LP / Pair / Pool, and the ElectroSwap locker) out of
  // the concentration figure, as well as burn addresses: liquidity sitting in a pool isn't a whale. false =
  // count every holder except burn addresses.
  excludePoolsFromConcentration: true,
  // Liquidity lock rules (the share of each ElectroSwap pool's liquidity in an active lock or burned LP):
  minLiquidityUsdForLockCheck: 50, // tokens with less pooled liquidity than this are skipped (dust)
  mainPoolMinLockedPct: 50, // main pool (holds most of the token's pooled supply) locked below this -> liquidity_unlocked
  overallMinLockedPct: 50, // main pool fine, but all pools together locked below this -> liquidity_partly_locked
  maxSingleFarmerPct: 25, // farmed liquidity counts toward the 50% only if no one farmer holds more than this % of the pool
  lockExpiringDays: 30, // a lock ending within this many days that takes the main pool below the threshold -> liquidity_lock_expiring
};

// Listed tokens whose ElectroSwap liquidity isn't a project's own to lock — bridged stablecoins, where
// many unrelated LPs provide it — so liquidity_unlocked doesn't apply. Only this rule; every other rule
// still runs on them.
export const LIQUIDITY_LOCK_NOT_APPLICABLE = {
  "0x48e722f1458b253c2fb0e573f939318d7dbd54e7": "USDT (bridged stablecoin)",
  "0x3187dead7a2bd6770f5fe81495d1b715926aae6e": "USDC (bridged stablecoin)",
  "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77": "WETN (wrapped ETN — the base pairing asset)",
};

// Highest severity any flag may have on a given contract — the owner's decision (2026-11-10): CORE is
// never shown red; a flag that would be high shows as caution, and keeps `cappedFrom: "high"` in the facts.
export const SEVERITY_CAPS = {
  "0x309b916b3a90cb3e071697ea9680e9217a30066f": "caution", // CORE (Planet Zephyros)
};

export const RISK_RULES = {
  unverified_source: { enabled: true, severity: "caution" }, // no published source at all
  verified_by_twin: { enabled: true, severity: "info" }, // identical bytecode to a verified contract (e.g. every ElectroSwap V2 pair)
  upgradeable_eoa_admin: { enabled: true, severity: "high" }, // upgrades decided by one wallet (EOA admin, or a ProxyAdmin / UUPS owner that's an EOA)
  upgradeable_proxy: { enabled: true, severity: "info" }, // upgradeable, controlled by a contract (multisig / timelock / other)
  owner_can_mint: { enabled: true, severity: "caution" }, // active owner + an owner-gated mint
  blacklist_power: { enabled: true, severity: "high" }, // can block / freeze addresses
  owner_adjustable_fees: { enabled: true, severity: "caution" },
  pause_power: { enabled: true, severity: "caution" }, // can pause transfers or trading
  router_pair_changeable: { enabled: true, severity: "info" },
  owner_can_sweep_tokens: { enabled: true, severity: "high" }, // owner can withdraw arbitrary tokens
  young_contract: { enabled: true, severity: "caution" },
  concentrated_holders: { enabled: true, severity: "caution" },
  balance_overwrite: { enabled: true, severity: "high" }, // a function sets a holder's balance outright (e.g. CORE's transferTaxWallet)
  custom_role_control: { enabled: true, severity: "info" },
  liquidity_unlocked: { enabled: true, severity: "high" }, // the main ElectroSwap pool is mostly unlocked (incl. expired locks)
  liquidity_farmed: { enabled: true, severity: "caution" }, // main pool mostly staked in the yield farm by many farmers — not locked, but no one can pull it all
  liquidity_partly_locked: { enabled: true, severity: "caution" }, // main pool locked, but most liquidity overall isn't
  liquidity_lock_expiring: { enabled: true, severity: "caution" }, // the main pool's lock ends within lockExpiringDays // powers gated to a role of the contract's own (survives a renounced owner)
  owner_renounced: { enabled: true, severity: "info" },
};
