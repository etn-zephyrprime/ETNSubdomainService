import { useEffect, useRef } from "react";

// A "keep re-fetching while the server says it's still working" poll, with two limits so a tab left
// open can't poll forever: it pauses while the page is hidden, and each burst stops after `maxPolls`
// (the figures already on screen stay — they're real, just possibly a few minutes old). A new burst
// starts the next time `active` turns true. Added after an open Portfolio tab polled two endpoints
// every 3s for 17 days straight (a busy tracked wallet kept the server answering `refreshing`),
// which drove most of the Nov 2026 Supabase egress.
export function useBoundedPoll(active, poll, intervalMs, maxPolls) {
  const count = useRef(0);
  const pollRef = useRef(poll);
  pollRef.current = poll; // always the latest callback, without restarting the interval for it

  useEffect(() => {
    if (!active) {
      count.current = 0;
      return undefined;
    }
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (count.current >= maxPolls) {
        clearInterval(id);
        return;
      }
      count.current += 1;
      pollRef.current();
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, maxPolls]);
}
