import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import generateNftRouter from "./utils/GenerateNft.js";
import telegramLinkRouter, { registerTelegramWebhook } from "./utils/telegramLinkRouter.js";
import { startMarketplaceWatcher } from "./utils/marketplaceWatcher.js";
import { startSubnameDomainsCache } from "./utils/subnameDomainsCache.js";
import { startActivatedDomainsCache } from "./utils/activatedDomainsCache.js";
import { startMarketplaceSellersCache } from "./utils/marketplaceSellersCache.js";
import { startOwnedNamesCache } from "./utils/ownedNamesCache.js";
import { startEtnPriceCache } from "./utils/etnPriceCache.js";
import { startExpiryAlertScheduler } from "./utils/expiryAlertScheduler.js";
import { startDashboardStatsCache } from "./utils/dashboardStatsCache.js";
import { startSubdomainAdvertScheduler } from "./utils/subdomainAdvertScheduler.js";
import { startCoreClashBurnWatcher } from "./utils/coreClashBurnWatcher.js";
import { startCoreClashSwapWatcher } from "./utils/coreClashSwapWatcher.js";
import { startCoreClashNftMintWatcher } from "./utils/coreClashNftMintWatcher.js";
import { startCoreClashNftSaleWatcher } from "./utils/coreClashNftSaleWatcher.js";
import { startCoreClashAdvertScheduler } from "./utils/coreClashAdvertScheduler.js";
import { startCoreClashDripBot } from "./utils/coreClashDripBot.js";

dotenv.config();

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, Postman, health checks)
    if (!origin) return callback(null, true);

    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`CORS blocked request from origin: ${origin}`);
    return callback(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "etn-name-service-backend" });
});

app.use("/api", generateNftRouter);
app.use("/api", telegramLinkRouter);

const PORT = process.env.PORT || 3001;

// Unlike startMarketplaceWatcher()/startSubnameDomainsCache() above (plain sync functions), the
// Core Clash start functions are async — they do awaited setup (reading token metadata, checking
// contract state) before entering their poll loop. Called bare with no await/catch, a startup
// failure (e.g. a malformed CORE_CLASH_BACKEND_PRIVATE_KEY) would become an unhandled promise rejection,
// which can crash the entire process on newer Node — taking the unrelated NFT-image backend down
// with it over what should be one disabled bot. This keeps a bad one from affecting the rest.
function safeStart(name, startFn) {
  Promise.resolve()
    .then(() => startFn())
    .catch((err) => console.error(`❌ ${name} failed to start:`, err.message || err));
}

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  startMarketplaceWatcher();
  startSubnameDomainsCache();
  startActivatedDomainsCache();
  startMarketplaceSellersCache();
  startOwnedNamesCache();
  startEtnPriceCache();
  startExpiryAlertScheduler();
  startDashboardStatsCache();
  safeStart("Telegram webhook registration", registerTelegramWebhook);
  safeStart("Subdomain advert scheduler", startSubdomainAdvertScheduler);

  // Telegram bots ported from etn-zephyrprime/CoreClashGame — see
  // backend/utils/coreClashConfig.js for why. Each one no-ops (logs and returns) if its required
  // env vars aren't set, same as startMarketplaceWatcher() above.
  safeStart("Core Clash burn watcher", startCoreClashBurnWatcher);
  safeStart("Core Clash swap watcher", startCoreClashSwapWatcher);
  safeStart("Core Clash NFT mint watcher", startCoreClashNftMintWatcher);
  safeStart("Core Clash NFT sale watcher", startCoreClashNftSaleWatcher);
  safeStart("Core Clash advert scheduler", startCoreClashAdvertScheduler);
  safeStart("Core Clash drip bot", startCoreClashDripBot);
});