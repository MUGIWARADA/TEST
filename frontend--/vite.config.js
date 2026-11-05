import { defineConfig, loadEnv } from 'vite'
import process from 'node:process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, '.', '')
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8080'
  const neonAuthUrl = env.VITE_NEON_AUTH_URL || process.env.NEON_AUTH_BASE_URL || ''
  const authUrl = neonAuthUrl ? new URL(neonAuthUrl) : null
  const authBasePath = authUrl?.pathname.replace(/\/+$/, '') || ''
  const useDevAuthProxy = command === 'serve' && Boolean(authUrl)
  const clientAuthUrl = useDevAuthProxy ? '/__neon_auth' : neonAuthUrl
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_NEON_AUTH_URL': JSON.stringify(clientAuthUrl)
    },
    server: {
      host: '0.0.0.0',
      allowedHosts: true,
      proxy: {
        '/v1': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
        ...(useDevAuthProxy ? {
          '/__neon_auth': {
            target: authUrl.origin,
            changeOrigin: true,
            secure: true,
            cookieDomainRewrite: '',
            cookiePathRewrite: '/',
            rewrite: (path) => path.replace(/^\/__neon_auth/, authBasePath)
          }
        } : {})
      }
    }
  }
})
