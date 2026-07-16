import { Gathernet, GathernetError } from '@gathernet/sdk'
import QRCode from 'qrcode'

const APP_ID = import.meta.env.VITE_GATHERNET_APP_ID ?? 'pub_00000000000000d1'
const SERVER_URL = import.meta.env.VITE_GATHERNET_SERVER ?? 'http://localhost:4000'
const HUB_URL = import.meta.env.VITE_GATHERNET_HUB ?? 'http://localhost:5173'

const root = document.getElementById('app')
if (!root) throw new Error('missing #app')

const gn = await Gathernet.init({ appId: APP_ID, serverUrl: SERVER_URL, hubUrl: HUB_URL })

function render(): void {
  if (!root) return
  root.innerHTML = ''
  root.append(gn.user ? loggedInView() : loginView())
}

function el(html: string): HTMLElement {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  return template.content.firstElementChild as HTMLElement
}

function loginView(): HTMLElement {
  const view = el(`
    <section>
      <h2>Sign in</h2>
      <div class="row">
        <button id="login">Sign in with Gathernet</button>
        <button id="login-code" class="quiet">Sign in on another device</button>
      </div>
      <div id="code-area" class="hidden">
        <p>Scan in the Gathernet Hub (or enter the code under <em>Connect an app</em>):</p>
        <div class="row">
          <canvas id="qr"></canvas>
          <div>
            <div style="font-size:1.6rem; letter-spacing:0.3em" id="user-code"></div>
            <p class="muted" id="code-status">waiting for approval…</p>
          </div>
        </div>
      </div>
      <p class="muted" id="login-error"></p>
    </section>
  `)

  const errorOut = view.querySelector('#login-error') as HTMLElement
  view.querySelector('#login')?.addEventListener('click', async () => {
    errorOut.textContent = ''
    try {
      await gn.login({ scopes: ['identity', 'storage'] })
      render()
    } catch (err) {
      errorOut.textContent =
        err instanceof GathernetError && err.code === 'denied'
          ? 'You declined the request.'
          : err instanceof GathernetError && err.code === 'cancelled'
            ? 'Sign-in window closed.'
            : `Sign-in failed: ${String(err)}`
    }
  })

  view.querySelector('#login-code')?.addEventListener('click', async () => {
    errorOut.textContent = ''
    try {
      const flow = await gn.loginWithCode({ scopes: ['identity', 'storage'] })
      view.querySelector('#code-area')?.classList.remove('hidden')
      const codeOut = view.querySelector('#user-code') as HTMLElement
      codeOut.textContent = `${flow.userCode.slice(0, 4)}-${flow.userCode.slice(4)}`
      await QRCode.toCanvas(view.querySelector('#qr'), flow.qrPayload, { width: 140, margin: 1 })
      await flow.waitForGrant()
      render()
    } catch (err) {
      const status = view.querySelector('#code-status') as HTMLElement
      status.textContent =
        err instanceof GathernetError && err.code === 'denied'
          ? 'Request declined.'
          : `Failed: ${String(err)}`
    }
  })

  return view
}

function loggedInView(): HTMLElement {
  const user = gn.user
  const view = el(`
    <div>
      <section>
        <h2>Signed in</h2>
        <p>Hello <strong>${user?.displayName ?? ''}</strong> <span class="muted">(${user?.appUserId ?? ''})</span></p>
        <p class="muted">Scopes: ${user?.scopes.join(', ') ?? ''}</p>
        <button id="logout" class="quiet">Sign out</button>
      </section>
      <section>
        <h2>Encrypted cloud save</h2>
        <p class="muted">Sealed client-side; the server stores only ciphertext.</p>
        <div class="row"><textarea id="note" rows="3" placeholder="Your note…"></textarea></div>
        <div class="row">
          <button id="save">Save</button>
          <button id="load" class="quiet">Load</button>
          <button id="conflict" class="quiet">Simulate conflict</button>
        </div>
        <p class="muted" id="save-status"></p>
      </section>
    </div>
  `)

  const note = view.querySelector('#note') as HTMLTextAreaElement
  const status = view.querySelector('#save-status') as HTMLElement
  let version = 0

  const load = async () => {
    try {
      const saved = await gn.storage.getJSON<{ text: string }>('demo-note')
      const entries = await gn.storage.list()
      version = entries.find((e) => e.key === 'demo-note')?.version ?? 0
      note.value = saved?.text ?? ''
      status.textContent = saved ? `loaded v${version}` : 'no save yet'
    } catch (err) {
      status.textContent =
        err instanceof GathernetError && err.code === 'no_storage_key'
          ? 'No storage key — grant the storage scope (or finish backfill in the Hub).'
          : `load failed: ${String(err)}`
    }
  }

  view.querySelector('#logout')?.addEventListener('click', async () => {
    await gn.logout()
    render()
  })
  view.querySelector('#save')?.addEventListener('click', async () => {
    try {
      const result = await gn.storage.putJSON(
        'demo-note',
        { text: note.value },
        version > 0 ? { ifVersion: version } : {},
      )
      version = result.version
      status.textContent = `saved v${version} ✓`
    } catch (err) {
      status.textContent =
        err instanceof GathernetError && err.code === 'version_conflict'
          ? 'Version conflict — someone else saved. Load first.'
          : `save failed: ${String(err)}`
    }
  })
  view.querySelector('#load')?.addEventListener('click', load)
  view.querySelector('#conflict')?.addEventListener('click', async () => {
    // Write once behind the UI's back, then try saving with the stale version.
    await gn.storage.putJSON('demo-note', { text: `${note.value} (other device)` })
    try {
      await gn.storage.putJSON('demo-note', { text: note.value }, { ifVersion: version })
      status.textContent = 'unexpected: no conflict?'
    } catch (err) {
      status.textContent =
        err instanceof GathernetError && err.code === 'version_conflict'
          ? 'Conflict detected as expected (412) — reload to converge.'
          : `unexpected error: ${String(err)}`
    }
  })

  void load()
  return view
}

gn.onAuthChange(render)
render()
