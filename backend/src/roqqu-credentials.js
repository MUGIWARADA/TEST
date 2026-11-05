import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey(encodedKey) {
  if (typeof encodedKey !== 'string' || !encodedKey) {
    const error = new Error('Roqqu credential encryption is not configured on the backend.');
    error.code = 'ROQQU_ENCRYPTION_NOT_CONFIGURED'; error.statusCode = 503; throw error;
  }
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) {
    const error = new Error('ROQQU_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
    error.code = 'ROQQU_ENCRYPTION_KEY_INVALID'; error.statusCode = 503; throw error;
  }
  return key;
}

function aadFor(identityId) {
  if (typeof identityId !== 'string' || !identityId) throw new TypeError('An identity id is required to protect a Roqqu credential.');
  return Buffer.from(`miroir:roqqu:${identityId}:v1`, 'utf8');
}

export function encryptRoqquApiKey(apiKey, encodedKey, identityId) {
  if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 512 || /\s/.test(apiKey)) {
    const error = new Error('Enter a valid Roqqu API key.');
    error.code = 'INVALID_ROQQU_API_KEY'; error.statusCode = 400; throw error;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(encodedKey), iv);
  cipher.setAAD(aadFor(identityId));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptRoqquApiKey(value, encodedKey, identityId) {
  if (typeof value !== 'string') throw new Error('No saved Roqqu credential is available.');
  const [version, encodedIv, encodedTag, encodedCiphertext, extra] = value.split('.');
  if (version !== 'v1' || !encodedIv || !encodedTag || encodedCiphertext === undefined || extra !== undefined) {
    throw new Error('Saved Roqqu credential has an unsupported format. Reconnect the account.');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(encodedKey), Buffer.from(encodedIv, 'base64url'));
  decipher.setAAD(aadFor(identityId));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, 'base64url')), decipher.final()]).toString('utf8');
}
