// tests/hireharness.test.tsx — the hire dialog's Harness row
// (@item:orgtree/harness-everywhere-harness-row-in-the-hire-dialo; USER
// 2026-10-30 07:36:24Z m5611018df279 "fix both yes"). A draft for an
// OpenRouter or language model server tier shows the agent Model tab's
// Harness row: it follows the key or server unless a harness is chosen, and
// the hire op carries the choice. Synthetic org, no engine: the fixture
// answers GET /hire-harness itself.
import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { closeDraftSettings } from './draftclose.fixture'
import { legacyAppBackend } from './appfeed-fixture'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { clearProviderDiscovery } from '../src/api'
import { resetConvos } from '../src/convo'
import { setLangServerTiers, setMuseProvider, setOpenRouterTiers } from '../src/canvas/shared'
import { resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import type { ProviderInfo, ProvidersPayload, TreePayload } from '../src/types'

const OR = 'or-fixture-model'
const LS = 'ls-fixture-model'
const samples = { claude: 'opus', openrouter: OR, langserver: LS } as const
const tree = { slug: 'draft-harness', name: 'Synthetic', roots: [], dirs: [], tiers: { opus: 5, [OR]: 2, [LS]: 2 },
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'team', permission_mode: 'acceptEdits', default_top_grant: 12, max_top_grant: 100,
  cascade_hire: true, audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0,
} as unknown as TreePayload
const providers: ProvidersPayload = { checking: false,
  providers: (Object.keys(samples) as (keyof typeof samples)[]).map(id => ({ id, label: id, cli: id,
    status: { installed: true, connected: true }, hire_enabled: true, reason: null,
    tiers: [{ tier: samples[id], provider: id, model: `fixture/${samples[id]}`, seat: 2, letter: 'F' }],
  } as ProviderInfo)),
}
const installed = (id: string, label: string) => ({ id, label, installed: true, available: true, why: 'installed' })
const OPENCODE_ABSENT = { id: 'opencode', label: 'OpenCode (ACP)', installed: false, available: false,
  why: 'OpenCode (ACP) is not installed on this computer' }
const CUSTOM_WHY = "this custom server's base path is set for Claude Code's API; Codex needs its own server entry"
/** what GET /api/orgs/{slug}/hire-harness answers (`harnesses::hire_row`) */
const rowFor = (tier: string) => tier.startsWith('or-') ? {
  tier, lane: 'openrouter', pin: null, current: null, moves: false,
  follow: { id: 'codex-cli', label: 'Codex', installed: true, source: 'key', name: 'team budget' },
  options: [installed('claude-code', 'Claude Code'), installed('codex-cli', 'Codex'), OPENCODE_ABSENT],
} : tier.startsWith('ls-') ? {
  tier, lane: 'langserver', pin: null, current: null, moves: false,
  follow: { id: 'claude-code', label: 'Claude Code', installed: true, source: 'server', name: 'Gateway' },
  options: [installed('claude-code', 'Claude Code'),
    { id: 'codex-cli', label: 'Codex', installed: true, available: false, why: CUSTOM_WHY },
    { ...OPENCODE_ABSENT, installed: true, available: true, why: 'installed' }],
} : { tier, lane: null, follow: null, pin: null, current: null, options: [], moves: false }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

const panel = () => document.querySelector('.draft-scope')!
const row = (label: string) => [...panel().querySelectorAll('.set-row, .set-block')]
  .find(r => r.querySelector('.set-label')?.textContent === label)
const harnessSelect = () => panel().querySelector<HTMLSelectElement>('[aria-label="Agent harness"]')
const hintOf = (label: string) => row(label)?.querySelector('.set-hint')?.textContent ?? ''
async function click(el: Element | null | undefined) {
  assert.ok(el, 'required control exists')
  await inAct(async () => { (el as HTMLElement).click(); await flush() })
}
async function choose(el: Element | null | undefined, value: string) {
  assert.ok(el, 'required select exists')
  await inAct(async () => {
    (el as HTMLSelectElement).value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
  })
}
async function rename(el: Element | null | undefined, value: string) {
  assert.ok(el, 'required field exists')
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
  })
}

/** a canvas with the three families offered; `reads` lists every hire-harness read */
async function fixture(t: TestContext) {
  useFakeClock(); installFetch(new FakeServer())
  clearProviderDiscovery(); resetStaffingOptionsForTests(); localStorage.clear()
  setMuseProvider(null)
  setOpenRouterTiers(providers.providers.find(p => p.id === 'openrouter')?.tiers)
  setLangServerTiers(providers.providers.find(p => p.id === 'langserver')?.tiers)
  const before = globalThis.fetch
  const reads: string[] = []
  const operations: Record<string, unknown>[] = []
  // the legacy reads (not the app feed), as orghire.test serves the providers
  globalThis.fetch = legacyAppBackend(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const at = new URL(url, 'http://local')
    if (at.pathname === `/api/orgs/${tree.slug}/hire-harness`) {
      reads.push(url)
      return json(rowFor(at.searchParams.get('tier') ?? ''))
    }
    // every family's lane is allowed and on, so the hire strip offers all three
    if (at.pathname === `/api/orgs/${tree.slug}/accounts-allowed`) return json({ org: tree.slug,
      accounts: Object.keys(samples).map(p => ({ id: `${p}:primary`, provider: p, label: `${p} primary`, allowed: true, enabled: true })) })
    if (url === '/api/providers') return json(providers)
    if (url.includes('staffing-options')) return json({ tiers: Object.values(samples).map(tier => ({
      tier, seat: 2, efforts: ['high'], accounts: [], default_ok: true })), loading: false, stale: false, errors: [], at: 0, generation: 0 })
    return before(input, init)
  })
  const view = await mountView(<OrgCanvas tree={tree} slug={tree.slug} mailEvt={null} toast={() => {}}
    op={async o => { operations.push({ ...o }); return { node: 'proposed' } }} />, el => el)
  t.after(async () => {
    await view.unmount(); resetConvos(); realClock(); globalThis.fetch = before
    clearProviderDiscovery(); resetStaffingOptionsForTests(); localStorage.clear()
    setOpenRouterTiers([]); setLangServerTiers([])
  })
  // provider discovery runs on timers: let it land before reading the strip
  await advance(2000); await inAct(async () => { await flush(12) })
  /** open a draft for `tier` under the user, name it, and open its Model tab */
  const draft = async (tier: string) => {
    await inAct(async () => {
      for (const b of view.el.querySelectorAll<HTMLButtonElement>('.hire-expand[aria-expanded="false"]')) b.click()
      await flush(4)
    })
    const chip = view.el.querySelector(`.sq.user button.t-${tier}`)
    assert.ok(chip, `the user square offers ${tier}; it offers: ${[...view.el.querySelectorAll('.sq.user button[class*="t-"]')]
      .map(b => b.className).join(' | ')}`)
    await click(chip); await advance(1200)
    await rename(view.el.querySelector('.df-name'), 'proposed')
    await click(view.el.querySelector('.df-gear'))
    await click(panel().querySelector('[role="tab"][id$="model"]'))
    await inAct(async () => { await flush(6) })
  }
  const hire = async () => {
    await closeDraftSettings(panel())
    await click(view.el.querySelector('.df-foot button.primary'))
    assert.equal(operations.length, 1, 'one hire op')
    return operations[0]!
  }
  return { view, reads, operations, draft, hire }
}

test('§1 an OpenRouter draft follows its key by default, and the hire names no harness', async t => {
  const f = await fixture(t)
  await f.draft(OR)
  assert.ok(row('Harness'), 'the draft Model tab has a Harness row')
  assert.equal(harnessSelect()?.value, '', 'it follows by default')
  assert.equal(harnessSelect()?.options[0]?.textContent, 'Follow key (Codex)')
  const opts = [...harnessSelect()!.options].map(o => [o.value, o.disabled])
  assert.deepEqual(opts.filter(([v]) => v === 'claude-code' || v === 'codex-cli' || v === 'opencode'),
    [['claude-code', false], ['codex-cli', false], ['opencode', true]], 'the key dialog list: not installed is disabled')
  assert.equal(hintOf('Harness'), 'Follows its key (team budget).')
  assert.ok(f.reads.some(u => u.includes(`/api/orgs/${tree.slug}/hire-harness?tier=${OR}`)), f.reads.join(' '))
  const hire = await f.hire()
  assert.equal(hire.tier, OR)
  assert.equal('harness' in hire, false, 'following sends no harness: the seat follows its key')
})

test('§2 choosing a harness in the draft pins the hire to it', async t => {
  const f = await fixture(t)
  await f.draft(OR)
  await choose(harnessSelect(), 'claude-code')
  assert.equal(hintOf('Harness'),
    'Its own choice: it starts on Claude Code and keeps it when its key (team budget) changes harness.')
  await closeDraftSettings(panel())
  await click(f.view.el.querySelector('.df-gear'))
  await click(panel().querySelector('[role="tab"][id$="model"]'))
  assert.equal(harnessSelect()?.value, 'claude-code', 'the choice is kept in the draft')
  const hire = await f.hire()
  assert.equal(hire.harness, 'claude-code', 'the hire op pins the new seat')
})

test('§3 a server draft follows its server; a harness it cannot carry is disabled with the reason', async t => {
  const f = await fixture(t)
  await f.draft(LS)
  assert.equal(harnessSelect()?.options[0]?.textContent, 'Follow server (Claude Code)')
  const codex = [...harnessSelect()!.options].find(o => o.value === 'codex-cli')!
  assert.equal(codex.disabled, true)
  assert.equal(codex.title, CUSTOM_WHY)
  assert.equal(hintOf('Harness'), 'Follows its server (Gateway).')
  await choose(harnessSelect(), 'opencode')
  const hire = await f.hire()
  assert.equal(hire.harness, 'opencode')
})

test('§4 a draft on another provider shows no Harness row and reads nothing', async t => {
  const f = await fixture(t)
  await f.draft('opus')
  assert.ok(row('Thinking effort'), 'the Model tab is showing')
  assert.equal(row('Harness'), undefined)
  assert.deepEqual(f.reads, [])
  const hire = await f.hire()
  assert.equal('harness' in hire, false)
})

test('§5 a harness chosen for one model is dropped when the draft changes model', async t => {
  const f = await fixture(t)
  await f.draft(OR)
  await choose(harnessSelect(), 'claude-code')
  await choose(panel().querySelector('[aria-label="Model tier"]'), LS)
  await inAct(async () => { await flush(6) })
  if (!panel()?.querySelector('[aria-label="Agent harness"]')) {
    await click(panel().querySelector('[role="tab"][id$="model"]'))
  }
  assert.equal(harnessSelect()?.options[0]?.textContent, 'Follow server (Claude Code)')
  assert.equal(harnessSelect()?.value, '', 'the new model starts by following its server')
  const hire = await f.hire()
  assert.equal(hire.tier, LS)
  assert.equal('harness' in hire, false, 'the OpenRouter choice does not ride a server hire')
})
