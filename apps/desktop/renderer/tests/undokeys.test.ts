import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { historyShortcut } from '../src/undokeys'

test('history recognizes undo and both requested redo chords without consuming events', () => {
  for (const [init, expected] of [
    [{ key: 'z', ctrlKey: true }, 'undo'],
    [{ key: 'Z', metaKey: true }, 'undo'],
    [{ key: 'y', ctrlKey: true }, 'redo'],
    [{ key: 'z', ctrlKey: true, shiftKey: true }, 'redo'],
    [{ key: 'z', metaKey: true, shiftKey: true }, 'redo'],
    [{ key: 'y', metaKey: true }, null],
    [{ key: 'y', ctrlKey: true, shiftKey: true }, null],
    [{ key: 'z' }, null],
    [{ key: 'z', ctrlKey: true, altKey: true }, null],
    [{ key: 'z', ctrlKey: true, repeat: true }, null],
    [{ key: 'z', ctrlKey: true, isComposing: true }, null],
  ] as [KeyboardEventInit, string | null][]) {
    const event = new window.KeyboardEvent('keydown', { cancelable: true, ...init })
    assert.equal(historyShortcut(event, document), expected, JSON.stringify(init))
    assert.equal(event.defaultPrevented, false, 'classification alone cannot steal native undo')
  }
  const handled = new window.KeyboardEvent('keydown', {key: 'z', ctrlKey: true, cancelable: true})
  handled.preventDefault()
  assert.equal(historyShortcut(handled, document), null)
})

test('redo and undo respect focused editors in each native document', () => {
  const child = new JSDOM('<!doctype html><body></body>', {url: 'http://localhost/'})
  try {
    const doc = child.window.document
    for (const html of ['<input>', '<textarea></textarea>', '<select><option>x</option></select>',
      '<div contenteditable="true" tabindex="0">draft</div>', '<div role="textbox" tabindex="0">draft</div>',
      '<div class="monaco-editor"><span tabindex="0">draft</span></div>']) {
      doc.body.innerHTML = html
      const editor = (doc.querySelector('[tabindex]') ?? doc.body.firstElementChild) as HTMLElement
      editor.focus()
      for (const init of [{key: 'z',ctrlKey: true}, {key: 'y',ctrlKey: true}, {key: 'z',metaKey: true,shiftKey: true}]) {
        const event = new child.window.KeyboardEvent('keydown', {cancelable: true,...init})
        assert.equal(historyShortcut(event as unknown as KeyboardEvent, doc), null, html)
        assert.equal(historyShortcut(event as unknown as KeyboardEvent, document), init.key === 'z' && !init.shiftKey ? 'undo' : 'redo', 'main focus does not stand in for the child document')
        assert.equal(event.defaultPrevented, false)
      }
    }
  } finally {child.window.close()}
})
