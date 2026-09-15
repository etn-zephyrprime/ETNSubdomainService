import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, LEGACY_MARKETPLACES, NAME_WRAPPER_ADDRESS, REGISTRAR_CONTROLLER_ADDRESS, BASE_REGISTRAR_ADDRESS, RPC_URL } from "../config.js";
import { computeTokenId } from "../utils/ens.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";
import NameWrapperABI from "../abis/NameWrapperABI.json";
import ETHRegistrarControllerABI from "../abis/ETHRegistrarControllerABI.json";
import BaseRegistrarABI from "../abis/BaseRegistrarABI.json";

// Every marketplace this app has ever pointed at, most-recent (current) first — shared by
// isDomainActivated/migrateActivation below to walk this app's whole contract history rather than
// just one hop back.
const MARKETPLACE_CHAIN = [MARKETPLACE_ADDRESS, ...LEGACY_MARKETPLACES.map((m) => m.address)];

export function useSubnamePricing() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const getReadContracts = useCallback(() => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    return {
      marketplace: new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, provider),
      nameWrapper: new ethers.Contract(NAME_WRAPPER_ADDRESS, NameWrapperABI, provider),
      controller: new ethers.Contract(REGISTRAR_CONTROLLER_ADDRESS, ETHRegistrarControllerABI, provider),
      baseRegistrar: new ethers.Contract(BASE_REGISTRAR_ADDRESS, BaseRegistrarABI, provider),
    };
  }, []);

  // paymentToken defaults to ETN (address(0)) — V4's subnamePricePerYear is now keyed per
  // payment token (mapping(bytes32 => mapping(address => uint256))), but this app is ETN-only
  // for now (Phase 1: point at V4 without exposing the new multi-currency surface yet).
  const getSubnamePricePerYear = useCallback(async (parentNode, paymentToken = ethers.ZeroAddress) => {
    const { marketplace } = getReadContracts();
    return await marketplace.subnamePricePerYear(parentNode, paymentToken);
  }, [getReadContracts]);

  // Checks the current contract first (the real source of truth for anything it itself gates —
  // setting a price, registering a subname, etc.). If not activated there, walks every deprecated
  // marketplace this app has ever pointed at (most recent first — MARKETPLACE_CHAIN) looking for a
  // real, already-paid activation: a domain paid to activate on an old contract and never migrated
  // forward is still real, already-paid-for activation, not a fresh "please pay again" case — each
  // contract's own permissionless migrateActivation(node) exists specifically to carry that over
  // for free, one hop at a time (its own immutable legacyMarketplace). A domain activated several
  // redeploys back (e.g. only ever activated on V3, never touched V4) needs that many
  // migrateActivation calls chained together to reach the current contract, not just one — this
  // returns the exact ordered list (`migrationSteps`, oldest-needed hop first) so the caller can
  // run all of them as one action instead of the user having to notice and repeat this manually.
  // This is what prevents a real double-charge risk: pointing this app at a fresh contract whose
  // own domainActivated starts false for every domain, regardless of real prior history, would
  // otherwise show the paid "Activate" flow again for a domain that's already been paid for once.
  const isDomainActivated = useCallback(async (node) => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contracts = MARKETPLACE_CHAIN.map((address) => new ethers.Contract(address, MarketplaceABI, provider));

    let firstActivatedIndex = -1;
    for (let i = 0; i < contracts.length; i++) {
      let activated = false;
      try {
        activated = await contracts[i].domainActivated(node);
      } catch (err) {
        console.warn(`Couldn't check activation status on ${MARKETPLACE_CHAIN[i]}:`, err.message);
        break; // don't guess past a genuinely failed read
      }
      if (activated) {
        firstActivatedIndex = i;
        break;
      }
    }

    if (firstActivatedIndex === -1) return { activated: false, needsMigration: false, migrationSteps: [] };
    if (firstActivatedIndex === 0) return { activated: true, needsMigration: false, migrationSteps: [] };

    // Oldest-needed hop first: fixing index i requires calling THAT contract's own
    // migrateActivation, which itself reads one hop further back (i+1) — so index
    // (firstActivatedIndex - 1) has to actually land before index (firstActivatedIndex - 2) can
    // succeed, and so on down to index 0 (the current contract) last.
    const migrationSteps = [];
    for (let i = firstActivatedIndex - 1; i >= 0; i--) migrationSteps.push(MARKETPLACE_CHAIN[i]);

    return { activated: true, needsMigration: true, migrationSteps };
  }, []);

  // Permissionless on-chain (anyone can call it, not just the domain owner) — carries a domain's
  // already-paid activation forward to the current contract for free. `steps` is
  // isDomainActivated's own `migrationSteps` (oldest-needed hop first) — each is a separate
  // migrateActivation transaction (the function takes no batching parameter), awaited in order
  // since a later step's own require(legacyMarketplace.domainActivated(node)) only passes once the
  // earlier step has actually landed.
  const migrateActivation = useCallback(async (node, signer, steps) => {
    setLoading(true);
    setError(null);
    try {
      let lastTxHash = null;
      for (const marketplaceAddress of steps) {
        const marketplace = new ethers.Contract(marketplaceAddress, MarketplaceABI, signer);
        const tx = await marketplace.migrateActivation(node, { gasLimit: 150000 });
        const receipt = await tx.wait();
        if (!receipt) throw new Error("Migration failed");
        lastTxHash = tx.hash;
      }
      return { success: true, txHash: lastTxHash };
    } catch (err) {
      console.error("Activation migration failed:", err);
      setError(err?.reason || err?.message || "Migration failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const isMarketplaceApproved = useCallback(async (ownerAddress) => {
    const { nameWrapper } = getReadContracts();
    return await nameWrapper.isApprovedForAll(ownerAddress, MARKETPLACE_ADDRESS);
  }, [getReadContracts]);

  const approveMarketplace = useCallback(async (signer) => {
    setLoading(true);
    setError(null);
    try {
      const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NameWrapperABI, signer);
      // Explicit gas limit — this chain's eth_estimateGas has proven unreliable elsewhere in
      // this app, so writes use a fixed generous limit instead of trusting the wallet's estimate.
      const tx = await nameWrapper.setApprovalForAll(MARKETPLACE_ADDRESS, true, { gasLimit: 120000 });
      await tx.wait();
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Marketplace approval failed:", err);
      setError(err?.reason || err?.message || "Approval failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // A separate approval from isMarketplaceApproved/approveMarketplace above — that one is
  // NameWrapper-level (needed for registerSubname/setSubnodeRecord on an already-wrapped name).
  // This one is BaseRegistrar-level: only relevant for a name that isn't wrapped yet, since
  // activateDomain now wraps it as part of activation — pulling the raw ERC721 registration into
  // its own custody first (see PlanetZephyrosSubdomainNameServiceV2's _wrapDirectRegistration),
  // which needs this operator approval or it reverts "Approve BaseRegistrar first".
  const isBaseRegistrarApproved = useCallback(async (ownerAddress) => {
    const { baseRegistrar } = getReadContracts();
    return await baseRegistrar.isApprovedForAll(ownerAddress, MARKETPLACE_ADDRESS);
  }, [getReadContracts]);

  const approveBaseRegistrar = useCallback(async (signer) => {
    setLoading(true);
    setError(null);
    try {
      const baseRegistrar = new ethers.Contract(BASE_REGISTRAR_ADDRESS, BaseRegistrarABI, signer);
      const tx = await baseRegistrar.setApprovalForAll(MARKETPLACE_ADDRESS, true, { gasLimit: 120000 });
      await tx.wait();
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("BaseRegistrar approval failed:", err);
      setError(err?.reason || err?.message || "Approval failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Replicates the contract's own _activationFee math — whichever is larger, the bps-based fee
  // or the minBrokerageFeePerYear floor scaled to however much time is actually left on the name
  // (read from NameWrapper), same as _brokerageFeeFor — plus a 5% buffer — mirrors
  // scripts/testActivateDomain2_remix.ts's estimate, since a few seconds pass before the tx
  // mines. Excess is always refunded on-chain regardless.
  //
  // Was bps-only (no floor) until 2026-08-08 — silently under-quoted every activation where the
  // floor should have dominated (i.e. every one with any meaningful remaining duration), matching
  // the exact bug fixed in PlanetZephyrosSubdomainNameServiceV3's _activationFee. Left stale here
  // after that contract fix meant every quote kept using the old formula, so the "Activate"
  // button sent a value the contract would then reject as insufficient.
  //
  // V4 charges 0 for a goldlisted domain regardless of what the bps/floor math comes out to — but
  // activateDomain still computes that math first, purely for its expiry-check side effect (it
  // reverts on an already-expired name even when goldlisted), so this mirrors that: still validates
  // expiry, just skips straight to 0 once that passes rather than doing the bps/floor computation
  // and the extra rentPrice()/brokerageBps()/minBrokerageFeePerYear() calls it would otherwise need.
  // Checking goldlisted status up front matters because that floor computation, for a domain with a
  // genuinely long remaining expiry (the whole reason goldlisting exists — see planetzephyros.etn's
  // own 100-year registration), comes out to an absurd ~2,500,000 ETN — showing/requiring that here
  // even though the real on-chain call would actually charge nothing.
  const getActivationFee = useCallback(async (label, node) => {
    const { marketplace, nameWrapper, controller, baseRegistrar } = getReadContracts();

    const data = await nameWrapper.getData(node);
    let expiry = data.expiry;

    // Names registered directly through Electroneum, outside this app — exactly the case this
    // whole activation flow exists for — are never wrapped, so NameWrapper.getData() for them
    // returns all-zero, including expiry. That would make every one of them look already-expired
    // even when the real registration has decades left. Fall back to the real registrar expiry
    // for top-level names (BaseRegistrar doesn't track subnames at all — only their parent's
    // label is — so this only applies when label has no dot).
    if (expiry === 0n && !label.includes(".")) {
      expiry = await baseRegistrar.nameExpires(computeTokenId(label));
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const remaining = expiry - BigInt(nowSeconds);
    if (remaining <= 0n) throw new Error("Name has expired");

    if (await marketplace.goldlisted(node)) return 0n;

    const price = await controller.rentPrice(label, remaining);
    const basePrice = price.base + price.premium;
    const [brokerageBps, minBrokerageFeePerYear] = await Promise.all([
      marketplace.brokerageBps(),
      marketplace.minBrokerageFeePerYear(),
    ]);
    const pctFee = (basePrice * brokerageBps) / 10000n;
    const minFee = (minBrokerageFeePerYear * remaining) / (365n * 24n * 60n * 60n);
    const fee = pctFee > minFee ? pctFee : minFee;
    return (fee * 105n) / 100n;
  }, [getReadContracts]);

  const activateDomain = useCallback(async (node, label, fee, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      // Bumped from 350000 — for an unwrapped name, this now also does an ERC721 transferFrom +
      // approve + NameWrapper.wrapETH2LD internally (PlanetZephyrosSubdomainNameServiceV2's
      // _wrapDirectRegistration), not just a storage flag flip.
      const tx = await marketplace.activateDomain(node, label, { value: fee, gasLimit: 600000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Activation failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Domain activation failed:", err);
      setError(err?.reason || err?.message || "Activation failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // paymentToken defaults to ETN (address(0)) — see getSubnamePricePerYear above.
  const setSubnamePricePerYear = useCallback(async (node, pricePerYearWei, signer, paymentToken = ethers.ZeroAddress) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const tx = await marketplace.setSubnamePricePerYear(node, paymentToken, pricePerYearWei, { gasLimit: 180000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Setting price failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Setting subname price failed:", err);
      setError(err?.reason || err?.message || "Setting price failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    getSubnamePricePerYear,
    isDomainActivated,
    migrateActivation,
    isMarketplaceApproved,
    approveMarketplace,
    isBaseRegistrarApproved,
    approveBaseRegistrar,
    getActivationFee,
    activateDomain,
    setSubnamePricePerYear,
    loading,
    error,
  };
}
