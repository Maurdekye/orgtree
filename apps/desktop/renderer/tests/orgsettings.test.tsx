// D-222 — org settings is ONE modal.
//
// User directive 2026-09-01: "consolidate settings into ONE modal. Remove the
// separate/nested Advanced Settings modal and its launch flow. The single
// modal should use a tab series: first tab = Basic settings; every subsequent
// tab = one of the tabs/sections currently housed in the Advanced modal."
//
// The panel used to render an `advanced…` disclosure that opened a SECOND
// `.overlay` on top of the first, with its own Escape handler, its own tab
// strip (roleless buttons, no arrow keys) and its own "done" button — while
// the only real save button stayed on the panel underneath, which is why each
// advanced tab had to end with a note explaining where its save button was.
//
// These tests state the consolidation as properties rather than as pixels:
// one overlay, one save, direct tab reach, nothing lost across a tab switch,
// and no orphaned launch flow.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsPanel } from '../src/App'
import type { TreePayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>

/** the shape SettingsPanel actually reads. Deliberately a plain org: no
 *  kiosk (so Autonomy exists) and a mail identity (so Mailserver exists),
 *  which is the widest tab set an ordinary org can show. */
function tree(over: Record<string, unknown> = {}): TreePayload {
  return {
    slug: 'acme', name: 'Acme', nodes: [], edges: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0.8,
    default_effort: '', cascade_hire: true, cascade_alloc: true,
    fable_limit_policy: 'halt', fable_filter_policy: 'halt',
    auto_cheap_compact: { enabled: false, occ: 0.5 },
    auto_resume_compact: false,
    kiosk: null, sandboxed: false, disk: null, net: { hubs: [] },
    ...over,
  } as unknown as TreePayload
}

function stubFetch(
  seen: { method: string; path: string; body: unknown }[],
  mcpServers?: string[],
  accounts?: unknown[],
) {
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    seen.push({ method, path,
      body: init?.body ? JSON.parse(String(init.body)) : null })
    const payload = path.startsWith('/api/orgs/acme/orgmd')
      ? { content: '# Acme\n' }
      : path.startsWith('/api/orgs/acme/net') ? { hubs: [], identity: null }
        : path === '/api/mcp-servers' ? { servers: mcpServers ?? [], sandbox_mcp: false }
          : path === '/api/accounts' ? { accounts: accounts ?? [] }
            : {}
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(payload),
    })
  }
}

async function mountOrg(over: Record<string, unknown> = {}) {
  const closed: true[] = []
  const view = await mountView(
    <SettingsPanel tree={tree(over)} toast={() => {}}
      close={() => { closed.push(true) }} />, (el) => el)
  await inAct(async () => { await flush(10) })
  return { view, closed }
}

const tabs = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]

/** a React controlled field ignores a plain `.value =` — its value tracker
 *  sees no change and the onChange never fires. Go through the prototype
 *  setter and dispatch the event React actually listens for. (Same technique
 *  as tests/kbdhire.test.tsx; kept local rather than exported so this file
 *  stays readable on its own.) */
async function setField(el: HTMLInputElement | HTMLSelectElement, v: string) {
  const w = el.ownerDocument.defaultView as unknown as {
    HTMLInputElement: typeof HTMLInputElement
    HTMLSelectElement: typeof HTMLSelectElement
    Event: typeof Event
  }
  const proto = el.tagName === 'SELECT'
    ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  assert.ok(setter, 'no value setter on the element prototype')
  await inAct(async () => {
    setter!.call(el, v)
    el.dispatchEvent(new w.Event('input', { bubbles: true }))
    el.dispatchEvent(new w.Event('change', { bubbles: true }))
    await flush()
  })
}

async function open(el: HTMLElement, label: string) {
  const t = tabs(el).find((b) => b.textContent?.includes(label))
  assert.ok(t, `no tab labelled ${label}`)
  await inAct(async () => { t!.click() })
  return t!
}

test('History loads inside Settings and the Autonomy toggle saves auto-resume', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view } = await mountOrg({ auto_resume: false })
  try {
    assert.equal(seen.some(r => r.path === '/api/orgs/acme/history'), false)
    await open(view.el, 'History')
    await inAct(async () => { await flush(10) })
    assert.ok(seen.some(r => r.method === 'GET' && r.path === '/api/orgs/acme/history'))
    assert.equal(view.el.querySelectorAll('.overlay').length, 1)
    await open(view.el, 'Autonomy')
    const label = [...view.el.querySelectorAll('label')].find(el =>
      el.textContent?.includes('auto-resume frozen agents when the usage limit resets'))
    const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    assert.ok(input, 'the setting is accessible in Autonomy')
    assert.equal(input.checked, false)
    await inAct(async () => { input.click(); await flush(10) })
    assert.ok(seen.some(r => r.method === 'POST' && r.path === '/api/orgs/acme/settings'
      && (r.body as Record<string, unknown>).auto_resume === true))
  } finally { await view.unmount(); delete g.fetch }
})

test('①  ONE modal: a single overlay, no advanced disclosure, and every '
  + 'former advanced section reachable as a sibling tab', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view } = await mountOrg()
  try {
    // exactly one overlay in the tree — the nested one is gone
    assert.equal(view.el.querySelectorAll('.overlay').length, 1)
    // and its launch flow with it
    assert.equal(view.el.querySelectorAll('.disclosure').length, 0)
    assert.doesNotMatch(view.el.textContent ?? '', /advanced…/)
    // Basic is first and selected on open
    const labels = tabs(view.el).map((t) => t.textContent?.trim())
    assert.equal(labels[0]?.startsWith('Basic'), true)
    assert.deepEqual(labels,
      ['Basic', 'Hire defaults', 'Policies', 'Connections', 'Autonomy',
        'History'])
    assert.equal(tabs(view.el)[0]!.getAttribute('aria-selected'), 'true')

    // every former advanced category is now reachable in ONE click from the
    // strip, rather than one click to open a modal and another to pick a tab
    for (const label of ['Hire defaults', 'Policies', 'Connections',
      'Autonomy', 'History']) {
      const t = await open(view.el, label)
      assert.equal(t.getAttribute('aria-selected'), 'true')
      // still one overlay: picking a tab must not open a second surface
      assert.equal(view.el.querySelectorAll('.overlay').length, 1)
      const panel = view.el.querySelector(`#${t.getAttribute('aria-controls')}`)
      assert.ok(panel, `${label} tab controls no panel`)
      assert.equal(panel!.hasAttribute('hidden'), false)
    }
  } finally { await view.unmount(); delete g.fetch }
})

test('②  ONE save surface, on every tab — and none of the four "changes here '
  + 'save with the panel\'s own save button" notes survive', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view } = await mountOrg()
  try {
    for (const label of ['Basic', 'Hire defaults', 'Policies', 'Autonomy',
      'History']) {
      await open(view.el, label)
      const saves = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
        .filter((b) => b.textContent?.trim() === 'save')
      assert.equal(saves.length, 1, `${label}: expected exactly one save`)
      // the nested modal's own dismissal is gone; cancel is the panel's
      assert.equal([...view.el.querySelectorAll<HTMLButtonElement>('button')]
        .filter((b) => b.textContent?.trim() === 'done').length, 0,
        `${label}: the nested modal's "done" button survived`)
      assert.doesNotMatch(view.el.textContent ?? '',
        /changes here save with the panel/,
        `${label}: a note explaining where the save button is`)
    }
  } finally { await view.unmount(); delete g.fetch }
})

test('③  a tab switch is lossless: an edit made on one tab is still there '
  + 'after visiting another, and rides the one save', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view, closed } = await mountOrg()
  try {
    // edit on Basic
    await setField(view.el.querySelector<HTMLInputElement>(
      'input[aria-label="top-level grant cap"]')!, '77')

    // edit on Policies
    await open(view.el, 'Policies')
    await setField(view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="fable weekly-limit policy"]')!, 'opus')

    // wander, then come back — both edits survive, because the panels are
    // hidden rather than unmounted
    await open(view.el, 'Autonomy')
    await open(view.el, 'Basic')
    assert.equal(view.el.querySelector<HTMLInputElement>(
      'input[aria-label="top-level grant cap"]')!.value, '77')
    await open(view.el, 'Policies')
    assert.equal(view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="fable weekly-limit policy"]')!.value, 'opus')

    // one save carries BOTH, from whichever tab you happen to be on
    seen.length = 0
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'save')!
    await inAct(async () => { save.click(); await flush(12) })
    const settings = seen.find((r) => r.method === 'POST'
      && r.path === '/api/orgs/acme/settings')
    assert.ok(settings, 'save did not POST the settings')
    const body = settings!.body as Record<string, unknown>
    assert.equal(body.max_top_grant, 77)
    assert.equal(body.fable_limit_policy, 'opus')
    assert.equal(closed.length, 1, 'a successful save closes the panel')
  } finally { await view.unmount(); delete g.fetch }
})

test('④  the tab set follows the org: an '
  + 'org with no mail identity has no Connections tab', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  let m = await mountOrg({ net: null })
  try {
    assert.deepEqual(tabs(m.view.el).map((t) => t.textContent?.trim()),
      ['Basic', 'Hire defaults', 'Policies', 'Autonomy', 'History'])
  } finally { await m.view.unmount() }

})

// Kiosk ceiling tests are outside the v2 desktop scope.

test('⑥  content-filter policy: auto-autopsy reveals model selector without fable and saves chosen model', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view, closed } = await mountOrg()
  try {
    await open(view.el, 'Policies')
    const policySelect = view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="fable content-filter policy"]')
    assert.ok(policySelect, 'policy select not found')

    const options = [...policySelect.options].map((o) => o.value)
    assert.ok(options.includes('auto-autopsy'), 'auto-autopsy not in policy options')

    // While policy is halt, autopsy model select is not rendered
    assert.equal(view.el.querySelector('select[aria-label="autopsy model"]'), null)

    // Switch policy to auto-autopsy
    await setField(policySelect, 'auto-autopsy')

    // Now autopsy model select is revealed
    const modelSelect = view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="autopsy model"]')
    assert.ok(modelSelect, 'autopsy model select not revealed')

    // Fable must NOT be among the choices
    const modelOptions = [...modelSelect.options].map((o) => o.value)
    assert.equal(modelOptions.includes('fable'), false, 'fable must not be selectable as autopsy model')
    assert.ok(modelOptions.includes('opus'), 'opus should be offered')
    assert.ok(modelOptions.includes('sonnet'), 'sonnet should be offered')

    // Select sonnet
    await setField(modelSelect, 'sonnet')

    // Click save
    seen.length = 0
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'save')!
    await inAct(async () => { save.click(); await flush(12) })

    const settings = seen.find((r) => r.method === 'POST'
      && r.path === '/api/orgs/acme/settings')
    assert.ok(settings, 'save did not POST settings')
    const body = settings!.body as Record<string, unknown>
    assert.equal(body.fable_filter_policy, 'auto-autopsy')
    assert.equal(body.fable_filter_model, 'sonnet')
    assert.equal(closed.length, 1)
  } finally { await view.unmount(); delete g.fetch }
})



test('legacy excluded fields cannot reintroduce kiosk, disk or fallback controls', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen)
  const { view } = await mountOrg({ kiosk: { max_scope: {}, credits: 99 }, sandboxed: true,
    disk: { size_mb: 4096 }, api_fallback: true, fable_api_fallback: true })
  try {
    assert.ok(tabs(view.el).some(t => t.textContent === 'Basic'), 'real settings modal mounted')
    for (const label of ['Basic', 'Policies', 'Connections', 'Autonomy', 'History']) {
      await open(view.el, label)
      const active = view.el.querySelector('[role="tabpanel"]:not([hidden])')!
      assert.ok(active, label + ' panel is visible')
      assert.doesNotMatch(active.textContent!, /API[- ]key fallback|sandbox|kiosk|virtual disk|permission ceiling|rollback backup/i)
    }
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'save')!
    await inAct(async () => { save.click(); await flush(10) })
    const body = seen.find(r => r.path.endsWith('/settings') && r.method === 'POST')!.body as Record<string, unknown>
    assert.equal(body.max_top_grant, 1000, 'ordinary settings still save')
    assert.equal(Object.keys(body).some(k => /kiosk|sandbox|disk|^(?:api_fallback|fable_api_fallback)$/.test(k)), false)
  } finally { await view.unmount(); delete g.fetch }
})


test('account fallback org default starts off and toggles independently of auto-resume', async t => {
  const seen: { method: string; path: string; body: unknown }[] = []
  const old = g.fetch
  stubFetch(seen)
  const { view } = await mountOrg()
  t.after(async () => { await view.unmount(); g.fetch = old })
  await open(view.el, 'Autonomy')
  const label = [...view.el.querySelectorAll('label')].find(x =>
    x.textContent?.includes('automatically switch accounts after a usage limit'))!
  assert.ok(label)
  const box = label.querySelector<HTMLInputElement>('input')!
  assert.equal(box.checked, false)
  await inAct(async () => { box.click(); await flush() })
  const request = seen.find(x => x.method === 'POST' && x.path.endsWith('/settings'))!
  assert.ok(request)
  assert.deepEqual(request.body, { account_fallback_default: true })
})

test('⑦  Hire defaults displays current registered MCP servers while wildcard is checked and switches to checklist on uncheck', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  const registered = ['filesystem', 'github', 'memory']
  stubFetch(seen, registered)
  const { view } = await mountOrg()
  try {
    await open(view.el, 'Hire defaults')
    await inAct(async () => { await flush(20) })

    // Checkbox is checked by default
    const allBox = view.el.querySelector<HTMLInputElement>('input[aria-label="all registered MCP servers"]')
    assert.ok(allBox, 'all registered MCP servers checkbox found')
    assert.equal(allBox.checked, true)

    // Current servers list is rendered
    const currentList = view.el.querySelector('.hire-mcp-current')
    assert.ok(currentList, '.hire-mcp-current container found')
    const chips = [...currentList.querySelectorAll('.hire-mcp-tags .chip')].map((c) => c.textContent?.trim())
    assert.deepEqual(chips, ['filesystem', 'github', 'memory'])

    // Checklist is not rendered while wildcard is active (only 4 default tool checkboxes + 1 allMcp checkbox)
    assert.equal(view.el.querySelectorAll('label.checkline input[type="checkbox"]').length, 5)

    // Uncheck all registered servers
    await inAct(async () => { allBox.click(); await flush(20) })
    assert.equal(allBox.checked, false)

    // .hire-mcp-current is hidden when wildcard is unchecked
    assert.equal(view.el.querySelector('.hire-mcp-current'), null)

    // McpChecklist is now visible with individual checkboxes
    const checklines = [...view.el.querySelectorAll('label.checkline')]
    const serverLabels = checklines.map((l) => l.querySelector('.mono')?.textContent?.trim()).filter(Boolean)
    assert.deepEqual(serverLabels, ['filesystem', 'github', 'memory'])

    // Check all registered servers back on
    await inAct(async () => { allBox.click(); await flush(20) })
    assert.equal(allBox.checked, true)
    const chipsRestored = [...view.el.querySelectorAll('.hire-mcp-current .hire-mcp-tags .chip')].map((c) => c.textContent?.trim())
    assert.deepEqual(chipsRestored, ['filesystem', 'github', 'memory'])
  } finally { await view.unmount(); delete g.fetch }
})

test('⑧  Hire defaults handles empty server list and updates when registered server set changes', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  let currentServers: string[] = []
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    seen.push({ method, path,
      body: init?.body ? JSON.parse(String(init.body)) : null })
    const payload = path.startsWith('/api/orgs/acme/orgmd')
      ? { content: '# Acme\n' }
      : path.startsWith('/api/orgs/acme/net') ? { hubs: [], identity: null }
        : path === '/api/mcp-servers' ? { servers: currentServers, sandbox_mcp: false }
          : {}
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(payload),
    })
  }

  const { view } = await mountOrg()
  try {
    await open(view.el, 'Hire defaults')
    await inAct(async () => { await flush(20) })

    // Empty list: displays "currently registered: none"
    const currentList = view.el.querySelector('.hire-mcp-current')
    assert.ok(currentList, '.hire-mcp-current found')
    assert.match(currentList.textContent ?? '', /currently registered:\s*none/)
    assert.equal(currentList.querySelectorAll('.chip').length, 0)

    // Server set changes externally and focus event triggers re-fetch
    currentServers = ['fetch', 'sqlite']
    await inAct(async () => {
      window.dispatchEvent(new Event('focus'))
      await flush(20)
    })

    // Updated list is rendered
    const updatedChips = [...view.el.querySelectorAll('.hire-mcp-current .hire-mcp-tags .chip')].map((c) => c.textContent?.trim())
    assert.deepEqual(updatedChips, ['fetch', 'sqlite'])
  } finally { await view.unmount(); delete g.fetch }
})

test('⑨  Hire defaults renders long registered server lists in a scrollable container with chips', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  const manyServers = Array.from({ length: 30 }, (_, i) => `server-${i.toString().padStart(2, '0')}`)
  stubFetch(seen, manyServers)
  const { view } = await mountOrg()
  try {
    await open(view.el, 'Hire defaults')
    await inAct(async () => { await flush(20) })

    const currentList = view.el.querySelector('.hire-mcp-current')
    assert.ok(currentList, '.hire-mcp-current found')
    const chips = [...currentList.querySelectorAll('.hire-mcp-tags .chip')]
    assert.equal(chips.length, 30)
    assert.equal(chips[0]?.textContent?.trim(), 'server-00')
    assert.equal(chips[29]?.textContent?.trim(), 'server-29')
  } finally { await view.unmount(); delete g.fetch }
})

test('⑩  Hire defaults offers canonical primary accounts even when no accounts are registered', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen, ['mcp-a'], [])
  const { view } = await mountOrg()
  try {
    await open(view.el, 'Hire defaults')
    await inAct(async () => { await flush(20) })

    const sel = view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="default provider account for new hires"]')
    assert.ok(sel, 'account selector found')
    assert.equal(sel.value, 'claude/primary')
    const opts = [...sel.querySelectorAll('option')]
    assert.deepEqual(opts.map((o) => o.value), ['claude/primary'])
    assert.equal(opts[0]?.textContent?.trim(), 'default · email unavailable')
    assert.equal(sel.disabled, true)
  } finally { await view.unmount(); delete g.fetch }
})

test('⑪  Hire defaults exposes live account options, updates selection, and persists in save payload', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  const accounts = [
    { id: 'acct-claude-primary', provider: 'claude', label: 'Primary Claude', standing: { state: 'healthy' } },
  ]
  stubFetch(seen, ['mcp-a'], accounts)
  const { view, closed } = await mountOrg()
  try {
    await open(view.el, 'Hire defaults')
    await inAct(async () => { await flush(20) })

    const sel = view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="default provider account for new hires"]')
    assert.ok(sel, 'account selector found')
    assert.equal(sel.value, 'claude/primary')
    const opts = [...sel.querySelectorAll('option')]
    assert.equal(opts.length, 2)
    const accountOption = opts.find((o) => o.value === 'acct-claude-primary')!
    assert.equal(accountOption.textContent, 'acct-claude-primary · email unavailable')

    // select the account
    await setField(sel, 'acct-claude-primary')
    assert.equal(sel.value, 'acct-claude-primary')

    // save settings
    seen.length = 0
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'save')!
    await inAct(async () => { save.click(); await flush(12) })

    const defaultsCall = seen.find((r) => r.method === 'POST' && r.path === '/api/orgs/acme/defaults')
    assert.ok(defaultsCall, 'defaults POST called')
    const defaultsBody = defaultsCall!.body as Record<string, unknown>
    assert.equal(defaultsBody.default_account, 'acct-claude-primary')

    const settingsCall = seen.find((r) => r.method === 'POST' && r.path === '/api/orgs/acme/settings')
    assert.ok(settingsCall, 'settings POST called')
    const settingsBody = settingsCall!.body as Record<string, unknown>
    assert.equal(settingsBody.default_account, 'acct-claude-primary')
    assert.equal(closed.length, 1)
  } finally { await view.unmount(); delete g.fetch }
})

test('⑫  Hire defaults handles multiple accounts across providers with limited standings and respects tree.default_account', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  const accounts = [
    { id: 'acct-claude-1', provider: 'claude', label: 'Work Claude', standing: { state: 'healthy' } },
    { id: 'acct-claude-2', provider: 'claude', label: 'Backup Claude', standing: { state: 'limited' } },
    { id: 'acct-codex-1', provider: 'openai', label: 'Codex Main', standing: { state: 'healthy' } },
  ]
  stubFetch(seen, ['mcp-a'], accounts)
  const { view } = await mountOrg({ default_account: 'acct-claude-2' })
  try {
    await open(view.el, 'Hire defaults')
    await inAct(async () => { await flush(20) })

    const sel = view.el.querySelector<HTMLSelectElement>(
      'select[aria-label="default provider account for new hires"]')
    assert.ok(sel, 'account selector found')
    // Pre-filled with tree.default_account
    assert.equal(sel.value, 'acct-claude-2')

    const opts = [...sel.querySelectorAll('option')]
    assert.equal(opts.length, 3) // primary and two Claude accounts
    assert.match(opts.find((o) => o.value === 'acct-claude-2')?.textContent ?? '',
      /acct-claude-2 · email unavailable \(limited — will wait\)/)
    const provider = view.el.querySelector<HTMLSelectElement>('select[aria-label="Provider for default account"]')!
    await setField(provider, 'openai')
    assert.equal([...sel.options].find(o => o.value === 'acct-codex-1')?.textContent,
      'acct-codex-1 · email unavailable')

    // Select unbound
    await inAct(async () => {
      [...view.el.querySelectorAll<HTMLButtonElement>('button')]
        .find(b => b.textContent === 'Use machine default')!.click()
    })
    assert.equal(sel.value, 'openai/primary')

    seen.length = 0
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'save')!
    await inAct(async () => { save.click(); await flush(12) })

    const defaultsCall = seen.find((r) => r.method === 'POST' && r.path === '/api/orgs/acme/defaults')
    assert.ok(defaultsCall, 'defaults POST called')
    const defaultsBody = defaultsCall!.body as Record<string, unknown>
    assert.equal(defaultsBody.default_account, '')
  } finally { await view.unmount(); delete g.fetch }
})

test('Settings selects and saves each canonical primary name with or without an ambient registry row', async () => {
  for (const provider of ['claude', 'openai', 'google']) {
    const name = `${provider}/primary`
    for (const registered of [false, true]) {
      const seen: { method: string; path: string; body: unknown }[] = []
      stubFetch(seen, [], registered ? [{ id: `${provider}-1`, provider,
        label: 'Historical label', name, ambient: true, standing: { state: 'ready' } }] : [])
      const { view, closed } = await mountOrg({ default_account: name })
      try {
        await open(view.el, 'Hire defaults')
        await inAct(async () => { await flush(10) })
        const sel = view.el.querySelector<HTMLSelectElement>(
          'select[aria-label="default provider account for new hires"]')!
        const options = [...sel.options].filter((o) => o.value === name)
        assert.equal(options.length, 1, `${name} is shown exactly once`)
        assert.equal(options[0].textContent, 'default · email unavailable')
        assert.equal(sel.value, name, 'the stored primary default remains selected')
        assert.equal(sel.disabled, true)
        const providerSelect = view.el.querySelector<HTMLSelectElement>('select[aria-label="Provider for default account"]')!
        await setField(providerSelect, provider === 'claude' ? 'openai' : 'claude')
        await setField(providerSelect, provider)
        seen.length = 0
        const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent?.trim() === 'save')!
        await inAct(async () => { save.click(); await flush(12) })
        for (const endpoint of ['defaults', 'settings']) {
          const request = seen.find((r) => r.method === 'POST' && r.path === `/api/orgs/acme/${endpoint}`)
          assert.ok(request)
          assert.equal((request.body as Record<string, unknown>).default_account, name)
        }
        assert.equal(closed.length, 1)
      } finally { await view.unmount(); delete g.fetch }
    }
  }
})


