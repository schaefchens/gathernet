import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const apiOrigin = process.env.VITE_API_ORIGIN ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      // Never silently swap a crypto app under the user.
      registerType: 'prompt',
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
      workbox: {
        // Precache the app shell INCLUDING the wasm module: offline unlock
        // and reading history must work with no network.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // The API and WS are never served from cache — privacy first.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/healthz/],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiOrigin, changeOrigin: true },
      '/healthz': { target: apiOrigin, changeOrigin: true },
      '/ws': { target: apiOrigin, ws: true },
    },
  },
})
