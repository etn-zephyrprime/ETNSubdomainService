import { BUBBLEMAP_CONFIG } from "./config.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BURN_ADDRESSES = new Set([
  ZERO_ADDRESS,
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000000000000000000000000",
]);
const REASON_LABELS = {
  SAME_FUNDER: "same first funder",
  BUNDLED_BUY: "bundled buys near launch",
  TOKEN_TRANSFER: "direct token transfers",
  ETN_TRANSFER_REPEATED: "repeated ETN transfers",
  ETN_TRANSFER_SINGLE: "single ETN transfer",
  SHARED_COUNTERPARTY: "shared wallet interaction",
  TEAM: "team wallet",
};
const lower = (value) => String(value || "").toLowerCase();
const safeNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const bigintOrZero = (value) => {
  try {
    return BigInt(value || 0);
  } catch {
    return 0n;
  }
};
const SUPPLY_SHARE_SCALE = 1_000_000_000_000_000n;
const shortAddress = (address) => `${address.slice(0, 6)}...${address.slice(-4)}`;
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const blockNumber = (transfer) => safeNumber(transfer.block_number ?? transfer.blockNumber);
const txIndex = (transfer) => safeNumber(transfer.log_index ?? transfer.index ?? transfer.logIndex);
const fromAddress = (transfer) => lower(transfer.from?.hash || transfer.from_address || transfer.from);
const toAddress = (transfer) => lower(transfer.to?.hash || transfer.to_address || transfer.to);
const transferTimestamp = (transfer) => Date.parse(transfer.timestamp || transfer.at || "");

export function supplyShare(balance, totalSupply) {
  const total = bigintOrZero(totalSupply);
  if (total <= 0n) return null;
  return Number((bigintOrZero(balance) * SUPPLY_SHARE_SCALE) / total) / Number(SUPPLY_SHARE_SCALE);
}

export function hasNftTransfer(transaction) {
  if (transaction?.has_nft === true || transaction?.hasNft === true || transaction?.token_transfers_overflow === true) return true;
  const transfers = transaction?.token_transfers || transaction?.tokenTransfers || [];
  return transfers.some((transfer) => ["ERC-721", "ERC-1155"].includes(String(transfer?.token_type || transfer?.tokenType || "").toUpperCase()));
}

export function findHubAddresses(counterpartiesByAddress, hubDegree = BUBBLEMAP_CONFIG.hubDegree) {
  const hubs = new Set();
  for (const [address, counterparties] of counterpartiesByAddress || []) {
    if (new Set(counterparties || []).size > hubDegree) hubs.add(lower(address));
  }
  return hubs;
}

function mapValue(source, address) {
  return source instanceof Map ? source.get(address) : source?.[address];
}

function tagsFor(metadata, entity) {
  const tags = new Set(entity?.tags || []);
  const rawTags = [...(metadata?.public_tags || []), ...(metadata?.private_tags || []), ...(metadata?.watchlist_names || [])];
  for (const raw of rawTags) {
    const tag = typeof raw === "string" ? raw : raw?.display_name || raw?.name || raw?.label;
    if (tag) tags.add(String(tag));
  }
  if (entity?.tag) tags.add(entity.tag);
  if (entity?.label) tags.add(entity.label);
  if (metadata?.is_contract) tags.add("Contract");
  return [...tags];
}

function infrastructureExclusion(metadata, entity) {
  const entityTag = lower(entity?.tag);
  if (entityTag.includes("farm") || entityTag.includes("staking")) return "Yield farm";
  if (entityTag.includes("liquidity") || entityTag.includes("pool") || entityTag.includes("locker")) return "Liquidity pool";

  const metadataTags = [...(metadata?.public_tags || []), ...(metadata?.private_tags || []), ...(metadata?.watchlist_names || [])]
    .map((raw) => typeof raw === "string" ? raw : raw?.display_name || raw?.name || raw?.label)
    .filter(Boolean);
  const labels = [metadata?.name, entity?.label, ...metadataTags].filter(Boolean).join(" ");
  if (/\byield[\s_-]*farms?\b|\bstaking[\s_-]*(?:pool|contract|vault)\b/i.test(labels)) return "Yield farm";
  if (/\b(?:liquidity[\s_-]*(?:pool|locker)|LP(?:\s+Token)?|Pair|Pool)\b|-LP\b/i.test(labels)) return "Liquidity pool";
  return null;
}

function exclusionFor(address, metadata, override, entity, degree, cfg) {
  if (BURN_ADDRESSES.has(address) || entity?.tag === "Burn") return "Burn address";
  if (override?.type === "ignore") return override.label ? `Ignored: ${override.label}` : "Ignored by admin";
  if (override?.type === "entity" && String(override.label || "").toLowerCase() !== "team") {
    return `Entity: ${override.label || "admin label"}`;
  }
  const infrastructure = infrastructureExclusion(metadata, entity);
  if (infrastructure && override?.type !== "include") return infrastructure;
  if (
    entity &&
    entity.tag !== "Team" &&
    !(override?.type === "include" && ["Yield Farm", "Liquidity Pool"].includes(entity.tag))
  ) return `${entity.tag} entity${entity.label ? `: ${entity.label}` : ""}`;
  if (override?.type === "hub") return "Hub marked by admin";
  if (override?.type !== "not_hub" && degree > cfg.hubDegree) return `Hub: ${degree} distinct counterparties`;
  if (metadata?.is_contract && override?.type !== "include") return "Contract";
  return null;
}

function newPair(pairs, a, b) {
  if (!a || !b || a === b) return null;
  const key = pairKey(a, b);
  let pair = pairs.get(key);
  if (!pair) {
    pair = { a: a < b ? a : b, b: a < b ? b : a, signals: new Map() };
    pairs.set(key, pair);
  }
  return pair;
}

function addSignal(pairs, a, b, type, weight, detail, strongSignal = false) {
  const pair = newPair(pairs, a, b);
  if (!pair) return;
  const signal = pair.signals.get(type) || { weight: 0, reasons: [], strong: false };
  signal.weight = Math.max(signal.weight, weight);
  signal.strong ||= strongSignal;
  if (detail && !signal.reasons.includes(detail)) signal.reasons.push(detail);
  pair.signals.set(type, signal);
}

function buildEtnSignals(pairs, transfers, eligible, team, coinPriceUsd, cfg) {
  if (!(coinPriceUsd > 0)) return;
  const grouped = new Map();
  for (const transfer of transfers || []) {
    if (hasNftTransfer(transfer)) continue;
    const from = fromAddress(transfer);
    const to = toAddress(transfer);
    if (!eligible.has(from) || !eligible.has(to) || team.has(from) || team.has(to)) continue;
    const valueEtn = Number(bigintOrZero(transfer.value)) / 1e18;
    const valueUsd = valueEtn * coinPriceUsd;
    if (!Number.isFinite(valueUsd) || valueUsd < cfg.minLinkValueUsd) continue;
    const key = pairKey(from, to);
    const row = grouped.get(key) || { a: from < to ? from : to, b: from < to ? to : from, count: 0, high: false, directions: new Set(), blocks: [] };
    row.count++;
    row.high ||= valueUsd >= cfg.largeEtnUsd;
    row.directions.add(from < to ? "a-to-b" : "b-to-a");
    row.blocks.push(blockNumber(transfer));
    grouped.set(key, row);
  }
  for (const row of grouped.values()) {
    const repeated = row.count >= 3 || row.high;
    if (repeated) {
      const directionWeight = cfg.edgeWeights.ETN_TRANSFER_REPEATED;
      addSignal(
        pairs,
        row.a,
        row.b,
        "ETN_TRANSFER_REPEATED",
        directionWeight,
        `${row.count} direct ETN transfer${row.count === 1 ? "" : "s"}${row.high ? ", including one >=$" + cfg.largeEtnUsd : ""}${row.directions.size > 1 ? ", bidirectional" : ""}`,
        row.directions.size > 1
      );
    } else {
      addSignal(pairs, row.a, row.b, "ETN_TRANSFER_SINGLE", cfg.edgeWeights.ETN_TRANSFER_SINGLE, `${row.count} small direct ETN transfer${row.count === 1 ? "" : "s"}`);
    }
  }
}

function buildSharedCounterpartySignals(pairs, interactions, eligible, team, addressData, entities, overrides, cfg) {
  const byCounterparty = new Map();
  for (const transfer of interactions || []) {
    if (hasNftTransfer(transfer)) continue;
    const from = fromAddress(transfer);
    const to = toAddress(transfer);
    const value = bigintOrZero(transfer.value);
    const usd = transfer.kind === "etn"
      ? Number(value) / 1e18 * safeNumber(transfer.coin_price_usd)
      : Number(value) / 10 ** Math.max(0, safeNumber(transfer.decimals)) * safeNumber(transfer.token_price_usd);
    if (!(usd >= cfg.minLinkValueUsd)) continue;
    const holder = eligible.has(from) ? from : eligible.has(to) ? to : null;
    const counterparty = holder === from ? to : holder === to ? from : null;
    if (!holder || !counterparty || team.has(holder)) continue;
    const metadata = mapValue(addressData, counterparty) || {};
    const override = mapValue(overrides, counterparty) || {};
    const entity = mapValue(entities, counterparty) || null;
    const degree = safeNumber(metadata.degree);
    if (!Object.keys(metadata).length || metadata.degree_complete !== true) continue;
    if (metadata.is_contract || entity || BURN_ADDRESSES.has(counterparty) || override.type === "hub" || (degree > cfg.hubDegree && override.type !== "not_hub")) continue;
    if (override.type === "ignore" || override.type === "entity") continue;
    const counterparties = byCounterparty.get(counterparty) || new Set();
    counterparties.add(holder);
    byCounterparty.set(counterparty, counterparties);
  }
  for (const [counterparty, holders] of byCounterparty) {
    const list = [...holders].filter((address) => !team.has(address)).sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        addSignal(pairs, list[i], list[j], "SHARED_COUNTERPARTY", cfg.edgeWeights.SHARED_COUNTERPARTY, shortAddress(counterparty));
      }
    }
  }
}

function collectPairData(input, nodes, cfg) {
  const pairs = new Map();
  const eligible = new Set(nodes.filter((n) => !n.excluded).map((n) => n.address));
  const team = new Set(nodes.filter((n) => n.team && !n.excluded).map((n) => n.address));
  const funders = new Map();
  for (const node of nodes) {
    if (node.excluded || node.team) continue;
    const funder = lower(node.metadata.first_funder);
    if (!funder || funder === node.address) continue;
    const funderMeta = mapValue(input.addresses, funder) || {};
    const funderOverride = mapValue(input.overrides, funder) || {};
    const funderEntity = mapValue(input.entities, funder) || null;
    const degree = safeNumber(funderMeta.degree);
    if (!Object.keys(funderMeta).length || funderMeta.degree == null || funderMeta.degree_complete !== true) continue;
    if (exclusionFor(funder, funderMeta, funderOverride, funderEntity, degree, cfg)) continue;
    const group = funders.get(funder) || [];
    group.push(node.address);
    funders.set(funder, group);
  }
  for (const [funder, group] of funders) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        addSignal(pairs, group[i], group[j], "SAME_FUNDER", cfg.edgeWeights.SAME_FUNDER, shortAddress(funder), true);
      }
    }
  }

  const launchAt = Date.parse(input.launch?.timestamp || "");
  const firstAcquisitions = new Map();
  const orderedTokenTransfers = [...(input.tokenTransfers || [])].sort((a, b) => blockNumber(a) - blockNumber(b) || txIndex(a) - txIndex(b));
  for (const transfer of orderedTokenTransfers) {
    if (hasNftTransfer(transfer)) continue;
    const to = toAddress(transfer);
    const amount = bigintOrZero(transfer.total?.value ?? transfer.value);
    const amountUsd = Number(amount) / 10 ** Math.max(0, safeNumber(input.decimals)) * safeNumber(input.tokenPriceUsd);
    if (!eligible.has(to) || team.has(to) || firstAcquisitions.has(to) || amountUsd < cfg.minLinkValueUsd) continue;
    firstAcquisitions.set(to, { block: blockNumber(transfer), at: transferTimestamp(transfer) });
  }
  const acquired = [...firstAcquisitions.entries()].filter(([, acquisition]) =>
    Number.isFinite(launchAt) &&
    Number.isFinite(acquisition.at) &&
    acquisition.at >= launchAt &&
    acquisition.at - launchAt <= cfg.launchWindowHours * 3600000
  );
  for (let i = 0; i < acquired.length; i++) {
    for (let j = i + 1; j < acquired.length; j++) {
      const [a, firstA] = acquired[i];
      const [b, firstB] = acquired[j];
      if (Math.abs(firstA.block - firstB.block) <= cfg.bundleBlocks) {
        addSignal(pairs, a, b, "BUNDLED_BUY", cfg.edgeWeights.BUNDLED_BUY, `block ${firstA.block} / ${firstB.block}`, true);
      }
    }
  }

  const balances = new Map();
  for (const transfer of orderedTokenTransfers) {
    if (hasNftTransfer(transfer)) continue;
    const from = fromAddress(transfer);
    const to = toAddress(transfer);
    const amount = bigintOrZero(transfer.total?.value ?? transfer.value);
    if (amount <= 0n) continue;
    const before = balances.get(from) || 0n;
    const currentBalance = before;
    const tokenUsd = safeNumber(input.tokenPriceUsd);
    const amountUsd = Number(amount) / 10 ** Math.max(0, safeNumber(input.decimals)) * tokenUsd;
    if (
      eligible.has(from) &&
      eligible.has(to) &&
      !team.has(from) &&
      !team.has(to) &&
      currentBalance > 0n &&
      tokenUsd > 0 &&
      amountUsd >= cfg.minLinkValueUsd
    ) {
      const share = Number(amount * 10000n / currentBalance) / 10000;
      const strong = share >= cfg.minTokenTransferShare;
      addSignal(
        pairs,
        from,
        to,
        "TOKEN_TRANSFER",
        cfg.edgeWeights.TOKEN_TRANSFER,
        `direct token transfer, ${(share * 100).toFixed(1)}% of sender balance`,
        strong
      );
    }
    balances.set(from, before >= amount ? before - amount : 0n);
    balances.set(to, (balances.get(to) || 0n) + amount);
  }

  buildEtnSignals(pairs, input.etnTransfers, eligible, team, safeNumber(input.coinPriceUsd), cfg);
  buildSharedCounterpartySignals(pairs, input.interactions, eligible, team, input.addresses, input.entities, input.overrides, cfg);

  const allPairs = [...pairs.values()].map((pair) => {
    const signals = [...pair.signals.entries()].map(([type, value]) => ({ type, ...value }));
    const score = Math.min(2, signals.reduce((sum, signal) => sum + signal.weight, 0));
    const strongSignal = signals.some((signal) => signal.strong);
    const reasons = signals.flatMap((signal) => signal.reasons.map((detail) => ({ type: signal.type, detail })));
    return { a: pair.a, b: pair.b, score, strongSignal, reasons, signals };
  });
  return { allPairs, eligible, team };
}

function components(addresses, pairs, threshold) {
  const parent = new Map(addresses.map((address) => [address, address]));
  const find = (address) => {
    let root = address;
    while (parent.get(root) !== root) root = parent.get(root);
    let current = address;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra < rb ? ra : rb), parent.set(ra, ra < rb ? ra : rb);
  };
  for (const pair of pairs) if (pair.strongSignal && pair.score >= threshold) union(pair.a, pair.b);
  const grouped = new Map();
  for (const address of addresses) {
    const root = find(address);
    const group = grouped.get(root) || [];
    group.push(address);
    grouped.set(root, group);
  }
  return [...grouped.values()];
}

function louvainPartition(nodes, pairs, maxShare) {
  const nodeSet = new Set(nodes);
  const edges = pairs.filter((pair) => nodeSet.has(pair.a) && nodeSet.has(pair.b) && pair.strongSignal && pair.score > 0);
  const adjacency = new Map(nodes.map((address) => [address, new Map()]));
  for (const edge of edges) {
    adjacency.get(edge.a).set(edge.b, edge.score);
    adjacency.get(edge.b).set(edge.a, edge.score);
  }
  const totalWeight = edges.reduce((sum, edge) => sum + edge.score, 0);
  if (!totalWeight) return nodes.map((address) => [address]);
  let bestGroups = nodes.map((address) => [address]);
  const maxMembers = Math.max(1, Math.floor(nodes.length * maxShare));

  for (let resolution = 1; resolution <= 8; resolution += 0.5) {
    const community = new Map(nodes.map((address) => [address, address]));
    const totals = new Map(nodes.map((address) => [address, [...adjacency.get(address).values()].reduce((a, b) => a + b, 0)]));
    let changed = true;
    let passes = 0;
    while (changed && passes++ < 20) {
      changed = false;
      for (const address of [...nodes].sort()) {
        const neighbors = adjacency.get(address);
        const degree = [...neighbors.values()].reduce((a, b) => a + b, 0);
        const old = community.get(address);
        totals.set(old, (totals.get(old) || 0) - degree);
        const candidates = new Set([old, ...[...neighbors.keys()].map((neighbor) => community.get(neighbor))]);
        let selected = old;
        let bestGain = -Infinity;
        for (const candidate of candidates) {
          let internal = 0;
          for (const [neighbor, weight] of neighbors) if (community.get(neighbor) === candidate) internal += weight;
          const gain = internal - resolution * degree * (totals.get(candidate) || 0) / (2 * totalWeight);
          if (gain > bestGain || (gain === bestGain && candidate < selected)) {
            bestGain = gain;
            selected = candidate;
          }
        }
        community.set(address, selected);
        totals.set(selected, (totals.get(selected) || 0) + degree);
        if (selected !== old) changed = true;
      }
    }
    const groups = new Map();
    for (const address of nodes) {
      const key = community.get(address);
      const group = groups.get(key) || [];
      group.push(address);
      groups.set(key, group);
    }
    bestGroups = [...groups.values()];
    if (bestGroups.every((group) => group.length <= maxMembers)) break;
  }

  if (bestGroups.some((group) => group.length > maxMembers)) {
    const next = [];
    for (const group of bestGroups) {
      if (group.length <= maxMembers) {
        next.push(group);
        continue;
      }
      const sorted = [...group].sort();
      for (let i = 0; i < sorted.length; i += maxMembers) next.push(sorted.slice(i, i + maxMembers));
    }
    bestGroups = next;
  }
  return bestGroups;
}

function cleanPercent(value) {
  return Math.round(value * 10) / 10;
}

function bandFor(score) {
  if (score >= 70) return "Widely spread";
  if (score >= 40) return "Moderately concentrated";
  return "Highly concentrated";
}

export function analyzeBubblemap(input, config = BUBBLEMAP_CONFIG) {
  const cfg = { ...BUBBLEMAP_CONFIG, ...config, edgeWeights: { ...BUBBLEMAP_CONFIG.edgeWeights, ...(config.edgeWeights || {}) } };
  const addresses = input.addresses || new Map();
  const overrides = input.overrides || new Map();
  const entities = input.entities || new Map();
  const hubs = input.hubs || new Set();
  const holders = (input.holders || []).slice(0, cfg.holdersTopN);
  const nodes = holders.map((holder) => {
    const balance = bigintOrZero(holder.value ?? holder.balance);
    const totalSupply = bigintOrZero(input.totalSupply);
    const address = lower(holder.address?.hash || holder.address || holder.address_hash);
    const holderAddressData = holder.address && typeof holder.address === "object" ? holder.address : {};
    const addressMetadata = mapValue(addresses, address) || {};
    const metadata = {
      ...holderAddressData,
      ...addressMetadata,
      name: addressMetadata.name || holderAddressData.name || null,
      ens_domain_name: addressMetadata.ens_domain_name || holderAddressData.ens_domain_name || null,
    };
    const override = mapValue(overrides, address) || {};
    const entity = mapValue(entities, address) || null;
    const isContract = holder.address?.is_contract ?? holder.is_contract ?? metadata.is_contract;
    const degree = Math.max(safeNumber(metadata.degree), safeNumber(input.degreeByAddress?.get?.(address)));
    const forcedHub = override.type === "hub" || (hubs.has(address) && override.type !== "not_hub");
    const exclusionReason = exclusionFor(address, { ...metadata, is_contract: isContract }, override, entity, forcedHub ? Math.max(degree, cfg.hubDegree + 1) : degree, cfg);
    const team = entity?.tag === "Team" || String(override.label || "").toLowerCase() === "team" || (metadata.tags || []).includes("Team");
    const display = entity?.label || override.label || metadata.ens_domain_name || metadata.name || holder.address?.ens_domain_name || holder.address?.name || shortAddress(address);
    return {
      address,
      label: display,
      balance: String(holder.value ?? holder.balance ?? "0"),
      pct: totalSupply > 0n ? cleanPercent(Number(balance * 10000n / totalSupply) / 100) : null,
      supply_share: supplyShare(balance, totalSupply),
      cluster_id: null,
      excluded: Boolean(exclusionReason),
      exclusion_reason: exclusionReason || null,
      tags: [...new Set([...tagsFor({ ...metadata, is_contract: isContract }, entity), ...(override.label ? [override.label] : [])])],
      team,
      metadata,
    };
  }).filter((node) => /^0x[0-9a-f]{40}$/.test(node.address));

  const { allPairs, eligible, team } = collectPairData(input, nodes, cfg);
  const eligibleAddresses = [...eligible];
  let threshold = cfg.clusterThreshold;
  let groups = components(eligibleAddresses, allPairs, threshold);
  const isOversized = (clusterList) => clusterList.some((group) =>
    group.length > 1 && group.length / Math.max(1, eligibleAddresses.length) > cfg.maxClusterHolderShare
  );
  let guardRaised = 0;
  while (isOversized(groups) && guardRaised < 3) {
    threshold = Math.round((threshold + 0.2) * 10) / 10;
    guardRaised++;
    groups = components(eligibleAddresses, allPairs, threshold);
  }
  let louvainSplits = 0;
  if (isOversized(groups)) {
    groups = groups.flatMap((group) => {
      if (group.length / Math.max(1, eligibleAddresses.length) <= cfg.maxClusterHolderShare) return [group];
      louvainSplits++;
      const split = louvainPartition(group, allPairs.filter((pair) => pair.score >= threshold), cfg.maxClusterHolderShare);
      console.warn(
        `🫧 Bubblemaps giant-cluster guard: token ${input.token} split ${group.length}/${eligibleAddresses.length} holders; ` +
          `edge types: ${[...new Set(allPairs.filter((pair) => group.includes(pair.a) && group.includes(pair.b)).flatMap((pair) => pair.signals.map((signal) => signal.type)))].join(", ") || "none"}`
      );
      return split;
    });
  }
  groups = groups.map((group) => [...group].sort()).sort((a, b) => {
    const balance = (list) => list.reduce((sum, address) => sum + bigintOrZero(nodes.find((node) => node.address === address)?.balance), 0n);
    const diff = balance(b) - balance(a);
    return diff === 0n ? a[0].localeCompare(b[0]) : diff > 0n ? 1 : -1;
  });

  const nodeByAddress = new Map(nodes.map((node) => [node.address, node]));
  const clusterByAddress = new Map();
  const eligibleSupply = eligibleAddresses.reduce((sum, address) => sum + bigintOrZero(nodeByAddress.get(address)?.balance), 0n);
  const consideredSupply = eligibleSupply;
  const clusters = groups.map((members, index) => {
    const id = index + 1;
    const balance = members.reduce((sum, address) => sum + bigintOrZero(nodeByAddress.get(address)?.balance), 0n);
    const pct = consideredSupply > 0n ? cleanPercent(Number(balance * 10000n / consideredSupply) / 100) : 0;
    for (const address of members) clusterByAddress.set(address, id);
    const reasons = new Set(
      allPairs
        .filter((pair) => members.includes(pair.a) && members.includes(pair.b))
        .flatMap((pair) => pair.reasons.map((reason) => reason.type))
    );
    if (members.some((address) => team.has(address))) reasons.add("TEAM");
    return { id, members: members.length, pct, reasons_summary: reasons.size ? [...reasons].sort() : ["No detected link"] };
  });
  for (const node of nodes) node.cluster_id = node.excluded ? null : clusterByAddress.get(node.address) ?? null;

  const bundledAddresses = new Set(allPairs.filter((pair) => pair.signals.some((signal) => signal.type === "BUNDLED_BUY")).flatMap((pair) => [pair.a, pair.b]));
  const bundledBalance = [...bundledAddresses].reduce((sum, address) => sum + bigintOrZero(nodeByAddress.get(address)?.balance), 0n);
  const teamBalance = nodes.filter((node) => node.team && !node.excluded).reduce((sum, node) => sum + bigintOrZero(node.balance), 0n);
  const largestClusterPct = clusters.length ? Math.max(...clusters.map((cluster) => cluster.pct)) : 0;
  const bundledPct = consideredSupply > 0n ? Number(bundledBalance * 10000n / consideredSupply) / 100 : 0;
  const teamPct = consideredSupply > 0n ? Number(teamBalance * 10000n / consideredSupply) / 100 : 0;
  let hhi = 0;
  if (consideredSupply > 0n) {
    for (const cluster of groups) {
      const balance = cluster.reduce((sum, address) => sum + bigintOrZero(nodeByAddress.get(address)?.balance), 0n);
      const share = Number(balance) / Number(consideredSupply);
      hhi += share * share;
    }
  }
  let score = consideredSupply > 0n ? Math.round(100 * (1 - hhi)) : null;
  if (score != null) {
    if (largestClusterPct > 25) score -= 10;
    if (bundledPct > 15) score -= 10;
    if (teamPct > 10) score -= 5;
    score = Math.max(0, Math.min(100, score));
  }

  const finalPairs = allPairs.map((pair) => ({
    a: pair.a,
    b: pair.b,
    score: Math.round(pair.score * 100) / 100,
    strong: pair.strongSignal && pair.score >= threshold && clusterByAddress.get(pair.a) === clusterByAddress.get(pair.b),
    reasons: pair.reasons,
  }));
  finalPairs.sort((a, b) => Number(b.strong) - Number(a.strong) || b.score - a.score || a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
  const edges = finalPairs.slice(0, cfg.maxMapEdges);
  const largest = clusters[0];
  const largestReasons = largest?.reasons_summary
    .filter((reason) => reason !== "No detected link")
    .map((reason) => REASON_LABELS[reason] || reason.toLowerCase().replaceAll("_", " "))
    .join(", ");
  const summary = score == null
    ? "Not enough eligible holder data to calculate a concentration score."
    : largest?.members > 1
      ? `${largest.members} linked wallets hold ${largest.pct.toFixed(1)}% of considered supply${largestReasons ? ` (${largestReasons})` : ""}.`
      : `The largest individual holding is ${largestClusterPct.toFixed(1)}% of considered supply.`;
  const output = {
    token: lower(input.token),
    computed_at_block: safeNumber(input.computedAtBlock),
    computed_at: input.computedAt || new Date().toISOString(),
    score,
    band: score == null ? "Insufficient data" : bandFor(score),
    score_parts: {
      largest_cluster_pct: cleanPercent(largestClusterPct),
      bundled_pct: cleanPercent(bundledPct),
      team_pct: cleanPercent(teamPct),
    },
    supply_considered: consideredSupply.toString(),
    summary,
    nodes: nodes.map(({ team: isTeam, metadata, ...node }) => ({
      ...node,
      label: String(node.label || "").slice(0, 120),
      tags: (node.tags || []).slice(0, 8).map((tag) => String(tag).slice(0, 80)),
      exclusion_reason: node.exclusion_reason ? String(node.exclusion_reason).slice(0, 120) : null,
    })),
    edges,
    edges_truncated: finalPairs.length > edges.length,
    clusters,
    calibration: {
      holders_considered: eligibleAddresses.length,
      cluster_count: clusters.length,
      largest_cluster_holders: largest?.members || 0,
      largest_cluster_holder_share_pct: eligibleAddresses.length ? cleanPercent((largest?.members || 0) / eligibleAddresses.length * 100) : 0,
      edge_counts: Object.fromEntries(Object.keys(cfg.edgeWeights).map((type) => [type, allPairs.filter((pair) => pair.signals.some((signal) => signal.type === type)).length])),
      giant_cluster_guard_raised: guardRaised,
      louvain_splits: louvainSplits,
      final_cluster_threshold: threshold,
    },
  };
  const exceedsSizeLimit = () => Buffer.byteLength(JSON.stringify(output), "utf8") > cfg.maxMapBytes;
  while (exceedsSizeLimit() && output.edges.length > 10) {
    output.edges = output.edges.slice(0, Math.max(10, Math.floor(output.edges.length * 0.8)));
    output.edges_truncated = true;
  }
  if (exceedsSizeLimit()) {
    output.edges = [];
    output.edges_truncated = true;
    output.payload_truncated = true;
    output.nodes = output.nodes.map((node) => ({
      address: node.address,
      balance: node.balance,
      pct: node.pct,
      supply_share: node.supply_share,
      cluster_id: node.cluster_id,
      excluded: node.excluded,
      exclusion_reason: node.exclusion_reason,
      tags: node.tags.slice(0, 4).map((tag) => tag.slice(0, 48)),
      label: node.label.slice(0, 64),
    }));
    while (exceedsSizeLimit() && output.nodes.length) output.nodes.pop();
  }
  return output;
}
