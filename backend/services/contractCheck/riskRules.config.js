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
  custom_role_control: { enabled: true, severity: "info" }, // powers gated to a role of the contract's own (survives a renounced owner)
  owner_renounced: { enabled: true, severity: "info" },
};
