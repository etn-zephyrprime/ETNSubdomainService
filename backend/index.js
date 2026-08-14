import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import generateNftRouter from "./utils/GenerateNft.js";
import { startMarketplaceWatcher } from "./utils/marketplaceWatcher.js";
import { startSubnameDomainsCache } from "./utils/subnameDomainsCache.js";

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

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  startMarketplaceWatcher();
  startSubnameDomainsCache();
});