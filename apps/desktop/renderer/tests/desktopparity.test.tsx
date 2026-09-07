import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import { DocumentDownload, documentFilename } from '../src/canvas/download'
import { NewOrg } from '../src/App'
import { createOrg } from '../src/api'

test('desktop settings retain providers and runtime while excluding registry and Git calls', async () => {
  const calls: string[] = []
  const old = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    const body = String(url).includes('/providers') ? { providers: [
      { id: 'claude', label: 'Claude Code', status: { installed: true, connected: true }, tiers: [], hire_enabled: true },
      { id: 'openai', label: 'Codex', status: { installed: false }, tiers: [], hire_enabled: false },
      { id: 'google', label: 'Antigravity', status: { installed: false }, tiers: [], hire_enabled: false },
    ] } : { warming_enabled: init?.method !== 'PUT', working_checkups_enabled: true }
    return { ok: true, headers: new Headers(), json: async () => body } as Response
  }
  const view = await mountView(<AccountsPanel close={() => {}} toast={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(10) })
    assert.match(view.el.textContent!, /Claude Code/)
    assert.match(view.el.textContent!, /Connected/)
    assert.ok(view.el.querySelector('a[href="https://developers.openai.com/codex/cli/"]'))
    assert.doesNotMatch(view.el.textContent!, /fallback account|setup-token|Git repositories/)
    const labels = [...view.el.querySelectorAll('button,input,select')].map(e =>
      e.getAttribute('aria-label') || e.textContent || '').join(' ')
    assert.doesNotMatch(labels, /add.*account|delete.*account|move.*account|fallback|priority/i)
    assert.equal(calls.some(c => c.includes('/accounts')), false)
    const runtime = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === 'Runtime')!
    await inAct(async () => { runtime.click() })
    const toggle = view.el.querySelector<HTMLInputElement>('#app-settings-panel-runtime input')!
    assert.ok(toggle.checked)
    await inAct(async () => { toggle.click(); await flush(10) })
    assert.equal(toggle.checked, false, 'real runtime toggle uses and adopts server response')
    assert.ok(calls.includes('/api/app-settings/runtime'))
  } finally { await view.unmount(); globalThis.fetch = old }
})

test('new organization keeps folder and hub controls without execution isolation controls', async () => {
  let submitted: unknown[] | undefined
  const view = await mountView(<NewOrg onCreate={(...args) => { submitted = args }} />, el => el)
  try {
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('button')!.click() })
    const advanced = view.el.querySelector<HTMLButtonElement>('.disclosure')!
    await inAct(async () => { advanced.click(); await flush(10) })
    assert.match(document.body.textContent!, /grant existing folders/)
    assert.match(document.body.textContent!, /mailserver/)
    for (const tab of [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]) {
      await inAct(() => { tab.click() })
      assert.doesNotMatch(document.body.textContent!, /publicly shareable|Docker container|permission ceiling|virtual disk|disk size|sandbox/i)
    }
    await inAct(() => {
      view.el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    assert.deepEqual(submitted, ['', [], true, []], 'create callback contains only desktop-supported fields')
  } finally { await view.unmount() }
})

test('document source downloads carry safe names and engine artifact identity for both formats', async () => {
  const view = await mountView(<><DocumentDownload slug="test org" id="doc:1" title="Report" />
    <DocumentDownload slug="test org" id="doc:2" title="Prototype" format="html" /></>, el => el)
  try {
    const links = view.el.querySelectorAll<HTMLAnchorElement>('a')
    assert.equal(links.length, 2)
    assert.equal(links[0]!.getAttribute('href'), '/api/orgs/test%20org/documents/doc%3A1/download')
    assert.equal(links[0]!.download, 'Report.md')
    assert.equal(links[1]!.download, 'Prototype.html')
    assert.equal(documentFilename('../bad: name*', 'html'), '..-bad- name-.html')
    assert.equal(documentFilename('   ', 'markdown'), 'document.md')
    assert.equal(view.el.querySelector('iframe'), null)
  } finally { await view.unmount() }
})


test('organization creation forwards mail choices and cannot serialize excluded execution fields', async () => {
  const old = globalThis.fetch
  let sent: unknown
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body))
    return { ok: true, headers: new Headers(), json: async () => ({ slug: 'new-org' }) } as Response
  }
  try {
    await createOrg('New Org', ['C:/project'], false, ['https://mail.example'])
    assert.deepEqual(sent, { name: 'New Org', dirs: ['C:/project'], net_autoconnect: false, net_hubs: ['https://mail.example'] })
  } finally { globalThis.fetch = old }
})
