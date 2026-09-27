import { useEffect, useRef } from "react";
import { track } from "@vercel/analytics";

// Free-dashboard usage tracking (unique visitors + visit counts come from Vercel Web Analytics
// itself, via the <Analytics/> component mounted in main.jsx — this hook only adds what that
// doesn't give out of the box: how long a visit lasts, and which tab gets used).
//
// Requires "Web Analytics" to be turned on for this project in the Vercel dashboard (Project ->
// Analytics -> Enable) — that's a one-time account-side setting, nothing this code can flip.
//
// `track()` fires a custom event Vercel's dashboard groups under "Events" — properties should be
// small, low-cardinality strings (a bucket/label), not raw numbers or anything per-visitor, so the
// grouped view stays meaningful instead of one row per unique value.
function durationBucket(ms) {
  const s = ms / 1000;
  if (s < 10) return "<10s";
  if (s < 30) return "10-30s";
  if (s < 120) return "30s-2m";
  if (s < 300) return "2-5m";
  if (s < 900) return "5-15m";
  return "15m+";
}

/** Call once, near the top of the dashboard's root component. Fires one "session_duration" custom
 * event per visit, sent on tab-hide/unload (not on a timer) so it reflects real time spent rather
 * than firing early. `visibilitychange` is used over `beforeunload`/`pagehide` alone because it's
 * the one event mobile Safari reliably fires before backgrounding a tab. */
export function useSessionAnalytics() {
  const startRef = useRef(Date.now());
  const sentRef = useRef(false);

  useEffect(() => {
    function sendOnce() {
      if (sentRef.current) return;
      sentRef.current = true;
      track("session_duration", { bucket: durationBucket(Date.now() - startRef.current) });
    }
    function handleVisibility() {
      if (document.visibilityState === "hidden") sendOnce();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", sendOnce);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", sendOnce);
    };
  }, []);
}

/** Call from the tab-change handler with the tab id being switched TO. Gives a basic "which tabs
 * get used" breakdown in Vercel's Events view, on top of the raw page-load pageview count Vercel
 * already tracks for the shared dashboard URL (most tab switches don't change the path). */
export function trackTabView(tabId) {
  track("tab_view", { tab: tabId });
}
