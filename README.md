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
  collection page (`/collection/<address>`) for NFTs, a trading page
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

Verified live: NFT rows show the ElectroSwap logo + correct
`/collection/` links; a real ERC-20 token page (Planet Zephyros CORE)
shows the correct `/explore/tokens/` link; holder percentages are real
and sum sensibly (top 14 holders of 71 ≈ 87% of supply, matching a
genuinely concentrated small-cap token).

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