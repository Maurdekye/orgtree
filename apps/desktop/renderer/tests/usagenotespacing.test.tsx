// usagenotespacing.test.tsx — regression coverage for tightened Usage limit-note spacing:
// stacked inferred limit notes (e.g. Fable + pooled limits) read as one compact group
// without excessive vertical gaps, while preserving surrounding section and row spacing.
//
// Run: node apps/desktop/renderer/tests/run.mjs usagenotespacing

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { UsageModal } from '../src/App'
import { StandingMarks } from '../src/accountusage'
import type { AccountRegistryPayload, RegisteredAccountUsage, UsagePayload } from '../src/types'

declare const __SRC_DIR__: string

const HOST_CLAUDE: UsagePayload = {
  available: true, plan: 'max', email: 'primary@example.test',
  limits: [{ kind: 'session', group: 'session', percent: 20,
    severity: 'normal', resets_at: null, is_active: false, model: null }],
}

const REGISTRY: AccountRegistryPayload = {
  primary: 'claude-1',
  accounts: [
    { id: 'claude-1', provider: 'claude', harness: 'claude-code',
      label: 'claude (primary)', identity: { email: 'primary@example.test' },
      auth: 'authenticated', ambient: true,
      standing: { auth: 'authenticated', state: 'ready', marks: {} }, bound: [] },
    { id: 'claude-4', provider: 'claude', harness: 'claude-code',
      label: 'claude-0', identity: { email: 'second@example.test' },
      auth: 'authenticated', ambient: false,
      standing: { auth: 'authenticated', state: 'ready', marks: {} }, bound: [] },
  ],
}

const MULTI_MARK_USAGE: RegisteredAccountUsage = {
  account: 'claude-4', provider: 'claude', label: 'claude-0', available: true,
  plan: 'Max', limits: [
    { kind: 'session', group: 'session', percent: 45, severity: 'normal',
      resets_at: null, is_active: false, model: null },
    { kind: 'weekly_all', group: 'weekly', percent: 80, severity: 'warn',
      resets_at: null, is_active: false, model: null },
  ],
  standing: {
    auth: 'authenticated',
    state: 'limited',
    marks: {
      fable: { until: 1789216200, provenance: 'inferred' },
      pooled: { until: 1789216200, provenance: 'inferred' },
    },
  },
}

const PROVIDERS = { providers: [
  { id: 'claude', hire_enabled: true, status: { installed: true } },
] }

function mockFetch(routes: Record<string, unknown>) {
  return (url: string) => {
    const p = new URL(String(url), 'http://localhost').pathname
    if (!(p in routes)) return Promise.reject(new Error(`unexpected fetch: ${p}`))
    const body = routes[p]
    if (body instanceof Error) return Promise.reject(body)
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }
}

test('styles.css: compact spacing rules for stacked standing limit notes', () => {
  const css = fs.readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

  // 1. .standing-marks defines a compact flex column with a tight 2px gap
  const marksRule = /\.standing-marks\s*\{([^}]*)\}/.exec(css)
  assert.ok(marksRule, 'the .standing-marks rule exists in styles.css')
  assert.match(marksRule![1]!, /display:\s*flex;/, '.standing-marks is a flex container')
  assert.match(marksRule![1]!, /flex-direction:\s*column;/, '.standing-marks stacks vertically')
  assert.match(marksRule![1]!, /gap:\s*2px;/, '.standing-marks uses a compact 2px gap between notes')

  // 2. Individual note paragraphs clear default margins and maintain readable line-height
  const pRule = /\.standing-marks\s+\.standing-mark,\s*\.standing-marks\s+p\s*\{([^}]*)\}/.exec(css)
  assert.ok(pRule, 'the .standing-marks paragraph rule exists in styles.css')
  assert.match(pRule![1]!, /margin:\s*0;/, 'clears browser default paragraph margins (no 1em gap)')
  assert.match(pRule![1]!, /font-size:\s*12px;/, 'matches secondary note font-size')
  assert.match(pRule![1]!, /line-height:\s*1\.4;/, 'preserves comfortable line-height for wrapped text')
  assert.match(pRule![1]!, /overflow-wrap:\s*anywhere;/, 'prevents horizontal clipping on narrow cards')

  // 3. Spacing around surrounding usage sections is preserved
  const cardsRule = /\.usage-cards\s*\{([^}]*)\}/.exec(css)
  assert.ok(cardsRule, '.usage-cards rule exists')
  assert.match(cardsRule![1]!, /gap:\s*12px;/, 'surrounding usage cards grid gap remains 12px')

  const acctRule = /(?:^|\n)\.usage-acct\s*\{([^}]*)\}/.exec(css)
  assert.ok(acctRule, '.usage-acct rule exists')
  assert.match(acctRule![1]!, /gap:\s*6px;/, 'usage account card gap remains 6px')
  assert.match(acctRule![1]!, /padding:\s*8px\s+10px;/, 'card padding remains 8px 10px')

  const rowRule = /\.usage-row\s*\{([^}]*)\}/.exec(css)
  assert.ok(rowRule, '.usage-row rule exists')
  assert.match(rowRule![1]!, /gap:\s*5px;/, 'progress bar row gap remains 5px')
})

test('StandingMarks component: renders null when absent and wraps entries in .standing-marks', async () => {
  // Empty or undefined standing renders null
  const vEmpty = await mountView(<StandingMarks standing={undefined} />, (el) => el)
  assert.equal(vEmpty.el.children.length, 0, 'undefined standing renders nothing')

  const vNoMarks = await mountView(
    <StandingMarks standing={{ auth: 'ok', state: 'ready', marks: {} }} />,
    (el) => el)
  assert.equal(vNoMarks.el.children.length, 0, 'empty marks renders nothing')

  // Single mark renders inside .standing-marks container
  const vSingle = await mountView(
    <StandingMarks standing={{
      auth: 'ok', state: 'limited',
      marks: { fable: { until: 1789216200, provenance: 'inferred' } },
    }} />, (el) => el)
  const containerSingle = vSingle.el.querySelector('.standing-marks')
  assert.ok(containerSingle, 'single mark is wrapped in .standing-marks')
  const notesSingle = containerSingle!.querySelectorAll('.standing-mark')
  assert.equal(notesSingle.length, 1)
  assert.match(notesSingle[0]!.textContent ?? '', /fable limited until/)
  assert.match(notesSingle[0]!.textContent ?? '', /\(inferred\)/)

  // Multiple marks (e.g. Fable + pooled) render as sibling paragraphs inside one .standing-marks group
  const vMulti = await mountView(
    <StandingMarks standing={MULTI_MARK_USAGE.standing} />, (el) => el)
  const containerMulti = vMulti.el.querySelector('.standing-marks')
  assert.ok(containerMulti, 'multiple marks are wrapped in one .standing-marks container')
  const notesMulti = containerMulti!.querySelectorAll('.standing-mark')
  assert.equal(notesMulti.length, 2, 'both Fable and pooled notes render')
  assert.match(notesMulti[0]!.textContent ?? '', /fable limited until/)
  assert.match(notesMulti[1]!.textContent ?? '', /pooled limited until/)
})

test('UsageModal: stacked Fable and pooled limit notes group inside .standing-marks', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = mockFetch({
    '/api/usage': HOST_CLAUDE,
    '/api/providers': PROVIDERS,
    '/api/accounts': REGISTRY,
    '/api/accounts/claude-4/usage': MULTI_MARK_USAGE,
  })
  try {
    const view = await mountView(
      <UsageModal close={() => {}} toast={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })

    const sec = view.el.querySelector('[data-account="claude-4"]') as HTMLElement
    assert.ok(sec, 'claude-4 account section rendered')

    // Inside the account section, .standing-marks groups the stacked notes
    const marksGroup = sec.querySelector('.standing-marks')
    assert.ok(marksGroup, '.standing-marks container is present in the account section')

    // Verify it is a direct child of .usage-acct so it respects the container's 6px gap
    assert.equal(marksGroup!.parentElement, sec, '.standing-marks sits as a direct flex child of .usage-acct')

    const paragraphs = marksGroup!.querySelectorAll('p.standing-mark')
    assert.equal(paragraphs.length, 2, 'renders exactly 2 limit notes')
    assert.match(paragraphs[0]!.textContent ?? '', /^fable limited until .*\(inferred\)$/)
    assert.match(paragraphs[1]!.textContent ?? '', /^pooled limited until .*\(inferred\)$/)

    // Verify surrounding elements remain intact
    assert.ok(sec.querySelector('.usage-acct-head'), 'account header is intact')
    assert.equal(sec.querySelectorAll('.usage-row').length, 2, 'both progress rows are intact')
  } finally {
    delete g.fetch
  }
})
