import React, { useState } from "react";
import DashboardHeader from "./components/DashboardHeader.jsx";
import { greenGlow, mutedLight, background } from "./theme.js";
import DashboardNav from "./components/DashboardNav.jsx";
import DashboardFooter from "./components/DashboardFooter.jsx";
import Overview from "./components/Overview.jsx";
import TokenLeaderboard from "./components/TokenLeaderboard.jsx";
import TokenDetail from "./components/TokenDetail.jsx";
import AddressLookup from "./components/AddressLookup.jsx";
import NameServiceStats from "./components/NameServiceStats.jsx";

// Free-tier Electroneum on-chain dashboard — read-only, no login required (see the build brief:
// premium tracked-wallet/subscription/PnL features are a separate, later pass). Deliberately
// walletless: no import of useReownWallet.jsx anywhere in this tree, so main.jsx's hostname-based
// dynamic import keeps the Reown/WalletConnect bundle (and its network calls) out of this build
// entirely for visitors who land on dashboard.planetzephyros.xyz.
export default function DashboardApp() {
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [tab, setTab] = useState("overview");
  const [selectedToken, setSelectedToken] = useState(null);
  // Which address Address Lookup should open on next — named generically since it's fed from
  // more than one source now (TokenDetail's holder links, Overview's validator links), not just
  // tokens.
  const [addressToLookUp, setAddressToLookUp] = useState(null);

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
      </div>

      <DashboardFooter isMobile={isMobile} />
    </div>
  );
}
