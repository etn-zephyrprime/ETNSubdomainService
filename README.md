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
  contract's `drip()` with `CORE_CLASH_BACKEND_PRIVATE_KEY` (Core Clash's
  treasury/admin wallet) whenever the contract's own timer says it's due.
  Treat that key with the same care you would in CoreClashGame's own
  `.env`.

Simplifications from the originals (documented in each file's own header
comment): the swap watcher only tracks the one CORE/WETN pool that's
actually live today rather than porting the general multi-token engine,
and NFT mint/sale alerts are text-only (no attached image) rather than
depending on CoreClashGame's own metadata cache.

---

## Advert rotations

Two independent rotating-advert bots, both built on the same scheduling
engine (`backend/utils/advertScheduler.js` — randomized time within a
cycle, a minimum gap between sends, never repeating the previous
cycle's first pick, restart-safe persisted queue):

- **Core Clash** (`coreClashAdvertScheduler.js`, via the Core Clash
  bot/chat above) — 3 static promo messages, one per **3-day** cycle
  (originally daily; widened on request).
- **Subdomain Service** (`subdomainAdvertScheduler.js`, via this repo's
  own `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`/`TELEGRAM_MESSAGE_THREAD_ID`
  — the "Subdomain Name Service" topic) — 3 messages, one per **1-day**
  cycle: activating a domain (links to the homepage as "ETN Subdomain
  Service"), current domains selling subnames + price (links each into
  `/subnames/<domain>.etn`, the same deep link `ManageSubdomain.jsx`'s
  "Copy Subname Link" uses), and current marketplace listings (links to
  the new `/marketplace` deep link — see `App.jsx`). Unlike the Core
  Clash bot's static rotation, the latter two are built fresh at send
  time from live data (the subname-domains R2 cache and a live
  `nextListingId()`/`listings()` scan respectively), not baked in.

---

## Activated Domains table (homepage)

Shows every activated domain and the subnames registered under it —
current owner (primary name if set, otherwise a short address) and time
left until expiry for each, expandable per domain. Backed by
`backend/utils/activatedDomainsCache.js`, same R2-publish-on-a-timer
pattern as the subname domains cache above (`ActivatedDomainsTable.jsx`
+ `useActivatedDomains.js` on the frontend side) — see that file's header
comment for why owner/expiry get re-verified for every known entry on
every scan cycle, not just newly-discovered ones. Expired entries are
hidden by default; a "Show expired" checkbox reveals them.

Every domain/subname label links to its block explorer name-domains page,
and every owner (primary name or address) links to that address's
explorer page — see `ActivatedDomainsTable.jsx`.

---

## Marketplace seller names

"Names For Sale" resolves each listing's seller to a primary name the
same way — `backend/utils/marketplaceSellersCache.js` publishes
`{seller address -> primary name}` for active listings' sellers to R2,
and `useMarketplaceListings.js` fetches it once per `getActiveListings()`
call instead of resolving each seller in the browser. The listings
themselves are *not* cached — they stay a live on-chain read, since
`ManageSubdomain.jsx`'s "List for Resale"/"Cancel Listing" UI needs to
reflect a just-submitted transaction immediately, not wait out a cache
cycle. Only the seller-name resolution (the part that was silently
failing — see that file's header comment for the root cause) moved
server-side.

---

## Owned names list ("Manage & Resell" / "Register Subdomain")

Both screens are the same `ManageSubdomain.jsx` component (`intent`
prop only changes framing copy) — previously both worked purely by
typing a name to look up. Now they open with a list of every wrapped
name (domain or subname, activated or not) the connected wallet owns,
built from `backend/utils/ownedNamesCache.js` (same R2-publish pattern
and cold-start safeguards as `activatedDomainsCache.js`) via
`useOwnedNames.js`. Domains are expandable to show their owned
subnames nested underneath; "Register Subdomain" only lists domains,
since subname pricing is a domain-level setting. Selecting an entry
runs it through the exact same lookup/verification logic the manual
box always used — the list only changes *how* a name gets picked, not
what happens once it's selected.

The original manual-entry box stays reachable via a "Don't see your
name?" toggle — necessary, not just a fallback: a genuinely unwrapped
("retro") name can never appear in the list at all (see
`ownedNamesCache.js`'s header comment for why), so typing it in by
hand is the only way to find one.

---

## Telegram bot wallet name resolution

Every Telegram bot in this repo that shows a wallet address — domain
activated/subname registered/name listed/name sold from
`marketplaceWatcher.js`, and the Core Clash NFT sale/mint/swap alerts —
now resolves it to that wallet's primary `.etn` name first, falling
back to a shortened address (`0x1234...abcd`) only if it hasn't set
one. `backend/utils/primaryNameResolver.js` centralizes this lookup;
unlike most small helpers in this codebase (duplicated per file on
purpose — see `queryLogsChunked`'s "fine to drift independently"
comment), this one is shared everywhere it's used, specifically
because getting it wrong already caused two real bugs (see
`activatedDomainsCache.js`'s header comment) — every new call site
gets the fix for free instead of a fresh chance to reintroduce it.

---

## ETN/USD price estimates

Every headline price shown on the site (registration total, subname
price, marketplace listings, renewal quotes, resale amounts, the burn
pool balance) shows a small "≈ $X.XX" estimate underneath, via
`UsdEstimate.jsx` + `useEtnPrice.js`. Backed by
`backend/utils/etnPriceCache.js`, same R2-publish-on-a-timer pattern
as every other cache here — the live ETN/USD price (from the same
CoinGecko endpoint `coreClashSwapWatcher.js` already uses for its own
WETN/USD estimate) is fetched once on a timer and published to R2,
rather than every visitor's browser hitting CoinGecko directly on
every page load. Renders nothing if the price hasn't loaded yet or
R2/the cache isn't configured — every price display still works, just
without the USD line, same fallback behavior as this repo's other
optional R2-backed features.

Only wired into headline totals, not every fee-breakdown sub-line
(e.g. the brokerage fee row) — a USD estimate next to every single
number on a receipt reads as clutter, not clarity.

---

## Personal Telegram alerts

Beyond the public "Subdomain Name Service" channel post
`marketplaceWatcher.js` already makes for every sale, a wallet owner
can opt in (from "Manage & Resell" / "Register Subdomain" — see
`TelegramAlertsCard.jsx`) to a personal DM the moment one of their
names or subnames actually sells. `backend/utils/telegramLinkRouter.js`
has the full flow in its header comment; short version: the wallet
signs a request (same pattern as `backendAuth.js`/`verifyOwnership.js`,
just proving control of the address rather than ownership of a
specific name) to get a one-time `t.me/<bot>?start=<code>` link,
tapping it starts a chat with the bot which sends `/start <code>` as
its first message automatically, and Telegram POSTs that to this
backend's webhook — which is what finally records `{ address -> chat
id }` and lets `marketplaceWatcher.js` DM that owner directly on every
future `SubnameRegistered`/`ListingSold` event for their name. `/unlink`
in the chat (or the toggle on the site) removes it again.

Requires `BACKEND_PUBLIC_URL` (so Telegram has an HTTPS address to
POST incoming messages to) on top of the `TELEGRAM_BOT_TOKEN` this
repo's bot already uses — see `.env.example`. Without it, linking
requests still go out but never complete (the UI just waits forever
for a confirmation that can never arrive), and the rest of the site
— including the public channel alerts — is completely unaffected.

Also covers expiry: `backend/utils/expiryAlertScheduler.js` DMs a
linked wallet when one of its activated domains or subnames is
getting close to expiring (30/7/1 days out by default, configurable
via `EXPIRY_ALERT_TIER_DAYS`), reading straight from the already-
published `ownedNamesCache.js` cache rather than re-scanning anything.
This one is deliberately personal-only with **no public-channel
equivalent** — broadcasting "X.etn expires in 3 days" to the shared
group is exactly the kind of tip-off a squatter is looking for, which
is the whole reason the linking feature above exists in the first
place. A wallet that hasn't linked Telegram simply doesn't get expiry
warnings.

---

## Electroneum dashboard (dashboard.planetzephyros.xyz)

A second, completely separate app living in `src/dashboard/` — free-
tier network stats/activity/token-leaderboard/wallet-lookup, read-only,
no wallet connection required. Ported from a standalone build brief
(premium tiers — tracked wallets, subscriptions, PnL — are a later,
separate pass; not implemented yet).

**Why one repo, one build, two domains**: `src/main.jsx` checks
`window.location.hostname` and dynamically `import()`s either
`App.jsx` (the existing ENS site) or `dashboard/DashboardApp.jsx` —
each domain's custom-domain entry in Vercel points at the same
project/deployment, so this is a client-side split, not two separate
deploys. Critically, both branches are *dynamic* imports specifically
so a dashboard visitor's bundle never pulls in the ENS site's
Reown/WalletConnect code (`createAppKit()` runs on module load and
talks to WalletConnect's infra) — confirmed via the build output that
`useReownWallet.jsx`'s ~1.5MB chunk is excluded from a dashboard-only
load.

**Data source**: Electroneum's own block explorer
(`blockexplorer.electroneum.com`) runs Blockscout, whose public v2 API
(`/api/v2/...`) sets `access-control-allow-origin: *` — confirmed live
— so `useBlockscout.js` calls it directly from the browser, no backend
proxy. `AddressLookup.jsx` reuses `usePayment.js`'s existing
`resolveName()` for `.etn` name input rather than re-implementing name
resolution a second time.

**Still needed to actually go live**: attaching
`dashboard.planetzephyros.xyz` as an additional custom domain on the
same Vercel project the main site already deploys to (Vercel dashboard
→ Domains) — not something this session had access to do. Until that
domain is attached, the dashboard code ships but isn't reachable
anywhere; the main site is completely unaffected either way.

**Testing locally**: since `localhost` doesn't match `dashboard.*`,
append `?__dashboard_test=1` to the dev server URL to force the
dashboard branch without editing hosts files.

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