import { flush, inAct } from './harness'
import assert from 'node:assert/strict'

/** Header close behavior only; real geometry/pointer checks live in the capture. */
export async function closeDraftSettings(panel: Element | null) {
  const close = panel?.querySelector<HTMLButtonElement>('.modalpin-bar .modalpin-x')
  assert.ok(close, 'draft frame has a header close button')
  assert.equal(close.getAttribute('aria-label'), 'close this window')
  await inAct(async () => { close.click(); await flush(3) })
}
