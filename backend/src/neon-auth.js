import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';

const validSubject = (value) => typeof value === 'string' && value.length > 0 && value.length <= 255;
const validEmail = (value) => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export function createNeonTokenVerifier(authUrl, options = {}) {
  if (!authUrl) return null;

  let base;
  try {
    base = new URL(authUrl);
  } catch {
    throw new Error('NEON_AUTH_URL must be a valid URL.');
  }
  if (base.protocol !== 'https:' && base.hostname !== 'localhost') {
    throw new Error('NEON_AUTH_URL must use HTTPS.');
  }

  const normalizedBase = authUrl.replace(/\/+$/, '');
  const issuer = base.origin;
  const jwksUrl = options.jwksUrl ? new URL(options.jwksUrl) : new URL(`${normalizedBase}/.well-known/jwks.json`);
  const jwks = options.fetcher
    ? createRemoteJWKSet(jwksUrl, { [customFetch]: options.fetcher })
    : createRemoteJWKSet(jwksUrl);

  return async function verifyNeonToken(token) {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, algorithms: ['EdDSA'] });
      const subject = payload.sub || payload.id;
      if (!validSubject(subject) || !validEmail(payload.email)) return null;
      return {
        subject,
        email: payload.email,
        emailVerified: payload.emailVerified === true || payload.email_verified === true,
        name: typeof payload.name === 'string' ? payload.name : ''
      };
    } catch (error) {
      if (error instanceof errors.JOSEError) return null;
      throw error;
    }
  };
}
