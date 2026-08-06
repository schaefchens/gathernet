import { expect, type Page, test } from '@playwright/test'

/**
 * The milestone-1 happy path, two real browsers:
 * create → invite → accept → presence both ways → E2EE chat → invisible.
 */

async function createAccount(page: Page, displayName: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account' }).click()

  await page.getByPlaceholder('Display name').fill(displayName)
  await page.getByRole('button', { name: 'Continue' }).click()

  // Scrape the recovery phrase, then confirm the requested word.
  await expect(page.getByText('Your recovery phrase')).toBeVisible()
  const items = await page
    .getByRole('list', { name: 'recovery phrase' })
    .locator('li')
    .allTextContents()
  const words = items.map((item) => item.replace(/^\d+\./, '').trim())
  expect(words).toHaveLength(12)
  await page.getByRole('button', { name: 'I wrote it down' }).click()

  const hint = await page.getByText(/Enter word \d+ of your phrase/).textContent()
  const index = Number(/Enter word (\d+)/.exec(hint ?? '')?.[1]) - 1
  await page
    .locator('form input')
    .first()
    .fill(words[index] ?? '')
  await page.getByRole('button', { name: 'Continue' }).click()

  await page.getByPlaceholder('Unlock password', { exact: true }).fill('test-password-1')
  await page.getByPlaceholder('Repeat password').fill('test-password-1')
  await page.getByRole('button', { name: 'Continue' }).click()

  // Argon2id (64 MiB) + account creation + MLS init can take a moment.
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 60_000 })
}

test('full journey: accounts, invite, presence, E2EE chat, invisible', async ({ browser }) => {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const anna = await contextA.newPage()
  const ben = await contextB.newPage()

  // Surface client-side failures (MLS orchestration logs) in the test output.
  for (const [name, page] of [
    ['anna', anna],
    ['ben', ben],
  ] as const) {
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.log(`[${name}:console] ${message.text()}`)
      }
    })
    page.on('pageerror', (err) => console.log(`[${name}:pageerror] ${err.message}`))
  }

  await createAccount(anna, 'Anna')
  await createAccount(ben, 'Ben')

  // Anna creates an invite code.
  await anna.getByRole('link', { name: 'Add friend' }).click()
  const code = (await anna.locator('.font-mono.text-2xl').textContent({ timeout: 20_000 }))?.trim()
  expect(code).toMatch(/^[0-9A-Z]{10}$/)

  // Ben accepts it.
  await ben.getByRole('link', { name: 'Add friend' }).click()
  await ben.getByRole('button', { name: 'Enter code' }).click()
  await ben.getByPlaceholder("Friend's invite code").fill(code ?? '')
  await ben.getByRole('button', { name: 'Connect' }).click()
  await expect(ben.getByText('You are now friends with Anna')).toBeVisible()

  // Both land on friends lists and see each other online.
  await ben.waitForURL('**/')
  await expect(ben.getByText('Anna')).toBeVisible()
  await expect(ben.locator('li', { hasText: 'Anna' }).getByText('Online')).toBeVisible({
    timeout: 20_000,
  })
  await anna.getByRole('link', { name: 'Gathernet' }).click()
  await expect(anna.locator('li', { hasText: 'Ben' }).getByText('Online')).toBeVisible({
    timeout: 20_000,
  })

  // Ben (invite accepter = MLS group creator) opens the chat and waits for
  // encryption setup, then sends the first message.
  await ben.locator('li', { hasText: 'Anna' }).getByRole('link').click()
  const benInput = ben.getByPlaceholder('Message…')
  await expect(benInput).toBeEnabled({ timeout: 30_000 })
  await benInput.fill('Hello Anna! Grace and peace.')
  await ben.getByRole('button', { name: 'Send' }).click()
  await expect(ben.getByText('Hello Anna! Grace and peace.')).toBeVisible()

  // Anna receives it decrypted, live.
  await anna.locator('li', { hasText: 'Ben' }).getByRole('link').click()
  await expect(anna.getByText('Hello Anna! Grace and peace.')).toBeVisible({ timeout: 30_000 })

  // Anna replies; Ben sees it.
  const annaInput = anna.getByPlaceholder('Message…')
  await expect(annaInput).toBeEnabled({ timeout: 30_000 })
  await annaInput.fill('He is risen indeed!')
  await anna.getByRole('button', { name: 'Send' }).click()
  await expect(ben.getByText('He is risen indeed!')).toBeVisible({ timeout: 30_000 })

  // Anna goes invisible; Ben sees her as offline.
  await anna.getByRole('link', { name: 'Gathernet' }).click()
  await anna.getByLabel('Presence').selectOption('invisible')
  await ben.getByRole('link', { name: 'Gathernet' }).click()
  await expect(ben.locator('li', { hasText: 'Anna' }).getByText('Offline')).toBeVisible({
    timeout: 20_000,
  })

  await contextA.close()
  await contextB.close()
})
