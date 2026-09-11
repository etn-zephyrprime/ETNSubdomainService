import React from "react";
import { panel2, border, mutedLight, error as errorColor, green } from "../theme.js";

// React only recognizes an error boundary via these two class lifecycle methods -- there is no
// hooks equivalent (as of the React version this app builds against), so this is deliberately a
// class component even though every other component in this app is functional.
//
// Built specifically because of a real production incident: a bad value in a demo snapshot's data
// (Blockscout's raw JSON returns decimals as a STRING; ethers.formatUnits only accepts a NUMBER —
// see CoreTierDemo.jsx's own comment on the exact bug) threw uncaught during render, and with
// nothing anywhere in this app catching it, React unmounted the ENTIRE tree -- a blank/black
// screen with zero indication anything had even gone wrong, let alone what. That specific bug is
// fixed, but the underlying gap (one bad render anywhere blanks the whole page) was real
// independent of it, and will recur for some other reason eventually. This scopes the blast radius
// to whatever's wrapped (see DashboardApp.jsx: the tab content area, not the whole page — the
// header/nav/footer stay usable so a visitor can navigate away from the broken tab) and shows an
// actual message instead of nothing, with the real error logged to the console for debugging.
export default class DashboardErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Dashboard render error (caught by DashboardErrorBoundary):", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{
        padding: "40px 24px",
        borderRadius: 16,
        border: `1px solid ${border}`,
        background: panel2,
        textAlign: "center",
      }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
          Something went wrong loading this section
        </div>
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 20 }}>
          The rest of the dashboard is still fine — try refreshing, or come back to this section later.
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: "10px 20px",
            borderRadius: 10,
            border: `1px solid ${green}`,
            background: "transparent",
            color: green,
            fontSize: 12,
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          Refresh Page
        </button>
      </div>
    );
  }
}
