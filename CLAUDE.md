# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

This is a multi-project repo, but only one project is active. There is **no `package.json` at the root** — work from inside the subproject.

- `LoraWan-Monitoreo-y-Control/` — active platform (React 19 + Vite 7 frontend, Express 4 backend, SQLite). All real code, tests, scripts, and docs live here. `cd LoraWan-Monitoreo-y-Control` before running any npm command.
- `LoraWan-Control-Agua/` — reserved placeholder, no code yet.

## Commands

All commands assume CWD is `LoraWan-Monitoreo-y-Control/`.

```bash
# Setup
npm install                          # from repo root: npm run install:app

# Dev (one terminal — backend + Vite together, prefixed [api]/[front], Ctrl+C kills both)
npm start                            # runs scripts/start-dev.mjs
npm run dev                          # frontend only (Vite on :5173)
npm run start:api                    # backend only (Express on :3001, loads --env-file=.env if present)

# Production
npm run production                   # build + start:prod (forces NODE_ENV=production)
npm run build                        # frontend → dist/
npm run start:prod                   # API serving built frontend, requires JWT_SECRET

# QA gates (run in this order before shipping)
npm run lint                         # ESLint on src/ only — server/ and scripts/ are ignored
npm run build                        # type/build sanity
npm test                             # node --test server/test/selfhosted.test.cjs
npm run verify                       # integration smoke (scripts/verify-integration.mjs)

# Tooling
npm run preview                      # serve built dist/ via Vite
npm run simulate:lns                 # LoRaWAN class A/B/C uplink simulator
npm run reset:bootstrap              # wipe local SQLite + bootstrap marker
npm run openrouter:sync              # regenerate server/OPENROUTER/settings.json from its .env

# Running a single backend test
node --test --test-name-pattern='rate limit' server/test/selfhosted.test.cjs
```

Node runtime requirement: **`^20.19.0` or `>=22.12.0`**. The server uses `node --experimental-sqlite` (no `better-sqlite3` dependency) — older Node versions will fail at startup, not at install.

## Architecture

### Two module systems on purpose
- **Frontend and arranque scripts** (`src/`, `scripts/*.mjs`, `vite.config.js`): ESM. The subproject's `package.json` has `"type": "module"`.
- **Server** (`server/*.js`, `server/test/*.cjs`): CommonJS. Don't migrate it casually — `server.js` is ~3.9k lines with many `require()` sites.

### Backend (`server/`)
`server/server.js` is the monolith: ~87 Express route handlers, SSE hub, JWT auth, ingest pipelines, LNS engine glue, and listeners on multiple ports.

Listeners (all bind `0.0.0.0`):
- HTTP API: `PORT` (default **3001**), serves `/api/*` plus the built `dist/` SPA in production.
- Optional dedicated ingest HTTP: `INGEST_PORT` (separate `POST /ingest/<userId>/<token>` Express app).
- UDP Semtech GWMP: `LNS_UDP_PORT` (default **1700**); disable with `LNS_UDP_PORT=0` or `SYSCOM_LNS_UDP=0` for hosts that can't bind UDP (e.g. Render).

Persistence is **SQLite via `node:sqlite`** (`server/store.js`). Schema is created and migrated inline at startup with `CREATE TABLE IF NOT EXISTS` plus ad-hoc ALTER steps — **there is no migrations directory and no migrate command**. Default DB path is `server/data/syscom.db`; override with `SYSCOM_SQLITE_PATH`. One-time import from the legacy `server/db.json` happens only when `SYSCOM_IMPORT_LEGACY_DB_JSON=1`.

LoRaWAN handling lives in `lorawan-*.js`, `semtech-udp-lns.js`, `lorawan-lns-engine.js`, `milesight-*.js`. Uplinks can arrive via three paths and all converge on the same `runUplinkPipeline`:
1. HTTP `POST /api/ingest/:userId/:ingestToken` (also `/api/lorawan/uplink/...` and `/api/milesight/uplink/...`).
2. Semtech UDP packet forwarder → LNS_UDP_PORT.
3. Milesight MQTT subscriber (`mqtt-ingest.js`).

Important: **never** publish LoRaWAN downlinks through the Milesight UG65 REST queue. The integrated LNS owns MAC and frame counters; the UG65 should be a packet forwarder only. This is enforced in `/api/milesight-ug-gateway/...` endpoints (see the explanatory error string ~`server.js:1826`).

### Frontend (`src/`)
React 19 SPA, no React Router. The active page is React state (`page` in `App.jsx`) and the last page is persisted in `localStorage` under `syscom_iot_last_page`. URLs are not user-facing routes — bookmarking a page is not supported.

Page visibility per role is gated in `resolvePageForRole` (`src/App.jsx:81`) and must stay in sync with `Sidebar.jsx`. New pages need entries in both `ALL_NAV_PAGE_IDS` and `PAGE_HEADINGS`.

State is plain React Context — no Redux/Zustand. Auth state, theme, language, activity log, and the device-widget-picker each have their own provider under `src/context/`.

API base resolution lives in **one place**: `src/config/apiBase.js`. Three functions matter:
- `getApiBase()` — defaults to `/api` (relative). Override at build time with `VITE_API_BASE` only when front and API are on different hosts; the value must end in `/api`.
- `getEventsStreamUrl(token)` — SSE. **In dev it deliberately bypasses the Vite proxy** and hits `http://localhost:3001` directly (Vite's HTTP proxy mangles long-lived SSE). Override the dev port with `VITE_DEV_API_PORT` or the whole origin with `VITE_SSE_ORIGIN`. Force the legacy proxy path with `VITE_SSE_VIA_PROXY=1`.
- `getPublicServerOrigin()` — for ingest URLs surfaced in the UI.

The shared SSE event-name contract is **frozen in `shared/realtime-sse-contract.json`** and required by both server (`server.js`) and client (`SyscomRealtimeBridge.jsx`). If you change an event name, change both ends + this file.

### Auth flow
- Single auth state across the app: JWT in `localStorage` as `local_token`. `axios` has a global 401 interceptor (`src/services/api.js:9`) that calls `refreshSession()` once and retries — within `SYSCOM_JWT_REFRESH_GRACE_MS` (default 30 days) the server lets a recently-expired token refresh.
- Default JWT lifetime is **365d** (`SYSCOM_JWT_EXPIRES`) because the product is intended for 24/7 kiosk displays. Shorten only when you understand that constraint.
- **First-run bootstrap**: if `users` is empty, `GET /api/setup/status` returns `needsSetup: true` and the UI shows a superadmin-creation form instead of login.
- OAuth (Google/Microsoft/Yahoo, in `*-auth-routes.js`) **only links to pre-existing local users** — it doesn't create accounts. Roles always come from SQLite.
- Login is rate-limited (`SYSCOM_LOGIN_RATE_MAX`, default 40 per 15 min) and ingest is too (`SYSCOM_INGEST_RATE_MAX`, default 600/min). The limiter is in-memory (`rate-limit-memory.js`), so multi-process deployments need a sticky load balancer or a shared store.

### Production runtime
In production the API serves the built `dist/` SPA from the same origin, so `getApiBase()` resolving to `/api` works without any CORS. If you split front and API onto different hosts, you must set `VITE_API_BASE` **at build time** (it's `import.meta.env`, not runtime), set `SYSCOM_CORS_ORIGINS` on the server, and ensure the SSE origin matches `getEventsStreamUrl`'s expectations.

When behind a reverse proxy, set `SYSCOM_TRUST_PROXY=1` so `req.ip` and rate limiting respect `X-Forwarded-*` (only takes effect in `NODE_ENV=production`).

### `server/OPENROUTER/`
Unrelated to the runtime app — it's a helper to generate a Claude Code settings.json that points at OpenRouter. Files there are not loaded by the server. Don't commit `server/OPENROUTER/.env`; regenerate `settings.json` with `npm run openrouter:sync`.

## Conventions

- **ESLint scope**: `eslint.config.js` ignores `server/`, `scripts/`, and `dist/`. Lint only enforces frontend rules; server changes don't get auto-checked. Run `npm test` to validate server changes.
- **Frontend lint quirks**: unused vars must start with uppercase, underscore, or be ignored by file-specific overrides (`src/services/api.js` disables `no-unused-vars`).
- **No migrations layer**: schema changes go into `server/store.js` as additional `CREATE TABLE IF NOT EXISTS` plus an inline backfill. Plan for idempotency — the same code runs on every boot.
- **HTML reports for PDF printing**: when generating HTML intended to be printed/exported as PDF, include a `@page { size; margin; }` rule matching the actual layout dimensions (see global user rule), not the default A4/Letter.
