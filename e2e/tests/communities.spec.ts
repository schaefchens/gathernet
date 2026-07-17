import { type BrowserContext, expect, type Page, test } from '@playwright/test'

/**
 * Communities journey, two browsers: create a community with a members channel
 * and a leaders-only channel, invite a second user, exchange an E2EE channel
 * message, and prove the leaders channel is inaccessible to a plain member —
 * then promote them and watch access open up.
 *
 * Requires the dev stack: server :4000 + hub :5173 (docker compose up -d
 * postgres; server dev; hub dev).
 */

const PASSWORD = 'test-password-1'

async function createAccount(page: Page, displayName: string): Promise<void> {
  await page.goto('/')
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
}

async function newUser(context: BrowserContext, name: string): Promise<Page> {
  const page = await context.newPage()
  await createAccount(page, name)
  return page
}

async function addChannel(page: Page, name: string, access: 'members' | 'leaders'): Promise<void> {
  await page.getByRole('button', { name: 'Add channel' }).click()
  await page.getByPlaceholder('Channel name').fill(name)
  await page.locator('select').last().selectOption(access) // header presence select is first
  await page.getByRole('button', { name: 'Create channel' }).click()
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible({
    timeout: 20_000,
  })
}

test('communities: channels, access control, invite, E2EE channel chat, promotion', async ({
  browser,
}) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const alice = await newUser(ctxA, 'Pastor Alice')
  const bob = await newUser(ctxB, 'Member Bob')

  // Alice creates a community.
  await alice.getByRole('link', { name: 'Communities' }).click()
  await alice.getByRole('button', { name: 'Create community' }).first().click() // header toggle
  await alice.getByPlaceholder('Community name').fill('Grace Fellowship')
  await alice.getByRole('button', { name: 'Create community' }).last().click() // form submit
  await expect(alice.getByRole('heading', { name: 'Grace Fellowship' })).toBeVisible({
    timeout: 30_000,
  })

  // Two channels: one for all members, one for leaders only.
  await addChannel(alice, 'general', 'members')
  await addChannel(alice, 'leaders', 'leaders')

  // Alice grabs the auto-created invite code.
  const code = (
    await alice.locator('.font-mono.text-2xl').first().textContent({ timeout: 20_000 })
  )?.trim()
  expect(code).toMatch(/^[0-9A-Z]{10}$/)

  // Bob joins with the code.
  await bob.getByRole('link', { name: 'Communities' }).click()
  await bob.getByRole('button', { name: 'Join with a code' }).click()
  await bob.getByPlaceholder('Community invite code').fill(code ?? '')
  await bob.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(bob.getByRole('heading', { name: 'Grace Fellowship' })).toBeVisible({
    timeout: 30_000,
  })

  // Bob sees the members channel but the leaders channel is hidden from him.
  await expect(bob.getByRole('button', { name: /general/ })).toBeVisible({ timeout: 20_000 })
  await expect(bob.getByRole('button', { name: /leaders/ })).toHaveCount(0)

  // Both open #general and exchange an E2EE message.
  await alice.getByRole('button', { name: /general/ }).click()
  await bob.getByRole('button', { name: /general/ }).click()
  const aliceInput = alice.getByPlaceholder('Message…')
  await expect(aliceInput).toBeEnabled({ timeout: 40_000 })
  await aliceInput.fill('Peace be with you all')
  await alice.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(bob.getByText('Peace be with you all')).toBeVisible({ timeout: 40_000 })

  const bobInput = bob.getByPlaceholder('Message…')
  await expect(bobInput).toBeEnabled({ timeout: 40_000 })
  await bobInput.fill('And also with you')
  await bob.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(alice.getByText('And also with you')).toBeVisible({ timeout: 40_000 })

  // Alice promotes Bob to leader → the community.role_changed WS event
  // refreshes Bob's channel list live, revealing the leaders channel.
  await alice.getByRole('button', { name: 'Make leader' }).click()
  await expect(bob.getByRole('button', { name: /leaders/ })).toBeVisible({ timeout: 30_000 })

  await ctxA.close()
  await ctxB.close()
})
