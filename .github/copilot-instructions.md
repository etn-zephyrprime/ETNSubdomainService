# Copilot instructions for ETNSubdomainService

## Build, test, and validation commands

This repository is split into two runnable apps:

- Frontend: Vite + React app at the repo root (`package.json`)
- Backend: Node + Express service in `backend/` (`backend/package.json`)

Run the frontend from the repo root:

- `npm install`
- `npm run dev`
- `npm run build`

Run the backend from `backend/`:

- `cd backend && npm install`
- `cd backend && npm start`
- `cd backend && npm run dev`
- `cd backend && npm test`

Run a single backend test file directly:

- `cd backend && node --test tests/<file>.test.js`
- `cd backend && npm test -- --test-name-pattern="pattern"`

There is no repo-level or backend lint script configured right now, so do not assume a `lint` command exists unless a package script is added.

## High-level architecture

The app is not a single-package service. The repo combines a browser wallet app and a background blockchain service:

- `src/` is the customer-facing React front end. `src/App.jsx` is the main app shell and handles deep links such as `/pay/:name`, `/subnames/:parent`, and `/marketplace`.
- `backend/index.js` boots the API server and starts many background watchers/caches. Most backend features are optional and are registered via `safeStart(...)` so that missing environment variables do not crash the entire process.
- The backend exposes `GET/POST` endpoints under `/api/*` for things such as NFT generation, Telegram linking, token/market data, premium features, contract checks, and app checks.
- Most of the backend logic is event-driven polling rather than long-lived WebSocket subscriptions, which is intentional for public RPC reliability.

The repo is centered around ETN domain/subdomain operations and supporting services:

- domain registration and subname flows in the frontend
- marketplace, pricing, and stats caches in `backend/utils/`
- contract and app monitoring in `backend/services/` and `backend/utils/`
- background Telegram, alert, and scheduler jobs that are enabled only when their env vars are set

## Key conventions and repository-specific patterns

- Keep backend optional features guarded by environment variables. Many files are designed to no-op cleanly if the required config is missing; do not assume every feature is enabled.
- `backend/index.js` is the startup registry. If you add a new watcher, cache, or scheduler, check whether it should be started there and whether it should be wrapped in `safeStart()`.
- The backend includes native dependencies (`canvas` in particular). Local setup may require system libraries such as `cairo`, `pango`, `libjpeg`, and `librsvg`; see the README for exact install guidance if local builds fail.
- The frontend uses route-level special handling in `src/App.jsx` instead of a separate router library; preserve the existing deep-link behavior for direct-share URLs.
- Use the backend package root (`backend/`) for Node-side scripts and tests. Root-level commands are for the frontend only.
- The repo has a documented polling architecture for chain watchers and state persistence; when touching those areas, prefer the existing polling/cache patterns instead of inventing a new live subscription model.

## Notes from the repo docs

- The backend README calls out that the service was built and syntax-checked but not fully exercised end-to-end in the current environment due to install/runtime constraints around native packages.
- If you work on the backend, treat local verification as important because native build issues can be environment-specific.
- For production deployments, persistent state matters; the backend tracks processed block positions and relies on durable storage for restart safety.
