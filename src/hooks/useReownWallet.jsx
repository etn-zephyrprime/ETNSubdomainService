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
  description: "Simplify your wallet - Activate your Electroneum subdomain and earn 80% of the revenue from your subdomain.",
  url: window.location.origin,
  icons: [`${window.location.origin}/TransparentSubdomainLogo.png`],
};

// Pins these to the top of the wallet list, in this order, ahead of AppKit's default
// popularity-based ranking — MetaMask/SafePal already rank highly there on their own, but Zypto
// (zypto.com), a wallet many Electroneum users specifically rely on via its in-app browser to
// reach this site, doesn't have the general-purpose popularity to surface near the top otherwise.
// IDs are each wallet's WalletConnect Explorer listing id (found via
// https://explorer-api.walletconnect.com/v3/wallets?search=<name>), not something derivable from
// the wallet's name/site itself.
const FEATURED_WALLET_IDS = [
  "482779b01ffd93b70c1f62e7905658ca1a6b02799f498b07cce423f7841aed75", // Zypto
  "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96", // MetaMask
  "0b415a746fb9ee99cce155c2ceca0c6f6061b1dbca2d722b3ba16381d0562150", // SafePal
];

export const appKitModal = createAppKit({
  adapters: [new EthersAdapter()],
  networks: [electroneum],
  defaultNetwork: electroneum,
  projectId: REOWN_PROJECT_ID,
  metadata,
  // Was `false` with no documented reason (present since this hook's first commit). Disabling
  // this skips creating an injected (window.ethereum) connector entirely — confirmed in
  // @reown/appkit-adapter-ethers' client.js, `enableInjected !== false` gates whether it even
  // instantiates one. That's mostly moot on a plain mobile browser tab (no window.ethereum there
  // regardless), but it also blocks the one genuinely reliable mobile path: opening this site
  // through MetaMask's own in-app browser, which injects window.ethereum directly — no
  // WalletConnect deep-link handoff involved. With injected disabled, even that route was forced
  // through the same deep-link roundtrip as a bare browser tab, which is a known source of
  // flakiness on Android (e.g. reown-com/appkit#4823 — MetaMask's confirmation dialog not
  // appearing after the deep link fires). `true` is also this option's own library default.
  enableInjected: true,
  allowUnsupportedChain: false,
  featuredWalletIds: FEATURED_WALLET_IDS,
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