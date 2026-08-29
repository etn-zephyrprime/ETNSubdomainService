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
as every other cache here — the live ETN/USD price is fetched once on
a timer and published to R2, rather than every visitor's browser
hitting CoinGecko directly on every page load. Renders nothing if the
price hasn't loaded yet or R2/the cache isn't configured — every price
display still works, just without the USD line, same fallback
behavior as this repo's other optional R2-backed features.

`coreClashSwapWatcher.js` needs this same price for its own WETN/USD
estimate. It originally called CoinGecko directly a second time, on
the same 5-minute cadence as this cache's own refresh, both started
from the same `app.listen()` callback — meaning every ~5 minutes this
backend made two near-simultaneous identical requests to CoinGecko
for the same data. Confirmed live: this genuinely tripped CoinGecko's
rate limit (`HTTP 429`), and — worse than it sounds from the log
line — the swap watcher's own "Prices refreshed" message fires
unconditionally even when it silently fell back to a hardcoded
placeholder price, so a 429 wasn't obviously visible from that log
line alone. Fixed by having `coreClashSwapWatcher.js` read this
cache's own published R2 value (`getEtnPriceCache()`) instead of
querying CoinGecko itself at all — R2 reads aren't rate-limited the
way CoinGecko's free API is, this halves the CoinGecko call volume
for no loss of freshness, and it's the same "poll once, everything
else reads the cache" pattern this cache exists to provide in the
first place, just applied to this backend's own internal callers too,
not only the frontend.

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

**Own brand, own palette**: `src/dashboard/theme.js` is a Planet
Zephyros-branded palette, deliberately separate from
`src/styles/theme.js` (which stays exactly as-is for the ETN Subdomain
Service site) — every dashboard file imports colors from its own copy,
never the main site's, so a brand change on one can never leak into
the other.

**Chart tiles**: Overview and Address Lookup each have a row of
clickable stat tiles sharing one chart underneath (`TileChart.jsx`) —
click a tile, the chart below swaps to that metric's history:

- Overview: Total Transactions is reconstructed from real ~90-day
  daily data `/stats/charts/transactions` already provides (see
  `reconstructCumulativeTransactions()` in `useDashboardStats.js` —
  real arithmetic on real numbers, not an estimate). Total Addresses /
  Total Blocks / Avg Block Time / Gas Price / Txs Today (hourly) all
  come from the new `dashboardStatsCache.js` hourly snapshot history
  described above — these start thin the moment this first deploys
  and grow one point richer every hour; there's no backfilling
  history Blockscout never recorded.
- Address Lookup: ETN Balance uses Blockscout's real
  `coin-balance-history-by-day` endpoint (full history, immediately).
  Transactions/Token Transfers have no Blockscout history endpoint at
  all, so they're derived from the address's own transaction/transfer
  list, bucketed by day. Originally fetched a *fixed* 5 pages (250
  items) regardless of the address's activity level — found live this
  could silently fall short of even 30 days: a wallet doing 4,248
  lifetime transactions only reached ~20 days back under that fixed
  count, rendering the rest of a 60-day chart window as flat zero,
  indistinguishable from genuine inactivity. `fetchUntilWindow()` in
  `AddressLookup.jsx` now fetches by *coverage* instead — as many
  pages as it takes for the oldest fetched item to reach 30 days back
  (capped at 20 pages/1000 items per fetch, purely as a runaway-request
  safety net, not the primary limiter) — plus a "Show more" button
  that extends the window another 30 days per click, fetching only
  what isn't already loaded, down to that address's genuine first
  activity (`next_page_params` running out, not just the safety cap).

**Own header/footer, dark green background**: `DashboardHeader.jsx` —
Planet Zephyros logo + wordmark side by side — replaced reusing the
main site's `Header.jsx` (wallet UI, ETN Subdomain Service branding,
"Simplify your wallet" tagline, none of which belongs here). Page
background is `theme.js`'s `background` token, a dark desaturated
green rather than the main site's navy, chosen to actually read as
"on brand" with the accent green rather than clash with it. The
"Electroneum Dashboard" line is set in Orbitron (already used
elsewhere in this app for NFT art — see `src/index.css`'s
`@font-face`) at a size that reads as the page's real heading now that
the old full-size logo lockup is gone.

**Tokens vs NFT's**: both the Tokens tab and Address Lookup's holdings
list split into "Tokens" (ERC-20) / "NFT's" (ERC-721 + ERC-1155) sub-
tabs, confirmed live that Blockscout's `/tokens` supports both as a
server-side `type=` filter (including comma-separated multi-type) so
neither list has to over-fetch and filter client-side. Both also drop
any token/collection whose name contains "dead", "test", or "token"
(case-insensitive — `isSpamTokenName()` in `utils/format.js`) — this
alone removed a wall of identical airdrop-spam "DEAD COIN" entries
that had been dominating the top of the unfiltered list.

Fixed a real bug found while wiring this up: `formatTokenAmount()`
defaulted to 18 decimals whenever a token had none set — true for
every NFT (`decimals` is `null` on Blockscout for ERC-721/1155) —
which divided a real integer count like "16" down to
"0.000000000000000016", silently displayed as "0" once rounded. NFT
holdings and NFT collection total-supply figures were both actually
showing wrong before this pass; both are correct now.

**Chart hover tooltips + dynamic axes**: every `SparklineChart.jsx`
instance takes `data` as `{ label, value }[]` (a real date/timestamp
per point, not just a bare number) and renders live Y-axis value
labels, X-axis date labels, and a hover tooltip (exact date/time +
value) that tracks the cursor — `formatValue`/`formatLabel` are
supplied per call site since the same chart component covers wildly
different units (ETN, gwei, seconds, plain counts, USD) and
granularities (daily vs. hourly). Threading real dates through meant
updating every series builder (`reconstructCumulativeTransactions()`,
`bucketDailyCounts()`, the dashboard-stats-snapshot mappings) to carry
a `label` alongside each `value`, not just an add-on to the chart
component itself.

Axis labels and the tooltip are plain HTML, deliberately not SVG
`<text>` — the chart SVG stretches non-uniformly to fill whatever
width its card renders at (`preserveAspectRatio="none"`, needed so the
line/area genuinely fills the card), and SVG text glyphs stretch right
along with it, which is what made the axis text look oversized/
distorted rather than a font problem per se. HTML text sitting outside
the SVG never has that issue and just inherits the page's own font.

Fixed two real bugs found in the process:
1. Address Lookup's ETN Balance series was calling `.reverse()` on
   `coin-balance-history-by-day`'s response, which — unlike every
   other Blockscout list endpoint used elsewhere in this dashboard —
   already comes back oldest-first. The reverse was silently flipping
   that one chart's X-axis backwards (confirmed live: labels ran
   newest-to-oldest, left-to-right); the original axis-less rendering
   never surfaced this.
2. The topmost Y-axis gridline/label sat exactly on the SVG's y=0, so
   it rendered half-clipped against whatever sat directly above the
   chart — resolved as a side effect of moving axis labels to HTML
   (no longer inside the SVG's coordinate space at all).

**ETN price + chart analysis**: `EtnPriceChart.jsx`, at the top of
Overview — current/high/low/% change plus a chart, with Price /
Market Cap and 7D / 30D / 90D toggles, via a new `useCoinGecko.js`
calling CoinGecko directly (confirmed live: sets
`access-control-allow-origin: *`, no backend proxy needed, same
reasoning as `useBlockscout.js`). Deliberately not sourced from
Blockscout's own `/stats/charts/market` the way the rest of this
dashboard prefers Blockscout-first — that endpoint's `closing_price`
field is empty for all but the most recent day on this deployment
(confirmed while building the original chart), so CoinGecko's actual
complete daily history is the only real option here.

Price renders as real green/red OHLC candlesticks
(`CandlestickChart.jsx`, via CoinGecko's `/ohlc` endpoint) with a
volume bar chart underneath, colored to match each candle's direction
— volume comes from `/market_chart`'s `total_volumes`, a *finer*
granularity than the OHLC candles (e.g. hourly volume points against
4-hour candles), so `alignVolumeToCandles()` sums whichever volume
points fall inside each candle's own time window rather than assuming
a 1:1 index match between the two arrays. Market Cap has no
meaningful "candle" concept (nothing trades market cap directly), so
that toggle stays the plain line/area `SparklineChart`.

**Per-token price + market cap chart**: on the Tokens tab, clicking any
token opens `TokenDetail.jsx`, which now renders `TokenPriceChart.jsx`
— the same Price/Market Cap and 7D/30D/90D pills as the ETN price
chart, but for that specific token's own ElectroSwap trading pair.

Sourced from GeckoTerminal's public "onchain" API rather than
CoinGecko (CoinGecko doesn't index arbitrary long-tail ElectroSwap
tokens) or a from-scratch pool-reserve/Swap-event scanner (GeckoTerminal
already indexes ElectroSwap's pools directly on its `electroneum`
network — confirmed live, real pools like CORE/WETN, USDT/WETN,
USDC/WETN, etc.). Unlike every other dashboard data source, this one
is **not** called directly from the browser: confirmed live that
GeckoTerminal's free API 429s after roughly half a dozen rapid
requests, with no way for one visitor's browser to coordinate with
another's. `backend/utils/tokenChartRouter.js` is a small
proxy+cache (5 min TTL, keyed by `address:range`) in front of it —
the one dashboard feature that needed backend involvement at all —
consumed via `useTokenChart.js`.

For each click, the backend looks up the token's pools and fetches
OHLCV for whichever side of the selected pool is the requested token.
Pool selection prefers the highest-liquidity **WETN** pair if one
exists at all — WETN (Wrapped Electroneum) is ElectroSwap's de facto
quote asset — and only falls back to highest-reserve-regardless-of-pair
when no WETN pool exists. Found live that raw "highest USD reserve"
alone isn't enough: ElectroSwap BOLT has both a DYNO/BOLT pool
($30k reserve) and a BOLT/WETN pool ($12k reserve), and reserve-only
selection was picking the DYNO-denominated one, which isn't the price
users actually want to see. Market Cap isn't something GeckoTerminal
tracks historically for an arbitrary token, so it's derived
client-side instead: each candle's close price × the token's current
total supply (an approximation — assumes supply hasn't materially
changed across the shown window).

Fixed a real bug found via live testing: `RANGE_PARAMS` originally
requested just enough candles to cover each range at face value (e.g.
42 four-hour candles for "7D"). GeckoTerminal omits candle periods
with zero trades entirely instead of returning a flat/carried-forward
one, so for any thinly-traded token that silently reached back much
further than the label promised (confirmed live: a "7D" request
for CORE/WETN returned candles spanning 47 days). Fixed by fetching
generously (GeckoTerminal's own cap, 1000) and filtering to the real
elapsed-time window server-side, so "7D"/"30D"/"90D" mean what they
say regardless of a token's trading activity. When filtering leaves
fewer than 2 candles, the response is `{ hasData: false, reason:
"no_recent_activity", pool }` — distinct from "no pool exists at
all" — so the UI can point the user at a longer range instead of
implying the token has no market (confirmed live against Bananacoin,
a real but essentially-idle pool).

**CORS gotcha (real, hit live):** this is the *only* dashboard feature
that calls back to this repo's own backend from the dashboard's
origin — every other dashboard data source goes straight to Blockscout
or CoinGecko. That means `ALLOWED_ORIGINS` (set in Render's dashboard,
not committed to the repo) needs `https://dashboard.planetzephyros.xyz`
in it specifically, on top of whatever the main site's origin already
is — nothing else in this feature would have caught that gap before
first real use, since curl (no `Origin` header) sails straight past
CORS and looks identical to a working deploy.

Fixed two more real bugs found via live testing after shipping:
1. The chart cache was keyed by `address:range`, so clicking through
   this UI's own 7D/30D/90D pills on the *same* token re-ran the pool
   lookup every time, even though pool selection doesn't depend on
   range — tripling GeckoTerminal calls for the single most obvious
   user action on this page. Fixed with a separate, longer-lived
   `poolCache` keyed by address alone (15 min TTL, vs. 5 min for the
   range-specific chart cache).
2. Even with that fix, a burst of several genuinely-new (uncached)
   tokens browsed back to back could still trip GeckoTerminal's rate
   limit — confirmed live it's a token bucket, not just an
   anti-simultaneity guard (an initial ~5-6 calls succeed instantly,
   then further calls need real spacing). All outbound GeckoTerminal
   calls now go through a serialized queue with a 1.5s minimum gap,
   plus a *shared* cooldown: the first 429 sets a cooldown that every
   other queued call (and retry) waits out together, instead of each
   one independently retrying on its own timer and turning a burst
   into a worse burst a few seconds later.

---

## Name Service tab (dashboard)

Blockscout's own `/stats` page (and every generic chain explorer) has
no way to show any of this — it sees raw addresses and transactions,
only. This tab surfaces the one thing genuinely unique to this app:
activity on the `.etn` naming layer itself, which Blockscout has zero
concept of.

Domain/subname counts and "Top Domains by Subnames" needed **no new
backend work at all** — `activated-domains.json` (published for the
homepage's own Activated Domains table) already had everything: domain
count, per-domain subname arrays (`.length` = subnames registered per
domain), summed for the total.

What genuinely didn't exist anywhere: a *timestamped* event history
(for the "new names per day" trend chart) and marketplace sale prices
over time. Confirmed live that Blockscout's own logs endpoint
(`/addresses/{address}/logs`) omits block timestamps entirely — only
`block_number`/`block_hash` — so there was no way to get real dates for
past registrations without a dedicated scanner. `nameServiceStatsCache.js`
is a new, independent R2-publishing scanner (own cursor, duplicated
`queryLogsChunked` — same "fine to drift independently" pattern as this
backend's other caches) that watches `NameRegistered`/`DomainActivated`/
`SubnameRegistered`/`ListingSold` and, for each new one, resolves its
block's real timestamp (deduped per unique block within a scan cycle,
since multiple events can share a block and this chain's RPC rejects
request batching). Floor price / active listing count come from a live
`nextListingId()`/`listings()` read each cycle — same as
`marketplaceSellersCache.js` — rather than reconstructing "currently
active" from the event log, which would be fragile around reorgs/
processing-order edge cases the contract's own current state doesn't
have to worry about.

Verified live against the real contract before shipping: at the time
this was built, the marketplace has had **zero** `ListingSold` events
ever — Marketplace Volume genuinely shows "no resales" rather than a
fabricated number, and will start reflecting real data the moment a
name actually resells. Small honest numbers (this is a young
ecosystem — 4 domains, 21 subnames at build time), not inflated ones.

**"All of Electroneum" vs. "via ETN Subdomain Service"** (added on
request — "track all domains on Electroneum, not just those that run
through my subdomain service"): everything above only ever reflected
activity through this app's own Marketplace contract. Confirmed live
that's a small fraction of the real total — `BaseRegistrarImplementation`
(the chain-level registrar every `.etn` domain actually mints through,
regardless of which frontend registered it) had **90** real
`NameRegistered` events at the time this was built, vs. only 4 domains
this app's own Marketplace ever touched. `nameServiceStatsCache.js` now
also scans that contract and publishes a "Total .etn Domains" stat +
its own registrations trend, kept **visually separate** from the
app-specific section below it rather than blended into one number —
blending would misattribute the other 86 registrations as if they were
this app's own traffic.

Two real wrinkles worth knowing:
1. `BaseRegistrarImplementation.NameRegistered(uint256 indexed id, ...)`
   never carries a plaintext label — only a hashed tokenId — same
   fundamental limitation already documented for "retro" names in
   `ownedNamesCache.js`. Fine here: this only needs an accurate
   network-wide *count* and *trend*, not a name list.
2. Both contracts happen to emit an event literally named
   `NameRegistered`, with different shapes. Confirmed the naive
   `event.eventName === "NameRegistered"` check would silently merge
   them (reading `.args.label` off an event that doesn't have one) —
   disambiguated by which contract actually emitted it (`event.address`)
   instead.

Deployed *before* the Marketplace contract (confirmed via its earliest
transaction, one block before its own earliest `NameRegistered`) — a
plain `MARKETPLACE_DEPLOY_BLOCK` cursor bootstrap would have missed
pre-Marketplace history entirely. Bumped `CACHE_SCHEMA_VERSION` (same
fix shape as `ownedNamesCache.js`'s own v1→v2 history) so the
already-published cache — whose cursor had already advanced past
`MARKETPLACE_DEPLOY_BLOCK` — properly re-backfills from the earlier of
the two deploy blocks instead of silently skipping that whole range
forever.

**Chart split, domain links, sale links** (three follow-up requests
after the tab shipped):

- The "domain activations + subname registrations" line chart blended
  both event types into one number — genuinely two different kinds of
  event sharing a day axis, not two things that sum to a meaningful
  total. `ActivityComboChart.jsx` (new — bars for one series, an
  overlaid line for the other, sharing one Y-axis) replaces it;
  `SparklineChart.jsx` stays as-is for the "All of Electroneum" trend
  above it, which only ever had one series. An initial version stacked
  both as bars instead — corrected to bars + line per explicit
  follow-up ("I wanted a bar for activations and a line for subnames").
- "Top Domains by Subnames" rows now link to
  `${SITE_URL}/subnames/<domain>.etn` — the same deep link
  `App.jsx`'s `/subnames/` route and the subdomain advert Telegram bot
  already use to open "Get a Subname" pre-populated with that parent,
  not a new route.
- `ListingSold` events now carry `txHash`, and each sale (once any
  exist) links straight to `${EXPLORER_BASE_URL}/tx/<hash>` — no name/
  label available here either (`ListingSold` carries a `listingId`,
  not a label; resolving one would mean an extra per-sale contract
  call this cache doesn't otherwise need), so the link is the primary
  way to see what actually sold. Untestable against real data at the
  time this shipped (still zero real sales ever) — verified the
  plumbing (event property name, URL construction) directly instead.

---

## "Txs (Last 24h)" no longer trusts Blockscout's own daily counter

Real bug hit in production: "Txs Today (by hour)" showed a flat `0`
line for 19+ consecutive hours. Confirmed live: Blockscout's own
`/stats` `transactions_today` field was frozen at the exact same value
(`317366`) the entire day, while `total_transactions` (their real
indexer output) kept growing normally the whole time — a stuck
upstream aggregation bug, not this app's code, and not their main
indexer being down.

Rather than add a "data may be delayed" indicator for that specific
upstream field, replaced the whole metric's data source: it no longer
reads `transactions_today` *at all*. `dashboardStatsCache.js` now
computes `transactionsThisHour` as a delta between each hourly
snapshot's own `totalTransactions` (confirmed reliable) instead —
immune to Blockscout's daily-bucket bug entirely, since it never
touches that field. The Overview tile and chart were also switched
from "since UTC midnight" to a genuine rolling last-24-hours window
(user's own suggestion, mid-fix) — a second, independent improvement:
even when Blockscout's field worked fine, "today" meant the chart only
had 1 real hour of bars right after midnight, growing to 24 by end of
day: a rolling window is always a consistent 24 hours regardless of
wall-clock time. Renamed "Txs Today (by hour)" → "Txs (Last 24h)"
accordingly.

One expected, self-healing transition: historical snapshots published
*before* this fix still carry `transactionsThisHour: 0` from the old
buggy computation — they'll show as stale zeros in the chart for up to
24 hours after deploy, aging out of the rolling window naturally as
new (correctly-computed) snapshots replace them. The tile's headline
number is unaffected by this transition — it's computed fresh
client-side from `totalTransactions`, which was never wrong.

---

## ElectroSwap links + holder concentration (Tokens tab)

Three follow-up requests:

- Every NFT collection row (`TokenLeaderboard.jsx`) and every token's
  own detail page (`TokenDetail.jsx`) now links to ElectroSwap — a
  collection page (`/nfts/collection/<address>`) for NFTs, a trading page
  (`/explore/tokens/electroneum/<address>?inputCurrency=ETN`) for
  fungible tokens, plus a small ElectroSwap logo next to the link text
  (already available in `backend/assets/media.js`, reused rather than
  re-imported). The NFT leaderboard row needed restructuring from a
  `<button>` to a `<div role="button" tabIndex={0}>` so the link could
  nest inside it at all (a real `<a>` inside a real `<button>` is
  invalid HTML) — `onKeyDown` added to keep Enter-to-activate working,
  and the link's own `onClick` calls `stopPropagation()` so clicking it
  doesn't also trigger the row's own "open token detail" navigation.
- Each Top Holder row (`TokenDetail.jsx`) now shows what percentage of
  total supply that holder controls, computed from the raw BigInt
  values (basis-points precision) rather than dividing
  `formatTokenAmount`'s already-decimal-shifted display strings, which
  would lose precision for large supplies. `null` (row just omits the
  percentage) when total supply is missing or zero, rather than
  showing "NaN%"/"Infinity%".

Verified live: NFT rows show the ElectroSwap logo + a
`/collection/<address>` link; a real ERC-20 token page (Planet Zephyros
CORE) shows the correct `/explore/tokens/` link; holder percentages are
real and sum sensibly (top 14 holders of 71 ≈ 87% of supply, matching a
genuinely concentrated small-cap token). The NFT link's path was
corrected after this — see "On-chain NFT sale history" below.

---

## R2 reads go through this backend, not R2 directly

Every browser-side R2 JSON read (dashboard stats, owned names, ETN
price, activated domains, marketplace sellers, subname pricing, Name
Service stats) is fetched via `backend/utils/r2CacheProxyRouter.js`
(`GET /api/r2/:filename`, an allowlist of the known cache filenames —
not an arbitrary-path proxy) instead of the browser calling
`R2_PUBLIC_URL` directly. NFT images are the one exception and stay a
direct `R2_PUBLIC_URL` read (`utils/ens.js`) — an `<img src>` never
needed CORS in the first place, only `fetch()` does.

**Why:** confirmed live (real user report — the Name Service tab above
worked from every angle except an actual browser) that R2's `pub-*.r2.dev`
"Public Development URL" does not apply the bucket's CORS policy at
all. A correctly-scoped CORS policy was added to the bucket and
confirmed *saved*, and `curl` against the exact URL with the exact
production `Origin` header still came back with no
`Access-Control-Allow-Origin` header — while a plain server-to-server
GET (no browser, no CORS enforcement) succeeded every time for the
same URL. Cloudflare's own docs confirmed why: r2.dev is documented as
"rate-limited... for development purposes" only, and CORS support is
described specifically in the context of *custom domains* — never
mentioned for r2.dev. (This also retroactively explains the
intermittent `503`s seen earlier from r2.dev under real traffic — that
rate limit.)

The "proper" fix — a real custom domain connected to the bucket —
needs either a paid Cloudflare Business/Enterprise plan (the
free-plan-compatible "Partial (CNAME) Setup" isn't available on Free)
or migrating the domain's nameservers to Cloudflare, and this
project's domain is on Vercel with no appetite for either. Proxying
server-to-server sidesteps the problem entirely: this backend already
holds real R2 credentials for the *write* side of every cache here,
and browser CORS was never an S3-SDK/server-to-server concern to begin
with — only "a browser's `fetch()` reads this response" is.

Small in-memory cache on the proxy (60s TTL, matching the `Cache-Control`
these objects already publish with) — cuts repeat-visitor R2 reads to
roughly once per window instead of once per page load, on top of
whatever caching already existed R2-side.

---

## Dashboard/main-site cross-promotion + own tab identity

`DashboardFooter.jsx` now mirrors the main site's `Footer.jsx`
structure (ecosystem banner row, Telegram/X socials) rather than the
minimal placeholder it shipped with — reused directly, not
reimplemented, since the dashboard is part of the same Planet Zephyros
ecosystem those links already promote. Two deliberate differences from
a straight copy:

- An extra **ETN Subdomain Service** card in the banner row
  (`TransparentSubdomainLogo`, links to `SITE_URL`) — that app doesn't
  link to itself in its own footer, so this needed adding, not just
  copying.
- **Terms & Conditions rewritten from scratch.** The main site's
  version is entirely about name registration ("All registrations are
  final...", "Renewal reminders are your responsibility...") — actively
  misleading here, where nothing is registered, purchased, or wallet-
  connected. Replaced with what's actually true of this app: read-only,
  third-party data sources (Blockscout/CoinGecko/GeckoTerminal) shown
  as-is with no accuracy guarantee, not financial advice.

Cross-promotion runs the other way too: the main site's `Footer.jsx`
gained an **Electroneum Dashboard** card linking to
`dashboard.planetzephyros.xyz`. No dedicated dashboard logo graphic
exists to put in it (confirmed — its actual visual identity is the
Orbitron-set "Electroneum Dashboard" wordmark `DashboardApp.jsx`
already renders as its own heading, not a logo image), so this is a
small text card matching `EcosystemBanner`'s exact visual footprint
(background/border/radius/height) rather than reusing the Planet
Zephyros logo already shown elsewhere in the same footer, which would
have been a duplicate, ambiguous visual.

**Own `<title>`/favicon, added on request** — both apps share one
static `index.html` (see "Why one repo, one build, two domains" above
for why), so a dashboard visitor was getting "ETN Subdomain Service
(ENS)" and that app's own rocket-logo favicon regardless. Set at
runtime in `main.jsx`, the same `isDashboardHost`-branch pattern
already used to pick which app mounts — not two separate HTML files.
Dashboard gets "Electroneum Dashboard | Planet Zephyros" and
`/PlanetZephyrosLogo.png` (already a public static asset, same
directory `TransparentSubdomainLogo.png` — the main site's own
favicon — already lives in); the main site's `<title>`/favicon are
untouched, since the branch only ever overwrites them for
`isDashboardHost`.

---

## Vercel edge request caching

`vercel.json`'s catch-all rewrite (`/(.*)` → `/index.html`, needed so
client-side routes like `/pay/`, `/subnames/`, `/marketplace` and the
dashboard's tabs work on a hard refresh) was found live to have
suppressed Vercel's usual automatic immutable-caching for hashed
static assets. Confirmed by curling the actual deployed asset:

```
Cache-Control: public, max-age=0, must-revalidate
```

on a Vite output file like `/assets/index-BtPFp1G8.js` — a
content-hashed filename that, by construction, never changes meaning
once built (a new build always gets a new hash). `max-age=0,
must-revalidate` means every single page load, from every visitor,
including repeat visits, forces a fresh round-trip to Vercel's edge
for every JS/CSS chunk instead of being served straight from the
browser's local cache — this is likely what's behind the "sharp
increase in edge requests" reported around the same time this
dashboard's feature set (and chunk count) grew.

Fixed with an explicit `headers` rule in `vercel.json` setting
`Cache-Control: public, max-age=31536000, immutable` specifically on
`/assets/(.*)` — scoped to just the hashed output directory, not
`index.html` (which must keep revalidating on every load, since its
content is what changes on every deploy and is what points at the
current hashes). This is the standard, textbook-correct policy for
content-hashed build output and carries no staleness risk: any code
change ships under a brand new filename, so a returning visitor
serving last week's `index-XXXX.js` from cache is only ever serving
bytes that are still exactly what that hash represents. Pure request
reduction, no behavior change.

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

## Address Lookup → Tokens/NFT's cross-navigation

`AddressLookup.jsx`'s holdings rows (both the "Tokens" and "NFT's"
category — same `visibleHoldings.map(...)` renders both) now link
straight to that asset's own detail page. The row itself became a
`<button onClick={() => onSelectToken?.(tb.token?.address)}>` rather
than a plain `<div>`; `DashboardApp.jsx` passes down
`handleSelectTokenFromAddress` (sets `selectedToken` + switches to the
"Tokens" tab) as `AddressLookup`'s new `onSelectToken` prop, the same
pattern `TokenDetail.jsx`'s own "click a holder" already used in the
other direction (`onSelectAddress`). `onSelectToken` is optional — the
button is disabled (and un-clickable) if the prop or the token address
is missing, so this degrades safely if `AddressLookup` is ever reused
somewhere without that wiring.

---

## On-chain NFT sale history (Tokens tab, NFT collections)

NFT collection pages had nothing useful where `TokenPriceChart.jsx`
normally goes — a collection isn't an ElectroSwap trading pair, so its
GeckoTerminal-pool lookup always came back empty. Fixed with a new
chart built entirely from public on-chain data — **zero calls to
electroswap.io in any form** (see the incident note below for why that
constraint is absolute here, not just a preference).

**The marketplace:** ElectroSwap's NFT sales settle through
[Seaport](https://github.com/ProjectOpenSea/seaport)
(`0x678748317e7fD5B7699D07e666087608B401cbFd`), a well-known open-source
marketplace protocol — already trusted elsewhere in this codebase as
`SEAPORT_ADDRESS` in `coreClashConfig.js` / `coreClashNftSaleWatcher.js`.
Confirmed to be ElectroSwap's own contract (not a guess) because every
real fulfillment also fires a `FeeDeposited` event on their
`EsDividendDistributorV2` fee-sharing contract.

**The scanner:** `backend/utils/nftSalesCache.js` scans Seaport's
`OrderFulfilled` events, decodes the NFT item (offer or consideration
side — an order can carry the NFT on either side depending on whether
it's a listing or a bid) and sums the fungible side into a price,
publishing a flat, deduped `sales` array (per-sale: collection address,
token ID, price in ETN wei or `null` for a non-ETN/WETN sale, buyer,
seller, timestamp, tx hash) to `nft-sales.json` in R2, read through the
same `r2CacheProxyRouter.js` proxy as every other cache. `useNftSales.js`
filters that flat array down to one collection client-side.

**Dual-cursor scan, unlike this repo's other single-forward-cursor
caches:** Seaport was deployed at block 5,221,734 — over 10M blocks
before chain tip at the time this was built. A single "oldest first"
scan would've taken roughly a day of 5-minute cycles before reaching
*today's* sales, leaving the feature visibly broken the whole time.
Instead `highScannedBlock` stays caught up to chain tip every cycle
(recent sales appear almost immediately), while `lowScannedBlock`
independently backfills older history in the background, oldest-first,
toward the deploy block.

**The one real limitation — no floor price.** Seaport orders are
off-chain signed messages; nothing about a *listing* ever touches the
chain, only its fulfillment or cancellation. There's no on-chain
"Listing" event, so a floor price (lowest active ask) isn't honestly
derivable from chain data at all — not a scanning limitation, an
architectural one. `NftSalesChart.jsx` shows a **"Last Sale"** headline
stat instead (a real, verifiable number from the most recent priced
sale), plus the price-over-time trend and a scrollable recent-sales
list, each linking to its transaction on the block explorer.

**Incident note, why this feature is on-chain-only:** the first attempt
at this queried ElectroSwap's own GraphQL API directly
(`electroswap.io/graphql`, which has introspection enabled) to look for
an `nftActivity` feed. That triggered Cloudflare's WAF and got the
user's own IP blocked from electroswap.io entirely. All calls to
electroswap.io in any form stopped immediately, and this feature was
rebuilt from scratch using only Blockscout's public API to identify the
real marketplace contract and RPC log scanning for its events — the
same approach every other cache in this backend already uses, and one
that was always going to be more reliable than scraping a third party
that (reasonably) doesn't want automated traffic.

Verified: build succeeds, the NFT collection page correctly renders the
new chart component (in place of `TokenPriceChart`) instead of the old
empty state, in its loading/error/empty states — checked live against
the deployed backend from a local dev server. The actual sales data
itself can only be verified once this deploys and `nftSalesCache.js`'s
background scanner has had time to run (backfill takes a while — see
above), same "starts thin, grows richer" rollout as this repo's other
scanners.

---

## Top Holders: top 10 + Show More, and a USD value per holding

Two follow-ups on `TokenDetail.jsx`'s Top Holders list and
`AddressLookup.jsx`'s own holdings list:

- Top Holders now renders only the first 10 by default (was all 25),
  with a "Show More" button (`NeonButton`, same component/style
  `TokenLeaderboard.jsx`'s own "Load More" already uses) revealing the
  rest — client-side only, no extra fetch, since the existing
  `getTokenHolders` call already returns up to 25 in one page.
- Each holder row (`TokenDetail.jsx`) and each holding row
  (`AddressLookup.jsx`, both the "Tokens" and "NFT's" category) now
  shows that holding's USD value under its token amount — e.g. BOLT's
  top holder shows `15,000,000 (15.00%)` with `$20,279.41` beneath it.

**Where the price comes from:** the same GeckoTerminal-backed
`/api/token-chart` endpoint (`tokenChartRouter.js`) `TokenPriceChart.jsx`
already uses — the smallest range (7D) is fetched purely to read its
last candle's close price, independent of whatever range/metric the
price chart itself currently has selected. `TokenDetail.jsx` fetches
its own token's price once; `AddressLookup.jsx` fetches one price per
distinct fungible token in the wallet's holdings (capped at 25, matching
the holdings list's own render cap) — NFTs are skipped entirely, since
they have no ElectroSwap trading pair to price against (same reason
`TokenPriceChart.jsx` shows nothing useful for one, which is why NFT
collection pages get `NftSalesChart.jsx` instead — see above).

Firing one request per held token sounds like it could hammer
GeckoTerminal's rate limit, but doesn't: `tokenChartRouter.js` already
serializes *every* outbound GeckoTerminal call, from every visitor and
every endpoint, through one shared queue with an enforced minimum
interval — a wallet holding 20 different tokens just means 20 requests
taking their turn in that same queue, each independently resolving and
updating that row's $ value as it arrives, rather than the whole list
waiting on the slowest one. A token with no real GeckoTerminal pool
(most of the long tail) just never gets a price — its row shows the
token amount with no $ value beneath it, same "omit rather than fake a
number" convention as the existing holder-percentage column.

Verified live (local backend, to avoid the deployed backend's
production `ALLOWED_ORIGINS` CORS allowlist rejecting a local dev
port): BOLT's Top Holders shows 10 rows + a working "Show More" that
reveals the remaining 15, each with a correct USD value; the exact same
wallet/token combination the user gave as an example
(`0x79c0c8Fe02B2438ea44d35CEC24Bf36E89D2704b` holding 15,000,000 BOLT,
15.00%) showed `$20,279.41`. On Address Lookup, the same wallet's BOLT
holding shows the identical `$20,279.41` (consistent between the two
pages, as expected — same price source), a token with real liquidity
(Pandy) showed a sensible small $ value, and a token with no real
GeckoTerminal pool (ETN Club) correctly showed no $ value at all rather
than a fake one.

---

## Real 90-day/7-day charts, heatmaps, and the constant-block-time fix (Overview tab)

A cluster of related asks on Overview.jsx's tile charts, investigated together since they share
the same root cause: several of these metrics had no real historical source deep enough to chart
honestly, and the fixes needed new backend scanning rather than a frontend-only change.

**What was actually possible, checked before building anything:**

- **Total Transactions**: Blockscout's own `/stats/charts/transactions` only has 31 real days —
  confirmed live, not a guess. Reaching a genuine 90 days meant a new backend scan.
- **Total Addresses**: no historical source exists *anywhere* — not Blockscout (no addresses
  chart), not reconstructable from raw blocks (unique-address-count-as-of-a-past-date isn't
  something block scanning can recover). Left as-is: it keeps growing from
  `dashboardStatsCache.js`'s hourly snapshots, honestly captioned rather than claiming a depth it
  doesn't have.
- **Total Blocks "give different validators different colors"**: confirmed live that this chain's
  block producers round-robin fast (4 different validators in 4 consecutive blocks) — a single
  color per *day* cell couldn't meaningfully represent "which validator" at 90-day scale, so
  validators are shown via a legend + per-day breakdown in the tooltip instead of the cell's own
  color (the cell's color is tx-count brightness, as literally asked).
- **Avg Block Time**: separately reported as always looking like a flatline — confirmed live it
  *is* a flatline: both Blockscout's own rolling average across 51 real hourly snapshots, and this
  app's own raw consecutive-block-timestamp deltas taken straight from the chain, are **exactly**
  5.000s, zero deviation. Not "rounds to 5.0" — genuinely constant, by protocol design. No chart
  type makes that a more honest picture, so it's not charted at all anymore (see below).

**New backend caches** (both dual-cursor like `nftSalesCache.js` — chain tip stays fresh every
cycle, older history backfills in the background):

- `backend/utils/dailyBlockStatsCache.js` → `daily-block-stats.json` — real per-UTC-day tx counts
  and validator (miner) block-production breakdowns, 90-day trailing window. The heaviest one-time
  backfill in this codebase (~1.5M individual block fetches, several hours), using the lightest
  possible call per block (`eth_getBlockByNumber(n, false)` — hashes only, no full tx objects) to
  keep that as cheap as it can be.
- `backend/utils/hourlyActivityCache.js` → `hourly-activity.json` — real per-UTC-hour tx counts
  and ETN volume transferred, a *rolling* ~8-day window (not a growing history — the 7-day heatmap
  never needs more, so nothing older is kept or backfilled). Needs full transaction objects (only
  a tx's own `value` field carries the transferred amount — there's no lighter call that includes
  it), so it's more expensive per block than the daily cache but over a much smaller range —
  catches up in well under an hour.

**Frontend:**

- `mergeDailyTransactionCounts` (`useDashboardStats.js`) merges Blockscout's live 31 days with
  `dailyBlockStatsCache.js`'s deeper extension into one real daily series — Blockscout preferred
  wherever both have a day (always freshest), our cache only extending further back. Found live
  while testing: Blockscout's chart doesn't include *today* at all (newest entry is yesterday) —
  the merge has to skip that leading gap rather than treat it as "no data at all", or the whole
  series collapses to zero days every time.
- `CalendarHeatmap.jsx` — 90-day GitHub-contribution-style grid for Total Blocks. Cell brightness
  = that day's tx count; a fixed-color legend for the window's most active validators (by total
  blocks produced), with each day's real breakdown shown on hover against that same legend.
- `WeekHourHeatmap.jsx` — 7×24 (day × hour) grid for the renamed "Txs (Last 7 Days)" tile (was "Txs
  Last 24h", now a heatmap, not a line). Tooltip shows real tx count *and* real ETN volume
  transferred that hour.
- `BlockTimeConstant.jsx` — replaces Avg Block Time's chart entirely with a static "5.0s" display
  and a row of evenly-spaced dots (a metronome, not a data series) instead of dressing up a
  flatline as if it were meaningful data.
- `TileChart.jsx` gained an optional `renderChart` prop — an escape hatch for a tile whose active
  metric needs an entirely different chart type, not just different data. Every existing caller
  (`AddressLookup.jsx`, Overview's other metrics) is unaffected when it's omitted.

Verified live against a local backend instance (R2 unconfigured there, so the two new caches
correctly no-op and every new component's empty/"collecting data" state was checked instead of the
populated one) plus targeted real-chain smoke tests of the core scanning mechanics (binary search,
block fetch shape, day/hour bucketing, BigInt value summing) run directly against the RPC before
writing the full caches. Real data populates after this deploys and the caches' backfills run.

---

## Validators tile + per-validator reward chart (Overview tab)

New "Validators" tile: total distinct validators seen, plus a 90-day line chart (one line per
validator, blocks produced per day) with per-validator toggle checkboxes and each validator's
total blocks + ETN earned over the window.

**Reward data source, checked live before building anything:** raw RPC has no way to get a
validator's earnings per block cheaply — `eth_getBlockByNumber` doesn't carry it, and this chain's
RPC doesn't support `eth_getBlockReceipts` (confirmed live: `-32601 method does not exist`), so
computing it via RPC would mean one `eth_getTransactionReceipt` call *per transaction*, on top of
`dailyBlockStatsCache.js`'s already-heaviest 1.5M-block scan — tens of millions of extra calls,
not viable. Blockscout's own `/api/v2/blocks?type=block` list already computes each block's reward
server-side (confirmed live: `rewards: [{ type: "validator", reward: "<wei>" }]`, and on this chain
it's exactly the block's priority-fee revenue — base fee is burnt separately, not paid to the
validator) and paginates 50 blocks/page via a keyset cursor confirmed live to hold up at least a
week back. A full 90-day backfill this way is ~31,000 page requests instead of ~1.5M individual RPC
calls, and — deliberately — against a completely different budget than the RPC-based scanners,
after this repo's own recent experience with two scanners fighting over one rate-limited RPC
endpoint (see the daily-block-stats/hourly-activity history above). Sequential by design, small
delay between requests, no concurrency knob — sensible defaults, but conservative on purpose since
Blockscout's own rate limits for this volume aren't documented anywhere.

**New backend cache:**

- `backend/utils/validatorRewardsCache.js` → `validator-rewards.json` — real per-UTC-day,
  per-validator block counts and ETN rewards earned, 90-day trailing window. Same dual-cursor shape
  as `dailyBlockStatsCache.js` (chain tip stays fresh every cycle, backfill catches up in the
  background), but the backfill cursor is Blockscout's own opaque `next_page_params` object rather
  than a block number — its keyset cursor isn't reconstructable from a height alone.

**Frontend:**

- `ValidatorLineChart.jsx` — one polyline per validator over the trailing 90 days, toggleable via a
  checkbox list below the chart (sorted by total blocks, each row showing block count + ETN
  earned). Defaults to the top 4 validators by blocks so the chart isn't a 20+-line tangle on first
  load; a missing day renders as a real gap (backfill hasn't reached it), a present day where a
  validator produced nothing renders as a real 0 — same "don't draw absence as zero" discipline as
  `SparklineChart.js`.
- `VALIDATOR_PALETTE` moved from `CalendarHeatmap.jsx` into `theme.js` so the same validator
  address gets the same color in both components instead of two independently-assigned palettes;
  ranks beyond the fixed 9-color palette (this chain's active validator set runs past that) get a
  deterministic HSL color instead of repeating one.

Verified: `npm run build` succeeds clean. Live-tested the Blockscout pagination (tip page + a
cursor ~7 days back) and confirmed reward/miner/timestamp shape before writing the scanner. Not yet
verified: a full production backfill cycle (takes roughly a day at the default cadence) and
sustained operation against Blockscout's real, undocumented rate limits.

---

## RPC failover — one endpoint's key getting disabled took the whole backend down

Every cache/watcher in this backend shared one `RPC_URL` env var and built its own
`new ethers.JsonRpcProvider(RPC_URL, ...)` directly. That was already the subject of two earlier
incidents in this file (public-endpoint rate-limit exhaustion, above) — this time Ankr disabled the
*key* itself outright (`"message: API key disabled", json-rpc code -32051, rest code 403` — not a
rate limit, confirmed live), which took every single one of them down at once, with nothing to
fall back to.

**What didn't work, checked before building anything:** ethers' own `FallbackProvider` looked like
the obvious fix, but reading its source (`node_modules/ethers`, `provider-fallback.ts`) shows its
`quorum` mechanism tallies a provider's *error* as a legitimate, quorum-meeting result — by design,
for its own "do enough decentralized nodes agree this call reverts" use case. With two equal-weight
providers and the quorum that setup needs, the primary's very first error alone already meets
quorum and gets thrown immediately; the secondary is never even dispatched. That's consensus, not
failover, and not what this needed.

**What's here instead:** `backend/utils/rpcProvider.js`'s `createRpcProvider()` — a small
hand-rolled `JsonRpcProvider` subclass overriding `_send()` (the one low-level dispatch point every
call, `getBlock`/`call`/`getLogs`/a raw `provider.send(...)`, all of it, funnels through). Tries
`RPC_URL` (Ankr by default) first; on any error, uses `RPC_URL_FALLBACK` (Electroneum's own public
RPC by default) for every call for `RPC_PRIMARY_COOLDOWN_MS` (default 1 minute) before trying the
primary again — a genuinely disabled key fails every request forever until someone fixes it
manually, so without a cooldown every call across the whole backend would pay one
guaranteed-failing request to it first, for as long as the outage lasts. A static network (chain
52014) is passed to the underlying provider so it never does a live `eth_chainId` auto-detection
handshake — that handshake failing outright (not just being slow) is what caused the
"`JsonRpcProvider failed to detect network and cannot start up`" retry loop seen once already in
this file's own history, against an endpoint under load.

One real snag found live: the secondary path can't reuse ethers' own request layer. Ankr's key
being disabled surfaced instantly via ethers' normal Node HTTP client, but hitting
`rpc.electroneum.com` through that same client (a raw `http`/`https` request under the hood, see
`node_modules/ethers/utils/geturl.js`) got a flat `403 Forbidden` that neither `curl` nor Node's
native `fetch()` got hitting the exact same URL — almost certainly a TLS/HTTP client fingerprint
check on their side, not anything about the request content (identical headers, identical body).
`rpcProvider.js`'s secondary path uses plain `fetch()` instead, which this codebase's non-ethers
HTTP calls already did anyway (`r2CacheProxyRouter.js`, `validatorRewardsCache.js`) — this was just
the first time it mattered for an ethers provider specifically.

Every one of this backend's 16 provider-construction call sites (every cache, every Core Clash
watcher, `verifyOwnership.js`) now goes through `createRpcProvider()` instead of building its own
`JsonRpcProvider` off a bare `RPC_URL`. `coreClashConfig.js` no longer exports `RPC_URL` at all —
the five Core Clash files that used to import it from there now import `createRpcProvider` from
`rpcProvider.js` directly instead, same as everything else.

Verified live against the real (currently disabled) Ankr key and the real secondary endpoint,
outside the running backend (a standalone script, not the deployed service): confirmed the
mechanism actually fails over — `getBlockNumber()`, `getBlock()`, and `getCode()` all succeeded via
the secondary once the primary's disabled-key error was hit, a second call skipped the primary
entirely (cooldown in effect, no wasted request), and the fetch-vs-ethers-HTTP-client 403 above was
diagnosed and fixed *because* of this live testing, not caught by `node --check` alone. Every
modified file passes `node --check`, resolves its imports cleanly, and the whole backend boots
without error locally (R2 unconfigured there, so the caches themselves correctly no-op before ever
reaching `createRpcProvider()` — this refactor's actual RPC-failover behavior was verified via the
standalone script above instead, since exercising a real cache cycle needs R2 credentials this
session doesn't have).

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