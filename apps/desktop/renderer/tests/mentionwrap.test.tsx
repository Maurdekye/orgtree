import { flush, inAct, mountView } from './harness'
import assert from 'node:assert/strict'
import test from 'node:test'
import { WrapExamples, WrapSettings, installWrapBackend } from './mentionwrap.fixture'

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
