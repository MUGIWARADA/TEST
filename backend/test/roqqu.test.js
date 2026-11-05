import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { MockStore } from '../src/mock-store.js';
import { decryptRoqquApiKey, encryptRoqquApiKey } from '../src/roqqu-credentials.js';
import { RoqquClient } from '../src/roqqu.js';

const testConfig = { corsOrigins: ['http://localhost:5173'], nodeEnv: 'test', dataMode: 'mock' };
const encryptionKey = Buffer.alloc(32, 7).toString('base64');

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('mock-mode Roqqu reads are labelled sample data and remain read-only', async () => {
  const app = await createApp({ store: new MockStore(), config: testConfig });
  try {
    const session = (await app.inject({ method: 'POST', url: '/v1/demo/session' })).json();
    const headers = { authorization: `Bearer ${session.token}` };
    const status = await app.inject({ method: 'GET', url: '/v1/roqqu/status', headers });
    assert.equal(status.json().enabled, true);
    assert.equal(status.json().mode, 'mock');
    assert.equal(status.json().writes_enabled, false);
    const balances = await app.inject({ method: 'GET', url: '/v1/roqqu/balances', headers });
    assert.equal(balances.statusCode, 200);
    assert.equal(balances.json().sample_data, true);
    assert.ok(balances.json().balance.usdt > 0);
    const history = await app.inject({ method: 'GET', url: '/v1/roqqu/history', headers });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().sample_data, true);
    assert.ok(Array.isArray(history.json().history));
  } finally { await app.close(); }
});

test('demo identities cannot connect live Roqqu API keys', async () => {
  const app = await createApp({ store: new MockStore(), config: { ...testConfig, dataMode: 'postgres' } });
  try {
    const session = (await app.inject({ method: 'POST', url: '/v1/demo/session' })).json();
    const headers = { authorization: `Bearer ${session.token}` };
    const connect = await app.inject({ method: 'POST', url: '/v1/roqqu/connect', headers, payload: { api_key: 'RQ-SEC-test-key-12345' } });
    assert.equal(connect.statusCode, 403);
    assert.equal(connect.json().error.code, 'VERIFIED_USER_REQUIRED');
  } finally { await app.close(); }
});

test('Roqqu API keys are encrypted at rest and bound to the Miroir identity', () => {
  const identityId = randomUUID();
  const apiKey = 'RQ-SEC-test-key-for-encryption';
  const ciphertext = encryptRoqquApiKey(apiKey, encryptionKey, identityId);
  assert.notEqual(ciphertext, apiKey);
  assert.equal(decryptRoqquApiKey(ciphertext, encryptionKey, identityId), apiKey);
  assert.throws(() => decryptRoqquApiKey(ciphertext, encryptionKey, randomUUID()));
  assert.throws(() => decryptRoqquApiKey(ciphertext, Buffer.alloc(32, 9).toString('base64'), identityId));
  assert.throws(() => encryptRoqquApiKey(apiKey, 'not-a-key', identityId), /32-byte/);
});

test('Roqqu client only calls documented wallet reads and blockchain address GETs', async () => {
  const calls = [];
  const client = new RoqquClient({
    apiKey: 'RQ-SEC-test-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/user/wallets')) return jsonResponse({ status: 'success', data: [{ address: '0x123456789', type: 'eth', total_received: '1.25', total_received_usdt: '3000', genesis: 1, created_at: '2024-01-01' }] });
      return jsonResponse({ status: 'success', data: { address: '0x123456789', network: 'ethereum', symbol: 'eth', balance: '1.2', transactions: [] } });
    }
  });
  const wallets = await client.getWallets('ETH');
  const details = await client.getAddressDetails('eth', '0x123456789');
  assert.equal(wallets[0].token, 'eth');
  assert.equal(wallets[0].total_received, 1.25);
  assert.equal(details.balance, '1.2');
  assert.equal(calls[0].url, 'https://api.roqqu.com/prod/v1/user/wallets');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer RQ-SEC-test-secret');
  assert.deepEqual(JSON.parse(calls[0].options.body), { token: 'eth' });
  assert.equal(calls[1].url, 'https://api.roqqu.com/prod/v1/blockchain/address?symbol=eth&addr=0x123456789');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.headers.Authorization, undefined);
  await assert.rejects(client.getWallets('sol'), { code: 'ROQQU_UNSUPPORTED_TOKEN' });
});

test('verified users can connect a key, retrieve wallet summaries, and only inspect their own wallet addresses', async () => {
  const identityId = randomUUID();
  const store = new MockStore();
  let savedConnection = null;
  store.ensureNeonIdentity = async () => ({ id: identityId, mode: 'user', display_name: 'Demo Tester', email: 'test@example.com', email_verified_at: new Date().toISOString() });
  store.connectRoqqu = async (id, apiKeyCiphertext) => { savedConnection = { identity_id: id, account_email: 'test@example.com', api_key_ciphertext: apiKeyCiphertext, connected_at: new Date().toISOString(), provider: 'roqqu_api' }; return savedConnection; };
  store.getRoqquConnection = async () => savedConnection;
  store.getRoqquAddressCache = async () => null;
  store.reserveRoqquAddressLookup = async () => ({ allowed: true, retry_after_seconds: 0 });
  store.saveRoqquAddressCache = async () => new Date().toISOString();
  store.disconnectRoqqu = async () => { savedConnection = null; };
  const calls = [];
  const roqquClientFactory = ({ apiKey }) => ({
    getWallets: async (token) => { calls.push({ type: 'wallets', apiKey, token }); return [{ address: `address-${token}`, token, total_received: 1, total_received_usdt: 2, genesis: false, created_at: null }]; },
    getAddressDetails: async (token, address) => { calls.push({ type: 'details', token, address }); return { address, symbol: token, balance: 1.5, transactions: [] }; }
  });
  const config = { ...testConfig, dataMode: 'postgres', neonAuthUrl: 'https://auth.example.test', roqquCredentialEncryptionKey: encryptionKey };
  const authVerifier = async (token) => token === 'neon-managed-user-token' ? { subject: 'subject-1', email: 'test@example.com', emailVerified: true, name: 'Demo Tester' } : null;
  const app = await createApp({ store, config, authVerifier, roqquClientFactory });
  const headers = { authorization: 'Bearer neon-managed-user-token' };
  const apiKey = 'RQ-SEC-demo-account-secret';
  try {
    const connect = await app.inject({ method: 'POST', url: '/v1/roqqu/connect', headers, payload: { api_key: apiKey } });
    assert.equal(connect.statusCode, 201);
    assert.equal(connect.json().validation.wallet_count, 1);
    assert.equal(JSON.stringify(connect.json()).includes(apiKey), false);
    assert.notEqual(savedConnection.api_key_ciphertext, apiKey);

    const status = await app.inject({ method: 'GET', url: '/v1/roqqu/status', headers });
    assert.equal(status.json().connected, true);
    assert.equal(status.json().mode, 'live');
    assert.equal(status.json().writes_enabled, false);
    assert.equal(JSON.stringify(status.json()).includes(apiKey), false);

    const wallets = await app.inject({ method: 'GET', url: '/v1/roqqu/balances', headers });
    assert.equal(wallets.statusCode, 200);
    assert.equal(wallets.json().wallet_count, 3);
    assert.equal(wallets.json().wallets[0].address, 'address-btc');
    assert.deepEqual(calls.slice(1).map((call) => call.token), ['btc', 'eth', 'trx']);

    const own = await app.inject({ method: 'GET', url: '/v1/roqqu/history?symbol=btc&address=address-btc', headers });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().balance, 1.5);
    const foreign = await app.inject({ method: 'GET', url: '/v1/roqqu/history?symbol=btc&address=not-owned', headers });
    assert.equal(foreign.statusCode, 404);
    assert.equal(foreign.json().error.code, 'ROQQU_WALLET_NOT_FOUND');
    assert.equal(calls.some((call) => call.type === 'details' && call.address === 'not-owned'), false);

    await app.inject({ method: 'POST', url: '/v1/roqqu/disconnect', headers });
    assert.equal(savedConnection, null);
  } finally { await app.close(); }
});
