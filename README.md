# Miroir

Miroir reviews trade-execution evidence against a strategy. This repository snapshot uses the current `frontend--/` app and a clean, provider-neutral backend rebuild. The visual design has not been redesigned; frontend changes wire existing screens to real API data and add the minimal sign-in/account-linking flow needed for per-user Roqqu access.

## Product and safety scope

- Deterministic rule evaluation is authoritative. Missing evidence is `cannot_assess`, not a zero or a breach.
- Profit and Loss (P&L) and Decision Quality remain separate metrics.
- Demo sessions are clearly labelled and seeded with sample trades/reviews. Mock data is intentional and remains available through the same API.
- Manual trade creation is supported by the backend API. The current `frontend--/` snapshot has no manual-trade form. **Open product decision:** decide whether to add a manual trade-entry window for recording trades. This means logging trades independently; it does not imply live order execution or trading integration. Roqqu remains read-only.
- Roqqu access is read-only and per user. A verified Miroir user enters a Roqqu API key once; the backend encrypts it with AES-256-GCM before storing it in PostgreSQL. Only the documented wallet-list and blockchain-address read endpoints are called; no send, trade, withdrawal, or account-change endpoint is implemented.
- Roqqu's public docs say account API keys are unrestricted, so users should connect a dedicated demo/empty account key. Application-level read-only allowlisting is not equivalent to a Roqqu-issued read-only credential.
- The live wallet view supports BTC, ETH, and TRX wallet lists. “Total received” is historical inbound volume, not spendable balance. A user can request on-chain balance/transaction details for a listed wallet; this lookup is globally rate-limited and cached to respect Roqqu's documented one-request-per-100-seconds limit.
- User accounts use Neon Managed Better Auth. Neon handles credentials, sessions, and email verification codes; the API validates short-lived Neon JWTs against the branch JWKS and maps the Neon subject to a Miroir-owned identity. Demo sessions remain separate.
- Refresh is on demand. No orders, transfers, polling, or streaming feed are implemented.
- AI explanation has a `not_configured` adapter placeholder. It may provide bounded explanatory text only and cannot change deterministic scores. AI Strategy Chat is out of scope.
- Hosting-provider-specific deployment files are deferred until a target is selected.

## Project layout

```text
frontend--/                 React + Vite application
backend/                    Fastify API, mock/PostgreSQL stores, migrations, scoring, auth, Roqqu read adapter
.github/workflows/ci.yml    CI for the current frontend and backend

docs/                       Preserved project docs and rebuild notes
```

Older audit/runbook docs in `docs/` describe previous backend copies and are retained for reference; current instructions are in this README and `backend/README.md`.

## Requirements

- Node.js 22+ and npm
- PostgreSQL for persistent mode (or Docker Compose to run local PostgreSQL)

## Quick start — mock mode

Run the API in one terminal:

```bash
cd backend
npm ci
cp .env.example .env       # optional; DATA_MODE defaults to mock
npm run dev
```

Run the frontend in a second terminal:

```bash
cd frontend--
npm ci
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/v1` and `/health` to `http://127.0.0.1:8080`. Demo sessions use the same API contract in both storage modes. Mock data lives in the backend and is labelled in the UI; the browser does not silently fall back if the API is unavailable. Neon account registration and sign-in use the Neon-backed run commands above; **Start Demo** remains separate.

## Neon PostgreSQL and Managed Auth

The linked Neon production branch has Postgres and Better Auth enabled. Miroir uses Neon Postgres for persistence and Neon Managed Better Auth for account creation, sign-in, sessions, and email verification codes. Neon handles the auth server and email delivery; the app only verifies Neon-issued JWTs and maps each Neon user to a Miroir-owned identity.

After the one-time Neon CLI sign-in, the linked `neon.ts` and `.neon` config let `@neon/env` inject the pooled database URL, direct migration URL, Auth base URL, and JWKS URL automatically. You do not need to copy those values into chat or hand-wire secrets into the app.

From the repository root, install dependencies, run the one-time setup, then start the app in separate terminals:

```bash
npm run install:all
npx neon@latest login      # one-time CLI authorization
npm run neon:setup         # deploy config, enable email-code verification, apply schema
npm run neon:backend
npm run neon:frontend
```

`neon-env run` fetches branch values from Neon for each command. `DATABASE_URL` is used for runtime queries and `DATABASE_URL_UNPOOLED` is used for migrations. Local `.env` files are only needed if you choose to run outside the Neon CLI. Do not commit them.

In Neon Console, confirm **Sign-up with Email** and **Verify at Sign-up → Verification code** are enabled under the production branch's Better Auth settings. Neon sends and verifies the code through its managed provider. The default provider is suitable for initial testing; custom email delivery is only needed for branded production emails.

The local Docker Compose database remains available for database-free demo work, but it does not power Neon Auth. Demo mode remains separate from Neon accounts.

## API contract

- `POST /v1/demo/session`
- `POST /v1/auth/logout` (legacy demo-session revocation; Neon accounts sign out through Managed Auth SDK)
- Neon account sign-up, email-code verification, sign-in, and sign-out use the Neon Auth client; API resource endpoints accept its verified JWT.
- `GET /v1/me`, `GET /v1/strategies`
- `GET /v1/trades`, `POST /v1/trades`
- Bodyless `POST /v1/trades/:id/review`
- `GET /v1/stats?currency=USD`, `GET /v1/progress`
- `GET /v1/roqqu/status`, `POST /v1/roqqu/connect`, `POST /v1/roqqu/disconnect`, `GET /v1/roqqu/balances`, `GET /v1/roqqu/history`

Errors use `{ "error": { "code", "message" } }`. The review request has no body; do not send `Content-Type: application/json` for it. The frontend only adds JSON content-type when a request body exists.

## Roqqu live wallet connection

A verified Miroir user enters their own Roqqu API key in **Accounts**. The key is sent only to the Miroir backend, validated with the documented read-only BTC wallet-list request, and stored as an identity-bound AES-256-GCM ciphertext in PostgreSQL. The plaintext key is never returned by the API or stored in browser storage. Disconnect deletes that user's saved encrypted credential.

The live read adapter is pinned to `https://api.roqqu.com/prod/v1/` and allowlists only `POST /user/wallets` (BTC, ETH, TRX) and `GET /blockchain/address`. It does not implement send, trade, withdraw, or settings routes. Wallet-list values `total_received` and `total_received_usdt` are cumulative receipts, not current/spendable balances. On-chain lookups require a listed wallet address and use a shared Postgres-backed 100-second limiter/cache.

**Key safety:** Roqqu's public API documentation describes an account secret key as unrestricted. Miroir's read-only code path does not reduce the key's permissions at Roqqu. Use a dedicated demo/empty account and revoke the key in Roqqu if it is no longer needed. Roqqu's public docs do not document a separate demo base URL for this account API; the app does not silently use a funded account or invent a sandbox.

Set `ROQQU_CREDENTIAL_ENCRYPTION_KEY` only in the backend environment (hosting secrets or an untracked local env file). Generate a new 32-byte key once with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep the same encryption key across deployments/backups; changing it makes previously saved user credentials undecryptable. This workspace has no Roqqu API key, so live upstream behavior still needs a user-provided demo-account key to verify.

## Checks

```bash
cd frontend-- && npm ci && npm run lint && npm run build
cd ../backend && npm ci && npm test && npm run lint && npm run build
```

CI runs a PostgreSQL service for persistence/auth tests. The current sandbox has no PostgreSQL server or Docker executable, so its PostgreSQL integration test is skipped locally and must be verified in CI or on a machine with PostgreSQL/Docker.

## Hosted deployment (decision B)

The hosted backend must use server-side environment variables; it must not need `neon login` or your personal Neon CLI session at runtime. Configure these in the hosting provider's secret/environment settings:

- `DATA_MODE=postgres`
- `DATABASE_URL` (Neon pooled runtime URL)
- `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL`
- `ROQQU_CREDENTIAL_ENCRYPTION_KEY` (persistent 32-byte base64 key)
- `HOST=0.0.0.0`, the provider's `PORT`, and allowed `CORS_ORIGIN`

Use `DATABASE_URL_UNPOOLED` only for schema migrations, not as a browser or frontend variable. The Neon CLI remains a local/deployment convenience for injecting values or applying migrations; it is not required when the hosted backend has these environment variables. Never put database URLs, encryption keys, or per-user Roqqu keys in the React build or source control. The frontend needs the public Neon Auth base URL, not the database credentials.

The deploy target has not been selected, so provider-specific deploy files/commands are not added yet. No hosted deployment or live Roqqu call has been performed in this workspace.
