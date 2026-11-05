import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { PostgresStore } from '../src/postgres-store.js';

const databaseUrl = process.env.DATABASE_URL;
test('Postgres persists Neon-managed identities and isolates verified Roqqu ownership', { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATION_URL || databaseUrl });
  const migrationsPath = fileURLToPath(new URL('../db/migrations/', import.meta.url));
  const migrationFiles = (await readdir(migrationsPath)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const file of migrationFiles) await pool.query(await readFile(path.join(migrationsPath, file), 'utf8'));

  const config = {
    corsOrigins: ['http://localhost:5173'], nodeEnv: 'test', dataMode: 'postgres',
    sessionTtlHours: 24, neonAuthUrl: 'https://auth.example.test/neondb/auth',
    roqquCredentialEncryptionKey: Buffer.alloc(32, 7).toString('base64')
  };
  const store = new PostgresStore(pool);
  const verifiedSubject = `neon-user-${randomUUID()}`;
  const unverifiedSubject = `neon-user-${randomUUID()}`;
  const testEmail = `trader-${randomUUID()}@example.com`;
  const unverifiedEmail = `unverified-${randomUUID()}@example.com`;
  const verifiedToken = `neon-test-token-${randomUUID()}`;
  const unverifiedToken = `neon-test-token-${randomUUID()}`;
  const claimsByToken = new Map([
    [verifiedToken, { subject: verifiedSubject, email: testEmail, emailVerified: true, name: 'Trader' }],
    [unverifiedToken, { subject: unverifiedSubject, email: unverifiedEmail, emailVerified: false, name: 'Unverified Trader' }]
  ]);
  const app = await createApp({
    store, config, authVerifier: async (token) => claimsByToken.get(token) || null,
    roqquClientFactory: () => ({ getWallets: async () => [{ address: 'btc-test-address' }] })
  });
  const authorization = (token) => ({ authorization: `Bearer ${token}` });
  try {
    const demoResponse = await app.inject({ method: 'POST', url: '/v1/demo/session' });
    assert.equal(demoResponse.statusCode, 201);
    const demo = demoResponse.json();
    const demoHeaders = authorization(demo.token);
    const list = await app.inject({ method: 'GET', url: '/v1/trades', headers: demoHeaders });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().trades.length, 3);
    const progress = await app.inject({ method: 'GET', url: '/v1/progress', headers: demoHeaders });
    assert.equal(progress.statusCode, 200);
    assert.equal(progress.json().progress.versions[0].assessed_trades, 3);

    const meResponse = await app.inject({ method: 'GET', url: '/v1/me', headers: authorization(verifiedToken) });
    assert.equal(meResponse.statusCode, 200);
    const identity = meResponse.json().identity;
    assert.equal(identity.email, testEmail);
    assert.equal(identity.mode, 'user');
    assert.ok(identity.email_verified_at);
    assert.equal(Object.hasOwn(identity, 'password_hash'), false);

    const strategies = await app.inject({ method: 'GET', url: '/v1/strategies', headers: authorization(verifiedToken) });
    assert.equal(strategies.statusCode, 200);
    assert.equal(strategies.json().strategies.length, 1);

    const connection = await app.inject({ method: 'POST', url: '/v1/roqqu/connect', headers: authorization(verifiedToken), payload: { api_key: 'RQ-SEC-postgres-test-key' } });
    assert.equal(connection.statusCode, 201);
    const savedConnection = await store.getRoqquConnection(identity.id);
    assert.equal(savedConnection.account_email, testEmail);
    assert.notEqual(savedConnection.api_key_ciphertext, 'RQ-SEC-postgres-test-key');
    const status = await app.inject({ method: 'GET', url: '/v1/roqqu/status', headers: authorization(verifiedToken) });
    assert.equal(status.json().connected, true);
    assert.equal(status.json().enabled, true);
    assert.equal(status.json().access_model, 'per_user_encrypted_api_key');

    const unverifiedConnect = await app.inject({ method: 'POST', url: '/v1/roqqu/connect', headers: authorization(unverifiedToken) });
    assert.equal(unverifiedConnect.statusCode, 403);
    assert.equal(unverifiedConnect.json().error.code, 'VERIFIED_USER_REQUIRED');

    const savedUser = await pool.query('SELECT id,auth_subject,password_hash,email_verified_at FROM users WHERE auth_subject=$1', [verifiedSubject]);
    assert.equal(savedUser.rows.length, 1);
    assert.equal(savedUser.rows[0].password_hash, null);
    assert.ok(savedUser.rows[0].email_verified_at);
  } finally {
    await app.close();
    await pool.query('DELETE FROM users WHERE auth_subject = ANY($1::text[])', [[verifiedSubject, unverifiedSubject]]);
    await pool.end();
  }
});
