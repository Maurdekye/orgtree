import type { WindowOutbox } from './window-outbox'

interface NavigationContents {
  on(name: string, listener: (...args: any[]) => void): unknown
  isLoadingMainFrame(): boolean
}

/** Shared by shipping window creation and the isolated Electron fixture.
 * A provisional load holds reveals. Commit invalidates the old listener;
 * cancellation retains it. Neither outcome guesses readiness from a timer. */
export function attachWindowEventLifecycle<E extends { type: string }>(
  contents: NavigationContents,
  record: { documentToken: string; outbox: WindowOutbox<E> },
  send: (event: E) => void,
) {
  let pendingFrom = record.documentToken
  let pending = false
  contents.on('did-start-navigation', details => {
    if (!details.isMainFrame || details.isSameDocument) return
    pending = true
    pendingFrom = record.documentToken
    record.outbox.suspend()
  })
  contents.on('did-navigate', () => {
    pending = false
    record.documentToken = ''
    record.outbox.rearm()
    record.outbox.resume() // no listener for the new document yet
  })
  contents.on('did-stop-loading', () => {
    // A stop belonging to a superseded navigation cannot release a newer
    // provisional load. Electron exposes the current main-frame load state.
    if (contents.isLoadingMainFrame()) return
    pending = false
    for (const event of record.outbox.resume()) send(event)
  })
  return {
    documentLost() {
      // A delayed failure cannot invalidate a newly announced document,
      // even when both attempts have the same URL.
      if (!pending || record.documentToken !== pendingFrom) return false
      record.documentToken = ''
      record.outbox.rearm()
      return true
    },
  }
}
