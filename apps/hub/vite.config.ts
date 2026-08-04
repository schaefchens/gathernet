import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const apiOrigin = process.env.VITE_API_ORIGIN ?? 'http://localhost:4000'

// The .onion address the app is served over (printed by the `tor` compose service).
// Vite's anti-DNS-rebinding guard 403s Host headers it doesn't recognise, so it must be
// allow-listed. Read from a gitignored file (set once, survives restarts) or ONION_HOST.
// See docs/onion.md.
function readOnionHost(): string | undefined {
  if (process.env.ONION_HOST) return process.env.ONION_HOST
  try {
    return readFileSync(new URL('./.onion-host', import.meta.url), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}
const onionHost = readOnionHost()

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      // Never silently swap a crypto app under the user.
      registerType: 'prompt',
      // Custom SW (src/sw.ts) so we can add the Web Push handler; it re-implements the
      // precache + SPA navigation fallback that generateSW gave us.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      // Run the service worker in dev too, so push (which needs the SW) is testable
      // without a production build. type:'module' because our SW is ESM.
      devOptions: {
        enabled: true,
        type: 'module',
      },
      manifest: {
        name: 'Gathernet',
        short_name: 'Gathernet',
        description: 'Fellowship, privately.',
        display: 'standalone',
        start_url: '/',
        theme_color: '#0e1220',
        background_color: '#0b0f1a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    // Listen on all interfaces so the `tor` container can reach the dev server via
    // host.docker.internal and expose it as a hidden service.
    host: true,
    ...(onionHost ? { allowedHosts: [onionHost] } : {}),
    proxy: {
      '/api': { target: apiOrigin, changeOrigin: true },
      '/healthz': { target: apiOrigin, changeOrigin: true },
      '/ws': { target: apiOrigin, ws: true },
    },
  },
})
