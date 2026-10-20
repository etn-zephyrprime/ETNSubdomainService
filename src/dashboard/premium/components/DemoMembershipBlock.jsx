import React from "react";
import { useReownWallet } from "../../../hooks/useReownWallet.jsx";
import MembershipPurchase from "./MembershipPurchase.jsx";

// The Premium Membership panel for the top of the Core Tier demo page. Its own module so
// CoreTierDemoPage.jsx can React.lazy it: that page is imported eagerly into DashboardApp.jsx and
// deliberately has no wallet-connection dependency (see its own header comment) — this is the one
// piece of it that needs the wallet, so the WalletConnect/AppKit bundle only loads when the demo opens.
export default function DemoMembershipBlock() {
  const wallet = useReownWallet();
  return <MembershipPurchase wallet={wallet} />;
}
