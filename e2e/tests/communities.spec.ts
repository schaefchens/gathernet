import { type BrowserContext, expect, type Page, test } from '@playwright/test'

/**
 * Communities v2 journey, two browsers. Proves the end-to-end wiring of the
 * encrypted-metadata + rich-channel model through the real UI + server + MLS:
 *
 *  - a community's name/description are E2E-encrypted; the creator renders them
 *    from the locally-held K_meta;
 *  - K_meta rides OUT OF BAND in the invite link's fragment, so a joiner who
 *    opens the link can decrypt the community's + channels' metadata (a joiner
 *    with only the bare code could not — that's an accepted degradation);
 *  - an open channel: click-to-join, then a bidirectional E2EE message;
 *  - a by-request channel: the joiner waits until a moderator accepts, via the
 *    moderation panel.
 *
 * The exhaustive branch matrix (visibility, targeted/code invites, moderator
 * appointment + channel-kick, leaders-only access, disappearing-message TTL) is
 * covered by the server test suite; this journey exercises the UI paths.
 *
 * Requires the dev stack: server :4000 + hub :5173 (docker compose up -d
 * postgres; server dev; hub dev).
 */

const PASSWORD = 'test-password-1'

async function createAccount(page: Page, displayName: string): Promise<string> {
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
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 60_000 })
  return words.join(' ')
}

/** Restore an existing account onto a fresh device (a new browser context). */
async function restoreAccount(page: Page, phrase: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'I have a recovery phrase' }).click()
  await page.getByPlaceholder('worship gather bread …').fill(phrase)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByPlaceholder('Unlock password', { exact: true }).fill(PASSWORD)
  await page.getByPlaceholder('Repeat password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 60_000 })
}

async function newUser(
  context: BrowserContext,
  name: string,
): Promise<{ page: Page; phrase: string }> {
  const page = await context.newPage()
  const phrase = await createAccount(page, name)
  return { page, phrase }
}

async function addChannel(
  page: Page,
  opts: {
    emoji?: string
    title: string
    joinPolicy?: 'open' | 'request'
    postPolicy?: 'everyone' | 'moderators'
    encryptionMode?: 'mls' | 'group_key'
  },
): Promise<void> {
  await page.getByRole('button', { name: 'Add channel' }).click()
  if (opts.emoji) await page.getByPlaceholder('Emoji').fill(opts.emoji)
  await page.getByPlaceholder('Channel title').fill(opts.title)
  if (opts.encryptionMode) {
    // "Channel type" offers the product-level kinds, not the raw crypto modes: small
    // presets mls, large/broadcast preset group_key (broadcast also restricts posting).
    const kind =
      opts.encryptionMode === 'mls'
        ? 'small'
        : opts.postPolicy === 'moderators'
          ? 'broadcast'
          : 'large'
    await page.getByLabel('Channel type').selectOption(kind)
  }
  if (opts.joinPolicy) await page.getByLabel('Who can join').selectOption(opts.joinPolicy)
  if (opts.postPolicy) await page.getByLabel('Who can post').selectOption(opts.postPolicy)
  await page.getByRole('button', { name: 'Create channel' }).click()
  await expect(page.getByRole('button', { name: new RegExp(opts.title) })).toBeVisible({
    timeout: 20_000,
  })
}

test('communities v2: encrypted metadata, K_meta out-of-band, open + request join, moderation', async ({
  browser,
}) => {
  // Alice's context can read the clipboard (the invite "Copy" button writes the
  // full K_meta-carrying link there).
  const ctxA = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const ctxB = await browser.newContext()
  const { page: alice } = await newUser(ctxA, 'Pastor Alice')
  const { page: bob } = await newUser(ctxB, 'Member Bob')

  // Alice creates a community — name + description are encrypted under K_meta.
  await alice.getByRole('link', { name: 'Communities' }).click()
  await alice.getByRole('button', { name: 'Create community' }).first().click()
  await alice.getByPlaceholder('Community name').fill('Grace Fellowship')
  await alice.getByPlaceholder('What is this community about?').fill('**Welcome** to our church')
  await alice.getByRole('button', { name: 'Create community' }).last().click()
  // The creator decrypts the name locally from the K_meta it just generated.
  await expect(alice.getByRole('heading', { name: 'Grace Fellowship' })).toBeVisible({
    timeout: 30_000,
  })

  // An open, listed channel with an emoji + title.
  await addChannel(alice, { emoji: '🙏', title: 'general' })

  // Grab the full invite link (carries K_meta in the URL fragment) via clipboard.
  await alice.getByRole('button', { name: 'Copy', exact: true }).click({ timeout: 20_000 })
  const payload = await alice.evaluate(() => navigator.clipboard.readText())
  expect(payload).toContain('gathernet:community:')
  expect(payload).toContain('#') // the K_meta fragment

  // Bob joins with the LINK → K_meta rides along → he decrypts the metadata.
  await bob.getByRole('link', { name: 'Communities' }).click()
  await bob.getByRole('button', { name: 'Join with a code' }).click()
  await bob.getByPlaceholder('Invite code or link').fill(payload)
  await bob.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(bob.getByRole('heading', { name: 'Grace Fellowship' })).toBeVisible({
    timeout: 30_000,
  })
  // Channel title decrypts on the joiner too (proves out-of-band K_meta worked).
  await expect(bob.getByRole('button', { name: /general/ })).toBeVisible({ timeout: 20_000 })

  // Bob joins the open channel; both exchange an E2EE message.
  await bob.getByRole('button', { name: /general/ }).click()
  await bob.getByRole('button', { name: 'Join', exact: true }).click()

  await alice.getByRole('button', { name: /general/ }).click()
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

  // A by-request channel: Bob requests, waits, and a moderator (Alice) accepts.
  await addChannel(alice, { title: 'prayer', joinPolicy: 'request' })

  await expect(bob.getByRole('button', { name: /prayer/ })).toBeVisible({ timeout: 20_000 })
  await bob.getByRole('button', { name: /prayer/ }).click()
  await bob.getByRole('button', { name: 'Request to join' }).click()
  await expect(bob.getByText('Waiting for approval')).toBeVisible({ timeout: 20_000 })

  // Alice opens the channel's Moderation tab and accepts Bob's pending request
  // (the Accept button is unique to a pending-request row).
  await alice.getByRole('button', { name: /prayer/ }).click()
  await alice.getByRole('button', { name: 'Moderation' }).click()
  const acceptBtn = alice.getByRole('button', { name: 'Accept', exact: true })
  await expect(acceptBtn).toBeVisible({ timeout: 20_000 })
  await acceptBtn.click()

  // The community.channel_join_approved WS event flips Bob to active live, so
  // his prayer channel becomes writable without a reload.
  const bobPrayerInput = bob.getByPlaceholder('Message…')
  await expect(bobPrayerInput).toBeEnabled({ timeout: 40_000 })

  // Announcement channel: read-only for members, writable only by moderators.
  await addChannel(alice, { title: 'announcements', postPolicy: 'moderators' })
  await expect(bob.getByRole('button', { name: /announcements/ })).toBeVisible({ timeout: 20_000 })
  await bob.getByRole('button', { name: /announcements/ }).click()
  await bob.getByRole('button', { name: 'Join', exact: true }).click()

  // Bob (a plain member) sees the read-only notice and gets no composer.
  await expect(bob.getByText('Only moderators can post in this channel.')).toBeVisible({
    timeout: 40_000,
  })
  await expect(bob.getByPlaceholder('Message…')).toHaveCount(0)

  // Alice (a moderator) can post, and Bob receives it.
  await alice.getByRole('button', { name: /announcements/ }).click()
  const aliceAnnounce = alice.getByPlaceholder('Message…')
  await expect(aliceAnnounce).toBeEnabled({ timeout: 40_000 })
  await aliceAnnounce.fill('Service at 10am')
  await alice.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(bob.getByText('Service at 10am')).toBeVisible({ timeout: 40_000 })

  await ctxA.close()
  await ctxB.close()
})

test('mega-communities: group_key channel — scalable channel, bidirectional E2EE, coexists with mls', async ({
  browser,
}) => {
  const ctxA = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const ctxB = await browser.newContext()
  const { page: alice } = await newUser(ctxA, 'Pastor Alice')
  const { page: bob } = await newUser(ctxB, 'Member Bob')

  await alice.getByRole('link', { name: 'Communities' }).click()
  await alice.getByRole('button', { name: 'Create community' }).first().click()
  await alice.getByPlaceholder('Community name').fill('Mega Church')
  await alice.getByRole('button', { name: 'Create community' }).last().click()
  await expect(alice.getByRole('heading', { name: 'Mega Church' })).toBeVisible({ timeout: 30_000 })

  // A SCALABLE (group_key) channel — no MLS group; content sealed under K_channel.
  await addChannel(alice, { emoji: '📣', title: 'general', encryptionMode: 'group_key' })
  // ...alongside a normal (mls) channel, proving the two modes coexist.
  await addChannel(alice, { title: 'elders' })

  await alice.getByRole('button', { name: 'Copy', exact: true }).click({ timeout: 20_000 })
  const payload = await alice.evaluate(() => navigator.clipboard.readText())

  // Bob joins the community by link (K_meta decrypts the metadata).
  await bob.getByRole('link', { name: 'Communities' }).click()
  await bob.getByRole('button', { name: 'Join with a code' }).click()
  await bob.getByPlaceholder('Invite code or link').fill(payload)
  await bob.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(bob.getByRole('heading', { name: 'Mega Church' })).toBeVisible({ timeout: 30_000 })

  // Bob opens + joins the group_key channel — no external-join; he fetches K_channel.
  await bob.getByRole('button', { name: /general/ }).click()
  await bob.getByRole('button', { name: 'Join', exact: true }).click()

  // Alice opens the channel + posts. Opening tops up Bob's K_channel grant; the
  // message is sealed under K_channel and carries Alice's Ed25519 sender signature.
  await alice.getByRole('button', { name: /general/ }).click()
  const aliceInput = alice.getByPlaceholder('Message…')
  await expect(aliceInput).toBeEnabled({ timeout: 40_000 })
  await aliceInput.fill('Grace and peace to the whole congregation')
  await alice.getByRole('button', { name: 'Send', exact: true }).click()
  // Bob obtains the grant, verifies the sender, and decrypts — proving group_key E2EE.
  await expect(bob.getByText('Grace and peace to the whole congregation')).toBeVisible({
    timeout: 60_000,
  })

  // Bob replies under the shared key; Alice reads it (bidirectional).
  const bobInput = bob.getByPlaceholder('Message…')
  await expect(bobInput).toBeEnabled({ timeout: 40_000 })
  await bobInput.fill('And also with you')
  await bob.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(alice.getByText('And also with you')).toBeVisible({ timeout: 60_000 })

  await ctxA.close()
  await ctxB.close()
})

test('communities v2: K_meta syncs to a restored second device via receipt-key grant', async ({
  browser,
}) => {
  // Three contexts: Alice, Bob's first device, and Bob's phrase-restored device.
  const ctxA = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const ctxB1 = await browser.newContext()
  const ctxB2 = await browser.newContext()
  const { page: alice } = await newUser(ctxA, 'Pastor Alice')
  const { page: bob1, phrase: bobPhrase } = await newUser(ctxB1, 'Member Bob')

  // Alice creates a community and grabs the K_meta-carrying invite link.
  await alice.getByRole('link', { name: 'Communities' }).click()
  await alice.getByRole('button', { name: 'Create community' }).first().click()
  await alice.getByPlaceholder('Community name').fill('Grace Fellowship')
  await alice.getByRole('button', { name: 'Create community' }).last().click()
  await expect(alice.getByRole('heading', { name: 'Grace Fellowship' })).toBeVisible({
    timeout: 30_000,
  })
  await alice.getByRole('button', { name: 'Copy', exact: true }).click({ timeout: 20_000 })
  const payload = await alice.evaluate(() => navigator.clipboard.readText())

  // Bob's first device joins by link — it holds K_meta and decrypts the name.
  await bob1.getByRole('link', { name: 'Communities' }).click()
  await bob1.getByRole('button', { name: 'Join with a code' }).click()
  await bob1.getByPlaceholder('Invite code or link').fill(payload)
  await bob1.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(bob1.getByRole('heading', { name: 'Grace Fellowship' })).toBeVisible({
    timeout: 30_000,
  })

  // Bob restores his account on a brand-new device (no K_meta anywhere on it).
  // Navigate within the SPA — a full page load would drop to the unlock screen.
  const bob2 = await ctxB2.newPage()
  await restoreAccount(bob2, bobPhrase)
  await bob2.getByRole('link', { name: 'Communities' }).click()
  // The community is listed, but its name can't be decrypted yet → placeholder.
  // Scoped to the content pane: the desktop sidebar lists the same communities.
  await bob2
    .getByRole('main')
    .getByRole('link', { name: /Encrypted community/ })
    .click()
  await expect(bob2.getByRole('heading', { name: 'Encrypted community' })).toBeVisible({
    timeout: 30_000,
  })

  // Bob's first device re-opens the community, which seeds K_meta grants to its
  // other devices. The grant reaches the second device, which decrypts the
  // metadata live (community.key_grants_available → fetch + open).
  await bob1.getByRole('link', { name: 'Communities' }).click()
  // Scoped to the content pane: the desktop sidebar lists the same communities.
  await bob1
    .getByRole('main')
    .getByRole('link', { name: /Grace Fellowship/ })
    .click()
  await expect(bob2.getByRole('heading', { name: 'Grace Fellowship' })).toBeVisible({
    timeout: 40_000,
  })

  await ctxA.close()
  await ctxB1.close()
  await ctxB2.close()
})

test('communities v2: removing a member rotates K_meta; remaining members re-key', async ({
  browser,
}) => {
  const ctxA = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const ctxB = await browser.newContext()
  const ctxC = await browser.newContext()
  const { page: alice } = await newUser(ctxA, 'Pastor Alice')
  const { page: bob } = await newUser(ctxB, 'Member Bob')
  const { page: carol } = await newUser(ctxC, 'Member Carol')
  alice.on('dialog', (d) => void d.accept()) // the Remove confirm()

  // Alice creates the community and grabs the K_meta invite link.
  await alice.getByRole('link', { name: 'Communities' }).click()
  await alice.getByRole('button', { name: 'Create community' }).first().click()
  await alice.getByPlaceholder('Community name').fill('Grace Fellowship')
  await alice.getByRole('button', { name: 'Create community' }).last().click()
  await expect(alice.getByRole('heading', { name: 'Grace Fellowship' })).toBeVisible({
    timeout: 30_000,
  })
  await alice.getByRole('button', { name: 'Copy', exact: true }).click({ timeout: 20_000 })
  const payload = await alice.evaluate(() => navigator.clipboard.readText())

  // Bob + Carol join by link — both hold the epoch-0 K_meta.
  for (const p of [bob, carol]) {
    await p.getByRole('link', { name: 'Communities' }).click()
    await p.getByRole('button', { name: 'Join with a code' }).click()
    await p.getByPlaceholder('Invite code or link').fill(payload)
    await p.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(p.getByRole('heading', { name: 'Grace Fellowship' })).toBeVisible({
      timeout: 30_000,
    })
  }

  // Alice removes Carol → the server flags rotation + nudges Alice, whose client
  // rotates K_meta (re-encrypts metadata under a new epoch, re-grants Alice+Bob).
  await alice
    .getByRole('listitem')
    .filter({ hasText: 'Member Carol' })
    .getByRole('button', { name: 'Remove' })
    .click()

  // Carol loses access to the community.
  await expect(carol.getByRole('heading', { name: 'Grace Fellowship' })).toHaveCount(0, {
    timeout: 30_000,
  })
  // Bob remains (this also gives the rotation time to complete).
  await expect(bob.getByRole('heading', { name: 'Grace Fellowship' })).toBeVisible({
    timeout: 30_000,
  })

  // Alice renames the community. The new name is sealed under the NEW (post-
  // rotation) key — so Bob can only read it if he re-keyed to the new epoch.
  await alice.getByRole('button', { name: 'Community settings' }).click()
  await alice.getByPlaceholder('Community name').fill('Rekeyed Fellowship')
  await alice.getByRole('button', { name: 'Save' }).click()
  await expect(bob.getByRole('heading', { name: 'Rekeyed Fellowship' })).toBeVisible({
    timeout: 40_000,
  })

  await ctxA.close()
  await ctxB.close()
  await ctxC.close()
})
