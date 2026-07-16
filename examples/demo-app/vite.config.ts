import { defineConfig } from 'vite'

// The demo app runs on its own origin (like a real third-party app) and
// talks to the Gathernet server cross-origin via CORS — no proxy.
export default defineConfig({
  server: { port: 5175, strictPort: true },
})
