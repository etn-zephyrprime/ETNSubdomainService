import React, { useCallback, useMemo } from "react";
import { ethers } from "ethers";
import { useEffect, useState } from "react";
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
  useAppKitProvider,
  useDisconnect,
} from "@reown/appkit/react";

import { defineChain } from "@reown/appkit/networks";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";

import {
  RPC_URL,
  CHAIN_ID,
  EXPLORER_BASE_URL,
  REOWN_PROJECT_ID,
} from "../config.js";

export const electroneum = defineChain({
  id: CHAIN_ID,
  caipNetworkId: `eip155:${CHAIN_ID}`,
  chainNamespace: "eip155",
  name: "Electroneum Mainnet",
  nativeCurrency: {
    name: "Electroneum",
    symbol: "ETN",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "Electroneum Explorer",
      url: EXPLORER_BASE_URL,
    },
  },
});

const metadata = {
  name: "Planet Zephyros - Electroneum Name Service",
  description: "Simplify your wallet - Register your ENS-style name on Electroneum Smart Chain",
  url: window.location.origin,
  icons: [`${window.location.origin}/TransparentSubdomainLogo.png`],
};

export const appKitModal = createAppKit({
  adapters: [new EthersAdapter()],
  networks: [electroneum],
  defaultNetwork: electroneum,
  projectId: REOWN_PROJECT_ID,
  metadata,
  enableInjected: false,
  allowUnsupportedChain: false,
  features: {
    analytics: true,
    email: false,
    socials: false,
  },
});

// Always points directly at Electroneum RPC — never affected by
// WalletConnect's chain reporting. Used for all read-only contract calls.
const readOnlyProvider = new ethers.JsonRpcProvider(RPC_URL);

export function useReownWallet() {
  const [, setForceUpdate] = useState(0);
  
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { switchNetwork, caipNetwork } = useAppKitNetwork();
  const { address, isConnected, status } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider("eip155");

  const signingProvider = useMemo(() => {
    if (!isConnected || !walletProvider) return null;
    try {
      return new ethers.BrowserProvider(walletProvider);
    } catch (err) {
      console.warn("Failed to create BrowserProvider:", err);
      return null;
    }
  }, [isConnected, walletProvider]);

  // Force re-render on connection changes
  useEffect(() => {
    if (appKitModal?.subscribeConnectedWallet) {
      const unsubscribe = appKitModal.subscribeConnectedWallet(() => {
        setForceUpdate(prev => prev + 1);
      });
      return () => unsubscribe?.();
    }
  }, []);

  const connectWallet = useCallback(async () => {
    try {
      await open({ view: "Connect" });
    } catch (err) {
      console.error("Connect wallet failed:", err);
    }
  }, [open]);
  
  const disconnectWallet = useCallback(async () => {
    try {
      await disconnect();
    } catch (err) {
      console.error("Disconnect wallet failed:", err);
    }
  }, [disconnect]);

  const ensureCorrectNetwork = useCallback(async () => {
    if (!isConnected || !walletProvider) {
      throw new Error("Wallet not connected");
    }
    const currentChainId = caipNetwork?.id ? Number(caipNetwork.id) : null;
    if (currentChainId !== CHAIN_ID) {
      await switchNetwork(electroneum);
    }
  }, [isConnected, walletProvider, caipNetwork?.id, switchNetwork]);

  // Always creates a fresh BrowserProvider for signing so the signer
  // is never stale after a reconnect.
  const getSigner = useCallback(async () => {
    if (!isConnected || !walletProvider) {
      throw new Error("Wallet not connected");
    }
    const browserProvider = new ethers.BrowserProvider(walletProvider);
    return browserProvider.getSigner();
  }, [isConnected, walletProvider]);

  return {
    provider: readOnlyProvider,   // ✅ reads  — always chain 52014
    signingProvider,              // ✅ writes — BrowserProvider via wallet
    walletProvider,               // raw transport, if needed directly
    account: address || null,
    isConnected,
    walletStatus: status,
    connectWallet,
    disconnectWallet,
    ensureCorrectNetwork,
    getSigner,
  };
}