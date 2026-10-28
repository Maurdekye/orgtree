import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { SettingsPanel } from '../src/App'
import { DefaultsForm } from '../src/shell/defaults'
import { SettingsSaveQueue } from '../src/settingsautosave'
import type { TreePayload } from '../src/types'

const org = { slug: 'autosave', name: 'Autosave', nodes: [], edges: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: .8,
  auto_cheap_compact: { enabled: true, occ: .25 }, net: null } as unknown as TreePayload
type Call = { path: string; method: string; body: Record<string, unknown> }
function backend(t: { after: (f: () => void) => void }, fail = false) {
  const calls: Call[] = [], old = globalThis.fetch
  let reject = fail
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, method, body })
    const bad = reject && method === 'POST'
    const data = bad ? { detail: 'storage unavailable' } : path.endsWith('/orgmd')
      ? { content: '# Original', rev: 'r1' } : path === '/api/defaults'
        ? { max_top_grant: 1000, default_top_grant: 50, compact_at: .8, auto_resume: true }
        : method === 'POST' ? { warnings: ['retained existing grants'] } : {}
    return { ok: !bad, status: bad ? 500 : 200, headers: new Headers(), json: async () => data }
  }) as typeof fetch
  t.after(() => { globalThis.fetch = old })
  return { calls, recover: () => { reject = false } }
}
async function change(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    await flush()
  })
}
const waitForDebounce = () => inAct(async () => { await new Promise(r => setTimeout(r, 800)); await flush(8) })
// Org settings has no footer Close button (USER 2026-10-28 m3291e5890d55 "remove this close
// button", in Org settings mc9c984cf52a5); its header X and Escape close it through the same
// closeSettings.
const escape = () => inAct(async () => {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await flush(8)
})

test('organization settings save only changed fields; charter saves explicitly and close never publishes it', async t => {
  const { calls } = backend(t)
  let closed = 0
  const view = await mountView(<SettingsPanel tree={org} toast={() => {}} close={() => { closed++ }} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(8) })
  assert.equal(calls.some(c => c.method !== 'GET'), false, 'mount never writes')
  await change(view.el.querySelector<HTMLTextAreaElement>('[aria-label="org.md"]')!, '# Unpublished')
  await change(view.el.querySelector<HTMLSelectElement>('[aria-label="Default thinking effort"]')!, 'high')
  await inAct(async () => { await flush(8) })
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.body), [{ default_effort: 'high' }])
  assert.equal(closed, 0, 'auto-save keeps the menu open')
  assert.match(view.el.textContent!, /retained existing grants/)
  const cap = view.el.querySelector<HTMLInputElement>('[aria-label="Top-level grant cap"]')!
  await change(cap, '77')
  await change(cap, '78')
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'numeric edits debounce')
  await waitForDebounce()
  assert.deepEqual(calls.filter(c => c.method === 'POST').at(-1)!.body, { max_top_grant: 78 })
  assert.equal(calls.some(c => c.method === 'PUT'), false, 'ordinary edits never publish org.md')
  const save = view.el.querySelector<HTMLButtonElement>('[aria-label="Save organization charter"]')!
  assert.ok(save, 'only the charter retains an explicit Save')
  await inAct(async () => { save.click(); await flush(8) })
  assert.deepEqual(calls.find(c => c.method === 'PUT')!.body, { content: '# Unpublished', base_rev: 'r1' })
  await change(view.el.querySelector<HTMLTextAreaElement>('[aria-label="org.md"]')!, '# Still unpublished')
  await escape()
  assert.equal(closed, 1)
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1, 'close discards unsaved charter edits')
})

test('default org settings auto-save in place and show failures until retry succeeds', async t => {
  const { calls, recover } = backend(t, true)
  const view = await mountView(<DefaultsForm toast={() => {}} onDone={() => {}} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(8) })
  assert.equal([...view.el.querySelectorAll('button')].some(b => /^save$/i.test(b.textContent!.trim())), false)
  await inAct(async () => {
    view.el.querySelector<HTMLInputElement>('input[role="switch"]')!.click()
    await flush(8)
  })
  assert.deepEqual(calls.find(c => c.method === 'POST')!.body, { auto_resume: false })
  assert.match(view.el.querySelector('[role="alert"]')!.textContent!, /storage unavailable/)
  recover()
  await inAct(async () => {
    view.el.querySelector<HTMLButtonElement>('[aria-label="Retry saving settings"]')!.click()
    await flush(8)
  })
  assert.equal(view.el.querySelector('[role="alert"]'), null)
  assert.equal(calls.filter(c => c.method === 'POST').length, 2)
})

test('saves serialize, keep newer edits, and retry only failed fields', async () => {
  let release!: () => void
  const first = new Promise<void>(resolve => { release = resolve })
  const calls: Record<string, unknown>[] = []
  let reject = true, active = 0, peak = 0
  const queue = new SettingsSaveQueue(async fields => {
    calls.push(fields); peak = Math.max(peak, ++active)
    try {
      if (calls.length === 1) await first
      if ('permission' in fields && reject) throw new Error('permission denied')
      return {}
    } finally { active-- }
  })
  queue.enqueue('cap', 10)
  await flush(3)
  queue.enqueue('cap', 20)
  queue.enqueue('permission', 'read')
  queue.enqueue('effort', 'high')
  release()
  assert.equal(await queue.flush(), false)
  assert.equal(peak, 1)
  assert.deepEqual(calls, [{ cap: 10 }, { cap: 20 }, { permission: 'read' }, { effort: 'high' }])
  assert.match(queue.snapshot().error!, /permission denied/, 'a later success does not hide an unsaved field')
  reject = false
  assert.equal(await queue.flush(true), true)
  assert.deepEqual(calls.at(-1), { permission: 'read' }, 'retry never repeats successful fields')
})

test('closing flushes a pending numeric edit without publishing charter text', async t => {
  const { calls } = backend(t)
  let closed = 0
  const view = await mountView(<SettingsPanel tree={org} toast={() => {}} close={() => { closed++ }} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(8) })
  await change(view.el.querySelector<HTMLInputElement>('[aria-label="Default top-level grant"]')!, '25')
  assert.equal(calls.some(c => c.method === 'POST'), false)
  assert.equal(view.el.querySelector('[aria-label="Close organization settings"]'), null, 'no footer Close button')
  assert.equal([...view.el.querySelectorAll('button')].filter(b => b.textContent?.trim() === 'Close').length, 0, 'nor any button named Close')
  const x = view.el.querySelector<HTMLButtonElement>('.modalpin-bar button.modalpin-x[aria-label="close this window"]')
  assert.ok(x, 'the centred window has its header X')
  await inAct(async () => { x!.click(); await flush(8) })
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.body), [{ default_top_grant: 25 }])
  assert.equal(calls.some(c => c.method === 'PUT'), false)
  assert.equal(closed, 1)
})

test('an incomplete numeric edit stays visible, does not write zero, and can be corrected', async t => {
  const { calls } = backend(t)
  const view = await mountView(<SettingsPanel tree={org} toast={() => {}} close={() => {}} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(8) })
  const input = view.el.querySelector<HTMLInputElement>('[aria-label="Top-level grant cap"]')!
  await change(input, '')
  await waitForDebounce()
  assert.equal(calls.some(c => c.method === 'POST'), false)
  assert.ok(view.el.querySelector('[role="alert"]'))
  assert.equal(input.value, '')
  await change(input, '200')
  await waitForDebounce()
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.body), [{ max_top_grant: 200 }])
  assert.equal(view.el.querySelector('[role="alert"]'), null)
})
