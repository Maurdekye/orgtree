// mainwindow.ts — IS THIS RENDERER'S MAIN WINDOW ON SCREEN?
//
// Closing the main window while a panel is popped out does not end the renderer: the native side hides the window
// and keeps it for its panels (`keepForPanels`, main/index.ts), and the popped-out windows go on being drawn by this
// same renderer. A route that would answer a click by moving something IN the main window (the canvas camera, a pin)
// then answers it where nobody can see. This is the one fact such a route needs.
//
// The native side publishes it: `getWindowControlsState()` once, then a `window-state` event at every show, hide,
// minimize and restore (`publishWindowState`). `document.hidden` is NOT the same question: the main process switches
// background throttling off for a window that hosts running panels, and Chromium then goes on reporting the hidden
// window's document as visible.
//
// ⚠ UNKNOWN IS "SHOWN". In a plain browser, in a test, or under a shell without these members, nothing ever says
// otherwise, and every route keeps exactly the behaviour it had before this file existed.
import { desktop } from './desktop'

let shown = true

const apply = (state: unknown): void => {
  const s = state as { visible?: unknown; minimized?: unknown } | null | undefined
  // minimized counts as not on screen: its canvas is as unreachable as a hidden window's
  if (s && typeof s.visible === 'boolean') shown = s.visible && s.minimized !== true
}

/** false only when the native side has said the main window is hidden or minimized */
export const mainWindowShown = (): boolean => shown

/** Follow the native side's reports for as long as the caller is mounted. Returns the unsubscribe, which also puts
 *  the answer back to "shown" (nothing is listening any more, so nothing would ever correct a stale "hidden"). */
export function watchMainWindow(): () => void {
  const bridge = desktop()
  if (!bridge?.onEvent) return () => {}
  let alive = true
  void bridge.getWindowControlsState?.().then((state) => { if (alive) apply(state) }).catch(() => {})
  const off = bridge.onEvent((event) => { if (alive && event.type === 'window-state') apply(event.data) })
  return () => { alive = false; off(); shown = true }
}
