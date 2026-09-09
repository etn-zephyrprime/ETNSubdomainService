import React, { useCallback, useEffect, useState } from "react";
import { Image as ImageIcon, RefreshCw, Info } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import { useNftPnlSnapshot } from "../../hooks/useNftPnlSnapshot.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { useTokenNames } from "../../hooks/useTokenNames.js";
import { formatUsdPrice } from "../../utils/format.js";
import { green, muted, mutedLight, error as errorColor, border, panel2 } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const sectionHeaderStyle = { fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 };
const selectStyle = { padding: "8px 12px", borderRadius: 10, border: `1px solid ${border}`, background: panel2, color: "#fff", fontSize: 12, fontWeight: 600, outline: "none" };

function pnlColor(v) {
  return v > 0 ? green : v < 0 ? errorColor : mutedLight;
}
function fmtSigned(v) {
  return `${v >= 0 ? "+" : ""}${formatUsdPrice(v)}`;
}
function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Core tier's ongoing NFT PnL — how much you've paid for NFTs, and, for anything sold, the
// realized gain/loss, at three tiers: across every NFT, per collection, and per specific token ID.
// Built on the EXACT SAME FIFO/cost-basis matching the PnL Statement product's NFT handling uses
// (see nftPnlService.js's own header comment) so this can never disagree with a Statement for the
// same wallet/NFT/timestamp.
//
// Deliberately has NO "current value" / unrealized P&L for a still-held NFT — there's no market-
// price feed for one specific NFT the way there is for a fungible token (see nftPnlService.js's own
// comment on why). This only ever reports what's actually known: what was paid, and — once sold —
// what came back and the resulting gain or loss.
export default function CoreTierNftPnl({ wallet, getAuthParams, coreTierAccess, walletFilter }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } = coreTierAccess;
  const { getNftPnlSnapshot } = useNftPnlSnapshot();
  const { resolve: resolveWalletName } = useDisplayNames(active.map((w) => w.address));

  const [snapshot, setSnapshot] = useState(null); // { perWallet, combined } | null
  const [snapshotError, setSnapshotError] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  const loadSnapshot = useCallback(async () => {
    setSnapshotLoading(true);
    setSnapshotError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await getNftPnlSnapshot(wallet.account, signature, timestamp);
      setSnapshot(res);
    } catch (err) {
      setSnapshotError(err.message || "Couldn't compute your NFT PnL");
    } finally {
      setSnapshotLoading(false);
    }
  }, [getAuthParams, getNftPnlSnapshot, wallet.account]);

  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setSnapshot(null);
      return;
    }
    loadSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, active]);

  // Same per-wallet-entry-has-the-combined-shape convention as CoreTierPnl.jsx's own walletFilter
  // handling — a drop-in swap, nothing downstream needs to know which it's looking at.
  const combined = walletFilter === "all" ? snapshot?.combined : snapshot?.perWallet?.find((w) => w.walletAddress === walletFilter);
  const filteredWalletFailed = walletFilter !== "all" && (snapshot?.failed || []).includes(walletFilter);

  const { resolve: resolveCollectionName } = useTokenNames((combined?.byCollection || []).map((c) => c.collectionAddress));

  // Collection filter — local to this panel, same reasoning as CoreTierPnl.jsx's own token filter:
  // self-heals to "all" if the selected collection falls out of scope (wallet filter change, a
  // refresh with different results) instead of showing a blank filtered view.
  const [collectionFilterRaw, setCollectionFilter] = useState("all");
  const collectionFilter =
    collectionFilterRaw === "all" || (combined?.byCollection || []).some((c) => c.collectionAddress === collectionFilterRaw)
      ? collectionFilterRaw
      : "all";

  const scopeCollection = collectionFilter !== "all" ? combined?.byCollection.find((c) => c.collectionAddress === collectionFilter) : null;
  const figures =
    collectionFilter === "all"
      ? combined && {
          costBasisUsd: combined.totalCostBasisUsd,
          proceedsUsd: combined.proceedsUsd,
          realizedPnlUsd: combined.realizedPnlUsd,
          heldCount: combined.heldTokenCount,
          soldCount: combined.soldTokenCount,
        }
      : scopeCollection && {
          costBasisUsd: (Number(scopeCollection.heldCostBasisUsd) + Number(scopeCollection.soldCostBasisUsd)).toString(),
          proceedsUsd: scopeCollection.proceedsUsd,
          realizedPnlUsd: scopeCollection.realizedPnlUsd,
          heldCount: scopeCollection.heldTokenCount,
          soldCount: scopeCollection.soldTokenCount,
        };

  const collectionOptions = (combined?.byCollection || [])
    .slice()
    .sort((a, b) => b.heldTokenCount + b.soldTokenCount - (a.heldTokenCount + a.soldTokenCount));

  const tokenRows =
    collectionFilter === "all"
      ? []
      : (combined?.byToken || [])
          .filter((t) => t.collectionAddress === collectionFilter)
          .slice()
          .sort((a, b) => {
            const na = Number(a.tokenId);
            const nb = Number(b.tokenId);
            return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.tokenId.localeCompare(b.tokenId);
          });

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <ImageIcon size={18} color={green} />
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
            Core Tier — NFT PnL
          </div>
        </div>
        {hasAccess && active.length > 0 && (
          <DashboardButton
            onClick={loadSnapshot}
            disabled={snapshotLoading}
            style={{ background: "transparent", border: `1px solid ${border}`, color: mutedLight, boxShadow: "none", padding: "6px 12px", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}
          >
            <RefreshCw size={12} />
            {snapshotLoading ? "Refreshing…" : "Refresh"}
          </DashboardButton>
        )}
      </div>

      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="see cost basis and realized gains/losses for your NFTs"
      >
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>
            Track a wallet under Core Tier — Portfolio above to see its NFT PnL here.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
              <Info size={14} color={mutedLight} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.6 }}>
                Cost basis and realized gains/losses only — there's no live market price for one specific NFT the
                way there is for a token, so a held NFT shows what you paid but not an estimated current value.
                For an immutable, downloadable statement suitable for tax purposes,{" "}
                <a href="/pnl" style={{ color: green, textDecoration: "underline" }}>generate a PnL Statement</a>.
              </div>
            </div>

            {snapshotError && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{snapshotError}</div>}
            {walletFilter === "all" && snapshot?.failed?.length > 0 && snapshot?.combined && (
              <div style={{ fontSize: 11, color: errorColor, marginBottom: 12 }}>
                Couldn't compute NFT PnL for {snapshot.failed.map((a) => resolveWalletName(a)).join(", ")} right now — the figures below only
                reflect your other tracked wallet{snapshot.failed.length === active.length - 1 ? "" : "s"}. Try Refresh.
              </div>
            )}

            {!snapshot && !snapshotError ? (
              <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>Computing your NFT PnL — this can take a moment…</div>
            ) : filteredWalletFailed ? (
              <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
                Couldn't compute NFT PnL for {resolveWalletName(walletFilter)} right now — try Refresh.
              </div>
            ) : !combined && snapshot?.failed?.length > 0 ? (
              <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
                Couldn't compute NFT PnL for any of your tracked wallets right now — try Refresh.
              </div>
            ) : combined ? (
              <>
                {combined.unmatchedCount > 0 && (
                  <div style={{ fontSize: 11, color: mutedLight, marginBottom: 12, fontStyle: "italic" }}>
                    {combined.unmatchedCount} NFT transfer{combined.unmatchedCount === 1 ? "" : "s"} had no matching payment found in the
                    same transaction — recorded at $0 cost basis / proceeds for that leg (correct for a genuine free mint, airdrop, or
                    gift; understates a real cost/gain if the payment happened in a separate transaction).
                  </div>
                )}

                {combined.byCollection.length === 0 ? (
                  <div style={{ fontSize: 12, color: muted }}>No NFT activity found for your tracked wallet{active.length === 1 ? "" : "s"}.</div>
                ) : (
                  <>
                    {collectionOptions.length > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted }}>Collection</span>
                        <select value={collectionFilter} onChange={(e) => setCollectionFilter(e.target.value)} style={selectStyle}>
                          <option value="all">All collections</option>
                          {collectionOptions.map((c) => (
                            <option key={c.collectionAddress} value={c.collectionAddress}>{resolveCollectionName(c.collectionAddress)}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {figures && (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginBottom: 20 }}>
                        <div>
                          <div style={sectionHeaderStyle}>Total Paid</div>
                          <div style={{ fontSize: 20, fontWeight: 900, color: "#fff" }}>{formatUsdPrice(Number(figures.costBasisUsd))}</div>
                        </div>
                        <div>
                          <div style={sectionHeaderStyle}>Proceeds (Sold)</div>
                          <div style={{ fontSize: 20, fontWeight: 900, color: "#fff" }}>{formatUsdPrice(Number(figures.proceedsUsd))}</div>
                        </div>
                        <div>
                          <div style={sectionHeaderStyle}>Realized P&amp;L</div>
                          <div style={{ fontSize: 20, fontWeight: 900, color: pnlColor(Number(figures.realizedPnlUsd)) }}>
                            {fmtSigned(Number(figures.realizedPnlUsd))}
                          </div>
                        </div>
                        <div>
                          <div style={sectionHeaderStyle}>Held / Sold</div>
                          <div style={{ fontSize: 20, fontWeight: 900, color: "#fff" }}>
                            {figures.heldCount} <span style={{ color: mutedLight, fontSize: 14 }}>/</span> {figures.soldCount}
                          </div>
                        </div>
                      </div>
                    )}

                    {collectionFilter === "all" ? (
                      <div>
                        <div style={sectionHeaderStyle}>By Collection</div>
                        {collectionOptions.map((c) => {
                          const totalCost = Number(c.heldCostBasisUsd) + Number(c.soldCostBasisUsd);
                          return (
                            <button
                              key={c.collectionAddress}
                              type="button"
                              onClick={() => setCollectionFilter(c.collectionAddress)}
                              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "10px 0", borderBottom: `1px solid ${border}`, background: "none", border: "none", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: border, cursor: "pointer", textAlign: "left" }}
                            >
                              <span style={{ fontSize: 12, color: "#fff" }}>
                                {resolveCollectionName(c.collectionAddress)}
                                <span style={{ color: muted, marginLeft: 6 }}>
                                  ({c.heldTokenCount} held{c.soldTokenCount > 0 ? `, ${c.soldTokenCount} sold` : ""})
                                </span>
                              </span>
                              <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                <span style={{ fontSize: 12, color: mutedLight }}>{formatUsdPrice(totalCost)} paid</span>
                                {c.soldTokenCount > 0 && (
                                  <span style={{ fontSize: 12, fontWeight: 700, color: pnlColor(Number(c.realizedPnlUsd)) }}>
                                    {fmtSigned(Number(c.realizedPnlUsd))}
                                  </span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div>
                        <div style={sectionHeaderStyle}>{resolveCollectionName(collectionFilter)} — By Token ID</div>
                        {tokenRows.length === 0 ? (
                          <div style={{ fontSize: 12, color: muted }}>No tokens found for this collection.</div>
                        ) : (
                          <div style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                              <thead>
                                <tr style={{ textAlign: "left", color: muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>
                                  <th style={{ padding: "6px 8px 6px 0" }}>Token ID</th>
                                  <th style={{ padding: "6px 8px" }}>Status</th>
                                  <th style={{ padding: "6px 8px" }}>Paid</th>
                                  <th style={{ padding: "6px 8px" }}>Proceeds</th>
                                  <th style={{ padding: "6px 8px" }}>Realized P&amp;L</th>
                                  <th style={{ padding: "6px 0 6px 8px" }}>Date</th>
                                </tr>
                              </thead>
                              <tbody>
                                {tokenRows.map((t) => {
                                  const held = Number(t.quantityHeld) > 0;
                                  const sold = Number(t.quantitySold) > 0;
                                  const totalCost = Number(t.heldCostBasisUsd) + Number(t.soldCostBasisUsd);
                                  return (
                                    <tr key={`${t.collectionAddress}:${t.tokenId}`} style={{ borderTop: `1px solid ${border}` }}>
                                      <td style={{ padding: "8px 8px 8px 0", color: "#fff", fontWeight: 700 }}>#{t.tokenId}</td>
                                      <td style={{ padding: "8px" }}>
                                        <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, textTransform: "uppercase", background: held ? "rgba(24,187,26,0.12)" : "rgba(255,255,255,0.06)", color: held ? green : mutedLight }}>
                                          {held ? "Held" : "Sold"}
                                        </span>
                                      </td>
                                      <td style={{ padding: "8px", color: "#fff" }}>{formatUsdPrice(totalCost)}</td>
                                      <td style={{ padding: "8px", color: sold ? "#fff" : muted }}>{sold ? formatUsdPrice(Number(t.proceedsUsd)) : "—"}</td>
                                      <td style={{ padding: "8px", color: sold ? pnlColor(Number(t.realizedPnlUsd)) : muted, fontWeight: sold ? 700 : 400 }}>
                                        {sold ? fmtSigned(Number(t.realizedPnlUsd)) : "—"}
                                      </td>
                                      <td style={{ padding: "8px 0 8px 8px", color: mutedLight }}>{fmtDate(sold ? t.lastSoldAt : t.firstAcquiredAt)}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            ) : null}
          </>
        )}
      </CoreTierGate>
    </DashboardPanel>
  );
}
