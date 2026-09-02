-- Convenience view for ad-hoc querying in Supabase — joins every ingested transfer to the CEX
-- dimension table (cex_addresses) by its counterparty_address, so a CEX label is available
-- directly on each row without writing the join by hand each time.
--
-- Deliberately does NOT read ingested_transfers.is_cex — that column is computed once, at
-- ingestion time, and ingestion is incremental (only scans blocks newer than the wallet's last
-- ingested one — see wallet_ingestion_state). Confirmed live: a CEX address added to
-- cex_addresses *after* a wallet's history was already ingested never retroactively updates that
-- stored column, no matter how many times a statement is later regenerated for that wallet — see
-- pnlStatementGenerator.js's own fix for the identical problem in statement generation itself.
-- This view re-derives CEX status live via the join instead, so it's never stale: it always
-- reflects whatever's currently in cex_addresses, the same source of truth the PDF generator now
-- uses.
--
-- is_cex (the raw stored column) is still included below for transparency/comparison against the
-- live-derived is_known_cex — a mismatch between the two on an old row is expected and just means
-- that counterparty was identified as a CEX after that row was ingested.
CREATE OR REPLACE VIEW ingested_transfers_with_cex AS
SELECT
  t.*,
  cex.label AS cex_label,
  cex.added_by AS cex_added_by,
  (cex.address IS NOT NULL) AS is_known_cex
FROM ingested_transfers t
LEFT JOIN cex_addresses cex ON cex.address = LOWER(t.counterparty_address);
