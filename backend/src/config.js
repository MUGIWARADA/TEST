export function loadConfig(env = process.env) {
  const dataMode = (env.DATA_MODE || (env.DATABASE_URL ? 'postgres' : 'mock')).toLowerCase();
  if (!['mock', 'postgres'].includes(dataMode)) throw new Error('DATA_MODE must be mock or postgres.');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  if (dataMode === 'postgres' && !env.DATABASE_URL) throw new Error('DATABASE_URL is required when DATA_MODE=postgres.');
  const neonAuthUrl = env.NEON_AUTH_BASE_URL || env.NEON_AUTH_URL || '';
  if (neonAuthUrl && !/^https:\/\//i.test(neonAuthUrl) && !/^http:\/\/localhost(?::|\/)/i.test(neonAuthUrl)) throw new Error('NEON_AUTH_BASE_URL must use HTTPS (localhost is allowed for development).');
  const corsOrigins = (env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((value) => value.trim()).filter(Boolean);
  return {
    dataMode,
    port,
    host: env.HOST || '0.0.0.0',
    corsOrigins,
    sessionTtlHours: Number(env.SESSION_TTL_HOURS || 24),
    databaseUrl: env.DATABASE_URL,
    databaseMigrationUrl: env.DATABASE_MIGRATION_URL || env.DATABASE_URL_UNPOOLED || env.DATABASE_URL,
    neonAuthUrl,
    neonAuthJwksUrl: env.NEON_AUTH_JWKS_URL || '',
    nodeEnv: env.NODE_ENV || 'development',
    roqquCredentialEncryptionKey: env.ROQQU_CREDENTIAL_ENCRYPTION_KEY || ''
  };
}
