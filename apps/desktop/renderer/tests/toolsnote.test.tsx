// The OpenRouter tool DECLARATION, as it renders on the surfaces where a
// person actually chooses a seat.
//
// Until 2026-09-05 the catalog's tool declaration reached the picker and
// stopped there: the favorites strip, the hire sheet and both switch selects
// never carried it, so every decision after the first was made without it.
// The picker itself tested `!m.tools`, which printed the SAME words for a
// model the catalog declared tool-less and one whose entry declared nothing
// readable — the silent-false this file exists to keep shut.
//
// ⚠ EVERY STRING HERE IS A CATALOG DECLARATION, NOT AN OBSERVATION. Nothing
// runs a turn, a tool call or a refusal against any model, and the rendered
// wording says `(catalog)` in all three states for exactly that reason.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenRouterSection } from '../src/canvas/openrouter'
import {
  capabilityNote, capabilityNotes, setOpenRouterTiers, tierCapabilityNotes,
  tierToolsNote, toolsNote,
} from '../src/canvas/shared'
import type { OpenRouterDoc, OpenRouterModel, ProviderInfo, ProviderTier } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>

const SUPPORTED = 'Tools: supported (catalog)'
const NOT_SUPPORTED = 'Tools: not supported (catalog)'
const UNKNOWN = 'Tools: unknown (catalog)'
// unit C (2026-09-05): image input and the reasoning REQUEST PARAMETER.
// "Reasoning parameter", never bare "Reasoning": the catalog fact is
// membership in `supported_parameters`, not a claim about how a model thinks.
const IMG_SUPPORTED = 'Image input: supported (catalog)'
const IMG_NOT = 'Image input: not supported (catalog)'
const IMG_UNKNOWN = 'Image input: unknown (catalog)'
const RSN_SUPPORTED = 'Reasoning parameter: supported (catalog)'
const RSN_NOT = 'Reasoning parameter: not supported (catalog)'
const RSN_UNKNOWN = 'Reasoning parameter: unknown (catalog)'

const tier = (over: Partial<ProviderTier>): ProviderTier => ({
  tier: 'or-vendor-model', provider: 'openrouter', seat: 1,
  model: 'vendor/model', letter: 'M', color: '#888888',
  name: 'Model', label: 'model', vendor: 'vendor',
  prompt: 1, completion: 2, context: 100000, ...over,
} as ProviderTier)

test('the formatter names all three states and says (catalog) in every one', () => {
  assert.equal(toolsNote(true), SUPPORTED)
  assert.equal(toolsNote(false), NOT_SUPPORTED)
  assert.equal(toolsNote(null), UNKNOWN)
  assert.equal(toolsNote(undefined), UNKNOWN)
  // ⚠ THE SILENT-FALSE GUARD. Unknown must not render as the declared-false
  // wording: the catalog never said this model lacks tool support.
  assert.notEqual(toolsNote(null), toolsNote(false))
  // the source is stated on every state, not only the unknown one
  for (const v of [true, false, null] as const) {
    assert.match(toolsNote(v), /\(catalog\)$/)
  }
  // and no wording may imply an observation
  for (const v of [true, false, null] as const) {
    assert.doesNotMatch(toolsNote(v), /observ|verified|cannot use|unable/i)
  }
})

test('tierToolsNote answers for a known OpenRouter tier and stays silent elsewhere', () => {
  setOpenRouterTiers([
    tier({ tier: 'or-a', model: 'v/a', tools: true }),
    tier({ tier: 'or-b', model: 'v/b', tools: false }),
    tier({ tier: 'or-c', model: 'v/c', tools: null }),
    tier({ tier: 'or-d', model: 'v/d' }),           // an older backend: absent
  ])
  assert.equal(tierToolsNote('or-a'), SUPPORTED)
  assert.equal(tierToolsNote('or-b'), NOT_SUPPORTED)
  assert.equal(tierToolsNote('or-c'), UNKNOWN)
  assert.equal(tierToolsNote('or-d'), UNKNOWN)
  // ⚠ NOT A CLAIM ABOUT OTHER LANES. The catalog is an OpenRouter fact;
  // inventing one for a Claude/Codex/Antigravity tier would be a statement
  // no catalog made. Empty string, so those surfaces render nothing.
  for (const t of ['sonnet', 'opus', 'luna', 'flash']) {
    assert.equal(tierToolsNote(t), '')
  }
  // an OpenRouter tier the registry has never seen: NO CATALOG METADATA
  // IS AVAILABLE, which is exactly what unknown means. Silence here
  // would render the same blank as a fully-supported Claude tier.
  assert.equal(tierToolsNote('or-never-seen'), UNKNOWN)
  setOpenRouterTiers([])
})

test('image input and the reasoning parameter get the same three states, '
  + 'their own labels, and (catalog) on every one', () => {
  for (const [kind, words] of [
    ['image', [IMG_SUPPORTED, IMG_NOT, IMG_UNKNOWN]],
    ['reasoning', [RSN_SUPPORTED, RSN_NOT, RSN_UNKNOWN]],
  ] as const) {
    const [yes, no, unk] = words
    assert.equal(capabilityNote(kind, true), yes)
    assert.equal(capabilityNote(kind, false), no)
    assert.equal(capabilityNote(kind, null), unk)
    assert.equal(capabilityNote(kind, undefined), unk)
    // ⚠ THE SILENT-FALSE GUARD, per field: unknown must never render the
    // declared-false wording. The catalog said nothing, not "no".
    assert.notEqual(capabilityNote(kind, null), capabilityNote(kind, false))
    for (const v of [true, false, null] as const) {
      assert.match(capabilityNote(kind, v), /\(catalog\)$/)
      // and no wording may imply an observation, a delivery or a refusal.
      // Orgtree sends image blocks and --effort to every OpenRouter seat
      // regardless of these values; nothing here has watched a turn.
      assert.doesNotMatch(capabilityNote(kind, v),
        /observ|verified|will (?:be )?(?:work|refus|reject)|thinking is|effort/i)
    }
  }
  // the labels are DISTINCT, so three notes in one string stay readable and
  // a reader cannot mistake one field's answer for another's
  const labels = (['tools', 'image', 'reasoning'] as const)
    .map((k) => capabilityNote(k, true))
  assert.equal(new Set(labels).size, 3, labels.join(' | '))
  // ⚠ `toolsNote` STAYS TOOLS-ONLY (reviewer decision). A callsite that asks
  // for the tools phrase must not silently start receiving three.
  assert.equal(toolsNote(true), SUPPORTED)
  assert.ok(!toolsNote(true).includes('Image input'))
  assert.ok(!toolsNote(true).includes('Reasoning'))
})

test('capabilityNotes carries all three, and an absent field is unknown '
  + 'rather than skipped', () => {
  assert.equal(capabilityNotes({ tools: true, image: false, reasoning: null }),
    `${SUPPORTED} · ${IMG_NOT} · ${RSN_UNKNOWN}`)
  // an older backend's row has none of them: three unknowns, not a blank.
  // A skipped note would read as "this lane has no catalog", which is what
  // a static Claude tier renders, and these are different facts.
  assert.equal(capabilityNotes({}),
    `${UNKNOWN} · ${IMG_UNKNOWN} · ${RSN_UNKNOWN}`)
  assert.equal(capabilityNotes(null), capabilityNotes({}))
  // the three fields are read independently — a mutant wiring two of them to
  // the same source produces the same word twice here
  assert.equal(capabilityNotes({ tools: true, image: false, reasoning: true }),
    `${SUPPORTED} · ${IMG_NOT} · ${RSN_SUPPORTED}`)
})

test('tierCapabilityNotes answers for an OpenRouter tier and stays silent '
  + 'for every other lane', () => {
  setOpenRouterTiers([
    tier({ tier: 'or-a', model: 'v/a', tools: true, image: true, reasoning: true }),
    tier({ tier: 'or-b', model: 'v/b', tools: false, image: false, reasoning: false }),
    tier({ tier: 'or-c', model: 'v/c', tools: null, image: null, reasoning: null }),
    tier({ tier: 'or-d', model: 'v/d' }),           // an older backend: absent
  ])
  assert.equal(tierCapabilityNotes('or-a'),
    `${SUPPORTED} · ${IMG_SUPPORTED} · ${RSN_SUPPORTED}`)
  assert.equal(tierCapabilityNotes('or-b'),
    `${NOT_SUPPORTED} · ${IMG_NOT} · ${RSN_NOT}`)
  assert.equal(tierCapabilityNotes('or-c'),
    `${UNKNOWN} · ${IMG_UNKNOWN} · ${RSN_UNKNOWN}`)
  assert.equal(tierCapabilityNotes('or-d'), tierCapabilityNotes('or-c'))
  // static lanes: '' — the catalog is an OpenRouter fact and inventing one
  // for another provider would be a claim no catalog made
  for (const t of ['sonnet', 'opus', 'luna', 'flash']) {
    assert.equal(tierCapabilityNotes(t), '')
  }
  // a tier the registry has never seen has NO catalog metadata at all, which
  // is exactly unknown — and it must not collapse to the static-lane blank
  assert.equal(tierCapabilityNotes('or-never-seen'),
    `${UNKNOWN} · ${IMG_UNKNOWN} · ${RSN_UNKNOWN}`)
  assert.notEqual(tierCapabilityNotes('or-never-seen'), '')
  setOpenRouterTiers([])
})

// ── the picker and the favorites strip, through the real section ─────────

const CATALOG: OpenRouterModel[] = [
  { id: 'vendor/full', name: 'Full', label: 'full', vendor: 'vendor',
    prompt: 3, completion: 15, cache_read: 0.3, context: 200000,
    tools: true, image: true, reasoning: true,
    free: false, letter: 'F', color: '#8fc9e8', created: 0 },
  { id: 'vendor/textonly', name: 'Textonly', label: 'textonly', vendor: 'vendor',
    prompt: 0.1, completion: 0.2, cache_read: 0, context: 8192,
    tools: false, image: false, reasoning: false,
    free: false, letter: 'T', color: '#f9907f', created: 0 },
  { id: 'vendor/silent', name: 'Silent', label: 'silent', vendor: 'vendor',
    prompt: 1, completion: 2, cache_read: 0, context: 32768,
    tools: null, image: null, reasoning: null,
    free: false, letter: 'S', color: '#9fe3d1', created: 0 },
  // ⚠ THE MIXED ROW, and it is what makes the per-field assertions below
  // non-vacuous: every other row answers the same way on all three axes, so
  // a picker wired to print the TOOLS value three times would pass without
  // it. Tools yes, image no, reasoning unknown.
  { id: 'vendor/mixed', name: 'Mixed', label: 'mixed', vendor: 'vendor',
    prompt: 2, completion: 4, cache_read: 0, context: 65536,
    tools: true, image: false, reasoning: null,
    free: false, letter: 'M', color: '#c8b6e2', created: 0 },
]

function stubFetch(favorites: string[] = []) {
  // the wire shapes the real section reads (mirrors openrouter.test.tsx):
  // `/api/openrouter` is the doc, `/api/openrouter/models` is a PAGE with
  // `items`, and every model row carries `selected`.
  const favs = favorites.map((id) => CATALOG.find((c) => c.id === id)!)
  const doc = (): OpenRouterDoc => ({
    installed: true, connected: true, key_set: true, kind: 'api-key',
    label: 'sk-or-v1-abc\u2026xyz',
    credits: { limit: null, limit_remaining: null, usage: 0, usage_daily: 0,
      usage_weekly: 0, usage_monthly: 0, is_free_tier: null, checked_at: null },
    reason: null, favorites: favs.length, favorites_max: 0,
    tiers: favs.map((f) => tier({
      tier: `or-${f.id.replace(/[^a-z0-9]+/g, '-')}`, model: f.id,
      name: f.name, label: f.label, vendor: f.vendor, letter: f.letter,
      color: f.color, prompt: f.prompt, completion: f.completion,
      context: f.context, tools: f.tools,
      image: f.image, reasoning: f.reasoning,
    })),
    user_enabled: true,
  })
  g.fetch = (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    const method = init?.method ?? 'GET'
    let payload: unknown = null
    if (u.pathname === '/api/openrouter' && method === 'GET') payload = doc()
    else if (u.pathname === '/api/openrouter/models') {
      const items = CATALOG.map((m) => ({
        ...m, selected: favorites.includes(m.id) }))
      payload = { query: '', offset: 0, limit: 25, total: items.length, items }
    }
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${u.pathname}`))
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(payload),
    })
  }
}

const providerInfo = (tiers: ProviderTier[]): ProviderInfo => ({
  id: 'openrouter', label: 'OpenRouter', cli: 'REST API (via Claude Code)',
  tiers, hire_enabled: true, user_enabled: true, reason: null,
} as ProviderInfo)

test('the picker distinguishes all three states, and the favourite strip '
  + 'carries the note the picker used to keep to itself', async () => {
  stubFetch(['vendor/textonly'])
  const view = await mountView(
    <OpenRouterSection
      provider={providerInfo([tier({
        tier: 'or-vendor-textonly', model: 'vendor/textonly', name: 'Textonly',
        label: 'textonly', letter: 'T', context: 8192, tools: false })])}
      toast={() => {}} pickerOpen setPickerOpen={() => {}} onChanged={() => {}} />,
    (el) => el)
  await inAct(async () => { await flush() })
  const root = view.el
  const text = root.textContent ?? ''

  // the declared-tool-less model says so, and the silent one says UNKNOWN —
  // the two used to render the identical ' · no tool use'
  assert.ok(text.includes(NOT_SUPPORTED), `picker text: ${text.slice(0, 400)}`)
  assert.ok(text.includes(UNKNOWN), `picker text: ${text.slice(0, 400)}`)

  // ⚠ POSITIVE CONTROL FOR THE ABSENCES ABOVE: every row IS rendered, so a
  // missing string means the note is missing, not the row.
  for (const m of CATALOG) assert.ok(text.includes(m.name), `row ${m.name}`)

  // every row states its declaration somewhere a person can reach it — the
  // dense dim line prints it only where it is news, so the supported row
  // carries it in the tooltip rather than nothing at all
  const titles = Array.from(root.querySelectorAll('.orr-row'))
    .map((n) => n.getAttribute('title') ?? '')
  // (substring, not equality: since unit C the tooltip carries all three
  // declarations joined, so the tools phrase is one part of a longer string)
  assert.ok(titles.some((t) => t.includes(SUPPORTED)),
    `row titles: ${JSON.stringify(titles)}`)
  assert.ok(titles.some((t) => t.includes(NOT_SUPPORTED)),
    `row titles: ${JSON.stringify(titles)}`)
  assert.ok(titles.some((t) => t.includes(UNKNOWN)),
    `row titles: ${JSON.stringify(titles)}`)

  // the SELECTED favourite's own chip carries it too — the surface that had
  // nothing at all before this change
  const sel = Array.from(root.querySelectorAll('.orr-sel'))
    .map((n) => n.getAttribute('title') ?? '')
  assert.ok(sel.some((t) => t.includes(NOT_SUPPORTED)),
    `selected strip titles: ${JSON.stringify(sel)}`)

  // ⚠ AND IT IS STILL SELECTABLE. Disclosure, never admission control: the
  // declared-tool-less row is not disabled and not removed.
  const rows = Array.from(root.querySelectorAll('.orr-row'))
  const textRow = rows.find((n) => (n.textContent ?? '').includes('Textonly'))
  assert.ok(textRow, 'the text-only row is offered at all')
  assert.equal((textRow as HTMLButtonElement).disabled, false,
    'a text-only model must remain selectable')

  // ── unit C: image input and the reasoning parameter, same surfaces ─────
  const rowNamed = (name: string) => {
    const r = rows.find((n) => (n.textContent ?? '').includes(name))
    assert.ok(r, `the ${name} row is rendered at all`)   // positive control
    return r!
  }
  // the TOOLTIP states all three on every row, so a row whose dense line
  // prints nothing is never ambiguous about which state it is in
  const titleOf = (name: string) => rowNamed(name).getAttribute('title') ?? ''
  assert.ok(titleOf('Full').includes(IMG_SUPPORTED), titleOf('Full'))
  assert.ok(titleOf('Full').includes(RSN_SUPPORTED), titleOf('Full'))
  assert.ok(titleOf('Textonly').includes(IMG_NOT), titleOf('Textonly'))
  assert.ok(titleOf('Textonly').includes(RSN_NOT), titleOf('Textonly'))
  assert.ok(titleOf('Silent').includes(IMG_UNKNOWN), titleOf('Silent'))
  assert.ok(titleOf('Silent').includes(RSN_UNKNOWN), titleOf('Silent'))
  // ⚠ THE MIXED ROW IS THE NON-VACUOUS ONE: three DIFFERENT answers in one
  // tooltip. A picker printing the tools value three times fails here.
  const mixed = titleOf('Mixed')
  assert.ok(mixed.includes(SUPPORTED), mixed)
  assert.ok(mixed.includes(IMG_NOT), mixed)
  assert.ok(mixed.includes(RSN_UNKNOWN), mixed)

  // the DENSE inline line prints image only where it is news — declared-not
  // or unknown — and stays quiet when it is supported, the same rule tools
  // already follows. Reasoning is title-only here (reviewer decision).
  const lineOf = (name: string) =>
    rowNamed(name).querySelector('.orr-name .dim')?.textContent ?? ''
  assert.ok(lineOf('Textonly').includes(IMG_NOT), lineOf('Textonly'))
  assert.ok(lineOf('Silent').includes(IMG_UNKNOWN), lineOf('Silent'))
  assert.ok(lineOf('Mixed').includes(IMG_NOT), lineOf('Mixed'))
  assert.ok(!lineOf('Full').includes('Image input'),
    `a supported image row stays quiet inline: ${lineOf('Full')}`)
  for (const n of ['Full', 'Textonly', 'Silent', 'Mixed']) {
    assert.ok(!lineOf(n).includes('Reasoning parameter'),
      `reasoning is title-only in the picker: ${lineOf(n)}`)
  }

  // the SELECTED favourite's chip carries all three too
  const selCaps = Array.from(root.querySelectorAll('.orr-sel'))
    .map((n) => n.getAttribute('title') ?? '')
  assert.ok(selCaps.some((t) => t.includes(IMG_NOT) && t.includes(RSN_NOT)),
    `selected strip titles: ${JSON.stringify(selCaps)}`)
  await view.unmount()
})
