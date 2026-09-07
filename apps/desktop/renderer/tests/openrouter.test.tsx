// The OpenRouter section of App settings → Providers (user spec 2026-09-02):
// key entry → favorites row of monogram cards → model-selection modal with
// search, paged results (card · full name · vendor · $/1M in and out) and
// select/deselect. Driven through the rendered controls against a scripted
// fetch — the key is only ever SENT, and the section renders nothing of it.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelCard, OpenRouterSection } from '../src/canvas/openrouter'
import {
  isDarkTierColor, modelLabel, noteTierModels, openrouterTierCss, openrouterTierIds,
  setOpenRouterTiers, TIER_LETTER, tierLabel,
} from '../src/canvas/shared'
import type { OpenRouterDoc, OpenRouterModel, ProviderInfo } from '../src/types'

type Seen = { method: string; path: string; body: unknown }
const g = globalThis as unknown as Record<string, unknown>

// what the backend serves since 2026-09-03: `name` without its `Vendor: `
// prefix, `label` = the id without its vendor namespace, `letter` = the
// first letter of the label's first word (claude-* → C, gpt-* → G)
const CATALOG: OpenRouterModel[] = [
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', label: 'claude-sonnet-5',
    vendor: 'anthropic', prompt: 2, completion: 10, cache_read: 0.2,
    context: 1000000, tools: true, free: false, letter: 'C', color: '#f9907f' },
  { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', label: 'gpt-5.6-luna', vendor: 'openai',
    prompt: 0.2, completion: 1.2, cache_read: 0.02, context: 1050000,
    tools: true, free: false, letter: 'G', color: '#9fe3d1' },
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3', label: 'kimi-k3', vendor: 'moonshotai',
    prompt: 3, completion: 15, cache_read: 0.3, context: 1048576,
    tools: true, free: false, letter: 'K', color: '#8fc9e8' },
]

function stubFetch(seen: Seen[], opts: { keySet?: boolean; favorites?: string[] } = {}) {
  let keySet = opts.keySet ?? false
  // favorites already on the server when the UI first reads it — the state
  // the user's 2026-09-03 bug needed: a search page fetched with rows ALREADY
  // selected, then deselected without a refetch
  const favorites: OpenRouterModel[] = (opts.favorites ?? [])
    .map((id) => CATALOG.find((c) => c.id === id)!)
  const doc = (): OpenRouterDoc => ({
    installed: keySet, connected: keySet, key_set: keySet,
    kind: keySet ? 'api-key' : null, label: keySet ? 'sk-or-v1-abc…xyz' : null,
    credits: { limit: null, limit_remaining: null, usage: 1.25, usage_daily: 0.5,
      usage_weekly: 1.25, usage_monthly: 1.25, is_free_tier: false,
      checked_at: '2026-09-02T22:00:00Z' },
    reason: keySet ? null : 'no API key — add one in App settings → Providers',
    favorites: favorites.length, favorites_max: 0,
    tiers: favorites.map((m) => ({
      tier: 'or-' + m.id.replace(/[^a-z0-9]+/g, '-'), provider: 'openrouter',
      seat: Math.max(1, Math.floor(m.prompt)), model: m.id, letter: m.letter,
      color: m.color, name: m.name, label: m.label, vendor: m.vendor, prompt: m.prompt,
      completion: m.completion, price_unknown: m.price_unknown,
      price_source: m.price_source, context: m.context })),
    user_enabled: true,
  })
  g.fetch = (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    const path = u.pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    seen.push({ method, path, body })
    let payload: unknown = null
    if (path === '/api/openrouter' && method === 'GET') payload = doc()
    else if (path === '/api/openrouter/key' && method === 'PUT') {
      keySet = true; payload = doc()
    } else if (path === '/api/openrouter/key' && method === 'DELETE') {
      keySet = false; payload = doc()
    } else if (path === '/api/openrouter/models') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase()
      const items = CATALOG.filter((m) => !q || m.id.includes(q) || m.name.toLowerCase().includes(q))
        .map((m) => ({ ...m, selected: favorites.some((f) => f.id === m.id) }))
      payload = { query: q, offset: 0, limit: 8, total: items.length, items }
    } else if (path === '/api/openrouter/favorites' && method === 'PUT') {
      const b = body as { id: string; selected: boolean }
      const m = CATALOG.find((c) => c.id === b.id)!
      if (b.selected && !favorites.some((f) => f.id === b.id)) favorites.push(m)
      if (!b.selected) favorites.splice(favorites.findIndex((f) => f.id === b.id), 1)
      payload = doc()
    }
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${path}`))
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(payload),
    })
  }
}

const PROVIDER: ProviderInfo = {
  id: 'openrouter', label: 'OpenRouter', cli: 'REST API (via Claude Code)',
  tiers: [], status: { installed: true, connected: true, key_set: true },
  hire_enabled: true, user_enabled: true, reason: null,
}

async function mountSection(pickerState: { open: boolean }) {
  const view = await mountView(
    <OpenRouterSection provider={PROVIDER} toast={() => {}}
      pickerOpen={pickerState.open}
      setPickerOpen={(o) => { pickerState.open = o }} />, (el) => el)
  await inAct(async () => { await flush(10) })
  return view
}

test('§1 no key: the section offers key entry and nothing else; setting it '
  + 'PUTs the key and reveals the favorites row', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const picker = { open: false }
  const view = await mountSection(picker)
  try {
    const input = view.el.querySelector<HTMLInputElement>(
      'input[aria-label="OpenRouter API key"]')
    assert.ok(input, 'key input rendered')
    assert.equal(input.type, 'password')
    assert.equal(view.el.querySelector('.orr-favs'), null, 'no favorites row yet')
    await inAct(async () => {
      // React tracks the input's value through the prototype setter; jsdom's
      // HTMLInputElement is reached via the element, not a global
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input), 'value')!.set!
      setter.call(input, 'sk-or-v1-testkey-000000000000')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush(2)
    })
    // the entry row is the Claude section's "paste a new key" row: the ✓
    // spans the two button columns
    const btn = view.el.querySelector<HTMLButtonElement>('button.acct-add[title="set the key"]')!
    assert.ok(btn, 'the ✓ button sets the key')
    await inAct(async () => { btn.click(); await flush(10) })
    const put = seen.find((r) => r.method === 'PUT' && r.path === '/api/openrouter/key')
    assert.deepEqual(put?.body, { key: 'sk-or-v1-testkey-000000000000' })
    assert.equal(view.el.textContent?.includes('sk-or-v1-testkey'), false,
      'the key never renders')
    assert.ok(view.el.querySelector('.orr-favs'), 'favorites row appears once a key is set')
    // the key row: an ACCOUNT ROW — identity + verdict on line 1, the credit
    // standing on line 2, three icon buttons in the account rows' columns
    const row = view.el.querySelector('.acct-line > .acct-row.orr-keyrow')!
    assert.ok(row, 'the key row is an account row')
    const line1 = row.querySelector('.acct-main > .orr-standing')!
    assert.ok(line1.textContent?.includes('sk-or-v1-abc…xyz'), 'the label is the identity')
    assert.ok(line1.textContent?.includes('connected'), 'connected standing shown')
    const line2 = row.querySelector('.acct-provenance')!.textContent ?? ''
    for (const s of ['$1.25 spent', 'today $0.50', 'week $1.25', 'month $1.25']) {
      assert.ok(line2.includes(s), `credit standing carries "${s}"`)
    }
    const btns = [...row.querySelectorAll<HTMLButtonElement>('.acct-main > .acct-btn')]
    assert.deepEqual(btns.map((b) => b.title.split(' — ')[0]), [
      're-check the key and its credit standing at openrouter.ai',
      'replace the key', 'forget the key'])
    // ⚠ `.acct-btn` is a 27px ICON button: a word in it spills out of the box
    // and over its neighbours (the 2026-09-02 overlap). Icons only, ever.
    for (const b of view.el.querySelectorAll('.acct-btn')) {
      assert.equal(b.textContent?.trim(), '', `no text in an icon button (${b.getAttribute('title')})`)
      assert.ok(b.querySelector('svg'), 'an icon button carries an icon')
    }
    // replace → the entry row comes back with a ✕ that keeps the current key
    await inAct(async () => { btns[1]!.click(); await flush(4) })
    assert.ok(view.el.querySelector('input[aria-label="OpenRouter API key"]'),
      'replace opens the entry row')
    const keep = view.el.querySelector<HTMLButtonElement>('button[title="keep the current key"]')!
    assert.ok(keep, 'a ✕ keeps the current key')
    await inAct(async () => { keep.click(); await flush(4) })
    assert.ok(view.el.querySelector('.orr-keyrow .orr-standing'), 'the key row is back')
    assert.equal(seen.filter((r) => r.path === '/api/openrouter/key').length, 1,
      'replace/keep touched the key endpoint no further')
  } finally { await view.unmount(); delete g.fetch }
})

test('§2 the favorites row opens the picker; search, select and deselect '
  + 'drive PUT /favorites and the monogram cards', async () => {
  const seen: Seen[] = []
  stubFetch(seen, { keySet: true })
  const picker = { open: false }
  let view = await mountSection(picker)
  try {
    const row = view.el.querySelector<HTMLButtonElement>('.orr-favs')!
    assert.ok(row, 'favorites row present')
    assert.equal(row.getAttribute('aria-haspopup'), 'dialog')
    await inAct(async () => { row.click() })
    assert.equal(picker.open, true, 'the row asks the panel to open the picker')
  } finally { await view.unmount() }
  // remount with the picker open (the panel owns that state)
  view = await mountSection({ open: true })
  try {
    const dialog = view.el.querySelector('[role="dialog"]')
    assert.ok(dialog, 'the model-selection modal renders')
    await inAct(async () => { await flush(10) })
    const rows = view.el.querySelectorAll<HTMLButtonElement>('.orr-row')
    assert.equal(rows.length, 3, 'catalog rows listed')
    const first = rows[0]!
    // the display forms (user ask 2026-09-03): no `Vendor: ` prefix on the
    // name, no vendor namespace on the id — the vendor stands alone
    assert.ok(first.textContent?.includes('Claude Sonnet 5'), 'display name')
    assert.equal(first.textContent?.includes('Anthropic:'), false, 'no vendor prefix on the name')
    assert.ok(first.textContent?.includes('anthropic · claude-sonnet-5'), 'vendor, then the short id')
    assert.equal(first.textContent?.includes('anthropic/claude'), false, 'no namespace on the id')
    assert.ok(first.textContent?.includes('$2 in'), 'price in per 1M')
    assert.ok(first.textContent?.includes('$10 out'), 'price out per 1M')
    assert.ok(first.querySelector('.orr-card')?.textContent === 'C', 'monogram card letter')
    // search narrows
    const search = view.el.querySelector<HTMLInputElement>(
      'input[aria-label="search OpenRouter models"]')!
    await inAct(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(search), 'value')!.set!
      setter.call(search, 'luna')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await flush(4)
      await new Promise((r) => setTimeout(r, 260))
      await flush(6)
    })
    const narrowed = view.el.querySelectorAll<HTMLButtonElement>('.orr-row')
    assert.equal(narrowed.length, 1, 'search narrows the page')
    assert.ok(narrowed[0]!.textContent?.includes('openai · gpt-5.6-luna'),
      'a non-Anthropic model displays vendor and label cleanly')
    assert.ok(!narrowed[0]!.textContent?.includes('best-effort'),
      'redundant best-effort qualifier is not displayed')
    // select it
    await inAct(async () => { narrowed[0]!.click(); await flush(10) })
    const put = seen.find((r) => r.method === 'PUT' && r.path === '/api/openrouter/favorites')
    assert.deepEqual(put?.body, { id: 'openai/gpt-5.6-luna', selected: true })
    const cards = view.el.querySelectorAll('.orr-favs .orr-card')
    assert.equal(cards.length, 1, 'the favorites row grew a card')
    assert.equal(cards[0]!.textContent, 'G')
    assert.match(cards[0]!.getAttribute('title') ?? '', /^gpt-5\.6-luna · GPT-5\.6 Luna — openai · /,
      'the card tooltip leads with the label, then the name, then the vendor once')
    // …and the shared registry learned the runtime tier + letter + name
    assert.deepEqual(openrouterTierIds(), ['or-openai-gpt-5-6-luna'])
    assert.equal(TIER_LETTER['or-openai-gpt-5-6-luna'], 'G')
    assert.equal(tierLabel('or-openai-gpt-5-6-luna'), 'gpt-5.6-luna')
    assert.ok(document.getElementById('orgtree-openrouter-tiers')?.textContent
      ?.includes('.tier.t-or-openai-gpt-5-6-luna{color:#9fe3d1'),
      'generated tier CSS injected')
    // deselect
    const selectedRow = view.el.querySelector<HTMLButtonElement>('.orr-row.on')!
    await inAct(async () => { selectedRow.click(); await flush(10) })
    const put2 = seen.filter((r) => r.path === '/api/openrouter/favorites').at(-1)
    assert.deepEqual(put2?.body, { id: 'openai/gpt-5.6-luna', selected: false })
    assert.equal(view.el.querySelectorAll('.orr-favs .orr-card').length, 0)
    assert.equal(tierLabel('or-openai-gpt-5-6-luna'), 'gpt-5.6-luna',
      'a tier once seen keeps its name after deselection (a node may still run on it)')
  } finally { await view.unmount(); delete g.fetch }
})

test('§2b the SELECTED list on the modal (user ask 2026-09-03): every favorite as a chip '
  + 'with a ✕; deselecting there — or on a search row fetched as selected — round-trips: '
  + 'PUT, gone from the list, the row reads "select", the favorites row shrinks', async () => {
  const seen: Seen[] = []
  stubFetch(seen, { keySet: true, favorites: ['anthropic/claude-sonnet-5', 'moonshotai/kimi-k3'] })
  const view = await mountSection({ open: true })
  // the catalog page lands after a debounce and a fetch: under the full
  // suite's load a fixed number of ticks is not enough (0 rows at 456 tests,
  // 3 rows alone), so every wait here is for the CONDITION, bounded
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !cond(); i++) await inAct(async () => { await flush(4) })
    assert.ok(cond(), `timed out waiting for: ${what}`)
  }
  const chips = () => [...view.el.querySelectorAll('.orr-selected .orr-sel')]
  const rows = () => [...view.el.querySelectorAll<HTMLButtonElement>('.orr-row')]
  try {
    await until(() => rows().length === 3 && chips().length === 2, 'the page and the doc')
    // the list: two chips, in the doc's order, each card + label + ✕
    const list = view.el.querySelector('[role="dialog"] .orr-selected')!
    assert.ok(list, 'the selected list renders on the modal itself')
    assert.deepEqual(chips().map((c) => c.querySelector('.orr-sel-name')?.textContent),
      ['claude-sonnet-5', 'kimi-k3'], 'one chip per favorite, the display label')
    assert.deepEqual(chips().map((c) => c.querySelector('.orr-card')?.textContent), ['C', 'K'])
    const xs = [...view.el.querySelectorAll<HTMLButtonElement>('.orr-selected .orr-sel-x')]
    assert.deepEqual(xs.map((b) => b.getAttribute('aria-label')),
      ['deselect claude-sonnet-5', 'deselect kimi-k3'])
    for (const b of xs) {
      assert.equal(b.textContent?.trim(), '', 'icon only in the small button')
      assert.ok(b.querySelector('svg'))
    }
    assert.ok(view.el.querySelector('[role="dialog"] h3')?.textContent?.includes('2 selected'))
    // the search rows were FETCHED with `selected: true` for both favorites
    assert.equal(rows().length, 3)
    const isOn = (r: HTMLButtonElement) => r.classList.contains('on')
      && r.getAttribute('aria-pressed') === 'true' && !!r.textContent?.includes('✓ selected')
    assert.deepEqual(rows().map(isOn), [true, false, true], 'both favorites read selected')

    // 1 · THE BUG: click the selected SEARCH ROW to deselect. Before the fix
    // the row OR-ed the page item's stale server flag into its state and
    // stayed "✓ selected" forever.
    await inAct(async () => { rows()[0]!.click() })
    await until(() => chips().length === 1, 'the deselect to land')
    assert.deepEqual(seen.filter((r) => r.path === '/api/openrouter/favorites').at(-1)?.body,
      { id: 'anthropic/claude-sonnet-5', selected: false })
    assert.equal(seen.filter((r) => r.path === '/api/openrouter/models').length, 1,
      'no refetch of the page — the row must read the live doc, not a fresh flag')
    assert.deepEqual(rows().map(isOn), [false, false, true],
      'the deselected row renders deselected (stale page flag ignored)')
    assert.equal(rows()[0]!.textContent?.includes('select'), true)
    assert.equal(rows()[0]!.textContent?.includes('✓ selected'), false)
    assert.deepEqual(chips().map((c) => c.querySelector('.orr-sel-name')?.textContent), ['kimi-k3'],
      'gone from the selected list too')
    assert.equal(view.el.querySelectorAll('.orr-favs .orr-card').length, 1, 'favorites row shrank')
    assert.ok(view.el.querySelector('[role="dialog"] h3')?.textContent?.includes('1 selected'))

    // 2 · deselect from the LIST: the ✕ on kimi, never searched for
    const x = view.el.querySelector<HTMLButtonElement>('.orr-sel-x[aria-label="deselect kimi-k3"]')!
    await inAct(async () => { x.click() })
    await until(() => chips().length === 0, 'the ✕ to land')
    assert.deepEqual(seen.filter((r) => r.path === '/api/openrouter/favorites').at(-1)?.body,
      { id: 'moonshotai/kimi-k3', selected: false })
    assert.deepEqual(chips(), [], 'the list is empty')
    assert.ok(view.el.querySelector('.orr-selected .dim')?.textContent?.includes('nothing selected yet'),
      'the empty state says so')
    assert.deepEqual(rows().map(isOn), [false, false, false], "kimi's search row reads deselected")
    assert.equal(view.el.querySelectorAll('.orr-favs .orr-card').length, 0)

    // 3 · and back: select from a search row → appears in the list
    await inAct(async () => { rows()[1]!.click() })
    await until(() => chips().length === 1, 'the select to land')
    assert.deepEqual(chips().map((c) => c.querySelector('.orr-sel-name')?.textContent), ['gpt-5.6-luna'])
    assert.deepEqual(rows().map(isOn), [false, true, false])
    assert.equal(view.el.querySelectorAll('.orr-favs .orr-card').length, 1)
  } finally { await view.unmount(); delete g.fetch }
})

test('§3 tierLabel: a static tier is its own name; an OpenRouter tier is its model — '
  + 'from the registry, else the org doc table, else (last) the bare slug', () => {
  assert.equal(tierLabel('sonnet'), 'sonnet')
  assert.equal(tierLabel('or-nobody-has-described-this'), 'nobody-has-described-this')
  noteTierModels({ 'or-z-ai-glm-5-2-free': 'z-ai/glm-5.2:free', sonnet: 'claude-sonnet-5' })
  assert.equal(tierLabel('or-z-ai-glm-5-2-free'), 'glm-5.2:free', 'the variant suffix stays')
  assert.equal(modelLabel('anthropic/claude-sonnet-5'), 'claude-sonnet-5')
  assert.equal(modelLabel('bare'), 'bare')
  setOpenRouterTiers([{ tier: 'or-a-b', provider: 'openrouter', seat: 1, model: 'a/b', letter: 'B' }])
  assert.equal(tierLabel('or-a-b'), 'b', 'a registry row without a label → derived from its model')
  setOpenRouterTiers([{ tier: 'or-a-b', provider: 'openrouter', seat: 1, model: 'a/b',
    letter: 'B', label: 'a/b' }])
  assert.equal(tierLabel('or-a-b'), 'a/b', "the backend's label wins — it is what knows about collisions")
  setOpenRouterTiers([])
})

test('§4 a DARK tier colour (the xAI black) renders FILLED with light ink and a rim; '
  + 'a light one stays ink on the panel', async () => {
  // the backend's xAI near-blacks are dark; every hue-bearing colour is not;
  // the chrome's own line colour is the boundary
  assert.equal(isDarkTierColor('#0d0d0d'), true)
  assert.equal(isDarkTierColor('#161616'), true, 'the lightest xAI band is still a fill')
  assert.equal(isDarkTierColor('#3c3c3c'), false, 'the chrome line (#3c3c3c) is above the cut')
  assert.equal(isDarkTierColor('#f9907f'), false)
  assert.equal(isDarkTierColor('#8f7f7f'), false, 'the darkest hue-bearing band is ink')
  assert.equal(isDarkTierColor('not-a-colour'), false)
  const grok = { tier: 'or-x-ai-grok-4-6', provider: 'openrouter', seat: 2,
    model: 'x-ai/grok-4.6', letter: 'G', color: '#0d0d0d', label: 'grok-4.6' }
  const luna = { tier: 'or-openai-gpt-5-6-luna', provider: 'openrouter', seat: 1,
    model: 'openai/gpt-5.6-luna', letter: 'G', color: '#9fe3d1', label: 'gpt-5.6-luna' }
  const css = openrouterTierCss([grok, luna])
  // the same selectors both ways — the dark one inverts them
  for (const sel of ['.tier.t-', '.hsof button.t-', '.chip.agents b.t-', '.sq.tier-',
    '.sq.mini.tier-', '.sq.prov-openrouter.desk.tier-']) {
    assert.ok(css.includes(sel + grok.tier), `${sel} rule for the dark tier`)
    assert.ok(css.includes(sel + luna.tier), `${sel} rule for the light tier`)
  }
  assert.ok(css.includes(`.tier.t-${grok.tier}{color:var(--ink-strong);background:#0d0d0d;`),
    'dark: the colour is the FILL, the letter is the strong ink')
  assert.ok(css.includes(`.tier.t-${luna.tier}{color:#9fe3d1;`), 'light: the colour is the ink')
  assert.ok(/\.hsof button\.t-or-x-ai-grok-4-6\{[^}]*border-color:color-mix\(in srgb, var\(--ink\) 40%, var\(--line\)\)/.test(css),
    'dark: a lifted grey rim, not a mix of black into the line')
  assert.ok(css.includes(`.sq.tier-${grok.tier}{border-top-color:#0d0d0d}`),
    "dark: the card's top edge is the black itself")
  assert.equal(css.includes(`.tier.t-${luna.tier}{color:var(--ink-strong)`), false,
    'a light tier is never inverted')
  // the monogram card takes the `dark` class from the same test
  const view = await mountView(
    <><ModelCard letter="G" color="#0d0d0d" title="grok" /><ModelCard letter="G" color="#9fe3d1" /></>,
    (el) => el)
  try {
    const cards = [...view.el.querySelectorAll('.orr-card')]
    assert.deepEqual(cards.map((c) => c.classList.contains('dark')), [true, false])
  } finally { await view.unmount() }
})

test('§4b a dark tier with a vendor ACCENT wears it as the rim (MiniMax, Z.AI — the brand '
  + 'palette 2026-09-03); the xAI black keeps the grey rim, a light colour never draws one',
async () => {
  const m3 = { tier: 'or-minimax-minimax-m3', provider: 'openrouter', seat: 1,
    model: 'minimax/minimax-m3', letter: 'M', color: '#152537', accent: '#ff5530',
    label: 'minimax-m3' }
  const glm = { tier: 'or-z-ai-glm-5-2-free', provider: 'openrouter', seat: 1,
    model: 'z-ai/glm-5.2:free', letter: 'G', color: '#2e2e2e', accent: '#00d4ff',
    label: 'glm-5.2:free' }
  const grok = { tier: 'or-x-ai-grok-4-6', provider: 'openrouter', seat: 2,
    model: 'x-ai/grok-4.6', letter: 'G', color: '#0d0d0d', accent: null, label: 'grok-4.6' }
  const luna = { tier: 'or-openai-gpt-5-6-luna', provider: 'openrouter', seat: 1,
    model: 'openai/gpt-5.6-luna', letter: 'G', color: '#9fe3d1', accent: '#ff0000',
    label: 'gpt-5.6-luna' }
  const bad = { ...m3, tier: 'or-minimax-bad', accent: 'red' }
  const css = openrouterTierCss([m3, glm, grok, luna, bad])
  assert.ok(css.includes(`.tier.t-${m3.tier}{color:var(--ink-strong);background:#152537;border-color:#ff5530}`),
    'MiniMax: navy fill, orange-red rim')
  assert.ok(css.includes(`.hsof button.t-${glm.tier}{color:var(--ink-strong);background:#2e2e2e;border-color:#00d4ff}`),
    'Z.AI: grey fill, cyan rim — on the hire strip too')
  assert.ok(css.includes(`.chip.agents b.t-${m3.tier}{color:var(--ink-strong);background:#152537;border-color:#ff5530;border:1px solid #ff5530;`),
    'the inventory chip draws the accent as its border')
  assert.ok(/\.tier\.t-or-x-ai-grok-4-6\{[^}]*border-color:color-mix\(in srgb, var\(--ink\) 40%, var\(--line\)\)/.test(css),
    'no accent → the lifted grey rim')
  assert.ok(/\.tier\.t-or-minimax-bad\{[^}]*border-color:color-mix\(in srgb, var\(--ink\) 40%/.test(css),
    'a malformed accent falls back to the grey rim, never reaches the stylesheet')
  assert.equal(css.includes('#ff0000'), false, 'a light tier never draws an accent')
  assert.equal(css.includes('red'), false)
  // the monogram card: `--orr-a` set only where the sheet will use it
  const view = await mountView(
    <>
      <ModelCard letter="M" color="#152537" accent="#ff5530" title="m3" />
      <ModelCard letter="G" color="#9fe3d1" accent="#ff5530" />
      <ModelCard letter="G" color="#0d0d0d" accent={null} />
      <ModelCard letter="G" color="#2e2e2e" accent="cyan" />
    </>, (el) => el)
  try {
    const cards = [...view.el.querySelectorAll('.orr-card')] as HTMLElement[]
    assert.deepEqual(cards.map((c) => c.classList.contains('dark')), [true, false, true, true])
    assert.deepEqual(cards.map((c) => /--orr-a/.test(c.getAttribute('style') ?? '')),
      [true, false, false, false], 'only the dark card with a well-formed accent carries --orr-a')
    assert.ok(/--orr-a:\s*#ff5530/.test(cards[0]!.getAttribute('style') ?? ''))
  } finally { await view.unmount() }
  // the live family notices an accent change (same colour, new rim)
  setOpenRouterTiers([m3])
  const before = document.getElementById('orgtree-openrouter-tiers')?.textContent ?? ''
  setOpenRouterTiers([{ ...m3, accent: '#00d4ff' }])
  const after = document.getElementById('orgtree-openrouter-tiers')?.textContent ?? ''
  assert.ok(before.includes('#ff5530') && after.includes('#00d4ff') && !after.includes('#ff5530'),
    'the injected sheet follows the accent')
  setOpenRouterTiers([])
})

test('§5 unknown catalog prices render as unknown, never free or compatibility $0',
async () => {
  const unknown: OpenRouterModel = {
    id: 'probe/unknown', name: 'Unknown', label: 'unknown', vendor: 'probe',
    prompt: 0, completion: 0, cache_read: 0, context: 1000, tools: true,
    free: false, created: 0, letter: 'U', color: '#aaaaaa',
    price_unknown: ['prompt', 'completion', 'cache_read', 'cache_write'],
    price_source: 'openrouter-catalog',
  }
  const free: OpenRouterModel = {
    ...unknown, id: 'probe/free:free', name: 'Free', label: 'free:free',
    free: true, letter: 'F', price_unknown: [],
  }
  CATALOG.push(unknown, free)
  const seen: Seen[] = []
  stubFetch(seen, { keySet: true, favorites: [unknown.id] })
  const view = await mountSection({ open: true })
  try {
    let rows: HTMLElement[] = []
    for (let i = 0; i < 20; i++) {
      rows = [...view.el.querySelectorAll<HTMLElement>('.orr-row')]
      if (rows.some((r) => r.textContent?.includes('Unknown'))
          && rows.some((r) => r.textContent?.includes('Free'))) break
      await inAct(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5)); await flush(2)
      })
    }
    const unknownRow = rows.find((r) => r.textContent?.includes('Unknown'))
    const freeRow = rows.find((r) => r.textContent?.includes('Free'))
    assert.ok(unknownRow && freeRow, 'both positive-control rows render')
    assert.match(unknownRow.querySelector('.orr-price')?.textContent ?? '', /— in ·\s+— out/)
    assert.doesNotMatch(unknownRow.querySelector('.orr-price')?.textContent ?? '', /free|\$0/)
    assert.equal(freeRow.querySelector('.orr-price')?.textContent?.trim(), 'free')
    const favoriteTitle = view.el.querySelector('.orr-favs .orr-card')?.getAttribute('title') ?? ''
    assert.match(favoriteTitle, /— in \/ — out per 1M · incomplete catalog pricing/)
    assert.doesNotMatch(favoriteTitle, /\$0 in/)
  } finally {
    await view.unmount(); delete g.fetch
    CATALOG.splice(-2)
  }
})
