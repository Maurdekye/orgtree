import { flush, inAct, mountView } from './harness'
import { useState } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PinFrame } from '../src/canvas/modalpin'
import { ProviderDialog } from '../src/canvas/providerdialog'

test('provider backdrop closes a draft, but inside clicks, drag-out and busy saves do not', async () => {
  let closes = 0
  const view = await mountView(<ProviderDialog title="Add provider" busy={false} close={() => { closes++ }}>
    <input aria-label="draft" />
  </ProviderDialog>, el => el)
  try {
    const panel = document.querySelector('.provider-dialog')!
    const backdrop = panel.parentElement!
    const pointer = (el: Element) => el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
    await inAct(async () => {
      pointer(panel.querySelector('input')!)
      ;(panel.querySelector('input') as HTMLElement).click()
      await flush(2)
    })
    assert.equal(closes, 0, 'inside click')
    await inAct(async () => { pointer(panel); backdrop.click(); await flush(2) })
    assert.equal(closes, 0, 'drag starting inside and ending on backdrop')
    await inAct(async () => { pointer(backdrop); backdrop.click(); await flush(2) })
    assert.equal(closes, 1, 'normal outside click')
    await view.render(<ProviderDialog title="Add provider" busy close={() => { closes++ }}>
      <input aria-label="draft" />
    </ProviderDialog>)
    await inAct(async () => {
      pointer(backdrop); backdrop.click()
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      await flush(2)
    })
    assert.equal(closes, 1, 'busy save blocks backdrop and Escape')
  } finally { await view.unmount() }
})

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
