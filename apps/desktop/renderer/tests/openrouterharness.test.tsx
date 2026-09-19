// THE OPENROUTER HARNESS ROW — which CLI drives OpenRouter agents.
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
import { HarnessRow, OpenRouterSection } from '../src/canvas/openrouter'
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
    <HarnessRow h={h} busy={false} onPick={onPick} />, (el) => el)
  await inAct(async () => { await flush(2) })
  return view
}

const radios = (view: { el: HTMLElement }): HTMLInputElement[] =>
  [...view.el.querySelectorAll('input[type=radio]')] as HTMLInputElement[]

test('§1 both available: the control is a live choice and Claude Code is '
  + 'selected by default', async () => {
  const view = await mountRow(BOTH)
  const rs = radios(view)
  assert.equal(rs.length, 2, 'both harnesses are offered')
  assert.ok(rs.every((r) => !r.disabled), 'the control is enabled')
  const on = rs.filter((r) => r.checked)
  assert.equal(on.length, 1)
  assert.equal(on[0].value, 'claude-code', 'Claude Code is the default')
  assert.match(view.el.textContent ?? '', /new agents only/,
    'the row says the choice applies to new hires, not to anyone running')
})

test('§1b both available: picking Codex reports that exact choice upward',
  async () => {
    const picked: string[] = []
    const view = await mountRow(BOTH, (id) => picked.push(id))
    const codex = radios(view).find((r) => r.value === 'codex-cli')!
    await inAct(async () => { codex.click() })
    assert.deepEqual(picked, ['codex-cli'])
  })

test('§2 exactly one available (Codex missing): Claude Code is shown selected '
  + 'and the control is greyed out, with the reason', async () => {
  const view = await mountRow(ONLY_CLAUDE)
  const rs = radios(view)
  assert.ok(rs.every((r) => r.disabled), 'no meaningless choice is offered')
  assert.equal(rs.find((r) => r.checked)?.value, 'claude-code')
  const text = view.el.textContent ?? ''
  assert.match(text, /only harness available/)
  assert.ok(text.includes(CODEX_GONE.why),
    'a greyed control must say WHY the other option is not there')
})

test('§2b exactly one available (Claude missing): CODEX is shown selected — '
  + 'the singular-harness rule outranks the default', async () => {
  const view = await mountRow(ONLY_CODEX)
  const rs = radios(view)
  assert.ok(rs.every((r) => r.disabled))
  assert.equal(rs.find((r) => r.checked)?.value, 'codex-cli',
    'showing the unusable default selected would be a lie about the machine')
  assert.ok((view.el.textContent ?? '').includes(CLAUDE_GONE.why))
})

test('§2c a disabled option cannot be picked', async () => {
  const picked: string[] = []
  const view = await mountRow(ONLY_CLAUDE, (id) => picked.push(id))
  const codex = radios(view).find((r) => r.value === 'codex-cli')!
  assert.equal(codex.disabled, true)
  await inAct(async () => { codex.click() })
  assert.deepEqual(picked, [], 'an unavailable harness must not be selectable')
})

test('§3 neither available: NO choice is offered, and both reasons are shown',
  async () => {
    const view = await mountRow(NEITHER)
    assert.equal(radios(view).length, 0,
      'every option here would be a false choice')
    const text = view.el.textContent ?? ''
    assert.match(text, /no OpenRouter harness available/)
    assert.ok(text.includes(CLAUDE_GONE.why))
    assert.ok(text.includes(CODEX_GONE.why))
  })

test('§4 a stored choice that is not currently available: the row shows what '
  + 'the machine CAN do and warns that agents set to the other one refuse',
  async () => {
    // the stored preference is Codex; only Claude Code works right now
    const stale: OpenRouterHarness = { ...ONLY_CLAUDE, stored: 'codex-cli' }
    const view = await mountRow(stale)
    assert.equal(radios(view).find((r) => r.checked)?.value, 'claude-code',
      'the row reflects reality')
    const text = view.el.textContent ?? ''
    assert.match(text, /your saved choice is Codex CLI/)
    assert.match(text, /refuse rather than switch/,
      'the user must be told the launch refuses — it does NOT fall back')
  })

// ── the row inside the real section, over a scripted backend ─────────────

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

test('§5 in the real section: choosing Codex PUTs that harness, and the head '
  + 'stops claiming the lane runs on Claude Code', async () => {
  const seen: { method: string; path: string; body: unknown }[] = []
  stubFetch(seen, BOTH)
  const picker = { open: false }
  const view = await mountView(
    <OpenRouterSection provider={PROVIDER} toast={() => {}}
      pickerOpen={picker.open}
      setPickerOpen={(o) => { picker.open = o }} />, (el) => el)
  await inAct(async () => { await flush(10) })

  assert.match(view.el.textContent ?? '', /runs on Claude Code/,
    'the head names the harness actually in use')

  const codex = [...view.el.querySelectorAll('input[type=radio]')]
    .find((r) => (r as HTMLInputElement).value === 'codex-cli') as HTMLInputElement
  await inAct(async () => { codex.click(); await flush(10) })

  const put = seen.find((s) => s.path === '/api/openrouter/harness')
  assert.ok(put, 'the choice reached the backend')
  assert.equal(put!.method, 'PUT')
  assert.deepEqual(put!.body, { harness: 'codex-cli' })
  assert.match(view.el.textContent ?? '', /runs on Codex CLI/,
    'the head follows the new harness')
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
    <OpenRouterSection provider={PROVIDER} toast={() => {}}
      pickerOpen={picker.open}
      setPickerOpen={(o) => { picker.open = o }} />, (el) => el)
  await inAct(async () => { await flush(10) })
  assert.equal(view.el.querySelectorAll('.orr-harness').length, 0)
  assert.doesNotMatch(view.el.textContent ?? '', /runs on/)
})
