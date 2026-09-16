import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { MARKETPLACE_ADDRESS, LEGACY_MARKETPLACES, NAME_WRAPPER_ADDRESS, REGISTRAR_CONTROLLER_ADDRESS, BASE_REGISTRAR_ADDRESS, RPC_URL } from "../config.js";
import { computeTokenId } from "../utils/ens.js";
import MarketplaceABI from "../abis/MarketplaceABI.json";
import NameWrapperABI from "../abis/NameWrapperABI.json";
import ETHRegistrarControllerABI from "../abis/ETHRegistrarControllerABI.json";
import BaseRegistrarABI from "../abis/BaseRegistrarABI.json";
import UniswapV2RouterLiteABI from "../abis/UniswapV2RouterLiteABI.json";
import ElectroSwapV3PoolLiteABI from "../abis/ElectroSwapV3PoolLiteABI.json";

// Every marketplace this app has ever pointed at, most-recent (current) first — shared by
// isDomainActivated/migrateActivation below to walk this app's whole contract history rather than
// just one hop back.
const MARKETPLACE_CHAIN = [MARKETPLACE_ADDRESS, ...LEGACY_MARKETPLACES.map((m) => m.address)];

// JS port of PlanetZephyrosSubdomainServiceV5.sol's V3PriceMath.getQuoteFromSqrtPriceX96 — used by
// quoteActivationInToken below to price a V3-pooled token off its live slot0() spot price without
// going through the contract itself (see that function's own comment for why). BigInt has no
// fixed-width overflow to guard against (unlike Solidity's uint256), so this skips the
// two-path/FullMath split the on-chain version needs and just does the multiplication directly —
// same result, since sqrtPriceX96 is at most 160 bits and BigInt handles arbitrary precision.
function getQuoteFromSqrtPriceX96(sqrtPriceX96, baseAmount, baseIsToken0) {
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96;
  return baseIsToken0 ? (ratioX192 * baseAmount) / (1n << 192n) : ((1n << 192n) * baseAmount) / ratioX192;
}

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

  // paymentToken defaults to ETN (address(0)) — subnamePricePerYear is keyed per payment token
  // (mapping(bytes32 => mapping(address => uint256))).
  const getSubnamePricePerYear = useCallback(async (parentNode, paymentToken = ethers.ZeroAddress) => {
    const { marketplace } = getReadContracts();
    return await marketplace.subnamePricePerYear(parentNode, paymentToken);
  }, [getReadContracts]);

  // Owner-adjustable floor under a subname's per-year price for `paymentToken` — genuinely
  // different per token (e.g. confirmed live 2026-09-15: DCNT's floor is 20,000 DCNT/year, PDY's
  // is 32,000,000,000 PDY/year), so a currency picker can't reuse config.js's
  // MIN_SUBNAME_PRICE_PER_YEAR_ETN constant for anything but ETN itself — every non-ETN currency
  // needs this live read instead.
  const getMinSubnamePricePerYear = useCallback(async (paymentToken) => {
    const { marketplace } = getReadContracts();
    return await marketplace.minSubnamePricePerYear(paymentToken);
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

  // How far out to set activateDomainWithToken's deadline from the moment the tx is submitted —
  // same reasoning/value as useBurnPool.js's DEADLINE_BUFFER_SECONDS: generous enough to clear
  // this chain's block times comfortably, the contract only uses it to bound how stale the swap
  // quote can get, not a UI concern.
  const ACTIVATION_TOKEN_DEADLINE_BUFFER_SECONDS = 20 * 60;

  // Quotes what a whitelisted ERC20 activation would cost right now, in that token's own smallest
  // unit — replicates activateDomainWithToken's own on-chain pricing (the contract has no separate
  // view function for this — see its own comment) using plain read calls against the swap
  // router/pool directly, rather than a staticCall against the real activateDomainWithToken.
  //
  // A staticCall against the real function was tried first and doesn't work as a quote: that
  // function unconditionally ends with `IERC20(paymentToken).transferFrom(msg.sender, ...)`, which
  // most real ERC20s (confirmed live with CORE) REVERT on — not just return false — when the
  // caller's allowance is insufficient. Since quoting has to happen *before* anyone knows how much
  // to approve, msg.sender's allowance is always 0 at quote time, so that staticCall reverted with
  // the token's own "insufficient allowance" every single time, for every token, on every
  // first-ever activation — permanently stuck (the Activate button gates on a successful quote, so
  // it could never even offer the approve step). Pricing this off pure view reads instead sidesteps
  // the token entirely: nothing here ever touches transferFrom or allowance.
  const quoteActivationInToken = useCallback(async (node, label, paymentToken) => {
    const { marketplace } = getReadContracts();
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    const etnFee = await getActivationFee(label, node);
    if (etnFee === 0n) return 0n; // goldlisted/free — nothing to price in any currency

    const [swapRouterAddress, v3Pool] = await Promise.all([
      marketplace.swapRouter(),
      marketplace.v3PoolForToken(paymentToken),
    ]);
    if (swapRouterAddress === ethers.ZeroAddress) throw new Error("Swap router not configured");
    const router = new ethers.Contract(swapRouterAddress, UniswapV2RouterLiteABI, provider);
    const weth = await router.WETH();

    if (v3Pool !== ethers.ZeroAddress) {
      const pool = new ethers.Contract(v3Pool, ElectroSwapV3PoolLiteABI, provider);
      const [token0, slot0] = await Promise.all([pool.token0(), pool.slot0()]);
      return getQuoteFromSqrtPriceX96(slot0.sqrtPriceX96, etnFee, token0.toLowerCase() === weth.toLowerCase());
    }

    const amounts = await router.getAmountsOut(etnFee, [weth, paymentToken]);
    return amounts[amounts.length - 1];
  }, [getReadContracts, getActivationFee]);

  // ERC20-denominated counterpart to activateDomain above. `maxTokenAmount` is the caller's own
  // slippage cap (same spirit as buyBackAndBurn's minCoreOut) — pass quoteActivationInToken's own
  // result plus a buffer (the UI applies the same 5% this app's ETN activation estimate already
  // uses), not the raw quote, since a few seconds pass between quoting and this transaction
  // actually mining. Caller must have already approved the marketplace to spend at least
  // maxTokenAmount of paymentToken (see usePaymentTokens.js's ERC20 approve flow) — this doesn't
  // check or request that itself, same division of responsibility as registerSubname's own ERC20
  // path.
  const activateDomainWithToken = useCallback(async (node, label, paymentToken, maxTokenAmount, signer) => {
    setLoading(true);
    setError(null);
    try {
      const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MarketplaceABI, signer);
      const deadline = Math.floor(Date.now() / 1000) + ACTIVATION_TOKEN_DEADLINE_BUFFER_SECONDS;
      const tx = await marketplace.activateDomainWithToken(node, label, paymentToken, maxTokenAmount, deadline, { gasLimit: 600000 });
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Activation failed");
      return { success: true, txHash: tx.hash };
    } catch (err) {
      console.error("Domain activation (token) failed:", err);
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
    getMinSubnamePricePerYear,
    isDomainActivated,
    migrateActivation,
    isMarketplaceApproved,
    approveMarketplace,
    isBaseRegistrarApproved,
    approveBaseRegistrar,
    getActivationFee,
    activateDomain,
    quoteActivationInToken,
    activateDomainWithToken,
    setSubnamePricePerYear,
    loading,
    error,
  };
}
