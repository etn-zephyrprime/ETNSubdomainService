import { getMembership } from "../db/premiumMemberships.js";

// Core tier (the first feature-gated premium tier beyond PnL Statements — see
// premiumDashboardRouter.js) accepts EITHER of PremiumSubscription's two independent membership
// tiers, not just monthly. The two are tracked separately on-chain and in premium_memberships
// because only annual grants the PnL statement discount (see that table's own header comment) —
// but for gating a plain feature on/off, an annual member has already paid for (at least) as much
// access as a monthly one, so requiring them to *also* buy monthly separately would be a real
// product wart, not a meaningful distinction. Confirmed decision, not an oversight.
export async function hasCoreAccess(walletAddress) {
  const membership = await getMembership(walletAddress);
  if (!membership) return false;

  const now = Date.now();
  const monthlyActive = membership.monthly_expiry && new Date(membership.monthly_expiry).getTime() > now;
  const annualActive = membership.annual_expiry && new Date(membership.annual_expiry).getTime() > now;
  return !!(monthlyActive || annualActive);
}
