import { flush, inAct, mountView } from './harness'
import { useState } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PinFrame } from '../src/canvas/modalpin'
import { ProviderDialog } from '../src/canvas/providerdialog'

test('provider dialog stays above App settings; Escape closes only the draft and restores focus', async () => {
  let parentClosed = false
  function Settings() {
    const [open, setOpen] = useState(false)
    return <PinFrame kind="app-settings" title="App settings" panel="settings" pinnable={false}
      close={() => { parentClosed = true }}>
      <button onClick={() => setOpen(true)}>Configure</button>
      {open && <ProviderDialog title="Configure provider" busy={false} close={() => setOpen(false)}>
        <input aria-label="draft" /><button onClick={() => setOpen(false)}>Cancel</button>
      </ProviderDialog>}
    </PinFrame>
  }
  const view = await mountView(<Settings />, el => el)
  try {
    const opener = view.el.querySelector('button')!
    await inAct(async () => { opener.focus(); opener.click(); await flush(3) })
    const dialog = document.querySelector('[role="dialog"][aria-label="Configure provider"]')!
    assert.ok(dialog)
    assert.equal(view.el.contains(dialog), false, 'portaled above the settings stacking context')
    assert.equal(document.activeElement, dialog.querySelector('input'))
    await inAct(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      await flush(3)
    })
    assert.equal(document.querySelector('.provider-dialog'), null)
    assert.equal(parentClosed, false)
    assert.equal(document.activeElement, opener)
  } finally { await view.unmount() }
})
