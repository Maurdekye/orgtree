import { flush, inAct, mountView } from './harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { WrapExamples, WrapSettings, installWrapBackend } from './mentionwrap.fixture'
import { watchAppFeed } from '../src/appfeed'

test('object wrapping is opt-in; Display saves, pushes and restores the existing controls', async () => {
  const backend = installWrapBackend(), original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket }
  globalThis.fetch = backend.fetcher
  globalThis.WebSocket = backend.Socket as unknown as typeof WebSocket
  const opened: string[] = []
  const view = await mountView(<><WrapExamples open={id => opened.push(id)} /><WrapSettings /></>, el => el)
  const controls = () => [...view.el.querySelectorAll<HTMLElement>('#wrap-examples [data-object-nav]')]
  const toggle = () => view.el.querySelector<HTMLInputElement>('input[aria-label="Wrap object mentions"]')
  try {
    await inAct(() => flush(12))
    assert.equal(Boolean(toggle()), true, 'Display exposes the wrapping toggle')
    assert.equal(toggle()!.checked, false, 'unset defaults OFF')
    assert.equal(controls().length, 10)
    assert.equal(controls().every(el => el.tagName === 'BUTTON'), true)
    await inAct(async () => { toggle()!.click(); await flush(10) })
    assert.deepEqual(backend.writes, [{ wrap_object_mentions: true }])
    assert.equal(document.documentElement.classList.contains('wrap-object-mentions'), true)
    assert.equal(controls().every(el => el.tagName === 'SPAN' && el.getAttribute('role') === 'button' && el.tabIndex === 0), true)
    for (const el of controls()) {
      assert.equal(Boolean(el.querySelector('.ref-mark')), true)
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    }
    assert.equal(opened.length, 20, 'React and delegated Markdown retain Enter and Space activation')
    const before = controls()[4]!
    await inAct(async () => { backend.emit(true); await flush(4) })
    assert.equal(controls()[4] === before, true, 'unchanged Markdown controls retain selection identity')
    await inAct(async () => { backend.emit(false); await flush(6) })
    assert.equal(toggle()!.checked, false, 'another window/tool change updates Display')
    assert.equal(controls().every(el => el.tagName === 'BUTTON'), true, 'OFF restores original button controls')
    assert.equal(view.el.querySelector('#markdown-links [data-object-nav="document"]')?.getAttribute('title')?.startsWith('Unread'), true)
  } finally {
    await view.unmount(); globalThis.fetch = original.fetch; globalThis.WebSocket = original.WebSocket
    document.documentElement.classList.remove('wrap-object-mentions')
  }
})

// 4.5.0 gate (2026-10-28, items 14/15/17-20/22/23): each chip subscribed to the
// whole app feed, so a chip mounted on its own opened the feed itself (one more
// /api/app/records read and a socket) and every chip re-rendered on every feed
// change. A chip reads the setting the shell's own feed delivers instead.
test('object mentions open no app feed of their own and follow the setting the open feed delivers', async () => {
  // a fresh feed epoch: the shared connection keeps the earlier test's sequence numbers
  const backend = installWrapBackend('wrap-chips'), original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket }
  const requests: string[] = []
  let sockets = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { requests.push(String(input)); return backend.fetcher(input, init) }) as typeof fetch
  const Base = backend.Socket as unknown as new (url: string) => object
  globalThis.WebSocket = class extends Base { constructor(url: string) { super(url); sockets++ } } as unknown as typeof WebSocket
  const view = await mountView(<WrapExamples />, el => el)
  const controls = () => [...view.el.querySelectorAll<HTMLElement>('#wrap-examples [data-object-nav]')]
  let stop = () => {}
  try {
    await inAct(() => flush(12))
    assert.equal(controls().length, 10)
    assert.deepEqual(requests, [], 'mention chips alone make no request')
    assert.equal(sockets, 0, 'mention chips alone open no app-feed socket')
    // the feed an app-wide consumer (the shell) keeps open delivers the setting
    await inAct(async () => { stop = watchAppFeed(() => {}); await flush(8) })
    await inAct(async () => { backend.emit(true); await flush(6) })
    assert.equal(controls().every(el => el.tagName === 'SPAN' && el.getAttribute('role') === 'button'), true, 'ON reaches every chip')
    await inAct(async () => { backend.emit(false); await flush(6) })
    assert.equal(controls().every(el => el.tagName === 'BUTTON'), true, 'OFF restores the buttons')
  } finally {
    stop()
    await view.unmount(); globalThis.fetch = original.fetch; globalThis.WebSocket = original.WebSocket
    document.documentElement.classList.remove('wrap-object-mentions')
  }
})
