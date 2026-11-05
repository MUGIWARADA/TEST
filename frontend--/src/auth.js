import { createAuthClient } from '@neondatabase/neon-js/auth';

const configuredAuthUrl = import.meta.env.VITE_NEON_AUTH_URL || '';
// In local Vite development, route Auth through the app origin so browser privacy
// settings do not drop Neon Auth's cross-site session cookie.
export const neonAuthUrl = configuredAuthUrl.startsWith('/') && typeof window !== 'undefined'
  ? `${window.location.origin}${configuredAuthUrl}`
  : configuredAuthUrl;
export const authEnabled = Boolean(neonAuthUrl);
export const authClient = authEnabled
  ? createAuthClient(neonAuthUrl, { fetchOptions: { credentials: 'include' } })
  : null;

export async function getNeonAccessToken() {
  if (!authClient) return null;
  const { data, error } = await authClient.token();
  if (error) throw error;
  return data?.token || null;
}
