import React, { useState, useEffect } from "react";
import { useReownWallet } from "./hooks/useReownWallet.jsx";
import { panel, muted } from "./styles/theme.js";
import SearchBar from "./components/SearchBar.jsx";
import RegistrationFlow from "./components/RegistrationFlow.jsx";
import ManageSubdomain from "./components/ManageSubdomain.jsx";
import SubnameSearch from "./components/SubnameSearch.jsx";
import PayFlow from "./components/PayFlow.jsx";
import Marketplace from "./components/Marketplace.jsx";
import HowItWorks from "./components/HowItWorks.jsx";
import Header from "./components/Header.jsx";
import Footer from "./components/Footer.jsx";
import NeonButton from "./components/NeonButton.jsx";
import BurnPoolCard from "./components/BurnPoolCard.jsx";

function AppContent() {
  const SUSPENDED = false; // flip to false to restore access
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  if (SUSPENDED) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "#011528",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "40px 20px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}>
        <Header wallet={null} isMobile={isMobile} hideWallet={true} />

        <div style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          color: "#fff",
        }}>
          <div>
            <h1 style={{ fontSize: 24, marginBottom: 12 }}>Temporarily Unavailable</h1>
            <p style={{ color: "#999" }}>We'll be back shortly.</p>
          </div>
        </div>
      </div>
    );
  }

  const wallet = useReownWallet();
  // ...rest unchanged

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const [selectedName, setSelectedName] = useState(null);
  const [showManageSubdomain, setShowManageSubdomain] = useState(false);
  const [manageIntent, setManageIntent] = useState("manage"); // "manage" | "retro"
  const [showSubnameSearch, setShowSubnameSearch] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [payPrefillName, setPayPrefillName] = useState(null);
  const [showMarketplace, setShowMarketplace] = useState(false);

  // Deep link: /pay/alice.etn (or /pay/shop.alice.etn, /pay/alice with no suffix) opens straight
  // to the Pay screen with that name pre-filled — e.g. for a payment request shared in Telegram.
  // Requires vercel.json's catch-all rewrite so a direct hit on this path serves index.html
  // instead of 404ing before React ever loads. Unlike the "Pay" button below, this doesn't gate
  // on connecting a wallet first — someone opening a payment link should see who/what it's for
  // before being asked to connect; PayFlow's own Send button handles that when they act on it.
  useEffect(() => {
    const match = window.location.pathname.match(/^\/pay\/([^/]+)\/?$/i);
    if (match) {
      setPayPrefillName(decodeURIComponent(match[1]));
      setShowPay(true);
    }
  }, []);

  const handleNameSelected = async (nameData) => {
    if (!wallet.isConnected) {
      await wallet.connectWallet();
      return;
    }
    try {
      await wallet.ensureCorrectNetwork();
    } catch (err) {
      console.error("Network switch failed:", err);
      return;
    }
    setSelectedName(nameData);
  };

  const handleBack = () => setSelectedName(null);

  const handleManageSubdomain = async () => {
    if (!wallet.isConnected) {
      await wallet.connectWallet();
      return;
    }
    try {
      await wallet.ensureCorrectNetwork();
    } catch (err) {
      console.error("Network switch failed:", err);
      return;
    }
    setManageIntent("manage");
    setShowManageSubdomain(true);
  };

  const handleRetroRegister = async () => {
    if (!wallet.isConnected) {
      await wallet.connectWallet();
      return;
    }
    try {
      await wallet.ensureCorrectNetwork();
    } catch (err) {
      console.error("Network switch failed:", err);
      return;
    }
    setManageIntent("retro");
    setShowManageSubdomain(true);
  };

  const handleBackFromManage = () => setShowManageSubdomain(false);

  const handleSubnameSearch = async () => {
    if (!wallet.isConnected) {
      await wallet.connectWallet();
      return;
    }
    try {
      await wallet.ensureCorrectNetwork();
    } catch (err) {
      console.error("Network switch failed:", err);
      return;
    }
    setShowSubnameSearch(true);
  };

  const handleBackFromSubnameSearch = () => setShowSubnameSearch(false);

  const handlePay = async () => {
    if (!wallet.isConnected) {
      await wallet.connectWallet();
      return;
    }
    try {
      await wallet.ensureCorrectNetwork();
    } catch (err) {
      console.error("Network switch failed:", err);
      return;
    }
    setShowPay(true);
  };

  const handleBackFromPay = () => {
    setShowPay(false);
    setPayPrefillName(null);
    // Drop back to "/" so the deep link doesn't reopen Pay on a refresh, and so a shared link's
    // name doesn't linger for whatever the user does next.
    if (window.location.pathname !== "/") {
      window.history.replaceState(null, "", "/");
    }
  };

  // Browsing listings is read-only, so — unlike every other button here — this doesn't gate on
  // connecting a wallet first; Marketplace's own Buy button handles that when someone acts on it.
  const handleMarketplace = () => setShowMarketplace(true);
  const handleBackFromMarketplace = () => setShowMarketplace(false);

  const handleRegistrationSuccess = (result) => {
    console.log("Registration successful:", result);
  };

  const showingMainSearch = !selectedName && !showManageSubdomain && !showSubnameSearch && !showPay && !showMarketplace;

  return (
    <div style={{
      minHeight: "100vh",
      background: "#011528",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "40px 20px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <Header wallet={wallet} isMobile={isMobile} />

      <div style={{ width: "100%", marginBottom: 40 }}>
        {showingMainSearch ? (
          <>
            <SearchBar
              key={wallet.isConnected ? "connected" : "disconnected"}
              wallet={wallet}
              onNameSelected={handleNameSelected}
            />
            <div style={{
              width: "100%",
              maxWidth: 600,
              margin: "16px auto 0",
              padding: "0 16px",
              display: "flex",
              gap: 12,
            }}>
              <NeonButton
                variant="dark"
                onClick={handleManageSubdomain}
                style={{ flex: 1, justifyContent: "center" }}
              >
                Manage & Resell
              </NeonButton>
              <NeonButton
                variant="dark"
                onClick={handleSubnameSearch}
                style={{ flex: 1, justifyContent: "center" }}
              >
                Get a Subname
              </NeonButton>
            </div>
            <div style={{ width: "100%", maxWidth: 600, margin: "12px auto 0", padding: "0 16px" }}>
              <NeonButton
                variant="dark"
                onClick={handleRetroRegister}
                style={{ width: "100%", justifyContent: "center" }}
              >
                Register Subdomain | Set Subname Pricing
              </NeonButton>
            </div>
            <div style={{ width: "100%", maxWidth: 600, margin: "12px auto 0", padding: "0 16px", display: "flex", gap: 12 }}>
              <NeonButton
                variant="green"
                onClick={handlePay}
                style={{ flex: 1, justifyContent: "center" }}
              >
                Pay / Receive
              </NeonButton>
              <NeonButton
                variant="dark"
                onClick={handleMarketplace}
                style={{ flex: 1, justifyContent: "center" }}
              >
                Marketplace
              </NeonButton>
            </div>

            <HowItWorks />
            <BurnPoolCard wallet={wallet} />
          </>
        ) : selectedName ? (
          <RegistrationFlow
            nameData={selectedName}
            wallet={wallet}
            onBack={handleBack}
            onSuccess={handleRegistrationSuccess}
          />
        ) : showManageSubdomain ? (
          <ManageSubdomain
            wallet={wallet}
            onBack={handleBackFromManage}
            intent={manageIntent}
          />
        ) : showSubnameSearch ? (
          <SubnameSearch
            wallet={wallet}
            onBack={handleBackFromSubnameSearch}
          />
        ) : showPay ? (
          <PayFlow
            wallet={wallet}
            onBack={handleBackFromPay}
            initialRecipient={payPrefillName}
          />
        ) : (
          <Marketplace
            wallet={wallet}
            onBack={handleBackFromMarketplace}
          />
        )}
      </div>

      <Footer isMobile={isMobile} />
    </div>
  );
}

export default AppContent;
