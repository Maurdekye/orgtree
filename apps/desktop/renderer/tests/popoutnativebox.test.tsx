import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MovableSurface, PopoutButton } from '../src/popout'
import { beginWindowExit, endWindowExit, savedWindows, windowLayoutKey } from '../src/windowlayout'

// docket 4-5-0-a-saved-pop-out-window-reopens-8-px-off-an: a popped-out window's
// saved place is its own content box as the native window reports it (main's
// popout-state bounds). The renderer's screenX/outerWidth include Windows'
// invisible frame, and a place saved from them reopened 8 px left and 16x8 px
// larger every time (measured in a Session 0 capture, 2026-10-27).
const tick = async () => { for (let i = 0; i < 5; i++) await flush() }
/** A pop-out as Windows reports it to the renderer: 8 px of invisible frame on
 *  the left, right and bottom around a 560x400 window at 340,180. */
interface Child { document: Document; closed: boolean; screenX: number; screenY: number; outerWidth: number; outerHeight: number; focus(): void; close(): void; addEventListener(): void; removeEventListener(): void; requestAnimationFrame(cb: (at: number) => void): number; cancelAnimationFrame(id: number): void }
type Emit = (data: Record<string, unknown>) => Promise<void>
function native(t: test.TestContext) {
  const realOpen = window.open, host = window as Window & { orgtreeDesktop?: unknown }, realBridge = host.orgtreeDesktop
  const g = globalThis as Record<string, unknown>, realObserver = g.MutationObserver
  g.MutationObserver = (window as unknown as Record<string, unknown>).MutationObserver
  const opened: { name: string; features: string; child: Child }[] = []
  const make = (): Child => {
    const doc = document.implementation.createHTMLDocument('popout'), noop = () => {}
    const child: Child = { document: doc, closed: false, screenX: 332, screenY: 180, outerWidth: 576, outerHeight: 408,
      focus: noop, close() { child.closed = true }, addEventListener: noop, removeEventListener: noop,
      requestAnimationFrame: cb => setTimeout(() => cb(0), 0) as unknown as number, cancelAnimationFrame: id => clearTimeout(id) }
    Object.defineProperty(doc, 'defaultView', { value: child, configurable: true })
    return child
  }
  window.open = ((_url?: string | URL, name?: string, features?: string) => {
    const child = make(); opened.push({ name: String(name ?? ''), features: String(features ?? ''), child }); return child as unknown as Window
  }) as typeof window.open
  const listeners = new Set<(event: { type: string; data: unknown }) => void>()
  host.orgtreeDesktop = { onEvent: (fn: (event: { type: string; data: unknown }) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }, focusPopout: () => Promise.resolve() }
  t.after(() => { window.open = realOpen; if (realBridge === undefined) delete host.orgtreeDesktop; else host.orgtreeDesktop = realBridge; if (realObserver === undefined) delete g.MutationObserver; else g.MutationObserver = realObserver })
  const emit: Emit = data => inAct(async () => { for (const fn of [...listeners]) fn({ type: 'popout-state', data }); await tick() })
  return { opened, emit }
}
const surface = (kind: string) => <MovableSurface kind={kind} org="native-org" title="Fixture"><p>Fixture</p><PopoutButton /></MovableSurface>
const click = (el: Element | null | undefined) => inAct(async () => { (el as HTMLElement).click(); await tick() })
const row = (kind: string) => savedWindows().find(r => r.key === windowLayoutKey(kind, 'native-org'))
/** Quit with the window open, so the row stays open, then start again: the startup restore. */
async function restart(kind: string, view: { unmount(): Promise<void> | void }) {
  beginWindowExit()
  try { await inAct(async () => { await view.unmount(); await tick() }) } finally { endWindowExit() }
  const again = await mountView(surface(kind), el => el)
  await inAct(tick)
  return again
}

test('the native window\'s own box is what its saved row keeps, and a restore asks for it exactly', async t => {
  const n = native(t), kind = 'fixture-native-box'
  const view = await mountView(surface(kind), el => el)
  await inAct(tick)
  await click(view.el.ownerDocument.querySelector('[aria-label="Open in new window"]'))
  assert.equal(n.opened.length, 1, 'it popped out')
  await n.emit({ name: n.opened[0]!.name, present: true, maximized: false, bounds: { x: 340, y: 180, width: 560, height: 400 } })
  const again = await restart(kind, view)
  t.after(() => again.unmount())
  assert.deepEqual([row(kind)?.rect, row(kind)?.exact], [{ x: 340, y: 180, width: 560, height: 400 }, true], 'the row keeps the reported box, marked exact')
  assert.equal(n.opened.length, 2, 'the restart restores its window')
  assert.match(n.opened[1]!.features, /(?:^|,)orgtreeExactRect=1,orgtreeNativeRect=1,left=340,top=180,width=560,height=400(?:,|$)/,
    'main places that box exactly, not the renderer\'s view of it (332,180 576x408)')
})

test('control: without a report for its own window, the row keeps the renderer\'s view and restores as before', async t => {
  const n = native(t), kind = 'fixture-native-none'
  const view = await mountView(surface(kind), el => el)
  await inAct(tick)
  await click(view.el.ownerDocument.querySelector('[aria-label="Open in new window"]'))
  await n.emit({ name: 'orgtree-popout-somebody-else', present: true, maximized: false, bounds: { x: 1, y: 2, width: 700, height: 500 } })
  const again = await restart(kind, view)
  t.after(() => again.unmount())
  assert.deepEqual([row(kind)?.rect, row(kind)?.exact], [{ x: 332, y: 180, width: 576, height: 408 }, undefined], 'another window\'s report is not this one\'s')
  assert.match(n.opened[1]!.features, /^popup,left=332,top=180,width=576,height=408(?:,|$)/, 'and the restore is unchanged')
})
