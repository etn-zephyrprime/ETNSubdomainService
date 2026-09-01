import React, { useState, Suspense, lazy } from "react";
import DashboardHeader from "./components/DashboardHeader.jsx";
import { greenGlow, mutedLight, background } from "./theme.js";
import DashboardNav from "./components/DashboardNav.jsx";
import DashboardFooter from "./components/DashboardFooter.jsx";
import Overview from "./components/Overview.jsx";
import TokenLeaderboard from "./components/TokenLeaderboard.jsx";
import TokenDetail from "./components/TokenDetail.jsx";
import AddressLookup from "./components/AddressLookup.jsx";
import NameServiceStats from "./components/NameServiceStats.jsx";

// Premium Feature #1 (per-wallet PnL statements) — the one wallet-requiring tab on this otherwise
// walletless dashboard. Loaded via React.lazy specifically so importing it (and the
// WalletConnect/AppKit side effect that import chain triggers — see useReownWallet.jsx) only
// happens once a visitor actually clicks the Premium tab, preserving the "no wallet code loads at
// all for a dashboard visitor who never touches this" property the rest of this file's own
// original comment already established for every other tab.
const PremiumDashboardSection = lazy(() => import("./premium/PremiumDashboardSection.jsx"));

// Free-tier Electroneum on-chain dashboard — read-only, no login required for every tab except
// Premium (see that lazy import above). Everything else here stays exactly as walletless as
// before: no top-level import of useReownWallet.jsx anywhere outside the Premium tab's own lazy
// chunk, so main.jsx's hostname-based dynamic import still keeps the Reown/WalletConnect bundle
// (and its network calls) out of the base dashboard build for visitors who never open Premium.
export default function DashboardApp() {
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  // /pnl opens straight to the Premium (PnL Statement) tab — the feature's canonical link,
  // dashboard.planetzephyros.xyz/pnl. /premium is kept working too, purely for backward
  // compatibility: it's the path already baked into the "Request another statement" link on every
  // PDF generated before this path was renamed (see PREMIUM_TAB_URL history in
  // pnlStatementGenerator.js) — those frozen artifacts can't be edited after the fact. Same
  // deep-link spirit as /statement/:requestId below.
  const [tab, setTab] = useState(() => (/^\/(statement\/[^/]+|premium|pnl)\/?$/i.test(window.location.pathname) ? "premium" : "overview"));
  const [selectedToken, setSelectedToken] = useState(null);
  // Which address Address Lookup should open on next — named generically since it's fed from
  // more than one source now (TokenDetail's holder links, Overview's validator links), not just
  // tokens.
  const [addressToLookUp, setAddressToLookUp] = useState(null);

  // Deep link: /statement/:requestId opens straight to the Premium tab's statement viewer with
  // that request ID — e.g. from a link the purchaser saved or shared. Read once on mount (the tab
  // state above already captures it for the initial render); this just extracts the id itself.
  // Deliberately NOT gated on connecting a wallet — access is tx-hash/request-ID based by design,
  // so a shared link works for anyone, including a visitor who never touches Premium's wallet
  // features otherwise.
  const [statementRequestId] = useState(() => {
    const match = window.location.pathname.match(/^\/statement\/([^/]+)\/?$/i);
    return match ? decodeURIComponent(match[1]) : null;
  });

  React.useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleTabChange = (id) => {
    setTab(id);
    setSelectedToken(null);
  };

  const handleSelectAddress = (address) => {
    setAddressToLookUp(address);
    setTab("address");
  };

  const handleSelectTokenFromAddress = (tokenAddress) => {
    setSelectedToken(tokenAddress);
    setTab("tokens");
  };

  return (
    <div style={{
      minHeight: "100vh",
      background,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      padding: "40px 16px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <DashboardHeader isMobile={isMobile} />

      <div style={{ width: "100%", maxWidth: 900 }}>
        <div style={{ marginBottom: 24, textAlign: "center" }}>
          <div style={{
            fontFamily: "Orbitron, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            fontWeight: 700,
            fontSize: isMobile ? 24 : 32,
            letterSpacing: 1,
            color: "#fff",
            textShadow: `0 0 16px ${greenGlow}`,
          }}>
            Electroneum Dashboard
          </div>
          <div style={{ fontSize: 13, color: mutedLight, marginTop: 8 }}>
            Live network stats, activity, tokens, and wallet lookup.
          </div>
        </div>

        <DashboardNav active={tab} onChange={handleTabChange} />

        {tab === "overview" && <Overview onSelectAddress={handleSelectAddress} />}
        {tab === "tokens" && (
          selectedToken ? (
            <TokenDetail
              address={selectedToken}
              onBack={() => setSelectedToken(null)}
              onSelectAddress={handleSelectAddress}
            />
          ) : (
            <TokenLeaderboard onSelectToken={setSelectedToken} />
          )
        )}
        {tab === "address" && <AddressLookup key={addressToLookUp} initialAddress={addressToLookUp} onSelectToken={handleSelectTokenFromAddress} />}
        {tab === "nameservice" && <NameServiceStats />}
        {tab === "premium" && (
          <Suspense fallback={<div style={{ textAlign: "center", color: mutedLight, fontSize: 13, padding: "40px 0" }}>Loading…</div>}>
            <PremiumDashboardSection initialStatementRequestId={statementRequestId} />
          </Suspense>
        )}
      </div>

      <DashboardFooter isMobile={isMobile} />
    </div>
  );
}
