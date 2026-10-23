import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installAppShortcuts } from '../src/shell/appshortcuts'

test('org navigation consumes Shift+Alt+Space through the existing app action', () => {
  let fits = 0
  const stop = installAppShortcuts(window, () => ({ fitOrg: () => { fits++ } }))
  try {
    const event = new window.KeyboardEvent('keydown', { key: ' ', altKey: true, shiftKey: true,
      bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    assert.equal(fits, 1, 'the assigned old matcher ignores the new chord')
    assert.equal(event.defaultPrevented, true)
  } finally { stop() }
})
