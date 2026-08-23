# ETN NFT Image Backend

Listens for `NameRegistered` events on your `ETNBaseRegistrar` contract,
generates a unique NFT image (your stock template + the registered name
printed on it), uploads it, and writes the resulting URL back on-chain via
`setNodeImage()`.

---

## ⚠️ Important — not yet executed end-to-end

This code was written and syntax-checked, but **could not be run in the
environment it was built in** due to a network restriction blocking npm
package installation (specifically the `canvas` package, which has native
binary dependencies). Treat your first local run as the real first test —
budget time for debugging environment-specific issues, particularly around
`node-canvas`'s native build step (see Troubleshooting below).

---

## Setup

### 1. Install dependencies

```bash
npm install
```

**Note on `canvas`:** this package compiles native bindings and can be
finicky depending on OS. On most Linux/Mac systems with build tools already
installed, `npm install` just works. On Windows, or minimal Linux containers,
you may need system-level dependencies first:

```bash
# Ubuntu/Debian (also what Render's build environment uses)
apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev

# macOS
brew install pkg-config cairo pango libpng jpeg giflib librsvg
```

Render's standard Node environment should handle this automatically on
`npm install`, but if the build fails, check Render's build logs for the
specific missing system library and add a Render "Build Command" override
to install it first.

### 2. Add your stock image

Place your template PNG at `assets/stock-template.png` (or update
`STOCK_IMAGE_PATH` in `.env` to point elsewhere). A placeholder test image
is NOT included in production use — generate or replace it with your real
artwork before deploying.

### 3. Configure environment variables

```bash
cp .env.example .env
```

Then fill in:
- `REGISTRAR_ADDRESS` — your deployed `ETNBaseRegistrar` address
- `BACKEND_PRIVATE_KEY` — a **dedicated wallet**, not your main owner key
- `STOCK_IMAGE_PATH`, `FONT_SIZE`, `FONT_COLOR`, text position percentages
- `STORAGE_TYPE` — `local` (simplest, serves images from this same Render
  service) or `s3` (for AWS S3 / Cloudflare R2 / Backblaze B2)

### 4. Authorize the backend wallet on-chain

From your **owner** wallet (in Remix, or wherever you control the contract),
call:
```
registrar.setImageOperator(<BACKEND_PRIVATE_KEY's corresponding address>)
```
This lets the backend wallet call `setNodeImage()` without needing your main
owner key on a server.

### 5. Test image generation locally (no blockchain needed)

```bash
npm run test-render
```//
Check the `/generated` folder — you should see PNGs with sample names
printed on your stock image. Inspect them for font size, position, and
legibility before going further.

### 6. Run the real listener

```bash
npm start
```

On startup, it scans the last `STARTUP_LOOKBACK_BLOCKS` blocks (default
50,000) for any registrations it might have missed while offline, processes
those, then starts listening live for new ones.

---

## Deploying to Render

1. Push this folder to a GitHub repo (or a subfolder of your existing repo)
2. In Render: **New → Web Service**, connect the repo
3. **Build command:** `npm install`
4. **Start command:** `npm start`
5. Add all your `.env` variables under Render's **Environment** tab
   (do NOT commit your real `.env` file to git — `.env.example` is the
   template, your real `.env` stays local/in Render's dashboard only)
6. If using `STORAGE_TYPE=local`, set `LOCAL_BASE_URL` to your Render
   service's public URL (e.g. `https://etn-nft-backend.onrender.com`)
   once Render assigns it

**Important for Render specifically:** Render's free tier spins down
inactive services after a period of no HTTP traffic. Since this service
needs to stay running continuously to catch on-chain events in real time,
you likely want at minimum a paid "Starter" instance type, or pair it with
an external uptime-pinger hitting `/health` periodically if you want to try
staying on the free tier (not recommended for production reliability).

---

## ⚠️ Render persistent disk — read before deploying

This service tracks the last block it processed in `data/state.json`,
so a restart doesn't have to re-scan a huge block range. **Render's default
filesystem is ephemeral** — it resets on every deploy/restart unless you
attach a persistent disk.

**Without a persistent disk:** every redeploy loses the state file, and the
service falls back to `STARTUP_LOOKBACK_BLOCKS` to catch up. Fine as a
safety net, but means every deploy re-scans that whole range. Increase
`STARTUP_LOOKBACK_BLOCKS` if you deploy infrequently, to avoid missing
anything that happened between your last deploy and now.

**With a persistent disk (recommended):** in Render's dashboard, add a
disk and mount it at the project root (or specifically at `./data`). The
service will then remember exactly where it left off across restarts and
deploys, with no re-scanning needed.

---

## How it works (v2 — polling architecture)

```
Startup
  │
  ├─ Check data/state.json for last processed block
  │     found?  → resume from there + 1
  │     not found? → scan back STARTUP_LOOKBACK_BLOCKS from current head
  │
  ├─ Process any events in that catch-up range
  │     (large ranges automatically split into chunks of
  │      MAX_BLOCK_RANGE_PER_QUERY blocks, to stay under RPC limits)
  │
  └─ Start polling loop (every POLL_INTERVAL_MS)
        │
        ├─ Check current block vs last processed
        ├─ If new blocks exist, fetch + process NameRegistered events
        └─ Update data/state.json with new last-processed block
```

**Why polling instead of a live event subscription?** Public RPC endpoints
frequently drop long-lived WebSocket/event subscriptions silently — no
error is thrown, the listener just stops receiving events. Polling is
slightly higher latency (bounded by `POLL_INTERVAL_MS`, default 15s) but
far more reliable for a service that needs to run unattended for months.

---

## Core Clash Telegram bots

`backend/utils/coreClash*.js` are burn/swap/NFT-mint/NFT-sale alerts, the
advert rotation, and the CORE drip bot, ported from
[etn-zephyrprime/CoreClashGame](https://github.com/etn-zephyrprime/CoreClashGame).
That backend also runs on Render's free tier, and its own background
listeners only fire while that instance happens to be awake — moved here
so they run alongside this service's own watchers, on the same
poll-with-R2-backed-cursor pattern as `marketplaceWatcher.js` above.

Each one starts independently and no-ops (logs and returns) if its
required env vars aren't set — see `backend/.env.example`'s "Core Clash
Telegram bots" section for the full list. Two things worth knowing:

- **Two different bots, one chat.** CoreClashGame posts via two separate
  Telegram bot identities into the same group (`COREBOT_ZEPHYROS_BOT_TOKEN`
  for burn/swap/NFT/drip alerts, `COREBOT_TELEGRAM_BOT_TOKEN` for the
  advert rotation) — all prefixed `COREBOT_` so they can't collide with
  this repo's own `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`.
- **The drip bot signs real transactions.** Unlike the others, which only
  read chain state and notify, `coreClashDripBot.js` calls the drip
  contract's `drip()` with `BACKEND_PRIVATE_KEY` (Core Clash's
  treasury/admin wallet) whenever the contract's own timer says it's due.
  Treat that key with the same care you would in CoreClashGame's own
  `.env`.

Simplifications from the originals (documented in each file's own header
comment): the swap watcher only tracks the one CORE/WETN pool that's
actually live today rather than porting the general multi-token engine,
and NFT mint/sale alerts are text-only (no attached image) rather than
depending on CoreClashGame's own metadata cache.

---

## Manual regeneration endpoint

If a specific name's image generation fails (RPC hiccup, gas spike, etc.),
you can manually re-trigger it without restarting the whole service:

```bash
curl -X POST https://your-service.onrender.com/regenerate/0xNODE_HASH_HERE \
  -H "X-Admin-Secret: your_admin_secret_from_env"
```

Set `ADMIN_SECRET` in your `.env` to a long random string — this endpoint
can trigger real on-chain transactions, so don't leave it unprotected.

---

## How name text gets formatted

The contract's `NameRegistered` event has a slightly different shape
depending on which registration function fired:
- `registerBasic` emits the bare label (e.g. `"alice"`) and `tld="etn"`
- `registerProject` emits the already-combined name (e.g. `"alice.gaming.etn"`)

This was traced against the actual deployed `ETNBaseRegistrar.sol` source
and confirmed correct — `buildDisplayName()` handles both shapes properly.

That said, **the system now prefers reading `fullName(node)` directly from
the contract** (via `resolveDisplayName()` in `src/index.js`) rather than
reconstructing the string client-side — the contract already computed and
stored this exact string at registration time, so reading it directly is
more robust than re-deriving it from event args. `buildDisplayName()` is
kept only as a fallback for the rare case where that read call fails (e.g.
a transient RPC error). If you ever change the contract's `NameRegistered`
event shape or `fullName` storage again, this fallback function is the one
remaining place that would need updating to match.

---

## Troubleshooting

**`canvas` fails to install** — see system dependency note above. This is
the single most likely setup obstacle.

**Backend wallet transactions revert with "not authorised"** — confirm
Step 4 (setImageOperator) was actually completed and confirmed on-chain.
Check by calling `registrar.imageOperator()` and comparing to your backend
wallet's address.

**Images generate but never appear in `tokenURI()`** — confirm the
`setNodeImage` transaction actually confirmed (check the tx hash logged in
the console against the block explorer), and that you're checking
`tokenURI()` for the correct node/tokenId.

**Startup recovery scan times out or errors** — your RPC provider may rate
limit large block-range queries. Reduce `STARTUP_LOOKBACK_BLOCKS` in `.env`
if this happens, or split the scan into smaller chunks (not implemented in
this version — flag if you need this for a high-volume launch).