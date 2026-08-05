import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { REGISTRAR_CONTROLLER_ADDRESS, RPC_URL } from "../config.js";
import ETHRegistrarControllerABI from "../abis/ETHRegistrarControllerABI.json";

export function useCheckAvailability() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const checkTopLevelAvailability = useCallback(async (label) => {
    if (!label || label.length === 0) return null;

    setLoading(true);
    setError(null);

    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const controller = new ethers.Contract(REGISTRAR_CONTROLLER_ADDRESS, ETHRegistrarControllerABI, provider);

      return await controller.available(label);
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
