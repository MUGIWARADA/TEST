import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createNeonTokenVerifier } from '../src/neon-auth.js';
import { createOpaqueToken, hashToken, normalizeEmail } from '../src/security.js';

test('demo tokens remain opaque and email normalization is stable', () => {
  const token = createOpaqueToken();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(hashToken(token).length, 64);
  assert.notEqual(hashToken(token), token);
  assert.equal(normalizeEmail(' Trader@Example.COM '), 'trader@example.com');
});

test('Neon Auth verifier accepts a signed EdDSA token and extracts verified identity claims', async () => {
  const issuer = 'https://auth.example.test';
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-neon-key';
  jwk.alg = 'EdDSA';
  jwk.use = 'sig';
  const token = await new SignJWT({ email: 'trader@example.com', emailVerified: true, name: 'Test Trader' })
    .setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid })
    .setSubject('neon-user-123')
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  const verifier = createNeonTokenVerifier(`${issuer}/neondb/auth`, {
    fetcher: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
  });

  assert.deepEqual(await verifier(token), {
    subject: 'neon-user-123',
    email: 'trader@example.com',
    emailVerified: true,
    name: 'Test Trader'
  });
  assert.equal(await verifier(`${token.slice(0, -2)}xx`), null);
});

test('Neon Auth verifier rejects missing or insecure service URLs', () => {
  assert.equal(createNeonTokenVerifier(''), null);
  assert.throws(() => createNeonTokenVerifier('not-a-url'), /valid URL/);
  assert.throws(() => createNeonTokenVerifier('http://auth.example.test'), /HTTPS/);
});
