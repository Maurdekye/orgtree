// THE OPENROUTER HARNESS IS EACH KEY'S OWN (user 2026-10-13: "configurable
// which harness to use per openrouter key"; "only the installed harnesses are
// available to select from"). The Runtime tab's global row is gone; each key's
// settings dialog carries a Harness select next to its Name.
//
//   · every supported harness is listed (user 2026-10-13 22:20Z): the
//     installed ones first, a separator, then the ones not installed,
//     greyed out and disabled (never selectable);
//   · a key whose saved harness is no longer installed names it "not
//     installed", warns that its agents refuse to start, and sends nothing
//     until another is picked (never a silent switch);
//   · a change says its agents move at their next turn (fresh session), and
//     agents hired with a chosen harness are counted as keeping theirs;
//   · every harness selector links to App settings › Harnesses.
//
// ⚠ THE RENDERER DECIDES NONE OF THIS: installed or not is the backend's
// answer (`harness.harnesses[].available`, `keys[].harness_installed`).

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenRouterSection } from '../src/canvas/openrouter'
import { HARNESS_SEPARATOR, HarnessesLink, HarnessesSection } from '../src/canvas/harnesses'
import { OPEN_APP_SETTINGS_EVENT } from '../src/canvas/settingskit'
import type { OpenRouterDoc, OpenRouterHarness, OpenRouterKey, ProviderInfo } from '../src/types'

type Seen = { method: string; path: string; body: unknown }
const g = globalThis as unknown as Record<string, unknown>

const CLAUDE = { id: 'claude-code', label: 'Claude Code', state: 'available', available: true, installed: true, why: 'installed' }
const CODEX = { id: 'codex-cli', label: 'Codex', state: 'available', available: true, installed: true, why: 'installed' }
const CODEX_GONE = { ...CODEX, state: 'missing', available: false, installed: false, why: 'Codex is not installed on this computer' }

const BOTH: OpenRouterHarness = { harnesses: [CLAUDE, CODEX], stored: 'claude-code', default: 'claude-code',
  enabled: true, unavailable: false, selected: 'claude-code', explain: '' }
const CLAUDE_GONE = { ...CLAUDE, state: 'missing', available: false, installed: false, why: 'Claude Code is not installed on this computer' }
const ONLY_CODEX: OpenRouterHarness = { harnesses: [CLAUDE_GONE, CODEX], stored: 'codex-cli', default: 'codex-cli',
  enabled: false, unavailable: false, selected: 'codex-cli', explain: 'Only Codex is installed, so it drives OpenRouter agents.' }
const ONLY_CLAUDE: OpenRouterHarness = { harnesses: [CLAUDE, CODEX_GONE], stored: 'claude-code', default: 'claude-code',
  enabled: false, unavailable: false, selected: 'claude-code', explain: 'Only Claude Code is installed, so it drives OpenRouter agents.' }

function key(id: string, over: Partial<OpenRouterKey> = {}): OpenRouterKey {
  const original = id === 'openrouter-key'
  return {
    id, lane: original ? 'openrouter' : id, original, label: original ? null : 'team',
    name: original ? 'personal' : 'team', key_label: null, enabled: true, connected: true, reason: null,
    observed_at: '2026-10-13T19:00:00Z', limits: [], harness: 'claude-code', harness_installed: true, pinned_seats: 0,
    ...over,
  }
}

function stubFetch(seen: Seen[], harness: OpenRouterHarness | undefined, initial: OpenRouterKey[]) {
  let keys = initial
  const doc = (): OpenRouterDoc => ({
    installed: true, connected: true, key_set: true, kind: 'api-key', label: 'personal',
    credits: { limit: null, limit_remaining: null, usage: 0, usage_daily: null, usage_weekly: null,
      usage_monthly: null, is_free_tier: false, checked_at: '2026-10-13T19:00:00Z' },
    reason: null, favorites: 0, favorites_max: 0, tiers: [], user_enabled: true,
    ...(harness ? { harness } : {}), keys, any_key: true,
  })
  g.fetch = (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    seen.push({ method, path: u.pathname, body })
    let payload: unknown = null
    if (u.pathname === '/api/openrouter' && method === 'GET') payload = doc()
    else if (u.pathname === '/api/openrouter/keys' && method === 'POST') {
      const b = body as { harness?: string }
      keys = [...keys, key('openrouter-3', { name: 'OpenRouter key 3', label: null, harness: b.harness ?? harness?.stored })]
      payload = { ...doc(), added: 'openrouter-3', added_lane: 'openrouter-3' }
    } else if (u.pathname.startsWith('/api/openrouter/keys/') && method === 'PUT') {
      const id = decodeURIComponent(u.pathname.split('/')[4]!)
      const b = body as { harness?: string }
      keys = keys.map((k) => (k.id === id && b.harness ? { ...k, harness: b.harness, harness_installed: true } : k))
      payload = doc()
    } else if (u.pathname === '/api/harnesses') {
      payload = { harnesses: [
        { id: 'claude-code', name: 'Claude Code', what: "Anthropic's coding agent CLI.", installed: true, selectable: true,
          providers: [{ id: 'claude', label: 'Claude' }, { id: 'openrouter', label: 'OpenRouter' }],
          install_url: 'https://code.claude.com/docs/en/setup', install: 'Install Claude Code.' },
        { id: 'opencode', name: 'opencode', what: 'A registry entry this file never names.', installed: false, selectable: true,
          providers: [{ id: 'openrouter', label: 'OpenRouter' }], install_url: null, install: 'Install opencode.' },
      ] }
    }
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${u.pathname}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload) })
  }
}

const PROVIDER: ProviderInfo = {
  id: 'openrouter', label: 'OpenRouter', cli: 'REST API', tiers: [],
  status: { installed: true, connected: true, key_set: true }, hire_enabled: true, user_enabled: true, reason: null,
}

async function mount() {
  const picker = { open: false }
  const view = await mountView(<OpenRouterSection provider={PROVIDER} toast={() => {}}
    pickerOpen={picker.open} setPickerOpen={(o) => { picker.open = o }} />, (el) => el)
  await inAct(async () => { await flush(10) })
  return view
}

const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
const harnessSelect = (root: ParentNode) => root.querySelector<HTMLSelectElement>('select[aria-label="OpenRouter key harness"]')
const optionValues = (sel: HTMLSelectElement) => [...sel.querySelectorAll('option')].map((o) => o.value)
const SEP = HARNESS_SEPARATOR
const opt = (sel: HTMLSelectElement, v: string) => [...sel.querySelectorAll('option')].find((o) => o.value === v)!

async function choose(sel: HTMLSelectElement, value: string) {
  const w = (globalThis as unknown as { window: Window }).window as unknown as {
    HTMLSelectElement: typeof HTMLSelectElement; Event: typeof Event }
  const setter = Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')?.set!
  await inAct(async () => { setter.call(sel, value); sel.dispatchEvent(new w.Event('change', { bubbles: true })); await flush(4) })
}
function type(input: HTMLInputElement, value: string) {
  const w = (globalThis as unknown as { window: Window }).window as unknown as {
    HTMLInputElement: typeof HTMLInputElement; Event: typeof Event }
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new w.Event('input', { bubbles: true }))
}

test('§1 adding a key: both harnesses installed, the default is preselected and a pick is POSTed', async () => {
  const seen: Seen[] = []
  stubFetch(seen, BOTH, [key('openrouter-key')])
  const view = await mount()
  try {
    assert.equal(view.el.querySelector('select'), null, 'no harness control on the card itself')
    assert.match(view.el.textContent ?? '', /runs on Claude Code/, 'one harness across the keys: the head names it')
    await inAct(async () => { button(view.el, 'Add another OpenRouter key').click(); await flush(4) })
    const dialog = document.querySelector('[aria-label="Add another OpenRouter key"]')!
    const sel = harnessSelect(dialog)!
    assert.ok(sel, 'the harness is chosen in the key dialog')
    assert.deepEqual(optionValues(sel), ['claude-code', 'codex-cli'])
    assert.equal(sel.value, 'claude-code', 'a new key starts on the original key\'s harness')
    assert.ok(button(dialog, 'Which harnesses are supported?'), 'the selector links to the harness list')
    await choose(sel, 'codex-cli')
    await inAct(async () => {
      type(dialog.querySelector<HTMLInputElement>('input[aria-label="OpenRouter API key"]')!, 'sk-or-v1-third-000')
      await flush(2)
    })
    await inAct(async () => { button(dialog, 'Save').click(); await flush(10) })
    assert.deepEqual(seen.find((r) => r.method === 'POST')?.body, { key: 'sk-or-v1-third-000', harness: 'codex-cli' })
    assert.match(view.el.textContent ?? '', /each key on its own harness/, 'keys on two harnesses: the head says so')
  } finally { await view.unmount(); delete g.fetch }
})

test('§2 editing a key: a change says when its agents move, counts pinned agents, and PUTs only the change', async () => {
  const seen: Seen[] = []
  stubFetch(seen, BOTH, [key('openrouter-key'), key('openrouter-2', { pinned_seats: 2 })])
  const view = await mount()
  try {
    const edit = view.el.querySelectorAll<HTMLButtonElement>('.acct-row.orr-keyrow')[1]!
      .querySelector<HTMLButtonElement>('button[title^="rename this key"]')!
    await inAct(async () => { edit.click(); await flush(4) })
    const dialog = document.querySelector('[aria-label="Edit team"]')!
    const sel = harnessSelect(dialog)!
    assert.equal(sel.value, 'claude-code')
    assert.match(dialog.textContent ?? '', /2 agents were hired with a chosen harness and keep theirs/)
    await choose(sel, 'codex-cli')
    assert.match(dialog.textContent ?? '', /move to Codex at their next turn, on a fresh session/)
    await inAct(async () => { button(dialog, 'Save').click(); await flush(10) })
    assert.deepEqual(seen.filter((r) => r.method === 'PUT').at(-1)?.body, { label: 'team', harness: 'codex-cli' })
    assert.match(view.el.textContent ?? '', /team \(openrouter-2\)[^]*Codex/, 'the key row names its harness')
  } finally { await view.unmount(); delete g.fetch }
})

test('§3 only Claude Code installed: Codex is listed after a separator, greyed out and disabled', async () => {
  const seen: Seen[] = []
  stubFetch(seen, ONLY_CLAUDE, [key('openrouter-key')])
  const view = await mount()
  try {
    await inAct(async () => { button(view.el, 'Add another OpenRouter key').click(); await flush(4) })
    const dialog = document.querySelector('[aria-label="Add another OpenRouter key"]')!
    const sel = harnessSelect(dialog)!
    assert.deepEqual(optionValues(sel), ['claude-code', SEP, 'codex-cli'], 'installed first, a separator, then the rest')
    assert.equal(opt(sel, 'claude-code').disabled, false)
    assert.equal(opt(sel, SEP).disabled, true, 'the separator is never a choice')
    assert.match(opt(sel, SEP).textContent ?? '', /^─+$/)
    assert.equal(opt(sel, 'codex-cli').disabled, true, 'a harness not installed cannot be selected')
    assert.equal(opt(sel, 'codex-cli').textContent, 'Codex (not installed)')
    assert.ok(opt(sel, 'codex-cli').classList.contains('harness-absent'), 'greyed out')
    assert.equal(sel.value, 'claude-code')
    assert.equal(sel.disabled, false, 'the list stays open to read')
    assert.match(dialog.textContent ?? '', /Only Claude Code is installed/)
    await inAct(async () => { button(dialog, 'Save').click(); await flush(10) })
  } finally { await view.unmount(); delete g.fetch }
})

test('§3b order follows install state, not the registry: Codex installed comes before Claude Code', async () => {
  const seen: Seen[] = []
  stubFetch(seen, ONLY_CODEX, [key('openrouter-key', { harness: 'codex-cli' })])
  const view = await mount()
  try {
    await inAct(async () => { button(view.el, 'Add another OpenRouter key').click(); await flush(4) })
    const dialog = document.querySelector('[aria-label="Add another OpenRouter key"]')!
    const sel = harnessSelect(dialog)!
    assert.deepEqual(optionValues(sel), ['codex-cli', SEP, 'claude-code'])
    assert.equal(opt(sel, 'claude-code').disabled, true)
    assert.equal(opt(sel, 'claude-code').textContent, 'Claude Code (not installed)')
  } finally { await view.unmount(); delete g.fetch }
})

test('§3c both installed: no separator and nothing disabled', async () => {
  const seen: Seen[] = []
  stubFetch(seen, BOTH, [key('openrouter-key')])
  const view = await mount()
  try {
    await inAct(async () => { button(view.el, 'Add another OpenRouter key').click(); await flush(4) })
    const sel = harnessSelect(document.querySelector('[aria-label="Add another OpenRouter key"]')!)!
    assert.deepEqual(optionValues(sel), ['claude-code', 'codex-cli'])
    assert.ok([...sel.querySelectorAll('option')].every((o) => !o.disabled))
  } finally { await view.unmount(); delete g.fetch }
})

test('§4 a saved harness since uninstalled is named, warned about, and never sent', async () => {
  const seen: Seen[] = []
  stubFetch(seen, ONLY_CLAUDE, [key('openrouter-key'), key('openrouter-2', { harness: 'codex-cli', harness_installed: false })])
  const view = await mount()
  try {
    assert.match(view.el.textContent ?? '', /Codex \(not installed\)/, 'the key row says so')
    const edit = view.el.querySelectorAll<HTMLButtonElement>('.acct-row.orr-keyrow')[1]!
      .querySelector<HTMLButtonElement>('button[title^="rename this key"]')!
    await inAct(async () => { edit.click(); await flush(4) })
    const dialog = document.querySelector('[aria-label="Edit team"]')!
    const sel = harnessSelect(dialog)!
    assert.equal(sel.value, 'codex-cli', 'the saved choice is shown, not silently replaced')
    const codex = [...sel.querySelectorAll('option')].find((o) => o.value === 'codex-cli')!
    assert.equal(codex.disabled, true)
    assert.match(codex.textContent ?? '', /not installed/)
    assert.deepEqual(optionValues(sel), ['claude-code', SEP, 'codex-cli'], 'the saved one sits in the not-installed group')
    assert.match(dialog.textContent ?? '', /refuse to start until it is installed or another harness is chosen/)
    assert.equal(sel.disabled, false, 'an installed one can be picked instead')
    await inAct(async () => { button(dialog, 'Save').click(); await flush(10) })
    assert.deepEqual(seen.filter((r) => r.method === 'PUT').at(-1)?.body, { label: 'team' }, 'the uninstalled harness is not sent')
  } finally { await view.unmount(); delete g.fetch }
})

test('§5 an older backend with no harness block: no harness row and no head clause', async () => {
  const seen: Seen[] = []
  stubFetch(seen, undefined, [key('openrouter-key', { harness: undefined, harness_installed: undefined })])
  const view = await mount()
  try {
    assert.doesNotMatch(view.el.textContent ?? '', /runs on/)
    await inAct(async () => { button(view.el, 'Add another OpenRouter key').click(); await flush(4) })
    assert.equal(harnessSelect(document.querySelector('[aria-label="Add another OpenRouter key"]')!), null)
  } finally { await view.unmount(); delete g.fetch }
})

test('§6 App settings › Harnesses lists the registry, installed or not, and the link opens it', async () => {
  const seen: Seen[] = []
  stubFetch(seen, BOTH, [])
  const view = await mountView(<><HarnessesSection active /><HarnessesLink /></>, (el) => el)
  try {
    await inAct(async () => { await flush(10) })
    const text = (view.el.textContent ?? '').replace(/\s+/g, ' ')
    assert.match(text, /Claude Code · installed/)
    assert.match(text, /opencode · not installed/, 'a registry entry appears with nothing named in the renderer')
    assert.match(text, /Runs agents on: Claude, OpenRouter/)
    assert.match(text, /Install: Install Claude Code\. https:\/\/code\.claude\.com/)
    const opened: string[] = []
    const w = (globalThis as unknown as { window: Window }).window
    const on = (e: Event) => opened.push((e as CustomEvent<{ tab: string }>).detail.tab)
    w.addEventListener(OPEN_APP_SETTINGS_EVENT, on)
    await inAct(async () => { button(view.el, 'Which harnesses are supported?').click(); await flush(2) })
    w.removeEventListener(OPEN_APP_SETTINGS_EVENT, on)
    assert.deepEqual(opened, ['harnesses'])
  } finally { await view.unmount(); delete g.fetch }
})
