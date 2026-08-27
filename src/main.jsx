import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

// dashboard.planetzephyros.xyz and the main ENS site (nameservice.planetzephyros.xyz) are two
// completely different apps sharing one build/deploy — both custom domains point at the same
// Vercel project, and this is the client-side split between them. Each branch is a *dynamic*
// import specifically so the other app's module graph (and its side effects — createAppKit()
// below talks to WalletConnect's infra on load) never loads at all for a visitor on the other
// domain. Matches this app's existing "check window.location, branch client-side" convention
// already used for the /pay/, /subnames/, /marketplace deep links in App.jsx.
const isDashboardHost = /^dashboard\./i.test(window.location.hostname) || new URLSearchParams(window.location.search).has("__dashboard_test");

// <title>/favicon live in the one static index.html both apps share, so a dashboard visitor was
// getting "ETN Subdomain Service (ENS)" and that app's rocket-logo favicon regardless — set here,
// same "check window.location, branch client-side" pattern as isDashboardHost itself, rather than
// two separate HTML files (Vercel serves one build from one project; see the header comment
// above for why that's a deliberate constraint, not an oversight).
if (isDashboardHost) {
  document.title = "Electroneum Dashboard | Planet Zephyros";
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = "/PlanetZephyrosLogo.png";
}

async function mount() {
  const root = ReactDOM.createRoot(document.getElementById('root'));

  if (isDashboardHost) {
    const { default: DashboardApp } = await import('./dashboard/DashboardApp.jsx');
    root.render(
      <React.StrictMode>
        <DashboardApp />
      </React.StrictMode>,
    );
    return;
  }

  const [{ default: App }] = await Promise.all([
    import('./App.jsx'),
    import('./hooks/useReownWallet.jsx'), // side effect: createAppKit() — same as before
  ]);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

mount();
