import { type BrowserContext, expect, type Page, test } from '@playwright/test'

/**
 * The M2 app-platform journey through the REAL demo app (@gathernet/sdk on its
 * own origin, :5175): popup sign-in against the Hub, an encrypted cloud save
 * round-trip, and — across two browsers — an E2EE room where a chat message and
 * an ordered-intent shared counter both converge.
 *
 * Requires the full dev stack: server :4000, hub :5173, demo app :5175
 * (docker compose up -d postgres; pnpm --filter @gathernet/server dev; hub dev;
 * pnpm --filter @gathernet/demo-app dev). The demo app + its origin are seeded
 * by `pnpm --filter @gathernet/server seed:apps` (pub_00000000000000d1).
 */

const HUB = 'http://localhost:5173'
const DEMO = 'http://localhost:5175'
const PASSWORD = 'test-password-1'

/** Create a Gathernet account in the Hub (same context the demo popup shares). */
async function createHubAccount(context: BrowserContext, displayName: string): Promise<void> {
  const page = await context.newPage()
  await page.goto(HUB)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByPlaceholder('Display name').fill(displayName)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Your recovery phrase')).toBeVisible()
  const items = await page
    .getByRole('list', { name: 'recovery phrase' })
    .locator('li')
    .allTextContents()
  const words = items.map((i) => i.replace(/^\d+\./, '').trim())
  await page.getByRole('button', { name: 'I wrote it down' }).click()
  const hint = await page.getByText(/Enter word \d+ of your phrase/).textContent()
  const index = Number(/Enter word (\d+)/.exec(hint ?? '')?.[1]) - 1
  await page
    .locator('form input')
    .first()
    .fill(words[index] ?? '')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByPlaceholder('Unlock password', { exact: true }).fill(PASSWORD)
  await page.getByPlaceholder('Repeat password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Friends' })).toBeVisible({ timeout: 60_000 })
  await page.close()
}

/** Sign the demo app in via the Hub popup (unlock + approve consent). */
async function demoLogin(context: BrowserContext, displayName: string): Promise<Page> {
  await createHubAccount(context, displayName)
  const demo = await context.newPage()
  demo.on('pageerror', (e) => console.log(`[demo:${displayName}] ${e.message}`))
  await demo.goto(DEMO)

  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    demo.getByRole('button', { name: 'Sign in with Gathernet' }).click(),
  ])
  await popup.getByPlaceholder('Unlock password').fill(PASSWORD)
  await popup.getByRole('button', { name: 'Unlock' }).click()
  // Consent may auto-approve; if the button shows, click it.
  const approve = popup.getByRole('button', { name: 'Approve' })
  await approve.click({ timeout: 15_000 }).catch(() => undefined)

  await expect(demo.getByText(`Hello`)).toBeVisible({ timeout: 60_000 })
  await expect(demo.getByText(displayName, { exact: false })).toBeVisible()
  return demo
}

test('demo app: popup login, encrypted save, and cross-browser E2EE room', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()

  const alice = await demoLogin(ctxA, 'DemoAlice')
  const bob = await demoLogin(ctxB, 'DemoBob')

  // --- encrypted cloud save round-trip (Alice) ---
  await alice.locator('#note').fill('walk by the Spirit')
  await alice.locator('#save').click()
  await expect(alice.locator('#save-status')).toContainText('saved v1')
  await alice.reload()
  // The SDK restores the session from localStorage on init(); no re-login.
  await expect(alice.getByText('Hello')).toBeVisible({ timeout: 60_000 })
  await alice.locator('#load').click()
  await expect(alice.locator('#note')).toHaveValue('walk by the Spirit', { timeout: 20_000 })

  // --- Alice creates a room ---
  await alice.getByRole('button', { name: 'Create room' }).click()
  await expect(alice.locator('#room-active')).toBeVisible({ timeout: 60_000 })
  const code = (await alice.locator('#room-code').textContent())?.trim() ?? ''
  expect(code).toMatch(/^[2-9A-Z]{4}$/)

  // --- Bob joins by code ---
  await bob.locator('#room-code-in').fill(code)
  await bob.getByRole('button', { name: 'Join' }).click()
  await expect(bob.locator('#room-active')).toBeVisible({ timeout: 60_000 })
  // Both see two members.
  await expect(alice.locator('#room-members')).toContainText('DemoBob', { timeout: 30_000 })

  // --- chat converges both ways ---
  await alice.locator('#room-chat-in').fill('grace and peace')
  await alice.locator('#room-chat-send').click()
  await expect(bob.locator('#room-chatlog')).toContainText('grace and peace', { timeout: 30_000 })
  await bob.locator('#room-chat-in').fill('and also with you')
  await bob.locator('#room-chat-send').click()
  await expect(alice.locator('#room-chatlog')).toContainText('and also with you', {
    timeout: 30_000,
  })

  // --- shared counter over ordered intents ---
  await alice.locator('#room-inc').click()
  await expect(bob.locator('#room-counter')).toHaveText('1', { timeout: 30_000 })
  await bob.locator('#room-inc').click()
  await expect(alice.locator('#room-counter')).toHaveText('2', { timeout: 30_000 })

  await ctxA.close()
  await ctxB.close()
})
