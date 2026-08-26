import React, { useState } from "react";
import Header from "../components/Header.jsx";
import { muted, mutedLight } from "./theme.js";
import DashboardNav from "./components/DashboardNav.jsx";
import DashboardFooter from "./components/DashboardFooter.jsx";
import Overview from "./components/Overview.jsx";
import TokenLeaderboard from "./components/TokenLeaderboard.jsx";
import TokenDetail from "./components/TokenDetail.jsx";
import AddressLookup from "./components/AddressLookup.jsx";

// Free-tier Electroneum on-chain dashboard — read-only, no login required (see the build brief:
// premium tracked-wallet/subscription/PnL features are a separate, later pass). Deliberately
// walletless: no import of useReownWallet.jsx anywhere in this tree, so main.jsx's hostname-based
// dynamic import keeps the Reown/WalletConnect bundle (and its network calls) out of this build
// entirely for visitors who land on dashboard.planetzephyros.xyz.
export default function DashboardApp() {
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [tab, setTab] = useState("overview");
  const [selectedToken, setSelectedToken] = useState(null);
  const [addressFromToken, setAddressFromToken] = useState(null);

  React.useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleTabChange = (id) => {
    setTab(id);
    setSelectedToken(null);
  };

  const handleSelectAddressFromToken = (address) => {
    setAddressFromToken(address);
    setTab("address");
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#011528",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      padding: "40px 16px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <Header wallet={null} isMobile={isMobile} hideWallet={true} />

      <div style={{ width: "100%", maxWidth: 900 }}>
        <div style={{ marginBottom: 24, textAlign: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted }}>
            Electroneum Dashboard
          </div>
          <div style={{ fontSize: 13, color: mutedLight, marginTop: 4 }}>
            Live network stats, activity, tokens, and wallet lookup.
          </div>
        </div>

        <DashboardNav active={tab} onChange={handleTabChange} />

        {tab === "overview" && <Overview />}
        {tab === "tokens" && (
          selectedToken ? (
            <TokenDetail
              address={selectedToken}
              onBack={() => setSelectedToken(null)}
              onSelectAddress={handleSelectAddressFromToken}
            />
          ) : (
            <TokenLeaderboard onSelectToken={setSelectedToken} />
          )
        )}
        {tab === "address" && <AddressLookup key={addressFromToken} initialAddress={addressFromToken} />}
      </div>

      <DashboardFooter />
    </div>
  );
}
