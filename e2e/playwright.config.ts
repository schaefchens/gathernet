import { defineConfig, devices } from '@playwright/test'

/**
 * Runs against an already-running stack by default:
 *   docker compose up -d postgres && pnpm dev
 * Override the target with E2E_BASE_URL (e.g. the prod-shaped compose stack).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
