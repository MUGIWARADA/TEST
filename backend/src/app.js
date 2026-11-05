import Fastify from 'fastify';
import cors from '@fastify/cors';
import { evaluateTrade } from './scoring.js';
import { RoqquClient, ROQQU_WALLET_TOKENS, roqquMockData } from './roqqu.js';
import { decryptRoqquApiKey, encryptRoqquApiKey } from './roqqu-credentials.js';
import { createAiAdapter } from './ai-adapter.js';
import { createNeonTokenVerifier } from './neon-auth.js';

function bearerToken(request) {
  const sessionHeader = request.headers['x-miroir-session'];
  if (typeof sessionHeader === 'string' && /^[A-Za-z0-9._~-]{16,4096}$/.test(sessionHeader)) return sessionHeader;
  const value = request.headers.authorization || '';
  const match = /^Bearer\s+([A-Za-z0-9._~-]{16,4096})$/i.exec(value);
  return match?.[1] || null;
}

function responseError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

const normalizeIdentity = (identity) => ({
  id: identity.id,
  mode: identity.mode,
  display_name: identity.display_name,
  ...(identity.email ? { email: identity.email } : {}),
  ...(identity.email_verified_at ? { email_verified_at: identity.email_verified_at } : {})
});

export async function createApp({
  store,
  config = { corsOrigins: ['http://localhost:5173'], nodeEnv: 'development', dataMode: 'mock', sessionTtlHours: 24, neonAuthUrl: '', neonAuthJwksUrl: '', roqquCredentialEncryptionKey: '' },
  aiAdapter = createAiAdapter(),
  roqquClientFactory = (options) => new RoqquClient(options),
  authVerifier = config.neonAuthUrl ? createNeonTokenVerifier(config.neonAuthUrl, { jwksUrl: config.neonAuthJwksUrl }) : null
}) {
  const app = Fastify({ logger: config.nodeEnv !== 'test' });
  await app.register(cors, { origin: config.corsOrigins, credentials: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'X-Miroir-Session'] });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/v1/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, request_id: request.id }, 'API request failed');
    const isApiError = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code);
    const status = isApiError ? error.statusCode : 500;
    const code = isApiError ? error.code : 'INTERNAL_ERROR';
    const message = isApiError ? error.message : 'An unexpected server error occurred.';
    const debug = config.nodeEnv === 'development' && !isApiError ? {
      request_id: request.id,
      cause: String(error?.message || error || 'Unknown error')
        .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted database URL]')
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .slice(0, 500),
      ...(typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? { sqlstate: error.code } : {})
    } : undefined;
    return reply.code(status).send({ error: { code, message }, ...(debug ? { debug } : {}) });
  });

  app.get('/health', async () => ({ status: 'ok', data_mode: config.dataMode }));

  app.post('/v1/demo/session', async (request, reply) => {
    const displayName = typeof request.body?.display_name === 'string' && request.body.display_name.trim()
      ? request.body.display_name.trim().slice(0, 80)
      : 'Demo Trader';
    const session = await store.createDemoSession(displayName);
    return reply.code(201).send(session);
  });

  // Account creation, email verification, and sign-in are handled by Neon Managed Auth in the client.
  // Keep a clear response for older clients rather than accepting app-managed passwords.
  for (const path of ['/v1/auth/register', '/v1/auth/verify', '/v1/auth/verification/resend', '/v1/auth/login']) {
    app.post(path, async () => {
      throw responseError('AUTH_MOVED_TO_NEON', 'Use the Miroir client to authenticate with Neon Managed Auth.', 410);
    });
  }

  app.post('/v1/auth/logout', async (request, reply) => {
    await requireIdentity(request, store, config, authVerifier);
    const token = bearerToken(request);
    if (token && typeof store.revokeSession === 'function') await store.revokeSession(token);
    return reply.code(204).send();
  });

  app.get('/v1/me', async (request) => {
    const identity = await requireIdentity(request, store, config, authVerifier);
    return { identity: normalizeIdentity(identity) };
  });

  app.get('/v1/strategies', async (request) => {
    const identity = await requireIdentity(request, store, config, authVerifier);
    return store.getStrategies(identity.id);
  });

  app.get('/v1/trades', async (request) => {
    const identity = await requireIdentity(request, store, config, authVerifier);
    return store.listTrades(identity.id);
  });

  app.post('/v1/trades', async (request, reply) => {
    const identity = await requireIdentity(request, store, config, authVerifier);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw responseError('INVALID_TRADE', 'A trade object is required.', 400);
    const payload = request.body;
    if (typeof payload.symbol !== 'string' || !payload.symbol.trim()) throw responseError('INVALID_TRADE', 'symbol is required.', 400);
    if (payload.evidence !== undefined && !Array.isArray(payload.evidence)) throw responseError('INVALID_TRADE', 'evidence must be an array.', 400);
    const cleanPayload = { ...payload, symbol: payload.symbol.trim().toUpperCase() };
    for (const field of ['id', 'identity_id', 'strategy_id', 'created_at', 'review']) delete cleanPayload[field];
    const trade = await store.createTrade(identity.id, cleanPayload);
    return reply.code(201).send({ trade });
  });

  app.post('/v1/trades/:id/review', async (request) => {
    const identity = await requireIdentity(request, store, config, authVerifier);
    const trade = await store.getTrade(identity.id, request.params.id);
    if (!trade) throw responseError('TRADE_NOT_FOUND', 'Trade not found.', 404);
    const cached = await store.getReview(identity.id, trade.id);
    if (cached) return { review: cached, cached: true };
    const strategies = await store.getStrategies(identity.id);
    const strategy = strategies.strategies.find((item) => item.id === trade.strategy_id) || strategies.strategies[0];
    if (!strategy) throw responseError('STRATEGY_NOT_FOUND', 'No strategy is available to assess this trade.', 409);
    const result = evaluateTrade(trade, strategy);
    result.ai_explanation = await aiAdapter.explain({ trade, review: result });
    const review = await store.saveReview(identity.id, trade.id, result);
    if (!review) throw responseError('TRADE_NOT_FOUND', 'Trade not found.', 404);
    return { review, cached: false };
  });

  app.get('/v1/stats', async (request) => {
    const identity = await requireIdentity(request, store, config, authVerifier);
    const currency = typeof request.query.currency === 'string' ? request.query.currency.toUpperCase() : 'USD';
    if (currency !== 'USD') throw responseError('UNSUPPORTED_CURRENCY', 'Only USD statistics are currently supported.', 400);
    return { stats: await store.getStats(identity.id, currency) };
  });

  app.get('/v1/progress', async (request) => {
    const identity = await requireIdentity(request, store, config, authVerifier);
    return store.getProgress(identity.id);
  });

  app.get('/v1/roqqu/status', async (request) => {
    const identity = await requireIdentity(request, store, config, authVerifier);
    if (config.dataMode === 'mock') {
      return { provider: 'roqqu_api', configured: true, connected: true, enabled: true, connectable: false, mode: 'mock', sample_data: true, refresh_mode: 'on_demand', access_model: 'sample_data', writes_enabled: false };
    }
    const isVerifiedUser = identity.mode === 'user' && Boolean(identity.email_verified_at);
    const savedConnection = isVerifiedUser ? await store.getRoqquConnection(identity.id) : null;
    const connected = Boolean(savedConnection?.api_key_ciphertext);
    const encryptionConfigured = Boolean(config.roqquCredentialEncryptionKey);
    return {
      provider: 'roqqu_api', configured: encryptionConfigured, connected,
      enabled: Boolean(connected && encryptionConfigured),
      connectable: Boolean(isVerifiedUser && encryptionConfigured),
      auth_required: !isVerifiedUser, mode: 'live', sample_data: false, refresh_mode: 'on_demand',
      access_model: 'per_user_encrypted_api_key', writes_enabled: false
    };
  });

  app.post('/v1/roqqu/connect', async (request, reply) => {
    const identity = await requireVerifiedUserIdentity(request, store, config, authVerifier);
    if (config.dataMode !== 'postgres') throw responseError('ROQQU_ACCESS_DISABLED', 'Live Roqqu connections require PostgreSQL mode.', 403);
    const apiKey = typeof request.body?.api_key === 'string' ? request.body.api_key.trim() : '';
    const encryptedApiKey = encryptRoqquApiKey(apiKey, config.roqquCredentialEncryptionKey, identity.id);
    // Validate via the documented read-only wallet-list endpoint before storing the key.
    const roqquClient = roqquClientFactory({ apiKey });
    const walletProbe = await roqquClient.getWallets('btc');
    const connection = await store.connectRoqqu(identity.id, encryptedApiKey);
    if (!connection) throw responseError('ROQQU_CONNECTION_FAILED', 'Could not save this verified account connection.', 409);
    return reply.code(201).send({ connection: { provider: 'roqqu_api', connected: true, connected_at: connection.connected_at }, validation: { token: 'btc', wallet_count: walletProbe.length }, writes_enabled: false });
  });

  app.post('/v1/roqqu/disconnect', async (request, reply) => {
    const identity = await requireVerifiedUserIdentity(request, store, config, authVerifier);
    if (config.dataMode !== 'postgres') throw responseError('ROQQU_ACCESS_DISABLED', 'Live Roqqu connections require PostgreSQL mode.', 403);
    await store.disconnectRoqqu(identity.id);
    return reply.code(204).send();
  });

  app.get('/v1/roqqu/balances', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (config.dataMode === 'mock') {
      await requireIdentity(request, store, config, authVerifier);
      return { provider: 'roqqu_api', mode: 'mock', sample_data: true, ...roqquMockData().balances };
    }
    const { client } = await requireRoqquConnection(request, store, config, authVerifier, roqquClientFactory);
    const wallets = [];
    for (const token of ROQQU_WALLET_TOKENS) {
      const items = await client.getWallets(token);
      wallets.push(...items.map((wallet) => ({ ...wallet, token })));
    }
    return { provider: 'roqqu_api', mode: 'live', sample_data: false, wallets, wallet_count: wallets.length, supported_tokens: ROQQU_WALLET_TOKENS, updated_at: new Date().toISOString(), writes_enabled: false };
  });

  app.get('/v1/roqqu/history', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (config.dataMode === 'mock') {
      await requireIdentity(request, store, config, authVerifier);
      return { provider: 'roqqu_api', mode: 'mock', sample_data: true, ...roqquMockData().history };
    }
    const symbol = typeof request.query.symbol === 'string' ? request.query.symbol.toLowerCase() : '';
    const address = typeof request.query.address === 'string' ? request.query.address : '';
    if (!ROQQU_WALLET_TOKENS.includes(symbol) || !address) throw responseError('ROQQU_ADDRESS_REQUIRED', 'Choose one of your BTC, ETH, or TRX wallets to load its on-chain balance and transaction history.', 400);
    const { client } = await requireRoqquConnection(request, store, config, authVerifier, roqquClientFactory);
    const accountWallets = await client.getWallets(symbol);
    if (!accountWallets.some((wallet) => wallet.address === address)) throw responseError('ROQQU_WALLET_NOT_FOUND', 'That address is not listed among this connected account’s wallets.', 404);
    const cached = await store.getRoqquAddressCache(symbol, address, 100_000);
    if (cached) return { provider: 'roqqu_api', mode: 'live', sample_data: false, cached: true, ...cached.data, updated_at: cached.fetched_at, writes_enabled: false };
    const reservation = await store.reserveRoqquAddressLookup(100_000);
    if (!reservation.allowed) {
      reply.header('Retry-After', String(reservation.retry_after_seconds));
      throw responseError('ROQQU_RATE_LIMITED', `Roqqu allows only one blockchain-address lookup every 100 seconds. Try again in about ${reservation.retry_after_seconds} seconds.`, 429);
    }
    const data = await client.getAddressDetails(symbol, address);
    const fetchedAt = await store.saveRoqquAddressCache(symbol, address, data);
    return { provider: 'roqqu_api', mode: 'live', sample_data: false, cached: false, ...data, updated_at: fetchedAt, writes_enabled: false };
  });

  return app;
}

async function requireIdentity(request, store, config, authVerifier) {
  const token = bearerToken(request);
  if (!token) throw responseError('UNAUTHENTICATED', 'A valid Miroir session is required.', 401);

  const appSession = await store.authenticate(token);
  if (appSession) return appSession;

  if (!authVerifier) {
    if (config.dataMode !== 'postgres') throw responseError('UNAUTHENTICATED', 'A valid Miroir session is required.', 401);
    throw responseError('NEON_AUTH_NOT_CONFIGURED', 'Neon Managed Auth is not configured for this backend.', 503);
  }

  let claims;
  try {
    claims = await authVerifier(token);
  } catch {
    throw responseError('NEON_AUTH_UNAVAILABLE', 'Neon authentication could not be reached. Try again shortly.', 503);
  }
  if (!claims) throw responseError('UNAUTHENTICATED', 'A valid Miroir session is required.', 401);
  if (config.dataMode !== 'postgres' || typeof store.ensureNeonIdentity !== 'function') {
    throw responseError('AUTH_REQUIRES_POSTGRES', 'Neon user accounts require PostgreSQL mode.', 503);
  }
  return store.ensureNeonIdentity(claims);
}

async function requireVerifiedUserIdentity(request, store, config, authVerifier) {
  const identity = await requireIdentity(request, store, config, authVerifier);
  if (identity.mode !== 'user' || !identity.email_verified_at) throw responseError('VERIFIED_USER_REQUIRED', 'A verified Miroir user account is required.', 403);
  return identity;
}

async function requireRoqquConnection(request, store, config, authVerifier, roqquClientFactory) {
  const identity = await requireVerifiedUserIdentity(request, store, config, authVerifier);
  if (config.dataMode !== 'postgres') throw responseError('ROQQU_ACCESS_DISABLED', 'Live Roqqu reads require PostgreSQL mode.', 403);
  const connection = await store.getRoqquConnection(identity.id);
  if (!connection?.api_key_ciphertext) throw responseError('ROQQU_NOT_CONNECTED', 'Connect your Roqqu API key before requesting live wallet data.', 409);
  const apiKey = decryptRoqquApiKey(connection.api_key_ciphertext, config.roqquCredentialEncryptionKey, identity.id);
  return { identity, connection, client: roqquClientFactory({ apiKey }) };
}
