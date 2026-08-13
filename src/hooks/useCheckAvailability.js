import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { REGISTRAR_CONTROLLER_ADDRESS, BASE_REGISTRAR_ADDRESS, RPC_URL } from "../config.js";
import ETHRegistrarControllerABI from "../abis/ETHRegistrarControllerABI.json";
import BaseRegistrarABI from "../abis/BaseRegistrarABI.json";
import { computeTokenId } from "../utils/ens.js";

export function useCheckAvailability() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Checks BOTH the controller (validity rules — length/characters — plus its own availability
  // opinion) AND BaseRegistrar directly (the actual shared ownership/expiry record every
  // registration path mints into, regardless of which controller performed it) and requires both
  // to agree "available". Controller-only was found to false-positive: a name registered through
  // some other controller deployment (confirmed live for "world" — BaseRegistrar.ownerOf/
  // nameExpires clearly show it registered and owned, but this app's configured controller's own
  // available() still returned true) showed as available here despite being taken. BaseRegistrar
  // is the reliable one — it's what every path actually mints against — so it's authoritative
  // for "is this taken"; the controller is kept in the AND only for whatever name-validity check
  // it does that BaseRegistrar's available() alone wouldn't catch.
  const checkTopLevelAvailability = useCallback(async (label) => {
    if (!label || label.length === 0) return null;

    setLoading(true);
    setError(null);

    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const controller = new ethers.Contract(REGISTRAR_CONTROLLER_ADDRESS, ETHRegistrarControllerABI, provider);
      const baseRegistrar = new ethers.Contract(BASE_REGISTRAR_ADDRESS, BaseRegistrarABI, provider);
      const tokenId = BigInt(computeTokenId(label));

      const [controllerAvailable, baseAvailable] = await Promise.all([
        controller.available(label),
        baseRegistrar.available(tokenId),
      ]);

      return controllerAvailable && baseAvailable;
    } catch (err) {
      console.error("Availability check failed:", err);
      setError(err.message || "Failed to check availability");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    checkTopLevelAvailability,
    loading,
    error,
  };
}
