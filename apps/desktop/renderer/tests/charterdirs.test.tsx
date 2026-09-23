// External charter template folders in the renderer.
//
// Docket add-external-agent-charter-templates-folder, user ruling 2026-09-23:
// configured folders contribute Markdown charter presets to the EXISTING
// hire-form picker; the same filename in two folders shows BOTH as
// distinguishable choices (never shadowed). The backend half — scanning,
// read-only guarantees, payload shape — is pinned by
// tests/test_charter_template_dirs.py; this file pins the picker and the
// settings list against that payload shape.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DraftNode, presetLabels } from '../src/canvas/cards'
import { CharterTemplateDirsSetting } from '../src/canvas/chartersettings'
import type { TreePayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>

function tree(): TreePayload {
  return { slug: 'acme', name: 'acme', nodes: [], edges: [],
    cascade_hire: true, cascade_alloc: true, net: { hubs: [] }, kiosk: null,
  } as unknown as TreePayload
}

function response(payload: unknown, ok = true, status = 200) {
  return { ok, status, statusText: ok ? 'OK' : 'Unprocessable', headers: new Headers(),
    json: () => Promise.resolve(payload) }
}

async function settle() {
  await inAct(async () => { await flush(10) })
}

const A = 'D:\\templates\\team-a'
const B = 'E:\\shared\\team-b'
const PRESETS = [
  { name: 'coordinator', content: 'external coordinator', path: `${A}\\coordinator.md`,
    file: 'coordinator.md', source: 'external', dir: A },
  { name: 'coordinator', content: 'bundled coordinator', path: 'C:\\app\\charters\\coordinator.md',
    file: 'coordinator.md', source: 'bundled' },
  { name: 'reviewer', content: 'reviewer from A', path: `${A}\\reviewer.md`,
    file: 'reviewer.md', source: 'external', dir: A },
  { name: 'reviewer', content: 'reviewer from B', path: `${B}\\reviewer.md`,
    file: 'reviewer.md', source: 'external', dir: B },
  { name: 'solo', content: 'only one', path: `${B}\\solo.md`,
    file: 'solo.md', source: 'external', dir: B },
] as const

test('presetLabels: unique names stay bare, repeats name where they live', () => {
  const labels = presetLabels([...PRESETS])
  assert.equal(labels.get(`${B}\\solo.md`), 'solo')
  assert.equal(labels.get(`${A}\\reviewer.md`), `reviewer — ${A}`)
  assert.equal(labels.get(`${B}\\reviewer.md`), `reviewer — ${B}`)
  assert.equal(labels.get(`${A}\\coordinator.md`), `coordinator — ${A}`)
  assert.equal(labels.get('C:\\app\\charters\\coordinator.md'), 'coordinator — bundled')
  // two different files that even share folder+name fall back to full paths
  const same = presetLabels([
    { name: 'a b', content: '', path: `${A}\\a-b.md`, source: 'external', dir: A },
    { name: 'a b', content: '', path: `${A}\\a b.md`, source: 'external', dir: A },
  ])
  assert.equal(same.get(`${A}\\a-b.md`), `a b — ${A}\\a-b.md`)
  assert.equal(same.get(`${A}\\a b.md`), `a b — ${A}\\a b.md`)
  assert.equal(new Set(presetLabels([...PRESETS]).values()).size, PRESETS.length,
    'every choice has its own label')
})

test('hire form offers same-named templates from two folders as two choices', async () => {
  let confirmed = ''
  g.fetch = (url: string) => {
    const path = new URL(url, 'http://localhost').pathname
    if (path === '/api/charters') return Promise.resolve(response({ charters: PRESETS }))
    return Promise.reject(new Error(`unexpected GET ${path}`))
  }
  const view = await mountView(
    <DraftNode pos={{ x: 0, y: 0 }} draft={{ parent: null, tier: 'haiku' }}
      map={new Map()} seats={{ haiku: 1 }} maxTop={100} defaultTop={0}
      kioskRemaining={null} tree={tree()} zoom={1} pxc={1}
      onConfirm={(_name, _grant, charter) => { confirmed = charter }}
      onCancel={() => {}} />, (el) => el)
  try {
    await settle()
    const select = () => view.el.querySelector<HTMLSelectElement>('.df-preset-add')!
    const options = [...select().options].slice(1)
    assert.deepEqual(options.map(o => o.value), PRESETS.map(p => p.path),
      'one option per file, none shadowed')
    assert.deepEqual(options.map(o => o.textContent), [
      `coordinator — ${A}`, 'coordinator — bundled',
      `reviewer — ${A}`, `reviewer — ${B}`, 'solo'])
    const pick = async (value: string) => inAct(async () => {
      select().value = value
      select().dispatchEvent(new Event('change', { bubbles: true }))
      await flush(4)
    })
    await pick(`${B}\\reviewer.md`)
    // the first pick names the agent after the template's plain name
    assert.equal(view.el.querySelector<HTMLInputElement>('.df-name')!.value, 'reviewer')
    // the other same-named template is still offered after picking one
    assert.ok([...select().options].some(o => o.value === `${A}\\reviewer.md`))
    assert.ok(![...select().options].some(o => o.value === `${B}\\reviewer.md`))
    await pick(`${A}\\reviewer.md`)
    const cards = [...view.el.querySelectorAll<HTMLButtonElement>('.preset-card')]
    assert.deepEqual(cards.map(c => c.textContent?.trim()),
      [`reviewer — ${B}`, `reviewer — ${A}`])
    // removing one card removes only that file's choice
    await inAct(async () => { cards[0]!.click() })
    assert.deepEqual([...view.el.querySelectorAll('.preset-card')].map(c => c.textContent?.trim()),
      [`reviewer — ${A}`])
    await pick(`${B}\\reviewer.md`)
    const hire = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('hire'))!
    await inAct(async () => { hire.click() })
    assert.equal(confirmed, 'reviewer from A\n\nreviewer from B',
      'each chosen file contributes its own text, in pick order')
  } finally {
    await view.unmount(); delete g.fetch
  }
})

test('settings list: shows folder states, adds and removes paths, surfaces refusals', async () => {
  const seen: { method: string; body?: string }[] = []
  let dirs: string[] = [A, 'X:\\gone']
  let refuse = ''
  const payload = () => ({
    dirs, max_dirs: 32,
    directories: dirs.map(p => p === A
      ? { path: p, status: 'ok', count: 2, skipped_links: ['evil.md'], templates: [] }
      : p === 'X:\\gone'
        ? { path: p, status: 'missing', count: 0, error: `folder does not exist: ${p}`, templates: [] }
        : { path: p, status: 'ok', count: 1, templates: [] }),
    duplicates: [{ name: 'reviewer', locations: [{ source: 'external', path: 'a' }, { source: 'external', path: 'b' }] }],
  })
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    if (path !== '/api/app-settings/charter-template-dirs')
      return Promise.reject(new Error(`unexpected ${method} ${path}`))
    seen.push({ method, body: init?.body?.toString() })
    if (method === 'PUT') {
      if (refuse) return Promise.resolve(response({ detail: refuse }, false, 422))
      dirs = JSON.parse(String(init!.body)).dirs
    }
    return Promise.resolve(response(payload()))
  }
  const view = await mountView(<CharterTemplateDirsSetting />, (el) => el)
  try {
    await settle()
    const text = () => view.el.textContent ?? ''
    assert.match(text(), /2 templates/)
    assert.match(text(), /missing — the folder does not exist/)
    assert.match(text(), /linked files not read: evil\.md/)
    assert.match(text(), /reviewer ×2/)
    const input = view.el.querySelector<HTMLInputElement>('[aria-label="add a charter template folder"]')!
    await inAct(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '  F:\\more  ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const addBtn = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent === 'add')!
    await inAct(async () => { addBtn.click(); await flush(6) })
    assert.deepEqual(JSON.parse(seen.at(-1)!.body!), { dirs: [A, 'X:\\gone', 'F:\\more'] },
      'add appends the trimmed path and keeps order')
    assert.match(text(), /F:\\more1 template(?!s)/)
    assert.equal(input.value, '', 'input clears after a successful add')
    const remove = view.el.querySelector<HTMLButtonElement>('[aria-label="remove X:\\\\gone"]')!
    await inAct(async () => { remove.click(); await flush(6) })
    assert.deepEqual(JSON.parse(seen.at(-1)!.body!), { dirs: [A, 'F:\\more'] })
    assert.doesNotMatch(text(), /X:\\gone/)
    // a refused save is shown and the displayed list is unchanged
    refuse = 'charter template directories must be absolute paths: rel'
    await inAct(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'rel')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await inAct(async () => { addBtn.click(); await flush(6) })
    const alert = view.el.querySelector('[role="alert"]')
    assert.ok(alert, 'refusal surfaced')
    assert.match(alert!.textContent ?? '', /must be absolute paths/)
    assert.equal(input.value, 'rel', 'the typed path is kept for correction')
    assert.equal(view.el.querySelectorAll('[aria-label^="remove "]').length, 2)
  } finally {
    await view.unmount(); delete g.fetch
  }
})
