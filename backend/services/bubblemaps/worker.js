import { getPool, query } from "../../db/pool.js";
import { listCexAddresses } from "../../db/cexAddresses.js";
import { listKnownContracts } from "../../db/knownContracts.js";
import { listBubblemapOverrides } from "../../db/bubblemaps.js";
import { fetchBlockscoutJson } from "../../utils/blockscoutClient.js";
import { getTokenLocksCache } from "../../state/tokenLocksState.js";
import { ELECTROSWAP_LISTED_TOKENS, getElectroSwapTokensWithActiveLocks } from "../../utils/electroSwapTokens.js";
import { BRIDGE_PROXY_ADDRESS } from "../../utils/etnBridge.js";
import { TEAM_WALLET_ADDRESSES } from "../../utils/teamWalletsCache.js";
import { analyzeBubblemap, hasNftTransfer } from "./analysis.js";
import { BUBBLEMAP_CONFIG } from "./config.js";

const TOKEN_CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;
const TOKEN_CATALOG_KEY = ELECTROSWAP_LISTED_TOKENS.map(({ address }) => address).join(",");
const MAX_HOLDER_PAGES_PER_TICK = 10;
const MAX_TRANSFER_PAGES_PER_TICK = BUBBLEMAP_CONFIG.maxTransferPagesPerTick;
const MAX_MAPS_PER_TICK = 3;
const STATS_REFRESH_MS = 60 * 1000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let workerStarted = false;
let workerRunning = false;
let nextRequestAt = 0;
let cachedEntities = null;
let cachedEntitiesAt = 0;
let cachedStats = null;
let lockCacheUnavailableLogged = false;

export function cursorQuery(cursor) {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return "";
  const queryString = new URLSearchParams(cursor).toString();
  return queryString ? `?${queryString}` : "";
}

export function isTokenCatalogFresh(state, catalogKey, now = Date.now()) {
  const syncedAt = Date.parse(state?.synced_at || "");
  return state?.catalog_key === catalogKey
    && !state.started_at
    && Number.isFinite(syncedAt)
    && now - syncedAt < TOKEN_CATALOG_REFRESH_MS;
}

export function normalizeTokenTransfer(item, tokenAddress) {
  return {
    token_address: tokenAddress.toLowerCase(),
    transaction_hash: String(item.transaction_hash || "").toLowerCase(),
    log_index: Number(item.log_index ?? item.index ?? 0),
    block_number: Number(item.block_number || 0),
    transfer_timestamp: item.timestamp || null,
    from_address: String(item.from?.hash || "").toLowerCase(),
    to_address: String(item.to?.hash || "").toLowerCase(),
    value: String(item.total?.value ?? item.value ?? "0"),
    token_type: item.token_type || null,
    has_nft: ["ERC-721", "ERC-1155"].includes(String(item.token_type || "").toUpperCase()),
    from: item.from,
    to: item.to,
  };
}

function isAddress(value) {
  return ADDRESS_RE.test(String(value || ""));
}

function positiveBigInt(value) {
  try {
    const parsed = BigInt(value || 0);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

export function splitTransfersAtBlock(items, lastProcessedBlock) {
  const firstExisting = (items || []).findIndex((item) => Number(item.block_number || 0) <= lastProcessedBlock);
  return {
    newItems: firstExisting < 0 ? items || [] : items.slice(0, firstExisting),
    reachedPreviouslyProcessed: firstExisting >= 0,
  };
}

async function waitForBlockscoutSlot() {
  const interval = 1000 / BUBBLEMAP_CONFIG.blockscoutRps;
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + interval;
  if (wait > 0) await sleep(wait);
}

async function blockscout(path) {
  await waitForBlockscoutSlot();
  return fetchBlockscoutJson(path, 0, { retry5xx: true });
}

function jsonOrNull(value) {
  return value == null ? null : typeof value === "string" ? JSON.parse(value) : value;
}

async function getWorkerState(key) {
  const result = await query("SELECT state_value FROM bubblemap_worker_state WHERE state_key = $1", [key]);
  return result?.rows?.[0]?.state_value || {};
}

async function setWorkerState(key, value) {
  await query(
    `INSERT INTO bubblemap_worker_state (state_key, state_value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = now()`,
    [key, value]
  );
}

function tokenFromExplorer(item) {
  const address = String(item.address_hash || item.address?.hash || item.address || "").toLowerCase();
  if (!isAddress(address)) return null;
  const parsedDecimals = Number(item.decimals);
  const parsedRate = Number(item.exchange_rate);
  return {
    address,
    name: String(item.name || "").slice(0, 200) || null,
    symbol: String(item.symbol || "").slice(0, 40) || null,
    decimals: Number.isInteger(parsedDecimals) && parsedDecimals >= 0 && parsedDecimals <= 255 ? parsedDecimals : 18,
    totalSupply: item.total_supply == null ? null : String(item.total_supply),
    exchangeRate: Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : null,
  };
}

async function saveTokenPage(items) {
  const tokens = (items || []).map(tokenFromExplorer).filter(Boolean);
  if (!tokens.length) return;
  const values = [];
  const params = [];
  tokens.forEach((token, index) => {
    const offset = index * 6;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, now())`);
    params.push(token.address, token.name, token.symbol, token.decimals, token.totalSupply, token.exchangeRate);
  });
  await query(
    `INSERT INTO bubblemap_tokens (token_address, name, symbol, decimals, total_supply, exchange_rate, updated_at)
     VALUES ${values.join(",")}
     ON CONFLICT (token_address) DO UPDATE SET name = EXCLUDED.name, symbol = EXCLUDED.symbol,
       decimals = EXCLUDED.decimals, total_supply = COALESCE(EXCLUDED.total_supply, bubblemap_tokens.total_supply),
       exchange_rate = COALESCE(EXCLUDED.exchange_rate, bubblemap_tokens.exchange_rate), updated_at = now()`,
    params
  );
}

async function syncTokenCatalog() {
  const now = Date.now();
  const lockCache = await getTokenLocksCache();
  const locksByAddress = lockCache?.locksByAddress;
  const lockCacheUpdatedAt = Date.parse(lockCache?.updatedAt || "");
  if (
    !Number.isFinite(lockCacheUpdatedAt)
    || !locksByAddress
    || typeof locksByAddress !== "object"
    || Array.isArray(locksByAddress)
    || Object.keys(locksByAddress).length === 0
  ) {
    if (!lockCacheUnavailableLogged) {
      console.warn("⚠️  Bubblemaps catalog unchanged — ElectroSwap lock cache is unavailable or empty");
      lockCacheUnavailableLogged = true;
    }
    return;
  }
  lockCacheUnavailableLogged = false;

  const eligibleTokens = getElectroSwapTokensWithActiveLocks(locksByAddress, now);
  const addresses = eligibleTokens.map(({ address }) => address);
  const catalogKey = [
    TOKEN_CATALOG_KEY,
    addresses.join(","),
  ].join("|");
  const state = await getWorkerState("token_catalog");
  if (isTokenCatalogFresh(state, catalogKey, now)) return;

  const resumed = state.catalog_key === catalogKey && Boolean(state.started_at);
  const startedAt = resumed ? state.started_at : new Date().toISOString();
  const savedCursor = resumed ? jsonOrNull(state.cursor) : null;
  const savedIndex = Number(savedCursor?.index);
  let index = Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex <= addresses.length ? savedIndex : 0;
  if (!resumed) {
    await query("UPDATE bubblemap_addresses SET degree_complete = false");
    await setWorkerState("token_catalog", {
      ...state,
      source: "electroswap-listed-tokens-with-locked-liquidity",
      catalog_key: catalogKey,
      degree_ready: false,
      started_at: startedAt,
      cursor: { index },
    });
  }

  for (let count = 0; count < 10 && index < eligibleTokens.length; count++) {
    const listedToken = eligibleTokens[index];
    const details = await blockscout(`/tokens/${listedToken.address}`);
    await saveTokenPage([{
      ...details,
      address_hash: listedToken.address,
      symbol: details.symbol || listedToken.symbol,
      decimals: details.decimals ?? listedToken.decimals,
    }]);
    index += 1;
    await setWorkerState("token_catalog", {
      source: "electroswap-listed-tokens-with-locked-liquidity",
      catalog_key: catalogKey,
      degree_ready: false,
      started_at: startedAt,
      cursor: { index },
    });
  }

  if (index >= eligibleTokens.length) {
    await query("DELETE FROM bubblemap_tokens WHERE NOT (token_address = ANY($1::text[]))", [addresses]);
    await query("UPDATE bubblemap_tokens SET analysis_dirty = true");
    await setWorkerState("token_catalog", {
      source: "electroswap-listed-tokens-with-locked-liquidity",
      catalog_key: catalogKey,
      synced_at: new Date().toISOString(),
      started_at: null,
      cursor: null,
      degree_ready: false,
    });
    console.log(`🫧 Bubblemaps catalog synchronized for ${addresses.length} ElectroSwap-listed tokens with locked liquidity`);
  }
}

async function upsertAddresses(records, scanRequested = false, fetchedFromAddressEndpoint = false, scanLevel = 0) {
  const unique = new Map();
  for (const raw of records || []) {
    const address = String(raw?.hash || raw?.address || raw || "").toLowerCase();
    if (!isAddress(address)) continue;
    const value = typeof raw === "object" && raw !== null ? raw : {};
    unique.set(address, {
      address,
      isContract: typeof value.is_contract === "boolean" ? value.is_contract : null,
      name: value.name || null,
      ens: value.ens_domain_name || null,
      publicTags: value.public_tags || [],
      privateTags: value.private_tags || [],
    });
  }
  const rows = [...unique.values()];
  if (!rows.length) return;
  const params = [];
  const values = rows.map((row, index) => {
    const offset = index * 9;
    params.push(
      row.address,
      row.isContract,
      row.name,
      row.ens,
      JSON.stringify(row.publicTags),
      JSON.stringify(row.privateTags),
      fetchedFromAddressEndpoint ? new Date() : null,
      scanRequested,
      scanLevel
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, now())`;
  });
  await query(
    `INSERT INTO bubblemap_addresses
       (address, is_contract, name, ens_domain_name, public_tags, private_tags, metadata_fetched_at, scan_requested, scan_level, updated_at)
     VALUES ${values.join(",")}
     ON CONFLICT (address) DO UPDATE SET
       is_contract = COALESCE(EXCLUDED.is_contract, bubblemap_addresses.is_contract),
       name = COALESCE(EXCLUDED.name, bubblemap_addresses.name),
       ens_domain_name = COALESCE(EXCLUDED.ens_domain_name, bubblemap_addresses.ens_domain_name),
       public_tags = CASE WHEN EXCLUDED.public_tags = '[]'::jsonb THEN bubblemap_addresses.public_tags ELSE EXCLUDED.public_tags END,
       private_tags = CASE WHEN EXCLUDED.private_tags = '[]'::jsonb THEN bubblemap_addresses.private_tags ELSE EXCLUDED.private_tags END,
       metadata_fetched_at = COALESCE(EXCLUDED.metadata_fetched_at, bubblemap_addresses.metadata_fetched_at),
       scan_requested = bubblemap_addresses.scan_requested OR (EXCLUDED.scan_requested AND NOT bubblemap_addresses.tx_scan_complete),
       scan_level = CASE WHEN NOT bubblemap_addresses.scan_requested AND EXCLUDED.scan_requested
         THEN EXCLUDED.scan_level ELSE LEAST(bubblemap_addresses.scan_level, EXCLUDED.scan_level) END,
       updated_at = now()`,
    params
  );
}

async function recordCounterparties(pairs) {
  const validPairs = [];
  const touched = new Set();
  for (const [left, right] of pairs || []) {
    const a = String(left || "").toLowerCase();
    const b = String(right || "").toLowerCase();
    if (!isAddress(a) || !isAddress(b) || a === b) continue;
    validPairs.push([a, b], [b, a]);
    touched.add(a);
    touched.add(b);
  }
  if (!validPairs.length) return;
  const params = [];
  const values = validPairs.map(([a, b], index) => {
    params.push(a, b);
    return `($${index * 2 + 1}, $${index * 2 + 2})`;
  });
  await query(
    `INSERT INTO bubblemap_address_counterparties (address, counterparty)
     VALUES ${values.join(",")} ON CONFLICT DO NOTHING`,
    params
  );
  await query(
    `UPDATE bubblemap_addresses a SET degree = (
       SELECT COUNT(*)::integer FROM bubblemap_address_counterparties c WHERE c.address = a.address
     ), updated_at = now() WHERE a.address = ANY($1::text[])`,
    [[...touched]]
  );
}

async function refreshOneHoldersPage(token) {
  let startedAt = token.holders_refresh_started_at;
  let cursor = jsonOrNull(token.holders_cursor);
  if (!startedAt) {
    startedAt = new Date();
    cursor = null;
    await query(
      `UPDATE bubblemap_tokens SET holders_refresh_started_at = $2, holders_cursor = NULL,
         holders_fetched_count = 0, updated_at = now()
       WHERE token_address = $1`,
      [token.token_address, startedAt]
    );
  }
  const response = await blockscout(`/tokens/${token.token_address}/holders${cursorQuery(cursor)}`);
  const items = (response.items || []).filter((item) => isAddress(item.address?.hash));
  if (items.length) {
    const params = [];
    const values = items.map((item, index) => {
      const address = item.address.hash.toLowerCase();
      params.push(token.token_address, address, String(item.value || "0"), item.address.is_contract ?? null, item.address, startedAt);
      const offset = index * 6;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`;
    });
    await query(
      `INSERT INTO bubblemap_token_holders
         (token_address, holder_address, balance, is_contract, address_data, seen_at)
       VALUES ${values.join(",")}
       ON CONFLICT (token_address, holder_address) DO UPDATE SET balance = EXCLUDED.balance,
         is_contract = EXCLUDED.is_contract, address_data = EXCLUDED.address_data, seen_at = EXCLUDED.seen_at`,
      params
    );
    await upsertAddresses(items.map((item) => item.address), true);
  }
  const fetchedCount = Number(token.holders_fetched_count || 0) + items.length;
  const next = fetchedCount >= BUBBLEMAP_CONFIG.holdersTopN ? null : response.next_page_params || null;
  if (next) {
    await query(
      `UPDATE bubblemap_tokens SET holders_cursor = $2, holders_fetched_count = $3,
         analysis_dirty = true, updated_at = now()
       WHERE token_address = $1`,
      [token.token_address, next, fetchedCount]
    );
  } else {
    await query(
      `DELETE FROM bubblemap_token_holders WHERE token_address = $1 AND seen_at < $2`,
      [token.token_address, startedAt]
    );
    await query(
      `UPDATE bubblemap_tokens SET holders_cursor = NULL, holders_fetched_count = $2, holders_refresh_started_at = NULL,
         holders_refreshed_at = now(), analysis_dirty = true, updated_at = now()
       WHERE token_address = $1`,
      [token.token_address, fetchedCount]
    );
  }
}

async function saveTokenTransfers(tokenAddress, items, minBlock = 0) {
  const transfers = (items || [])
    .map((item) => normalizeTokenTransfer(item, tokenAddress))
    .filter((item) => /^0x[0-9a-f]{64}$/i.test(item.transaction_hash) && isAddress(item.from_address) && isAddress(item.to_address))
    .filter((item) => item.block_number > minBlock || minBlock === 0);
  if (!transfers.length) return { count: 0, maxBlock: minBlock };
  const params = [];
  const values = transfers.map((item, index) => {
    const offset = index * 10;
    params.push(
      item.token_address,
      item.transaction_hash,
      item.log_index,
      item.block_number,
      item.transfer_timestamp,
      item.from_address,
      item.to_address,
      item.value,
      item.token_type,
      item.has_nft
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`;
  });
  await query(
    `INSERT INTO bubblemap_token_transfers
       (token_address, transaction_hash, log_index, block_number, transfer_timestamp, from_address, to_address, value, token_type, has_nft)
     VALUES ${values.join(",")}
     ON CONFLICT (token_address, transaction_hash, log_index) DO UPDATE SET
       block_number = EXCLUDED.block_number, transfer_timestamp = EXCLUDED.transfer_timestamp,
       from_address = EXCLUDED.from_address, to_address = EXCLUDED.to_address, value = EXCLUDED.value,
       token_type = EXCLUDED.token_type, has_nft = EXCLUDED.has_nft`,
    params
  );
  await upsertAddresses(transfers.flatMap((item) => [item.from, item.to]));
  await recordCounterparties(transfers.map((item) => [item.from_address, item.to_address]));
  return { count: transfers.length, maxBlock: Math.max(minBlock, ...transfers.map((item) => item.block_number)) };
}

async function refreshOneTransfersPage(token) {
  if (!token.transfer_backfill_complete) {
    const cursor = jsonOrNull(token.transfer_cursor);
    const response = await blockscout(`/tokens/${token.token_address}/transfers${cursorQuery(cursor)}`);
    const saved = await saveTokenTransfers(token.token_address, response.items);
    const next = response.next_page_params || null;
    await query(
      `UPDATE bubblemap_tokens SET transfer_cursor = $2, last_processed_block = GREATEST(last_processed_block, $3),
         transfer_backfill_complete = $4, transfer_polled_at = now(), analysis_dirty = true, updated_at = now()
       WHERE token_address = $1`,
      [token.token_address, next, saved.maxBlock, !next]
    );
    return;
  }

  const startedBlock = token.transfer_poll_started_block == null
    ? Number(token.last_processed_block || 0)
    : Number(token.transfer_poll_started_block);
  const cursor = jsonOrNull(token.transfer_poll_cursor);
  const response = await blockscout(`/tokens/${token.token_address}/transfers${cursorQuery(cursor)}`);
  const items = response.items || [];
  const { newItems, reachedPreviouslyProcessed } = splitTransfersAtBlock(items, startedBlock);
  const saved = await saveTokenTransfers(token.token_address, newItems, startedBlock);
  if (reachedPreviouslyProcessed || !response.next_page_params) {
    await query(
      `UPDATE bubblemap_tokens SET transfer_poll_cursor = NULL, transfer_poll_started_block = NULL,
         last_processed_block = GREATEST(last_processed_block, $2), transfer_polled_at = now(),
         analysis_dirty = (analysis_dirty OR $3), updated_at = now()
       WHERE token_address = $1`,
      [token.token_address, saved.maxBlock, saved.count > 0]
    );
  } else {
    await query(
      `UPDATE bubblemap_tokens SET transfer_poll_cursor = $2, transfer_poll_started_block = $3,
         last_processed_block = GREATEST(last_processed_block, $4), transfer_polled_at = now(),
         analysis_dirty = (analysis_dirty OR $5), updated_at = now()
       WHERE token_address = $1`,
      [token.token_address, response.next_page_params, startedBlock, saved.maxBlock, saved.count > 0]
    );
  }
}

async function saveNativeTransfers(items) {
  const transfers = (items || []).filter((tx) =>
    /^0x[0-9a-f]{64}$/i.test(String(tx.hash || "")) &&
    isAddress(tx.from?.hash) &&
    isAddress(tx.to?.hash) &&
    positiveBigInt(tx.value) > 0n
  );
  if (!transfers.length) return;
  const params = [];
  const values = transfers.map((tx, index) => {
    const offset = index * 7;
    params.push(
      String(tx.hash).toLowerCase(),
      Number(tx.block_number || 0),
      tx.timestamp || null,
      tx.from.hash.toLowerCase(),
      tx.to.hash.toLowerCase(),
      String(tx.value),
      hasNftTransfer(tx)
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
  });
  await query(
    `INSERT INTO bubblemap_native_transfers
       (transaction_hash, block_number, transfer_timestamp, from_address, to_address, value, has_nft)
     VALUES ${values.join(",")}
     ON CONFLICT (transaction_hash) DO UPDATE SET has_nft = bubblemap_native_transfers.has_nft OR EXCLUDED.has_nft`,
    params
  );
}

async function processOneAddress(addressRow) {
  const address = addressRow.address;
  let metadata = addressRow;
  if (!addressRow.metadata_fetched_at) {
    metadata = await blockscout(`/addresses/${address}`);
    await query(
      `UPDATE bubblemap_addresses SET is_contract = $2, name = $3, ens_domain_name = $4,
         public_tags = $5, private_tags = $6, metadata_fetched_at = now(), updated_at = now()
       WHERE address = $1`,
      [
        address,
        metadata.is_contract ?? null,
        metadata.name || null,
        metadata.ens_domain_name || null,
        JSON.stringify(metadata.public_tags || []),
        JSON.stringify(metadata.private_tags || []),
      ]
    );
    if (metadata.is_contract) {
      await query(
        `UPDATE bubblemap_addresses SET scan_requested = false, tx_scan_complete = true,
           first_funder_complete = true, degree_complete = true, updated_at = now()
         WHERE address = $1`,
        [address]
      );
      await markAddressMapsDirty(address);
      return;
    }
    addressRow.scan_level = Number(addressRow.scan_level || 0);
    addressRow.tx_cursor = null;
    addressRow.tx_pages_scanned = 0;
  }

  let cursor = jsonOrNull(addressRow.tx_cursor);
  let pages = 0;
  let done = false;
  let earliestFunder = null;
  while (pages < BUBBLEMAP_CONFIG.maxTxPagesPerAddress && !done) {
    const response = await blockscout(`/addresses/${address}/transactions${cursorQuery(cursor)}`);
    const items = response.items || [];
    const participants = items.flatMap((tx) => [tx.from, tx.to]).filter(Boolean);
    await upsertAddresses(participants);
    await recordCounterparties(items.map((tx) => [tx.from?.hash, tx.to?.hash]));
    await saveNativeTransfers(items);

    for (const tx of items) {
      const txTo = String(tx.to?.hash || "").toLowerCase();
      const txFrom = String(tx.from?.hash || "").toLowerCase();
      const value = positiveBigInt(tx.value);
      if (txTo !== address || !isAddress(txFrom) || value <= 0n) continue;
      const block = Number(tx.block_number || 0);
      if (!earliestFunder || block < earliestFunder.block) earliestFunder = { address: txFrom, block, raw: tx.from };
    }
    if (earliestFunder) {
      await query(
        `UPDATE bubblemap_addresses SET first_funder_candidate = $2, first_funder_candidate_block = $3, updated_at = now()
         WHERE address = $1 AND (first_funder_candidate_block IS NULL OR first_funder_candidate_block > $3)`,
        [address, earliestFunder.address, earliestFunder.block]
      );
      if (Number(addressRow.scan_level || 0) === 0) {
        await upsertAddresses([earliestFunder.raw], true, false, 1);
      }
    }
    pages++;
    cursor = response.next_page_params || null;
    done = !cursor;
  }

  await query(
    `UPDATE bubblemap_addresses SET tx_cursor = $2, tx_pages_scanned = tx_pages_scanned + $3,
       tx_scan_complete = $4, degree_complete = $4, scan_requested = NOT $4,
       first_funder = CASE WHEN $4 AND NOT first_funder_complete THEN first_funder_candidate ELSE first_funder END,
       first_funder_complete = first_funder_complete OR $4, updated_at = now()
     WHERE address = $1`,
    [address, cursor, pages, done]
  );
  await markAddressMapsDirty(address);
}

async function markAddressMapsDirty(address) {
  await query(
    `UPDATE bubblemap_tokens t SET analysis_dirty = true, updated_at = now()
     WHERE EXISTS (
       SELECT 1 FROM bubblemap_token_holders h
       WHERE h.token_address = t.token_address AND h.holder_address = $1
     ) OR EXISTS (
       SELECT 1 FROM bubblemap_token_holders h
       JOIN bubblemap_addresses a ON a.address = h.holder_address
       WHERE h.token_address = t.token_address AND a.first_funder = $1
     )`,
    [address]
  );
}

async function processAddresses() {
  const result = await query(
    `SELECT address, is_contract, metadata_fetched_at, tx_cursor, tx_pages_scanned, scan_level
     FROM bubblemap_addresses WHERE scan_requested = true
     ORDER BY scan_level ASC, metadata_fetched_at ASC NULLS FIRST, updated_at ASC
     LIMIT $1`,
    [BUBBLEMAP_CONFIG.maxAddressesPerTick]
  );
  for (const address of result?.rows || []) {
    try {
      await processOneAddress(address);
    } catch (err) {
      console.error(`⚠️  Bubblemaps address scan failed for ${address.address}: ${err.message}`);
    }
  }
}

async function processHolderPages() {
  for (let page = 0; page < MAX_HOLDER_PAGES_PER_TICK; page++) {
    const result = await query(
      `SELECT token_address, holders_cursor, holders_fetched_count, holders_refresh_started_at, holders_refreshed_at
       FROM bubblemap_tokens
       WHERE holders_refresh_started_at IS NOT NULL OR holders_refreshed_at IS NULL
          OR holders_refreshed_at < now() - ($1 * interval '1 millisecond')
       ORDER BY holders_refreshed_at ASC NULLS FIRST, updated_at ASC
       LIMIT 1`,
      [BUBBLEMAP_CONFIG.holderRefreshMs]
    );
    const token = result?.rows?.[0];
    if (!token) return;
    try {
      await refreshOneHoldersPage(token);
    } catch (err) {
      console.error(`⚠️  Bubblemaps holder refresh failed for ${token.token_address}: ${err.message}`);
      return;
    }
  }
}

async function processTransferPages() {
  for (let page = 0; page < MAX_TRANSFER_PAGES_PER_TICK; page++) {
    const result = await query(
      `SELECT token_address, transfer_cursor, transfer_poll_cursor, transfer_poll_started_block,
              transfer_backfill_complete, last_processed_block
       FROM bubblemap_tokens
       WHERE holders_refreshed_at IS NOT NULL AND (
         transfer_backfill_complete = false OR transfer_poll_cursor IS NOT NULL OR
         transfer_polled_at IS NULL OR transfer_polled_at < now() - interval '30 minutes'
       )
       ORDER BY transfer_backfill_complete ASC, transfer_poll_cursor DESC NULLS LAST,
                transfer_polled_at ASC NULLS FIRST, updated_at ASC
       LIMIT 1`
    );
    const token = result?.rows?.[0];
    if (!token) return;
    try {
      await refreshOneTransfersPage(token);
    } catch (err) {
      console.error(`⚠️  Bubblemaps transfer refresh failed for ${token.token_address}: ${err.message}`);
      return;
    }
  }

}

async function finalizeDegreeCache() {
  const state = await getWorkerState("token_catalog");
  if (!state.synced_at || state.degree_ready) return;
  const pending = await query(
    `SELECT COUNT(*)::integer AS count FROM bubblemap_tokens WHERE transfer_backfill_complete = false`
  );
  if (Number(pending?.rows?.[0]?.count || 0) !== 0) return;
  await query(
    `UPDATE bubblemap_addresses SET degree_complete = true, updated_at = now()
     WHERE tx_scan_complete = true`
  );
  await query("UPDATE bubblemap_tokens SET analysis_dirty = true");
  await setWorkerState("token_catalog", { ...state, degree_ready: true });
}

function addEntity(map, address, tag, label = null) {
  const key = String(address || "").toLowerCase();
  if (!isAddress(key)) return;
  const existing = map.get(key) || { tag, label: null, tags: [] };
  existing.tag = tag || existing.tag;
  existing.label = label || existing.label;
  existing.tags = [...new Set([...(existing.tags || []), tag].filter(Boolean))];
  map.set(key, existing);
}

async function getEntities() {
  if (cachedEntities && Date.now() - cachedEntitiesAt < 5 * 60 * 1000) return cachedEntities;
  const entities = new Map();
  for (const address of TEAM_WALLET_ADDRESSES) addEntity(entities, address, "Team");
  addEntity(entities, BRIDGE_PROXY_ADDRESS, "Bridge", "ETN Bridge");
  addEntity(entities, ZERO_ADDRESS, "Burn");
  addEntity(entities, "0x000000000000000000000000000000000000dead", "Burn");
  addEntity(entities, "0xdead000000000000000000000000000000000000", "Burn");

  for (const item of await listCexAddresses()) addEntity(entities, item.address, "CEX", item.label);
  for (const item of await listKnownContracts()) {
    const category = String(item.category || "").toLowerCase();
    const tag = category.includes("bridge") ? "Bridge"
      : category.includes("cex") || category.includes("exchange") ? "CEX"
        : category.includes("team") ? "Team"
          : category.includes("burn") ? "Burn"
            : null;
    if (tag) addEntity(entities, item.address, tag, item.label);
  }
  cachedEntities = entities;
  cachedEntitiesAt = Date.now();
  return entities;
}

async function getOverrides() {
  const rows = await listBubblemapOverrides();
  return new Map(rows.map((row) => [row.address.toLowerCase(), { type: row.type, label: row.label }]));
}

async function getCurrentStats() {
  if (cachedStats && Date.now() - cachedStats.fetchedAt < STATS_REFRESH_MS) return cachedStats;
  const stored = await getWorkerState("chain_stats");
  const storedStats = {
    block: Number(stored.block || 0),
    coinPriceUsd: Number(stored.coin_price_usd || 0),
    fetchedAt: Date.parse(stored.fetched_at || "") || 0,
  };
  if (storedStats.fetchedAt && Date.now() - storedStats.fetchedAt < STATS_REFRESH_MS) {
    cachedStats = storedStats;
    return cachedStats;
  }
  try {
    const [blocks, stats] = await Promise.all([
      blockscout("/blocks"),
      blockscout("/stats"),
    ]);
    const next = {
      block: Number(blocks.items?.[0]?.height || 0),
      coinPriceUsd: Number(stats.coin_price || 0),
      fetchedAt: Date.now(),
    };
    cachedStats = next;
    await setWorkerState("chain_stats", {
      block: next.block,
      coin_price_usd: next.coinPriceUsd,
      fetched_at: new Date(next.fetchedAt).toISOString(),
    });
    return next;
  } catch (err) {
    console.error(`⚠️  Bubblemaps could not refresh Blockscout stats: ${err.message}`);
    if (storedStats.block > 0 && storedStats.coinPriceUsd > 0) {
      cachedStats = storedStats;
      return cachedStats;
    }
    throw err;
  }
}

async function getTokenLaunch(token) {
  if (token.launch_checked_at && Date.now() - Date.parse(token.launch_checked_at) < 24 * 60 * 60 * 1000) {
    return { blockNumber: Number(token.launch_block || 0), timestamp: token.launch_timestamp || null };
  }
  const address = await blockscout(`/addresses/${token.token_address}`);
  const transactionHash = address.creation_transaction_hash;
  if (!transactionHash) {
    await query("UPDATE bubblemap_tokens SET launch_checked_at = now() WHERE token_address = $1", [token.token_address]);
    return { blockNumber: 0, timestamp: null };
  }
  const transaction = await blockscout(`/transactions/${transactionHash}`);
  const block = Number(transaction.block_number || 0);
  const timestamp = transaction.timestamp || null;
  await query(
    `UPDATE bubblemap_tokens SET launch_block = $2, launch_timestamp = $3, launch_checked_at = now()
     WHERE token_address = $1`,
    [token.token_address, block || null, timestamp]
  );
  return { blockNumber: block, timestamp };
}

async function refreshTokenPrice(token) {
  if (token.price_checked_at && Date.now() - Date.parse(token.price_checked_at) < 6 * 60 * 60 * 1000) return token;
  const details = await blockscout(`/tokens/${token.token_address}`);
  const rate = Number(details.exchange_rate);
  const exchangeRate = Number.isFinite(rate) && rate > 0 ? rate : null;
  const totalSupply = details.total_supply == null ? token.total_supply : String(details.total_supply);
  const parsedDecimals = Number(details.decimals);
  const decimals = Number.isInteger(parsedDecimals) && parsedDecimals >= 0 && parsedDecimals <= 255
    ? parsedDecimals
    : Number(token.decimals || 18);
  await query(
    `UPDATE bubblemap_tokens SET exchange_rate = $2, total_supply = COALESCE($3, total_supply),
       decimals = $4, price_checked_at = now(), updated_at = now()
     WHERE token_address = $1`,
    [token.token_address, exchangeRate, totalSupply, decimals]
  );
  return { ...token, exchange_rate: exchangeRate, total_supply: totalSupply, decimals };
}

async function analyzeOneToken(originalToken, stats, entities, overrides) {
  let token = originalToken;
  try {
    token = await refreshTokenPrice(token);
  } catch (err) {
    console.error(`⚠️  Bubblemaps token price refresh failed for ${token.token_address}: ${err.message}`);
  }
  const [holdersResult, transferResult] = await Promise.all([
    query(
      `SELECT holder_address, balance, is_contract, address_data
       FROM bubblemap_token_holders WHERE token_address = $1
       ORDER BY balance::numeric DESC LIMIT $2`,
      [token.token_address, BUBBLEMAP_CONFIG.holdersTopN]
    ),
    query(
      `SELECT t.transaction_hash, t.log_index, t.block_number, t.transfer_timestamp, t.from_address, t.to_address,
              t.value, t.token_type, (t.has_nft OR COALESCE(n.has_nft, false)) AS has_nft
       FROM bubblemap_token_transfers t
       LEFT JOIN bubblemap_native_transfers n ON n.transaction_hash = t.transaction_hash
       WHERE t.token_address = $1 ORDER BY t.block_number ASC, t.log_index ASC`,
      [token.token_address]
    ),
  ]);
  const holders = holdersResult?.rows || [];
  const holderAddresses = holders.map((holder) => holder.holder_address);
  const nativeResult = holderAddresses.length
    ? await query(
        `SELECT transaction_hash, block_number, transfer_timestamp AS timestamp, from_address AS "from",
                to_address AS "to", value, has_nft
         FROM bubblemap_native_transfers
         WHERE from_address = ANY($1::text[]) OR to_address = ANY($1::text[])`,
        [holderAddresses]
      )
    : { rows: [] };
  const tokenTransfers = transferResult?.rows || [];
  const etnTransfers = nativeResult?.rows || [];
  const interactions = [
    ...tokenTransfers.map((transfer) => ({
      from: transfer.from_address,
      to: transfer.to_address,
      value: transfer.value,
      has_nft: transfer.has_nft,
      kind: "token",
      decimals: token.decimals,
      token_price_usd: Number(token.exchange_rate || 0),
    })),
    ...etnTransfers.map((transfer) => ({
      from: transfer.from,
      to: transfer.to,
      value: transfer.value,
      has_nft: transfer.has_nft,
      kind: "etn",
      coin_price_usd: stats.coinPriceUsd,
    })),
  ];
  const relatedAddresses = new Set([...holderAddresses]);
  for (const transfer of interactions) {
    relatedAddresses.add(String(transfer.from).toLowerCase());
    relatedAddresses.add(String(transfer.to).toLowerCase());
  }
  const relatedList = [...relatedAddresses].filter(isAddress);
  const addressResult = relatedList.length
    ? await query(
        `SELECT address, is_contract, name, ens_domain_name, public_tags, private_tags,
                first_funder, degree, degree_complete
         FROM bubblemap_addresses WHERE address = ANY($1::text[])`,
        [relatedList]
      )
    : { rows: [] };
  const addressMap = new Map((addressResult?.rows || []).map((row) => [row.address, row]));
  const holderInput = holders.map((holder) => {
    const data = holder.address_data || {};
    return {
      address: {
        ...data,
        hash: holder.holder_address,
        is_contract: holder.is_contract ?? data.is_contract,
      },
      value: holder.balance,
    };
  });
  let launch = { blockNumber: Number(token.launch_block || 0), timestamp: token.launch_timestamp || null };
  try {
    launch = await getTokenLaunch(token);
  } catch (err) {
    console.error(`⚠️  Bubblemaps launch lookup failed for ${token.token_address}: ${err.message}`);
  }
  const output = analyzeBubblemap({
    token: token.token_address,
    holders: holderInput,
    addresses: addressMap,
    entities,
    overrides,
    tokenTransfers,
    etnTransfers,
    interactions,
    tokenPriceUsd: Number(token.exchange_rate || 0),
    coinPriceUsd: stats.coinPriceUsd,
    totalSupply: token.total_supply,
    decimals: Number(token.decimals || 18),
    launch,
    computedAtBlock: stats.block,
  });
  await query(
    `UPDATE bubblemap_tokens SET map_json = $2, map_updated_at = now(), analysis_dirty = false,
       last_error = NULL, updated_at = now() WHERE token_address = $1`,
    [token.token_address, output]
  );
}

async function saveCalibrationReport() {
  const [maps, hubs] = await Promise.all([
    query(
      `SELECT token_address, symbol, name, map_json->'calibration' AS calibration,
              map_json->'score_parts' AS score_parts, map_json->>'score' AS score
       FROM bubblemap_tokens WHERE map_json IS NOT NULL
       ORDER BY COALESCE(symbol, name, token_address)`
    ),
    query(
      `SELECT address, name, degree FROM bubblemap_addresses
       WHERE degree > $1 ORDER BY degree DESC, address LIMIT 10`,
      [BUBBLEMAP_CONFIG.hubDegree]
    ),
  ]);
  const report = {
    generated_at: new Date().toISOString(),
    token_count: maps?.rows?.length || 0,
    tokens: (maps?.rows || []).map((row) => ({
      token: row.token_address,
      symbol: row.symbol,
      name: row.name,
      holders_considered: row.calibration?.holders_considered || 0,
      cluster_count: row.calibration?.cluster_count || 0,
      largest_cluster_holder_share_pct: row.calibration?.largest_cluster_holder_share_pct || 0,
      largest_cluster_supply_pct: row.score_parts?.largest_cluster_pct || 0,
      edge_counts: row.calibration?.edge_counts || {},
      giant_cluster_guard_raised: row.calibration?.giant_cluster_guard_raised || 0,
      score: row.score == null ? null : Number(row.score),
    })),
    top_hubs: (hubs?.rows || []).map((row) => ({ address: row.address, label: row.name || null, degree: row.degree })),
  };
  await setWorkerState("calibration_report", report);
}

async function analyzeDirtyMaps(stats) {
  const entities = await getEntities();
  const overrides = await getOverrides();
  for (let index = 0; index < MAX_MAPS_PER_TICK; index++) {
    const result = await query(
      `      SELECT token_address, name, symbol, decimals, total_supply, exchange_rate, price_checked_at,
              launch_block, launch_timestamp, launch_checked_at
       FROM bubblemap_tokens
       WHERE analysis_dirty = true AND holders_refreshed_at IS NOT NULL AND transfer_backfill_complete = true
       ORDER BY map_updated_at ASC NULLS FIRST, updated_at ASC LIMIT 1`
    );
    const token = result?.rows?.[0];
    if (!token) break;
    try {
      await analyzeOneToken(token, stats, entities, overrides);
    } catch (err) {
      await query(
        `UPDATE bubblemap_tokens SET last_error = $2, updated_at = now() WHERE token_address = $1`,
        [token.token_address, String(err.message || err).slice(0, 1000)]
      );
      console.error(`⚠️  Bubblemaps analysis failed for ${token.token_address}: ${err.message}`);
      break;
    }
  }
  await saveCalibrationReport();
}

export async function runBubblemapWorkerTick() {
  if (!getPool()) return { enabled: false };
  if (workerRunning) return { skipped: true };
  workerRunning = true;
  try {
    await syncTokenCatalog();
    const stats = await getCurrentStats();
    await processHolderPages();
    await processTransferPages();
    await finalizeDegreeCache();
    await processAddresses();
    await analyzeDirtyMaps(stats);
    return { enabled: true, block: stats.block };
  } finally {
    workerRunning = false;
  }
}

export function startBubblemapWorker() {
  if (workerStarted) return;
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not configured — Bubblemaps worker disabled");
    return;
  }
  workerStarted = true;
  console.log(
    `🫧 Bubblemaps worker started — ${BUBBLEMAP_CONFIG.blockscoutRps} Blockscout requests/sec, ` +
      `${BUBBLEMAP_CONFIG.maxTxPagesPerAddress} transaction pages/address per pass`
  );
  const schedule = () => {
    const timer = setTimeout(async () => {
      try {
        await runBubblemapWorkerTick();
      } catch (err) {
        console.error(`⚠️  Bubblemaps worker tick failed: ${err.message}`);
      } finally {
        schedule();
      }
    }, BUBBLEMAP_CONFIG.workerTickMs);
    timer.unref?.();
  };
  schedule();
}
