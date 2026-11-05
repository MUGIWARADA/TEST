import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { MockStore } from '../src/mock-store.js';

const config = { corsOrigins: ['http://localhost:5173'], nodeEnv: 'test', dataMode: 'mock' };

async function withApp(fn) {
  const app = await createApp({ store: new MockStore(), config });
  try { await fn(app); } finally { await app.close(); }
}

test('health reports the configured data mode without auth', async () => {
  await withApp(async (app) => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', data_mode: 'mock' });
  });
});

test('demo session exposes a token; protected routes require it', async () => {
  await withApp(async (app) => {
    const denied = await app.inject({ method: 'GET', url: '/v1/strategies' });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.json().error.code, 'UNAUTHENTICATED');

    const sessionResponse = await app.inject({ method: 'POST', url: '/v1/demo/session', payload: { display_name: 'Test Trader' } });
    assert.equal(sessionResponse.statusCode, 201);
    const session = sessionResponse.json();
    assert.equal(session.identity.display_name, 'Test Trader');
    assert.equal(session.identity.mode, 'demo');
    assert.ok(session.demo_data.strategy_version_id);
    const auth = { authorization: `Bearer ${session.token}` };

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().identity.id, session.identity.id);
    const proxyHeaderMe = await app.inject({ method: 'GET', url: '/v1/me', headers: { 'x-miroir-session': session.token } });
    assert.equal(proxyHeaderMe.statusCode, 200);
    assert.equal(proxyHeaderMe.json().identity.id, session.identity.id);
    const strategies = await app.inject({ method: 'GET', url: '/v1/strategies', headers: auth });
    assert.equal(strategies.statusCode, 200);
    assert.equal(strategies.json().strategies.length, 1);
  });
});

test('trade history, bodyless review, stats and progress use stable response shapes', async () => {
  await withApp(async (app) => {
    const session = (await app.inject({ method: 'POST', url: '/v1/demo/session' })).json();
    const headers = { authorization: `Bearer ${session.token}` };
    const list = await app.inject({ method: 'GET', url: '/v1/trades', headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().trades.length, 3);
    assert.ok(list.json().trades[0].id);

    const tradeId = list.json().trades[0].id;
    const review = await app.inject({ method: 'POST', url: `/v1/trades/${tradeId}/review`, headers });
    assert.equal(review.statusCode, 200);
    assert.equal(typeof review.json().review.result.coverage_pct, 'number');
    assert.ok(Array.isArray(review.json().review.result.dimensions));
    const cached = await app.inject({ method: 'POST', url: `/v1/trades/${tradeId}/review`, headers });
    assert.equal(cached.json().cached, true);

    const stats = await app.inject({ method: 'GET', url: '/v1/stats?currency=USD', headers });
    assert.equal(stats.statusCode, 200);
    assert.equal(stats.json().stats.sample_size, 3);
    assert.equal(stats.json().stats.net_realized_pnl, 945);
    const progress = await app.inject({ method: 'GET', url: '/v1/progress', headers });
    assert.equal(progress.statusCode, 200);
    assert.equal(progress.json().progress.versions[0].assessed_trades, 3);
  });
});

test('manual trade creation validates input and then returns a stored trade', async () => {
  await withApp(async (app) => {
    const session = (await app.inject({ method: 'POST', url: '/v1/demo/session' })).json();
    const headers = { authorization: `Bearer ${session.token}` };
    const bad = await app.inject({ method: 'POST', url: '/v1/trades', headers, payload: { direction: 'long' } });
    assert.equal(bad.statusCode, 400);
    const good = await app.inject({ method: 'POST', url: '/v1/trades', headers, payload: { symbol: 'xbt/usdt', direction: 'long', quantity: 0.1, entry_price: 50000 } });
    assert.equal(good.statusCode, 201);
    assert.equal(good.json().trade.symbol, 'XBT/USDT');
  });
});

test('Neon Managed Auth tokens resolve to isolated Miroir identities and gate verified-only routes', async () => {
  const identitiesBySubject = new Map();
  const store = new MockStore();
  store.ensureNeonIdentity = async ({ subject, email, emailVerified, name }) => {
    if (!identitiesBySubject.has(subject)) {
      identitiesBySubject.set(subject, {
        id: randomUUID(), mode: 'user', display_name: name || 'Miroir Trader', email,
        email_verified_at: emailVerified ? new Date().toISOString() : null
      });
    }
    return identitiesBySubject.get(subject);
  };
  const claimsByToken = new Map([
    ['neon-managed-test-token-verified', { subject: 'neon-user-1', email: 'one@example.com', emailVerified: true, name: 'One' }],
    ['neon-managed-test-token-unverified', { subject: 'neon-user-2', email: 'two@example.com', emailVerified: false, name: 'Two' }]
  ]);
  const app = await createApp({
    store,
    config: { ...config, dataMode: 'postgres', neonAuthUrl: 'https://auth.example.test/neondb/auth', roqquCredentialEncryptionKey: Buffer.alloc(32, 7).toString('base64') },
    authVerifier: async (token) => claimsByToken.get(token) || null
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer neon-managed-test-token-verified' } });
    const second = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer neon-managed-test-token-unverified' } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().identity.email, 'one@example.com');
    assert.ok(first.json().identity.email_verified_at);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().identity.email, 'two@example.com');
    assert.notEqual(first.json().identity.id, second.json().identity.id);

    const denied = await app.inject({ method: 'POST', url: '/v1/roqqu/connect', headers: { authorization: 'Bearer neon-managed-test-token-unverified' } });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'VERIFIED_USER_REQUIRED');
    const invalid = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer neon-managed-test-token-invalid' } });
    assert.equal(invalid.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('unexpected errors expose redacted diagnostics only in development mode', async () => {
  const store = new MockStore();
  store.ensureNeonIdentity = async () => { throw Object.assign(new Error('relation "users" does not exist'), { code: '42P01' }); };
  const authVerifier = async () => ({ subject: 'neon-user-debug', email: 'debug@example.com', emailVerified: true, name: 'Debug' });
  const devApp = await createApp({ store, config: { ...config, nodeEnv: 'development', dataMode: 'postgres' }, authVerifier });
  try {
    const response = await devApp.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer neon-debug-token-123456' } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, 'INTERNAL_ERROR');
    assert.equal(response.json().debug.cause, 'relation "users" does not exist');
    assert.equal(response.json().debug.sqlstate, '42P01');
    assert.ok(response.json().debug.request_id);
  } finally { await devApp.close(); }

  const prodApp = await createApp({ store, config: { ...config, nodeEnv: 'production', dataMode: 'postgres' }, authVerifier });
  try {
    const response = await prodApp.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer neon-debug-token-123456' } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, 'INTERNAL_ERROR');
    assert.equal('debug' in response.json(), false);
    assert.equal(JSON.stringify(response.json()).includes('users'), false);
  } finally { await prodApp.close(); }
});

test('legacy account-auth endpoints clearly direct old clients to Neon Managed Auth', async () => {
  await withApp(async (app) => {
    const response = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'trader@example.com', password: 'very-secure-password' } });
    assert.equal(response.statusCode, 410);
    assert.equal(response.json().error.code, 'AUTH_MOVED_TO_NEON');
  });
});
