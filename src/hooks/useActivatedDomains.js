import { useCallback } from "react";
import { R2_PUBLIC_URL } from "../config.js";

// backend/utils/activatedDomainsCache.js publishes exactly this shape to R2 on a timer — see that
// file for why (scanning + resolving owner/expiry/primary-name for every activated domain and its
// subnames is far too much for a visitor's browser to do itself, the same lesson
// useSubnameRegistration.js's getAvailableParentDomains already learned).
//
// No on-chain fallback here, unlike getAvailableParentDomains — that fallback exists because a
// handful of SubnamePricePerYearSet events is a scan a browser can still do in a pinch. This
// dataset additionally needs a getData() + primary-name resolution per domain *and* per subname,
// which is exactly the RPC-flood problem that made "Get a Subname" slow in the first place.
// Running that in-browser as a "fallback" would just reintroduce the bug it's meant to avoid, so
// this fails honestly (a clear "temporarily unavailable" message) instead.
export function useActivatedDomains() {
  const getActivatedDomains = useCallback(async () => {
    if (!R2_PUBLIC_URL) {
      throw new Error("Activated domains list isn't configured for this deployment.");
    }

    const res = await fetch(`${R2_PUBLIC_URL.replace(/\/$/, "")}/activated-domains.json`);
    if (!res.ok) {
      throw new Error(`Activated domains fetch failed (HTTP ${res.status})`);
    }

    const data = await res.json();
    if (!Array.isArray(data?.domains)) {
      throw new Error("Activated domains response was malformed.");
    }

    return data.domains;
  }, []);

  return { getActivatedDomains };
}
