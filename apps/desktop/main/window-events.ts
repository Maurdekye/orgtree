/** WHO MINIMIZED IT. Every main window's minimize, restore, show, hide and
 *  focus, and every Orgtree action that causes one, as one short JSON line
 *  each in <data root>/diagnostics/desktop-windows.jsonl.
 *
 *  ⚠ WHY (user 2026-10-09: "dont minimize any existing window"). The window
 *  they were in ended up minimized after a notification opened another
 *  organization's window, and nothing on record could say what minimized it.
 *  Orgtree's own causes are written just BEFORE it acts ('action'); the
 *  native events are written as Electron reports them ('event'). A minimize
 *  with no 'minimize-button' action for that window just before it came from
 *  Windows or the user, not from Orgtree.
 *
 *  Cheap by construction: no move, resize or other per-frame event, one
 *  small append per line, and the file is rotated to `.1` past MAX_BYTES so
 *  it can never grow without bound. Best effort: a full disk or a missing
 *  data root never breaks a window. Pure apart from the filesystem (no
 *  electron import) so tests/window-events.test.mjs drives it. */
import fs from 'node:fs'
import path from 'node:path'

export const WINDOW_EVENTS_LOG = path.join('diagnostics', 'desktop-windows.jsonl')
export const WINDOW_EVENTS_MAX_BYTES = 1_000_000

/** The native events recorded. Deliberately not move, resize or blur. */
export const WINDOW_EVENT_TYPES = ['minimize', 'restore', 'show', 'hide', 'focus'] as const
export type WindowEventType = typeof WINDOW_EVENT_TYPES[number]

/** Orgtree's own causes, written just before it acts:
 *  reveal          — a notification, the tray or an open showed/restored/focused it
 *  minimize-button — the window's own minimize button
 *  close-hide      — closing the last visible window hid it (tray retention) */
export type WindowAction = 'reveal' | 'minimize-button' | 'close-hide'

/** What a line says about the window: its registry identity at that moment. */
export interface WindowFacts { kind?: string; org?: string }

export class WindowEventLog {
  constructor(private readonly file: () => string | undefined,
    private readonly maxBytes = WINDOW_EVENTS_MAX_BYTES,
    private readonly clock: () => Date = () => new Date()) {}

  record(window: string, facts: WindowFacts | undefined, what: { event: WindowEventType } | { action: WindowAction }): void {
    try {
      const file = this.file()
      if (!file) return
      fs.mkdirSync(path.dirname(file), { recursive: true })
      let size = 0
      try { size = fs.statSync(file).size } catch { /* not there yet */ }
      if (size > this.maxBytes) fs.renameSync(file, file + '.1')
      const line = { at: this.clock().toISOString(), window, kind: facts?.kind, org: facts?.org, ...what }
      fs.appendFileSync(file, JSON.stringify(line) + '\n')
    } catch { /* diagnostics never break the window they describe */ }
  }
}

/** Record one main window's native events. `facts` is asked at event time,
 *  so a Homepage that binds an organization is logged with it from then on. */
export function watchWindowEvents(window: { on(event: WindowEventType, listener: () => void): unknown }, id: string,
  facts: () => WindowFacts | undefined, log: WindowEventLog): void {
  for (const event of WINDOW_EVENT_TYPES) window.on(event, () => log.record(id, facts(), { event }))
}
