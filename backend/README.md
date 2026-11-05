# Miroir backend

Provider-neutral Fastify API for the current `frontend--/` application. `DATA_MODE=mock|postgres` selects storage behind one stable HTTP contract:

- `mock`: in-memory demo store with labelled sample Roqqu balances/history.
- `postgres`: Neon-backed persistent data and Neon Managed Better Auth identities.

Neon Managed Better Auth owns account creation, sign-in, sessions, and email verification codes. The API verifies Neon-issued EdDSA JWTs against Neon JWKS, then maps the verified subject to a Miroir-owned user identity. Demo tokens remain separate. No Miroir password or email-verification service is maintained.

Deterministic rule evaluation is authoritative. The AI explanation adapter defaults to `not_configured`; explanatory text cannot change scores. Roqqu routes are read-only and on-demand. A verified user supplies their own Roqqu API key once; the backend encrypts it with AES-256-GCM and only calls wallet-list/on-chain read endpoints. The API key is unrestricted at Roqqu, so a dedicated demo/empty account is recommended. No send/trade/withdraw operations or transaction-to-trade import are implemented.

## Neon local development

From the repository root, after authenticating the Neon CLI once, use `@neon/env` to inject the linked production branch environment:

```bash
npm run neon:migrate
npm run neon:backend
```

The migration runner uses Neon’s direct connection URL when supplied. The backend uses the pooled `DATABASE_URL` at runtime. It accepts `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL` from the Neon CLI. No database URL or auth token needs to be copied into source files.

The frontend runs in a separate terminal with `npm run neon:frontend` from the repository root. Its Vite config passes the injected Auth base URL to the browser SDK. Verify at Sign-up with **Verification code** should be enabled for the Neon production branch.

## Local mock mode

```bash
npm ci
npm --prefix backend ci
npm --prefix backend run dev
```

Check `http://localhost:8080/health`. Vite proxies API requests to this local address. Mock mode supports demo sessions; Neon accounts require the linked Neon environment.

## Database migrations

Versioned migrations are in `db/migrations/` and `src/migrate.js` applies them in order. Migration `002_neon_managed_auth.sql` adds the Neon subject mapping; migration `003_roqqu_user_keys.sql` adds encrypted per-user key storage plus shared on-chain rate-limit/cache tables. Run migrations against the intended branch before starting the new app code.

## Per-user Roqqu wallet API

In PostgreSQL mode, a verified user submits their own Roqqu API key to `POST /v1/roqqu/connect`. The backend validates it with `POST https://api.roqqu.com/prod/v1/user/wallets` for BTC, encrypts it using `ROQQU_CREDENTIAL_ENCRYPTION_KEY`, and stores only the ciphertext in the user's `roqqu_connections` row. Account reads decrypt it in memory and use the key only for the allowlisted `POST /user/wallets` endpoint. Blockchain address lookups use the documented public `GET /blockchain/address` endpoint after confirming the address appears in that user's wallet list.

The app only exposes BTC, ETH, and TRX wallet reads. Roqqu's blockchain-address lookup is limited to one request per 100 seconds; Postgres-backed global throttling and response caching are used. No write endpoint, order execution, transfer, withdrawal, or settings action is implemented. Roqqu API keys are unrestricted at the provider level; the app's allowlist does not change the key's provider permissions. Use a dedicated demo/empty account.

`ROQQU_CREDENTIAL_ENCRYPTION_KEY` must be a persistent base64-encoded 32-byte secret available to the backend. Generate it with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`; keep it out of source control and do not rotate it without re-encrypting saved credentials. Apply the numbered migrations before enabling live connections. Mock mode continues to return labelled sample data.

## API surface

- `POST /v1/demo/session`
- `POST /v1/auth/logout` (demo-session revocation; Neon sign-out uses the Neon SDK)
- `GET /v1/me`, `GET /v1/strategies`
- `GET /v1/trades`, `POST /v1/trades`, bodyless `POST /v1/trades/:id/review`
- `GET /v1/stats?currency=USD`, `GET /v1/progress`
- `GET /v1/roqqu/status`, `POST /v1/roqqu/connect`, `POST /v1/roqqu/disconnect`, `GET /v1/roqqu/balances`, `GET /v1/roqqu/history`

Neon auth UI methods run through the Neon SDK. Legacy `/v1/auth/register`, `/login`, `/verify`, and `/verification/resend` return `410 AUTH_MOVED_TO_NEON`. Resource API requests use a bearer JWT; demo mode uses an opaque session token.

Errors are returned as `{ error: { code, message } }`. Review POST is bodyless; clients must omit JSON content-type when no body is sent.

## Checks

```bash
npm test
npm run lint
npm run build
```

The PostgreSQL integration test runs when `DATABASE_URL` points to a dedicated test database. It applies idempotent migrations and cleans up the unique Neon-subject test users. Do not point it at production. The CI PostgreSQL service exercises persistence; live Neon/JWKS and email delivery require the linked project and cannot be simulated by that test.
