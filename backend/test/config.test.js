import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('a Neon-injected database URL selects persistent mode by default', () => {
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://pooled.example/db' }).dataMode, 'postgres');
  assert.equal(loadConfig({}).dataMode, 'mock');
});

test('Neon CLI environment values configure pooled runtime and direct migration connections', () => {
  const config = loadConfig({
    DATA_MODE: 'postgres',
    DATABASE_URL: 'postgres://pooled.example/db',
    DATABASE_URL_UNPOOLED: 'postgres://direct.example/db',
    NEON_AUTH_BASE_URL: 'https://auth.example.test/neondb/auth',
    NEON_AUTH_JWKS_URL: 'https://auth.example.test/neondb/auth/.well-known/jwks.json',
    ROQQU_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')
  });
  assert.equal(config.databaseUrl, 'postgres://pooled.example/db');
  assert.equal(config.databaseMigrationUrl, 'postgres://direct.example/db');
  assert.equal(config.neonAuthUrl, 'https://auth.example.test/neondb/auth');
  assert.equal(config.neonAuthJwksUrl, 'https://auth.example.test/neondb/auth/.well-known/jwks.json');
  assert.equal(config.roqquCredentialEncryptionKey, Buffer.alloc(32, 7).toString('base64'));
});

test('Neon auth endpoint must be HTTPS except localhost development', () => {
  assert.throws(() => loadConfig({ NEON_AUTH_BASE_URL: 'http://auth.example.test' }), /HTTPS/);
  assert.equal(loadConfig({ NEON_AUTH_BASE_URL: 'http://localhost:8081/auth' }).neonAuthUrl, 'http://localhost:8081/auth');
});
