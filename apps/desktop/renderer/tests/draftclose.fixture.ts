import { flush, inAct } from './harness'
import assert from 'node:assert/strict'

/** Centered draft frames offer Close on their title-bar menu. */
export async function closeDraftSettings(panel: Element | null) {
  const bar = panel?.querySelector('.modalpin-bar')
  assert.ok(bar, 'draft frame title bar exists')
  await inAct(async () => {
    bar.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }))
    await flush(3)
  })
  const close = [...document.querySelectorAll<HTMLElement>('.ctxmenu [role="menuitem"]')]
    .find(item => item.textContent?.trim() === 'Close')
  assert.ok(close, 'frame menu offers Close')
  await inAct(async () => { close.click(); await flush(3) })
}
