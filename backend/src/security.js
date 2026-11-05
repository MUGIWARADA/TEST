import { createHash, randomBytes } from 'node:crypto';

export const createOpaqueToken = () => randomBytes(32).toString('hex');
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
