-- Adds NFT (ERC-721/ERC-1155) support to ingested_transfers. Previously any token-transfer was
-- assumed fungible (asset_type constrained to 'native'/'erc20'), so an NFT transfer's amount_raw
-- collapsed to 0 (Blockscout's NFT transfer shape has no `total.value`, only `total.token_id`) and
-- got silently filtered out everywhere amount_raw = 0 is treated as "nothing happened" — see
-- pnlIngestion.js's own updated comment on this fix.
ALTER TABLE ingested_transfers DROP CONSTRAINT IF EXISTS ingested_transfers_asset_type_check;
ALTER TABLE ingested_transfers ADD CONSTRAINT ingested_transfers_asset_type_check
  CHECK (asset_type IN ('native', 'erc20', 'erc721', 'erc1155'));

-- Null for native/erc20 rows; the specific NFT's identifier within its collection for erc721/
-- erc1155 rows — this is what makes each NFT a distinct, individually-cost-tracked asset (see
-- fifoLotEngine.js's lot key convention: NFT lots are keyed "tokenAddress:tokenId", not just
-- tokenAddress, since unlike a fungible token every tokenId has its own unique cost basis).
ALTER TABLE ingested_transfers ADD COLUMN IF NOT EXISTS token_id TEXT;
