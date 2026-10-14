import { flush, inAct, mountView, StrictMode } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPortal } from 'react-dom'
import { JSDOM } from 'jsdom'
import { HistorySurface, useUserHistory } from '../src/historyui'
import { HistoryController } from '../src/historycontroller'
import { historyEnabled, historyUndo, bindHistory } from '../src/historyregistry'
import { createToast, ToastStack } from '../src/toasts'
import type { HistoryAnswer, HistoryKind, UserHistory } from '../src/historyapi'

const target = (id: number, kind: HistoryKind = 'move') => ({ id, kind, label: `${kind} ${id}`, at: '2026-10-14T00:00:00Z' })
const history = (undo: number | null, redo: number | null = null, kind: HistoryKind = 'move'): UserHistory =>
  ({ bound: 100, undo: undo == null ? null : target(undo, kind), redo: redo == null ? null : target(redo, kind), entries: [] })
const shown = (doc: Document) => Object.defineProperty(doc, 'hidden', { configurable: true, value: false })
async function key(doc = document, init: KeyboardEventInit = {}, element: EventTarget = doc.defaultView!) {
  const EventClass = (doc.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent
  const event = new EventClass('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true, ...init })
  await inAct(async () => { element.dispatchEvent(event); await flush(5) })
  return event
}

for (const kind of ['move', 'hire', 'retire', 'retool'] as const) test(`durable ${kind} shortcuts survive absent toasts and walk several entries then redo`, async t => {
  shown(document)
  const calls: [string, number][] = []
  const controller = new HistoryController({ read: async () => history(3, null, kind), report: () => {}, changed: () => {},
    apply: async (direction, id) => {
      calls.push([direction, id])
      return { status: direction === 'undo' ? 'undone' : 'redone', id, label: `${kind} ${id}`,
        history: direction === 'undo' ? history(id - 1 || null, id, kind) : history(id, null, kind) }
    } })
  await controller.refresh()
  const view = await mountView(<><HistorySurface controller={controller} /><ToastStack toasts={[]} /></>, el => el)
  t.after(async () => { await view.unmount(); controller.dispose() })
  assert.equal((await key()).defaultPrevented, true)
  assert.equal((await key(document, { ctrlKey: false, metaKey: true })).defaultPrevented, true)
  assert.equal((await key(document, { key: 'y' })).defaultPrevented, true)
  assert.deepEqual(calls, [['undo', 3], ['undo', 2], ['redo', 2]])
})

test('history hook survives StrictMode setup/cleanup and unbinds its org when removed', async t => {
  shown(document)
  const original = globalThis.fetch, posts: string[] = []
  globalThis.fetch = (async (url, init) => {
    if (init?.method === 'POST') posts.push(String(url))
    return new Response(JSON.stringify(init?.method === 'POST'
      ? { status: 'undone', id: 7, label: 'Move 7', history: history(6, 7) } : history(7)))
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  function Hook() {
    const controller = useUserHistory('strict-org', true, 1, () => {}, () => {})
    return <HistorySurface controller={controller} />
  }
  const view = await mountView(<StrictMode><Hook /></StrictMode>, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.equal(historyEnabled('strict-org'), true)
    assert.equal((await key()).defaultPrevented, true)
    assert.deepEqual(posts, ['/api/orgs/strict-org/undo-history/undo'])
  } finally { await view.unmount() }
  assert.equal(historyEnabled('strict-org'), false)
})

test('worked hire asks, cancel consumes nothing, and close-before-confirm preserves the fresh token in mirrored documents', async t => {
  shown(document)
  const native = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  shown(native.window.document)
  const calls: [string, number, string | undefined][] = []
  const controller = new HistoryController({ read: async () => history(9), report: () => {}, changed: () => {},
    apply: async (direction, id, token) => {
      calls.push([direction, id, token])
      if (!token || token === 'first') return { status: 'confirm', id, label: 'Hire alice', agent: 'alice',
        turns: token ? 2 : 1, confirm: token ? 'fresh' : 'first', history: history(9) }
      return { status: 'undone', id, label: 'Hire alice', history: history(null, 9) }
    } })
  await controller.refresh()
  const view = await mountView(<><HistorySurface controller={controller} />
    {createPortal(<HistorySurface controller={controller} />, native.window.document.body)}</>, el => el)
  t.after(async () => { await view.unmount(); native.window.close(); controller.dispose() })
  await key(native.window.document)
  assert.match(native.window.document.querySelector('[role="dialog"]')?.textContent ?? '', /alice has started 1 turn/)
  const cancel = [...native.window.document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'cancel')!
  assert.ok(cancel)
  await inAct(() => cancel.click())
  assert.equal(calls.length, 1); assert.equal(controller.getSnapshot().history?.undo?.id, 9)
  await key()
  const confirmButton = (doc: Document) => [...doc.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Retire hired agent')!
  await inAct(async () => { confirmButton(document).click(); await flush(5) })
  assert.equal(controller.getSnapshot().confirmation?.turns, 2, 'a turn after preflight requires another confirmation')
  await inAct(async () => { confirmButton(native.window.document).click(); await flush(5) })
  assert.deepEqual(calls, [['undo', 9, undefined], ['undo', 9, undefined], ['undo', 9, 'first'], ['undo', 9, 'fresh']])
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(native.window.document.querySelector('[role="dialog"]'), null)
  const editor = native.window.document.createElement('textarea'); native.window.document.body.appendChild(editor); editor.focus()
  assert.equal((await key(native.window.document, { shiftKey: true }, editor)).defaultPrevented, false)
  assert.equal(calls.length, 4, 'native text redo never reaches the org journal')
})

test('pending history keys cannot fall through to an older transient toast; toast identity never undoes a newer entry', async t => {
  shown(document)
  let resolve!: (answer: HistoryAnswer) => void
  let legacyCalls = 0, calls = 0
  const controller = new HistoryController({ read: async () => history(4), report: () => {}, changed: () => {},
    apply: () => { calls++; return new Promise<HistoryAnswer>(r => { resolve = r }) } })
  await controller.refresh()
  const unbind = bindHistory('pending-org', controller)
  const old = historyUndo('pending-org', { history_entry: target(3) })!
  assert.equal(old.available?.(), false, 'old toast does not target the new journal head')
  const legacy = createToast(['rename'], () => { legacyCalls++ }, () => {})
  const view = await mountView(<><HistorySurface controller={controller} /><ToastStack toasts={[legacy]} /></>, el => el)
  const button = view.el.querySelector<HTMLButtonElement>('.toast-undo')!
  const rect = { x: 1, y: 1, left: 1, top: 1, right: 20, bottom: 20, width: 19, height: 19, toJSON: () => ({}) }
  button.getBoundingClientRect = () => rect; button.getClientRects = () => [rect] as unknown as DOMRectList
  t.after(async () => { await view.unmount(); unbind(); controller.dispose() })
  await key(); await key()
  assert.equal(calls, 1); assert.equal(legacyCalls, 0)
  await inAct(async () => { resolve({ status: 'undone', id: 4, label: 'Move 4', history: history(2, 4) }); await flush(5) })
  assert.equal(old.available?.(), false)
})
