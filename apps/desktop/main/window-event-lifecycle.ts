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
  let phase: 'idle' | 'provisional' | 'committed' = 'idle'
  contents.on('did-start-navigation', details => {
    if (!details.isMainFrame || details.isSameDocument) return
    phase = 'provisional'
    pendingFrom = record.documentToken
    record.outbox.suspend()
  })
  contents.on('did-navigate', () => {
    // The response has committed, but its body can still fail before finish.
    // Keep this load current even after the replacement preload mints a token.
    phase = 'committed'
    record.documentToken = ''
    record.outbox.rearm()
    record.outbox.resume() // no listener for the new document yet
  })
  contents.on('did-finish-load', () => {
    // An error/old-document finish while another navigation is provisional
    // does not complete that newer load. Only its own commit enables finish.
    if (phase === 'committed') phase = 'idle'
  })
  contents.on('did-stop-loading', () => {
    // A stop belonging to a superseded navigation cannot release a newer
    // provisional load. Electron exposes the current main-frame load state.
    if (contents.isLoadingMainFrame()) return
    phase = 'idle'
    for (const event of record.outbox.resume()) send(event)
  })
  return {
    documentLost() {
      // A finished document is protected against delayed failures, including
      // retries at the same URL. During a provisional load, the old token
      // identifies the document being left; after commit the current response
      // itself is unfinished and can fail even though its preload has run.
      if (phase === 'idle' || (phase === 'provisional' && record.documentToken !== pendingFrom)) return false
      record.documentToken = ''
      record.outbox.rearm()
      return true
    },
  }
}
