// THE OPENROUTER HARNESS ROW — which CLI drives OpenRouter agents. Since
// 2026-09-30 it is an ordinary App settings > Runtime row (label, <select>,
// hint), and the Providers > OpenRouter card no longer carries it.
//
// The row has three shapes and they look similar on screen while meaning very
// different things, which is exactly why each one is pinned here:
//
//   · both CLIs usable  → a live choice, Claude Code selected by default;
//   · exactly one usable → that one shown SELECTED and the control DISABLED,
//     with the reason the other is out (a greyed control with no reason is
//     the state people file bugs about);
//   · neither usable     → no choice offered at all, both reasons shown.
//
// ⚠ THE RENDERER DECIDES NONE OF THIS. The backend serves the whole decision
// (`openrouter_harness.selector`) and these tests drive the component with
// that payload, so a rule can never be half-implemented in two places. A test
// that recomputed the rule here would agree with a broken renderer.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HarnessChoice, OpenRouterHarnessSetting, OpenRouterSection } from '../src/canvas/openrouter'
import type { OpenRouterDoc, OpenRouterHarness, ProviderInfo } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>

const CLAUDE_OK = {
  id: 'claude-code', label: 'Claude Code', state: 'available',
  available: true, why: 'installed and ready', version: '2.1.241',
}
const CODEX_OK = {
  id: 'codex-cli', label: 'Codex CLI', state: 'available',
  available: true, why: 'installed and ready', version: '0.154.0',
}
const CODEX_GONE = {
  id: 'codex-cli', label: 'Codex CLI', state: 'missing', available: false,
  why: 'the Codex CLI was not found on this machine',
}
const CLAUDE_GONE = {
  id: 'claude-code', label: 'Claude Code', state: 'missing', available: false,
  why: 'the Claude Code CLI was not found on this machine',
}

const BOTH: OpenRouterHarness = {
  harnesses: [CLAUDE_OK, CODEX_OK], stored: 'claude-code',
  default: 'claude-code', enabled: true, unavailable: false,
  selected: 'claude-code', explain: '',
}
const ONLY_CLAUDE: OpenRouterHarness = {
  harnesses: [CLAUDE_OK, CODEX_GONE], stored: 'claude-code',
  default: 'claude-code', enabled: false, unavailable: false,
  selected: 'claude-code',
  explain: `Claude Code is the only harness available on this machine — `
    + `Codex CLI is not (${CODEX_GONE.why})`,
}
const ONLY_CODEX: OpenRouterHarness = {
  harnesses: [CLAUDE_GONE, CODEX_OK], stored: 'claude-code',
  default: 'claude-code', enabled: false, unavailable: false,
  selected: 'codex-cli',
  explain: `Codex CLI is the only harness available on this machine — `
    + `Claude Code is not (${CLAUDE_GONE.why})`,
}
const NEITHER: OpenRouterHarness = {
  harnesses: [CLAUDE_GONE, CODEX_GONE], stored: 'claude-code',
  default: 'claude-code', enabled: false, unavailable: true,
  selected: null,
  explain: 'no OpenRouter harness is available on this machine. '
    + `Claude Code: ${CLAUDE_GONE.why}; Codex CLI: ${CODEX_GONE.why}`,
}

async function mountRow(h: OpenRouterHarness, onPick: (id: string) => void = () => {}) {
  const view = await mountView(
    <HarnessChoice h={h} busy={false} onPick={onPick} />, (el) => el)
  await inAct(async () => { await flush(2) })
  return view
}

const selectOf = (el: Element): HTMLSelectElement | null => el.querySelector('select')
const options = (el: Element): HTMLOptionElement[] =>
  [...el.querySelectorAll('option')] as HTMLOptionElement[]
async function choose(sel: HTMLSelectElement, value: string) {
  const w = (globalThis as unknown as { window: Window }).window as unknown as {
    HTMLSelectElement: typeof HTMLSelectElement
    Event: typeof Event
  }
  const setter = Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')?.set
  assert.ok(setter, 'no value setter on HTMLSelectElement')
  await inAct(async () => {
    setter.call(sel, value)
    sel.dispatchEvent(new w.Event('change', { bubbles: true }))
    await flush(10)
  })
}

test('§0 it is a Runtime-style setting row: label, select, dim hint', async () => {
  const view = await mountRow(BOTH)
  const row = view.el.querySelector('.set-row')
  assert.ok(row, 'rendered as the shared SetRow')
  assert.equal(row!.querySelector('.set-label')?.textContent, 'OpenRouter harness')
  assert.ok(row!.querySelector('.set-control select'), 'the control is a select')
  assert.ok(row!.querySelector('.set-hint'), 'the help line is the dim hint')
  assert.equal(view.el.querySelectorAll('input[type=radio]').length, 0,
    'the old pill radios are gone')
})

test('§1 both available: the control is a live choice and Claude Code is '
  + 'selected by default', async () => {
  const view = await mountRow(BOTH)
  const sel = selectOf(view.el)!
  assert.equal(options(view.el).length, 2, 'both harnesses are offered')
  assert.equal(sel.disabled, false, 'the control is enabled')
  assert.ok(options(view.el).every((o) => !o.disabled))
  assert.equal(sel.value, 'claude-code', 'Claude Code is the default')
  assert.match(view.el.textContent ?? '', /New agents only/,
    'the row says the choice applies to new hires, not to anyone running')
})

test('§1b both available: picking Codex reports that exact choice upward',
  async () => {
    const picked: string[] = []
    const view = await mountRow(BOTH, (id) => picked.push(id))
    await choose(selectOf(view.el)!, 'codex-cli')
    assert.deepEqual(picked, ['codex-cli'])
  })

test('§2 exactly one available (Codex missing): Claude Code is shown selected '
  + 'and the control is greyed out, with the reason', async () => {
  const view = await mountRow(ONLY_CLAUDE)
  const sel = selectOf(view.el)!
  assert.equal(sel.disabled, true, 'no meaningless choice is offered')
  assert.equal(sel.value, 'claude-code')
  const text = view.el.textContent ?? ''
  assert.match(text, /only harness available/)
  assert.ok(text.includes(CODEX_GONE.why),
    'a greyed control must say WHY the other option is not there')
})

test('§2b exactly one available (Claude missing): CODEX is shown selected — '
  + 'the singular-harness rule outranks the default', async () => {
  const view = await mountRow(ONLY_CODEX)
  const sel = selectOf(view.el)!
  assert.equal(sel.disabled, true)
  assert.equal(sel.value, 'codex-cli',
    'showing the unusable default selected would be a lie about the machine')
  assert.ok((view.el.textContent ?? '').includes(CLAUDE_GONE.why))
})

test('§2c an unavailable option cannot be picked', async () => {
  const view = await mountRow(ONLY_CLAUDE)
  const codex = options(view.el).find((o) => o.value === 'codex-cli')!
  assert.equal(codex.disabled, true, 'an unavailable harness must not be selectable')
  assert.match(codex.textContent ?? '', /not available/)
})

test('§3 neither available: NO choice is offered, and both reasons are shown',
  async () => {
    const view = await mountRow(NEITHER)
    assert.equal(selectOf(view.el), null, 'every option here would be a false choice')
    const text = view.el.textContent ?? ''
    assert.match(text, /none available/)
    assert.ok(text.includes(CLAUDE_GONE.why))
    assert.ok(text.includes(CODEX_GONE.why))
  })

test('§4 a stored choice that is not currently available: the row shows what '
  + 'the machine CAN do and warns that agents set to the other one refuse',
  async () => {
    // the stored preference is Codex; only Claude Code works right now
    const stale: OpenRouterHarness = { ...ONLY_CLAUDE, stored: 'codex-cli' }
    const view = await mountRow(stale)
    assert.equal(selectOf(view.el)!.value, 'claude-code', 'the row reflects reality')
    const text = (view.el.textContent ?? '').replace(/\s+/g, ' ')
    assert.match(text, /Your saved choice is Codex CLI/)
    assert.match(text, /refuse rather than switch/,
      'the user must be told the launch refuses — it does NOT fall back')
  })

// ── the row and the card together, over a scripted backend ───────────────

function stubFetch(seen: { method: string; path: string; body: unknown }[],
  harness: OpenRouterHarness) {
  let current = harness
  const doc = (): OpenRouterDoc => ({
    installed: true, connected: true, key_set: true, kind: 'api-key',
    label: 'sk-or-v1-abc…xyz',
    credits: { limit: null, limit_remaining: null, usage: 0, usage_daily: 0,
      usage_weekly: 0, usage_monthly: 0, is_free_tier: false,
      checked_at: '2026-09-19T14:00:00Z' },
    reason: null, favorites: 0, favorites_max: 0, tiers: [],
    user_enabled: true, harness: current,
  })
  g.fetch = (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    seen.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/openrouter/harness' && method === 'PUT') {
      const want = (body as { harness: string }).harness
      current = { ...current, stored: want, selected: want }
    }
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(doc()),
    })
  }
}

const PROVIDER: ProviderInfo = {
  id: 'openrouter', label: 'OpenRouter', cli: 'REST API',
  tiers: [], status: { installed: true, connected: true, key_set: true },
  hire_enabled: true, user_enabled: true, reason: null,
}

test('§5 the Runtime row PUTs the chosen harness; the Providers card no longer '
  + 'carries the choice, and its head follows the new harness', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen, BOTH)
  const picker = { open: false }
  const view = await mountView(
    <>
      <div className="providers">
        <OpenRouterSection provider={PROVIDER} toast={() => {}}
          pickerOpen={picker.open}
          setPickerOpen={(o) => { picker.open = o }} />
      </div>
      <div className="runtime"><OpenRouterHarnessSetting toast={() => {}} /></div>
    </>, (el) => el)
  await inAct(async () => { await flush(10) })

  const card = view.el.querySelector('.providers')!
  const runtime = view.el.querySelector('.runtime')!
  assert.equal(card.querySelectorAll('select, input[type=radio]').length, 0,
    'no harness control left in the OpenRouter card')
  assert.doesNotMatch(card.textContent ?? '', /new agents only/i)
  assert.match(card.textContent ?? '', /runs on Claude Code/,
    'the head names the harness actually in use')

  await choose(selectOf(runtime)!, 'codex-cli')

  const put = seen.find((s) => s.path === '/api/openrouter/harness')
  assert.ok(put, 'the choice reached the backend')
  assert.equal(put!.method, 'PUT')
  assert.deepEqual(put!.body, { harness: 'codex-cli' })
  assert.equal(selectOf(runtime)!.value, 'codex-cli')
  assert.match(card.textContent ?? '', /runs on Codex CLI/,
    'the card head follows a harness picked in Runtime')
})

test('§6 an older backend that serves no harness block renders no row at all '
  + '(and does not crash)', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  const noHarness = { ...BOTH }
  stubFetch(seen, noHarness)
  const prev = g.fetch as (url: string, init?: RequestInit) => Promise<unknown>
  g.fetch = (url: string, init?: RequestInit) =>
    prev(url, init).then((r) => {
      const res = r as { json: () => Promise<OpenRouterDoc> }
      return {
        ...res,
        json: () => res.json().then((d) => {
          const { harness: _drop, ...rest } = d
          return rest as OpenRouterDoc
        }),
      }
    })
  const picker = { open: false }
  const view = await mountView(
    <>
      <OpenRouterSection provider={PROVIDER} toast={() => {}}
        pickerOpen={picker.open}
        setPickerOpen={(o) => { picker.open = o }} />
      <OpenRouterHarnessSetting toast={() => {}} />
    </>, (el) => el)
  await inAct(async () => { await flush(10) })
  assert.equal(view.el.querySelectorAll('select').length, 0)
  assert.doesNotMatch(view.el.textContent ?? '', /runs on|OpenRouter harness/)
})
