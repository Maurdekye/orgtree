// App settings → Providers → Language Server (user 2026-10-10, batch 2):
// a server is one read-only line until ✎ (the OpenRouter key row's shape,
// its offered models as chips), ✎ is a draft that Save sends and Cancel
// drops, the models are chosen in a browser that holds hundreds, and the
// window a server really runs is said wherever it differs from the one
// agents are told. Since 2026-10-10 evening ("i should be able to click to
// change the models available without editing the entry"): a click on a
// card's chip offers or withdraws the model at once, a short list shows every
// model, a long one stays behind "+", and more than eight offered are cards
// alone. Driven through the rendered controls against a scripted fetch.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { LanguageServerSection } from '../src/canvas/langserver'
import type { LangServer, LangServerDoc, LangServerProbeModel } from '../src/types'

type Seen = { method: string; path: string; body: Record<string, unknown> | null }
const g = globalThis as unknown as Record<string, unknown>

const LATEST = 'qwen3.6-35b-a3b:latest'
const V64 = 'qwen3.6-35b-a3b:latest-64k'

/** 300 more models: every 3rd thinks, every 2nd uses tools, sizes 1–30 GB, windows 32K–256K */
const MANY: LangServerProbeModel[] = Array.from({ length: 300 }, (_, i) => ({
  id: `model-${String(i).padStart(3, '0')}:7b`, size: (1 + (i % 30)) * 1e9, max_context: [32768, 65536, 131072, 262144][i % 4],
  parameters: '7B', quantization: 'Q4_K_M', family: 'fake', tools: i % 2 === 0,
  capabilities: ['completion', ...(i % 2 === 0 ? ['tools'] : []), ...(i % 3 === 0 ? ['thinking'] : [])],
}))
const OFFERED: LangServerProbeModel[] = [
  { id: LATEST, size: 13.2e9, max_context: 262144, family: 'qwen35moe', parameters: '34.7B', quantization: 'IQ3_XXS',
    tools: true, capabilities: ['completion', 'tools', 'thinking'], loaded_context: 4096 },
  { id: V64, size: 13.2e9, max_context: 262144, family: 'qwen35moe', parameters: '34.7B', quantization: 'IQ3_XXS',
    tools: true, capabilities: ['completion', 'tools', 'thinking'], configured_context: 65536 },
]

/** the user's own Ollama (2026-10-10): two Qwen 3.6 models offered, two Qwen 3.8 ones not */
const Q38 = 'qwen3.8-27b:latest'
const Q38V = 'qwen3.8-27b:latest-64k'
const SHORT: LangServerProbeModel[] = [...OFFERED,
  { id: Q38, size: 10.2e9, max_context: 262144, family: 'qwen3', parameters: '27B', quantization: 'IQ3_XXS',
    tools: true, capabilities: ['completion', 'tools', 'thinking'] },
  { id: Q38V, size: 10.2e9, max_context: 262144, family: 'qwen3', parameters: '27B', quantization: 'IQ3_XXS',
    tools: true, capabilities: ['completion', 'tools', 'thinking'], configured_context: 65536 },
]

const stored = (id: string, offered = true) => ({ id, tier: `ls-ollama-${id}`, label: id, offered, context: 65536,
  context_in_use: 65536, too_small: false })

function server(ids: string[] = [LATEST, V64]): LangServer {
  return {
    id: 'ollama', preset: 'ollama', label: 'Ollama', address: 'http://127.0.0.1:11434', harness: 'claude-code',
    api: 'anthropic', base_path: '', base_url: 'http://127.0.0.1:11434', max_agents: 1, seat: 1, enabled: true,
    key_set: false, created_at: '2026-10-10T08:00:00Z',
    models: Object.fromEntries(ids.map((id) => [id, stored(id)])),
  }
}

/** a scripted engine: the server lists `list` (302 models by default), or does not answer */
function stubFetch(seen: Seen[], opts: { list?: LangServerProbeModel[], down?: boolean, offered?: string[], second?: boolean, keySet?: boolean } = {}) {
  const s = server(opts.offered)
  s.key_set = opts.keySet ?? false
  const other = { ...server(), id: 'other', label: 'Other server' }
  const doc = (): LangServerDoc => ({
    servers: opts.second ? [s, other] : [s],
    presets: [{ id: 'ollama', label: 'Ollama', address: 'http://127.0.0.1:11434', claude: true, codex: true,
      harnesses: [{ id: 'claude-code', label: 'Claude Code', available: true, why: '' }],
      note: 'Ollama 0.14 or later serves both harnesses.' }] as unknown as LangServerDoc['presets'],
    default_seat: 1, max_seat: 100, min_context: 65536, default_context: 65536, user_enabled: true,
  })
  g.fetch = (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    const path = u.pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    seen.push({ method, path, body })
    let payload: unknown = null
    if (path === '/api/langservers' && method === 'GET') payload = doc()
    else if (path === '/api/langservers/probe') {
      const only = (body?.only as string[] | undefined) ?? []
      const all = opts.list ?? [...OFFERED, ...MANY]
      payload = opts.down
        ? { reachable: false, error: 'nothing is answering at that address (is the server running?)', models: [] }
        : { reachable: true, version: '0.40.2', listed: all.length, models: only.length ? all.filter((m) => only.includes(m.id)) : all }
    } else if (path === '/api/langservers' && method === 'POST') {
      payload = { server: s, doc: doc() }
    } else if (path === '/api/langservers/ollama' && method === 'PATCH') {
      const b = body as Record<string, unknown>
      for (const k of ['label', 'address', 'max_agents', 'seat', 'enabled'] as const) {
        if (k in b) (s as unknown as Record<string, unknown>)[k] = b[k]
      }
      for (const m of (b.models as { id: string, offered: boolean, context?: number }[] | undefined) ?? []) {
        const cur = s.models[m.id] ?? { id: m.id, tier: `ls-ollama-${m.id}`, label: m.id, offered: false, context: null,
          context_in_use: 65536, too_small: false }
        s.models[m.id] = { ...cur, offered: m.offered, ...(m.context ? { context: m.context, context_in_use: m.context } : {}) }
      }
      payload = { server: s, doc: doc(), repriced: 'seat' in b ? [{ org: 'demo', repriced: [{ node: 'lsa', from: 1, to: b.seat }] }] : [] }
    }
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${path}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload) })
  }
}

async function mountSection(toasts: string[][]) {
  const view = await mountView(<LanguageServerSection provider={undefined} toast={(l) => toasts.push(l)} />, (el) => el)
  await inAct(async () => { await flush(12) })
  return view
}
const typeInto = async (input: HTMLInputElement, value: string) => inAct(async () => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flush(2)
})
const choose = async (select: HTMLSelectElement, value: string) => inAct(async () => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')!.set!
  setter.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flush(2)
})
const click = async (el: Element | null | undefined) => {
  assert.ok(el, 'the control is there')
  await inAct(async () => { (el as HTMLElement).click(); await flush(8) })
}

test('§1 a server is one read-only line: name · preset · harness · address, ⟳ ✎ ✕, a digest, its models as chips; '
  + 'the window Ollama really runs is said where it differs from the one agents are told', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const toasts: string[][] = []
  const view = await mountSection(toasts)
  try {
    const card = view.el.querySelector('.ls-server')!
    assert.ok(card, 'the server card renders')
    const row = card.querySelector('.acct-line > .acct-row.ls-server-row')!
    assert.ok(row, 'the server is an account row, like the OpenRouter key row')
    assert.equal(row.querySelector('.ls-server-head')?.textContent, 'Ollama · Ollama · Claude Code · http://127.0.0.1:11434')
    const btns = [...row.querySelectorAll<HTMLButtonElement>('.acct-main > .acct-btn')]
    assert.equal(btns.length, 3, '⟳ ✎ ✕')
    for (const b of btns) {
      assert.equal(b.textContent?.trim(), '', `an icon button carries no words (${b.title})`)
      assert.ok(b.querySelector('svg'), 'an icon button carries an icon')
    }
    const digest = [...row.querySelectorAll('.acct-provenance span')].map((x) => x.textContent)
    assert.deepEqual(digest.slice(0, 5), ['on', '1 at once', '2 models', 'key: none', 'seat 1'])
    assert.ok(digest.includes('answering · version 0.40.2 · 302 models on the server'), digest.join(' | '))
    assert.equal(card.querySelectorAll('input:not([type="checkbox"]), select, textarea').length, 0,
      'configuration stays in the dialog; only the direct server switch is editable')
    const chips = [...card.querySelectorAll('.ls-toggles .orr-tog')]
    assert.deepEqual(chips.map((c) => c.querySelector('.orr-card')?.textContent), ['Q', 'Q'], 'letters from the models')
    assert.deepEqual(chips.map((c) => c.querySelector('.orr-sel-name')?.textContent), [LATEST, V64])
    assert.deepEqual(chips.map((c) => c.getAttribute('aria-pressed')), ['true', 'true'], 'both offered: lit')
    assert.equal(chips[0]!.getAttribute('title'), `${LATEST} · agents are told 64K\n`
      + 'click to withdraw it: no new hires on it; agents already on it keep running')
    assert.equal(card.querySelector('.ls-toggles .orr-more')?.textContent, '+300 more',
      'a list longer than the row holds stays behind "+"')
    // the check asked about the models the card knows only, and loaded nothing
    const checks = seen.filter((r) => r.path === '/api/langservers/probe')
    assert.deepEqual(checks.map((r) => r.body), [{ server: 'ollama', only: [LATEST, V64] }], 'one check: 302 is too many to list')
    const lines = [...card.querySelectorAll('.ls-mismatch-line')].map((x) => x.textContent)
    assert.deepEqual(lines, [`${LATEST}: the server runs it with 4K, but agents are told 64K`],
      'the plain model runs at 4K (Ollama /api/ps); the 64K version agrees')
  } finally { await view.unmount(); delete g.fetch }
})

test('§2 ✎ opens a draft: Cancel drops it and sends nothing; Save sends only what changed', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const toasts: string[][] = []
  const view = await mountSection(toasts)
  try {
    const edit = () => view.el.querySelector<HTMLButtonElement>('.ls-server-row button[title="edit this server"]')
    await click(edit())
    const form = document.querySelector('.ls-edit')!
    assert.ok(form, 'the draft form opens')
    assert.ok(form.closest('[role="dialog"][aria-label="Configure Ollama"]'))
    assert.equal(view.el.contains(form), false, 'configuration is outside the Providers section')
    for (const l of ['server name', 'server address', 'agents at once', 'seat price', 'API key']) {
      assert.ok(form.querySelector(`input[aria-label="${l}"]`), `the form has ${l}`)
    }
    assert.ok(form.textContent?.includes('offer this server’s models to new hires'), 'the offer toggle')
    await typeInto(form.querySelector<HTMLInputElement>('input[aria-label="seat price"]')!, '2')
    await typeInto(form.querySelector<HTMLInputElement>('input[aria-label="agents at once"]')!, '3')
    assert.ok(form.textContent?.includes('unsaved changes'))
    await click([...form.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    assert.equal(document.querySelector('.ls-edit'), null, 'Cancel closes the draft')
    assert.equal(seen.filter((r) => r.method === 'PATCH').length, 0, 'Cancel sends nothing')
    assert.ok([...view.el.querySelectorAll('.acct-provenance span')].some((s) => s.textContent === 'seat 1'), 'the summary keeps seat 1')
    await click(edit())
    await typeInto(document.querySelector<HTMLInputElement>('.ls-edit input[aria-label="seat price"]')!, '2')
    await click([...document.querySelectorAll('.ls-edit button')].find((b) => b.textContent === 'Save'))
    const patches = seen.filter((r) => r.method === 'PATCH')
    assert.equal(patches.length, 1, 'one PATCH')
    assert.deepEqual(patches[0]!.body, { seat: 2 }, 'only the seat changed')
    assert.equal(document.querySelector('.ls-edit'), null, 'Save closes the draft')
    assert.deepEqual(toasts.at(-1), ['saved Ollama · 1 agent repriced'])
    assert.ok([...view.el.querySelectorAll('.acct-provenance span')].some((s) => s.textContent === 'seat 2'))
  } finally { await view.unmount(); delete g.fetch }
})

test('§3 the browser holds 302 models: offered ones pinned first, 25 a page, search and filters narrow, '
  + 'offer and withdraw change the draft only; Save sends those changes', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mountSection([])
  try {
    await click(view.el.querySelector('.ls-server-row button[title="edit this server"]'))
    await click(document.querySelector('.ls-edit .ls-favs'))
    const dialog = document.querySelector('[aria-label="Language Server model selection"]')!
    assert.ok(dialog, 'the browser opens')
    assert.ok(seen.some((r) => r.path === '/api/langservers/probe' && r.body && !('only' in r.body)), 'the whole list is asked for')
    const h3 = () => dialog.querySelector('h3')?.textContent
    assert.equal(h3(), 'Models on Ollama · 2 offered')
    const names = () => [...dialog.querySelectorAll('.orr-row .orr-name b')].map((b) => b.textContent)
    assert.equal(names().length, 25, 'one page')
    assert.deepEqual(names().slice(0, 3), [LATEST, V64, 'model-000:7b'], 'the offered models lead')
    assert.equal(dialog.querySelector('.orr-pager .dim')?.textContent, '1–25 of 302')
    assert.equal(dialog.querySelector('.ls-count')?.textContent, '302 models on the server')
    // the plain model's row says what Ollama really runs it with
    assert.ok(dialog.querySelector('.orr-row .ls-mismatch')?.textContent?.includes('the server runs it with 4K'))
    const search = dialog.querySelector<HTMLInputElement>('input[aria-label="search the server\'s models"]')!
    await typeInto(search, 'model-29')
    assert.deepEqual(names(), Array.from({ length: 10 }, (_, i) => `model-29${i}:7b`))
    assert.equal(dialog.querySelector('.ls-count')?.textContent, '10 of 302 models match')
    await typeInto(search, '')
    await click(dialog.querySelector('input[aria-label="thinking only"]'))
    assert.ok(names().every((n) => n === LATEST || n === V64 || Number(n!.slice(6, 9)) % 3 === 0), 'thinking models only')
    await choose(dialog.querySelector<HTMLSelectElement>('select[aria-label="trained window at least"]')!, '262144')
    assert.ok(names().length > 2 && names().every((n) => n === LATEST || n === V64 || Number(n!.slice(6, 9)) % 12 === 3),
      'and trained for 256K (thinking: every 3rd, 256K: every 4th from 3)')
    await click(dialog.querySelector('input[aria-label="thinking only"]'))
    await choose(dialog.querySelector<HTMLSelectElement>('select[aria-label="trained window at least"]')!, '0')
    // offer one, withdraw one: only the draft changes
    const rowOf = (id: string) => [...dialog.querySelectorAll('.orr-row')].find((r) => r.querySelector('b')?.textContent === id)
    await click(rowOf('model-000:7b')?.querySelector('button.ls-offer'))
    assert.equal(h3(), 'Models on Ollama · 3 offered')
    assert.ok(rowOf('model-000:7b')?.querySelector('input[aria-label="model-000:7b context window in tokens"]'),
      'an offered model carries its window')
    assert.equal((rowOf('model-000:7b')?.querySelector('input') as HTMLInputElement).value, '32768',
      'it starts at the window it was trained for')
    assert.ok(rowOf('model-000:7b')?.textContent?.includes('too small for an agent'))
    await click(dialog.querySelector(`.orr-selected button[aria-label="withdraw ${LATEST}"]`))
    assert.equal(h3(), 'Models on Ollama · 2 offered')
    assert.equal(seen.filter((r) => r.method === 'PATCH').length, 0, 'nothing is sent from the browser')
    await click([...dialog.querySelectorAll('.orr-pager button')].find((b) => b.textContent === 'done'))
    await click([...document.querySelectorAll('.ls-edit button')].find((b) => b.textContent === 'Save'))
    const patch = seen.find((r) => r.method === 'PATCH')
    assert.deepEqual(patch?.body, { models: [{ id: LATEST, offered: false }, { id: 'model-000:7b', offered: true, context: 32768 }] })
  } finally { await view.unmount(); delete g.fetch }
})

const chipsOf = (el: Element) => [...el.querySelectorAll<HTMLButtonElement>('.ls-toggles .orr-tog')]
const nameOf = (c: Element) => c.querySelector('.orr-sel-name')?.textContent ?? c.getAttribute('aria-label')
const chipNamed = (el: Element, id: string) => chipsOf(el).find((c) => nameOf(c) === id)
const pressed = (el: Element) => chipsOf(el).map((c) => [nameOf(c), c.getAttribute('aria-pressed')])

test('§4 a click on a chip withdraws its model at once, and a second click offers it again with the window it had; '
  + 'nothing opens, and the server is not asked again', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const toasts: string[][] = []
  const view = await mountSection(toasts)
  try {
    const probes = () => seen.filter((r) => r.path === '/api/langservers/probe').length
    const patches = () => seen.filter((r) => r.method === 'PATCH').map((r) => r.body)
    const before = probes()
    await click(chipNamed(view.el, LATEST))
    assert.deepEqual(patches(), [{ models: [{ id: LATEST, offered: false }] }])
    assert.deepEqual(pressed(view.el), [[LATEST, 'false'], [V64, 'true']], 'withdrawn: dimmed, in its place')
    assert.deepEqual(toasts.at(-1), [`${LATEST} is withdrawn: no new hires on it; agents already on it keep running`])
    assert.equal(document.querySelector('.ls-edit'), null, 'no edit form')
    assert.equal(document.querySelector('[aria-label="Language Server model selection"]'), null, 'no browser')
    const digest = [...view.el.querySelectorAll('.acct-provenance span')].map((x) => x.textContent)
    assert.ok(digest.includes('1 model'), digest.join(' | '))
    await click(chipNamed(view.el, LATEST))
    assert.deepEqual(patches()[1], { models: [{ id: LATEST, offered: true }] }, 'a known model keeps its window')
    assert.deepEqual(pressed(view.el), [[LATEST, 'true'], [V64, 'true']])
    assert.deepEqual(toasts.at(-1), [`${LATEST} is offered to new hires`])
    assert.equal(probes(), before, 'switching a known model asks the server nothing')
  } finally { await view.unmount(); delete g.fetch }
})

test('§5 a server listing at most 12 models shows them all, the ones not offered dimmed; a click offers one '
  + 'with the window it would start with in the browser', async () => {
  const seen: Seen[] = []
  stubFetch(seen, { list: SHORT })
  const toasts: string[][] = []
  const view = await mountSection(toasts)
  try {
    const checks = seen.filter((r) => r.path === '/api/langservers/probe').map((r) => r.body)
    assert.deepEqual(checks, [{ server: 'ollama', only: [LATEST, V64] }, { server: 'ollama' }],
      'the known models first; the server lists 4, so the whole list next')
    assert.deepEqual(pressed(view.el), [[LATEST, 'true'], [V64, 'true'], [Q38, 'false'], [Q38V, 'false']])
    assert.equal(chipNamed(view.el, Q38)!.getAttribute('title'),
      `${Q38} · qwen3 · 27B · IQ3_XXS · 10.2 GB · trained for 256K · thinking\nclick to offer it to new hires`)
    assert.equal(view.el.querySelector('.ls-toggles .orr-more')?.textContent, '+', 'nothing hidden: "+" alone, for the browser')
    await click(chipNamed(view.el, Q38V))
    assert.deepEqual(seen.filter((r) => r.method === 'PATCH').map((r) => r.body),
      [{ models: [{ id: Q38V, offered: true, context: 65536 }] }], 'the window its Modelfile sets')
    assert.deepEqual(pressed(view.el), [[LATEST, 'true'], [V64, 'true'], [Q38, 'false'], [Q38V, 'true']])
    assert.deepEqual(toasts.at(-1), [`${Q38V} is offered to new hires`])
  } finally { await view.unmount(); delete g.fetch }
})

test('§6 a server that is not answering: the models the card knows can still be switched; no "+"', async () => {
  const seen: Seen[] = []
  stubFetch(seen, { down: true })
  const view = await mountSection([])
  try {
    assert.ok(view.el.querySelector('.acct-dead')?.textContent?.startsWith('not answering'), 'the digest says so')
    assert.deepEqual(pressed(view.el), [[LATEST, 'true'], [V64, 'true']])
    assert.equal(view.el.querySelector('.ls-toggles .orr-more'), null, 'nothing to browse')
    await click(chipNamed(view.el, V64))
    assert.deepEqual(seen.filter((r) => r.method === 'PATCH').map((r) => r.body), [{ models: [{ id: V64, offered: false }] }])
    assert.deepEqual(pressed(view.el), [[LATEST, 'true'], [V64, 'false']])
  } finally { await view.unmount(); delete g.fetch }
})

test('§7 more than eight offered: the chips are their cards alone, the name in the tooltip and the label; '
  + 'at eight the names come back', async () => {
  const seen: Seen[] = []
  stubFetch(seen, { offered: MANY.slice(0, 10).map((m) => m.id) })
  const view = await mountSection([])
  try {
    const row = () => view.el.querySelector('.ls-toggles')!
    assert.ok(row().classList.contains('icons'), 'ten offered: icons only')
    assert.equal(row().querySelectorAll('.orr-sel-name').length, 0, 'no names')
    assert.equal(chipsOf(view.el).length, 10)
    assert.equal(chipsOf(view.el)[0]!.getAttribute('aria-label'), 'model-000:7b')
    assert.ok(chipsOf(view.el)[0]!.getAttribute('title')?.startsWith('model-000:7b · agents are told 64K\n'))
    assert.equal(row().querySelector('.orr-more')?.textContent, '+292 more')
    await click(chipNamed(view.el, 'model-000:7b'))
    assert.ok(row().classList.contains('icons'), 'nine offered: still icons only')
    await click(chipNamed(view.el, 'model-001:7b'))
    assert.ok(!row().classList.contains('icons'), 'eight offered: names')
    assert.equal(row().querySelectorAll('.orr-sel-name').length, 10, 'every chip named, the two withdrawn dimmed')
  } finally { await view.unmount(); delete g.fetch }
})

test('§8 "+" opens the browser saving at once: an offer when clicked, a window when its field is left or Enter is '
  + 'pressed, a withdrawal at its ✕; the card follows', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const toasts: string[][] = []
  const view = await mountSection(toasts)
  try {
    await click(view.el.querySelector('.ls-toggles .orr-more'))
    const dialog = document.querySelector('[aria-label="Language Server model selection"]')!
    assert.ok(dialog, 'the browser opens')
    assert.equal(document.querySelector('.ls-edit'), null, 'without the edit form')
    const h3 = () => dialog.querySelector('h3')?.textContent
    assert.equal(h3(), 'Models on Ollama · 2 offered · each change is saved at once')
    const patches = () => seen.filter((r) => r.method === 'PATCH').map((r) => r.body)
    const rowOf = (id: string) => [...dialog.querySelectorAll('.orr-row')].find((r) => r.querySelector('b')?.textContent === id)
    await click(rowOf('model-000:7b')?.querySelector('button.ls-offer'))
    assert.deepEqual(patches(), [{ models: [{ id: 'model-000:7b', offered: true, context: 32768 }] }], 'sent at once')
    assert.equal(h3(), 'Models on Ollama · 3 offered · each change is saved at once')
    const field = () => rowOf('model-000:7b')!.querySelector<HTMLInputElement>('input')!
    await typeInto(field(), '65536')
    assert.equal(patches().length, 1, 'typing sends nothing')
    assert.ok(!rowOf('model-000:7b')!.textContent?.includes('too small for an agent'), 'the typed window is judged')
    await inAct(async () => {
      field().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flush(8)
    })
    assert.deepEqual(patches()[1], { models: [{ id: 'model-000:7b', offered: true, context: 65536 }] }, 'Enter sends it')
    assert.deepEqual(toasts.at(-1), ['model-000:7b: agents are told 64K'])
    await typeInto(field(), '131072')
    await inAct(async () => { field().dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); await flush(8) })
    assert.deepEqual(patches()[2], { models: [{ id: 'model-000:7b', offered: true, context: 131072 }] }, 'leaving the field sends it')
    await click(dialog.querySelector(`.orr-selected button[aria-label="withdraw ${LATEST}"]`))
    assert.deepEqual(patches()[3], { models: [{ id: LATEST, offered: false }] })
    await click([...dialog.querySelectorAll('.orr-pager button')].find((b) => b.textContent === 'done'))
    assert.equal(document.querySelector('[aria-label="Language Server model selection"]'), null, 'done closes it')
    assert.deepEqual(pressed(view.el), [['model-000:7b', 'true'], [LATEST, 'false'], [V64, 'true']], 'the card follows')
  } finally { await view.unmount(); delete g.fetch }
})


test('add dialog: adding a server opens a separate dialog; Cancel discards and Save keeps the original payload', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mountSection([])
  const add = () => view.el.querySelector('button[title^="add a model server"]')
  const dialog = () => document.querySelector('[role="dialog"][aria-label="Add language server"]')
  try {
    assert.equal(dialog(), null)
    await click(add())
    assert.ok(dialog())
    assert.equal(view.el.querySelector('.ls-add'), null, 'no inline form remains')
    await typeInto(dialog()!.querySelector<HTMLInputElement>('input[aria-label="server address"]')!, 'http://discard.test')
    await click([...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Cancel'))
    assert.equal(dialog(), null)
    assert.equal(seen.filter(r => r.path === '/api/langservers' && r.method === 'POST').length, 0)
    await click(add())
    assert.equal(dialog()!.querySelector<HTMLInputElement>('input[aria-label="server address"]')!.value, 'http://127.0.0.1:11434')
    await click([...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Add server'))
    assert.equal(dialog(), null, 'successful add closes only the dialog')
    assert.deepEqual(seen.find(r => r.path === '/api/langservers' && r.method === 'POST')?.body,
      { preset: 'ollama', address: 'http://127.0.0.1:11434', harness: 'claude-code', max_agents: 1, seat: 1, models: [] })
    assert.ok(view.el.querySelector('.ls-section'), 'Providers remains mounted')
  } finally { await view.unmount(); delete g.fetch }
})

test('nested dialogs: Escape closes the model picker before the edit dialog and discards no saved settings', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mountSection([])
  const escape = () => inAct(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flush(3)
  })
  try {
    await click(view.el.querySelector('.ls-server-row button[title="edit this server"]'))
    await typeInto(document.querySelector<HTMLInputElement>('.ls-edit input[aria-label="seat price"]')!, '7')
    await click(document.querySelector('.ls-edit .ls-favs'))
    assert.ok(document.querySelector('[aria-label="Language Server model selection"]'))
    await escape()
    assert.equal(document.querySelector('[aria-label="Language Server model selection"]'), null)
    assert.equal(document.querySelector<HTMLInputElement>('.ls-edit input[aria-label="seat price"]')!.value, '7')
    await escape()
    assert.equal(document.querySelector('.provider-dialog'), null)
    assert.equal(seen.filter(r => r.method === 'PATCH').length, 0)
    assert.ok(view.el.querySelector('.ls-section'))
  } finally { await view.unmount(); delete g.fetch }
})

test('save lifecycle: a pending save cannot be dismissed; a rejected save keeps the draft for correction', async () => {
  const seen: Seen[] = []
  stubFetch(seen)
  const original = g.fetch as typeof fetch
  let rejectSave: ((e: Error) => void) | undefined
  g.fetch = (url: string, init?: RequestInit) => init?.method === 'PATCH'
    ? new Promise((_resolve, reject) => { rejectSave = reject }) : original(url, init)
  const toasts: string[][] = []
  const view = await mountSection(toasts)
  try {
    await click(view.el.querySelector('.ls-server-row button[title="edit this server"]'))
    await typeInto(document.querySelector<HTMLInputElement>('.ls-edit input[aria-label="seat price"]')!, '7')
    await click([...document.querySelectorAll('.ls-edit button')].find(b => b.textContent === 'Save'))
    assert.ok(rejectSave)
    await inAct(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      await flush(3)
    })
    assert.ok(document.querySelector('.ls-edit'), 'in-flight save keeps dialog open')
    assert.ok([...document.querySelectorAll<HTMLButtonElement>('.ls-edit button')].find(b => b.textContent === 'Cancel')!.disabled)
    await inAct(async () => { rejectSave!(new Error('synthetic save failure')); await flush(8) })
    assert.equal(document.querySelector<HTMLInputElement>('.ls-edit input[aria-label="seat price"]')!.value, '7')
    assert.ok(toasts.flat().some(t => t.includes('synthetic save failure')))
  } finally { await view.unmount(); delete g.fetch }
})


test('direct server switch changes only that server enabled flag and preserves configuration', async () => {
  const seen: Seen[] = []
  stubFetch(seen, { second: true, keySet: true })
  const view = await mountSection([])
  try {
    const toggle = () => view.el.querySelector<HTMLInputElement>('input[aria-label="Use Ollama"]')!
    const other = () => view.el.querySelector<HTMLInputElement>('input[aria-label="Use Other server"]')!
    assert.equal(toggle().checked, true)
    await click(toggle())
    assert.equal(toggle().checked, false)
    assert.equal(other().checked, true)
    assert.equal(document.querySelector('.provider-dialog'), null, 'direct switch needs no configuration dialog')
    assert.ok(view.el.querySelector('.ls-server .ls-digest')!.textContent?.includes('key: set'))
    assert.ok(view.el.textContent?.includes(LATEST), 'offered model configuration retained')
    await click(toggle())
    assert.equal(toggle().checked, true)
    assert.equal(other().checked, true)
    assert.deepEqual(seen.filter(r => r.method === 'PATCH').map(r => ({ path: r.path, body: r.body })), [
      { path: '/api/langservers/ollama', body: { enabled: false } },
      { path: '/api/langservers/ollama', body: { enabled: true } },
    ])
    assert.equal(seen.filter(r => r.method === 'DELETE' || r.path.endsWith('/key')).length, 0)
  } finally { await view.unmount(); delete g.fetch }
})
