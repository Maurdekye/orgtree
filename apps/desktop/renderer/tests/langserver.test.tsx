// App settings → Providers → Language Server (user 2026-10-10, batch 2):
// a server is one read-only line until ✎ (the OpenRouter key row's shape,
// its offered models as chips), ✎ is a draft that Save sends and Cancel
// drops, the models are chosen in a browser that holds hundreds, and the
// window a server really runs is said wherever it differs from the one
// agents are told. Driven through the rendered controls against a scripted
// fetch.

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

function server(): LangServer {
  const model = (id: string, tier: string) => ({ id, tier, label: id, offered: true, context: 65536,
    context_in_use: 65536, too_small: false })
  return {
    id: 'ollama', preset: 'ollama', label: 'Ollama', address: 'http://127.0.0.1:11434', harness: 'claude-code',
    api: 'anthropic', base_path: '', base_url: 'http://127.0.0.1:11434', max_agents: 1, seat: 1, enabled: true,
    key_set: false, created_at: '2026-10-10T08:00:00Z',
    models: { [LATEST]: model(LATEST, 'ls-ollama-qwen3-6-35b-a3b-latest'), [V64]: model(V64, 'ls-ollama-qwen3-6-35b-a3b-latest-64k') },
  }
}

function stubFetch(seen: Seen[]) {
  const s = server()
  const doc = (): LangServerDoc => ({
    servers: [s],
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
      const all = [...OFFERED, ...MANY]
      payload = { reachable: true, version: '0.40.2', listed: all.length,
        models: only.length ? all.filter((m) => only.includes(m.id)) : all }
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
    assert.equal(card.querySelectorAll('input, select, textarea').length, 0, 'nothing is editable before ✎')
    const chips = [...card.querySelectorAll('.ls-favs .ls-chip')]
    assert.deepEqual(chips.map((c) => c.querySelector('.orr-card')?.textContent), ['Q', 'Q'], 'letters from the models')
    assert.deepEqual(chips.map((c) => c.querySelector('.orr-sel-name')?.textContent), [LATEST, V64])
    assert.equal(chips[0]!.getAttribute('title'), `${LATEST} · agents are told 64K`)
    // the check asked about the offered models only, and loaded nothing
    const check = seen.find((r) => r.path === '/api/langservers/probe')
    assert.deepEqual(check?.body, { server: 'ollama', only: [LATEST, V64] })
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
    const form = view.el.querySelector('.ls-edit')!
    assert.ok(form, 'the draft form opens')
    for (const l of ['server name', 'server address', 'agents at once', 'seat price', 'API key']) {
      assert.ok(form.querySelector(`input[aria-label="${l}"]`), `the form has ${l}`)
    }
    assert.ok(form.textContent?.includes('offer this server’s models to new hires'), 'the offer toggle')
    await typeInto(form.querySelector<HTMLInputElement>('input[aria-label="seat price"]')!, '2')
    await typeInto(form.querySelector<HTMLInputElement>('input[aria-label="agents at once"]')!, '3')
    assert.ok(form.textContent?.includes('unsaved changes'))
    await click([...form.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    assert.equal(view.el.querySelector('.ls-edit'), null, 'Cancel closes the draft')
    assert.equal(seen.filter((r) => r.method === 'PATCH').length, 0, 'Cancel sends nothing')
    assert.ok([...view.el.querySelectorAll('.acct-provenance span')].some((s) => s.textContent === 'seat 1'), 'the summary keeps seat 1')
    await click(edit())
    await typeInto(view.el.querySelector<HTMLInputElement>('.ls-edit input[aria-label="seat price"]')!, '2')
    await click([...view.el.querySelectorAll('.ls-edit button')].find((b) => b.textContent === 'Save'))
    const patches = seen.filter((r) => r.method === 'PATCH')
    assert.equal(patches.length, 1, 'one PATCH')
    assert.deepEqual(patches[0]!.body, { seat: 2 }, 'only the seat changed')
    assert.equal(view.el.querySelector('.ls-edit'), null, 'Save closes the draft')
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
    await click(view.el.querySelector('.ls-edit .ls-favs'))
    const dialog = view.el.querySelector('[role="dialog"]')!
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
    await click([...view.el.querySelectorAll('.ls-edit button')].find((b) => b.textContent === 'Save'))
    const patch = seen.find((r) => r.method === 'PATCH')
    assert.deepEqual(patch?.body, { models: [{ id: LATEST, offered: false }, { id: 'model-000:7b', offered: true, context: 32768 }] })
  } finally { await view.unmount(); delete g.fetch }
})
