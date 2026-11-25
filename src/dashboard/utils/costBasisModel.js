import { useCallback, useEffect, useState } from "react";

// Cost-basis method for the live PnL views: FIFO (default) or pooled average cost. Stored per browser
// and shared across every component reading it (the PnL panel, the headline cards), so the page never
// shows two different methods at once. Only the live snapshot follows this setting; history charts
// and per-category/token/NFT views are still FIFO.
const STORAGE_KEY = "pz-cost-basis-model";
const CHANGE_EVENT = "pz-cost-basis-model-change";

function readModel() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "pooled" ? "pooled" : "fifo";
  } catch {
    return "fifo";
  }
}

export function useCostBasisModel() {
  const [model, setModelState] = useState(readModel);

  useEffect(() => {
    const sync = () => setModelState(readModel());
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);

  const setModel = useCallback((next) => {
    const value = next === "pooled" ? "pooled" : "fifo";
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // private mode / storage disabled: the setting still applies for this page view
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [model, setModel];
}
