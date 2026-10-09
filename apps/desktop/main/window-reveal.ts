/** PUTTING ONE WINDOW IN FRONT OF THE USER, AND ONLY THAT ONE.
 *
 *  ⚠ "DONT MINIMIZE ANY EXISTING WINDOW" (user 2026-10-09, after clicking a
 *  notification for another organization: its window opened and the window
 *  they had been in ended up minimized). Revealing is done TO ONE WINDOW: it
 *  is shown, restored if it was minimized, maximized if that is its saved
 *  state, and focused. Nothing here minimizes, hides, restores, resizes, moves
 *  or re-orders any other window, and each function is handed exactly the one
 *  window it acts on, so it could not reach another if it tried.
 *
 *  Pure on purpose (no electron import): tests/window-reveal.test.mjs drives
 *  it, with the real registry, openOrg and notification manager, against
 *  windows that record every call made on them. */

/** The native calls a reveal makes. Nothing else is needed, or reachable. */
export interface RevealableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  show(): void
  restore(): void
  maximize(): void
  focus(): void
}

export interface RevealRecord<W extends RevealableWindow = RevealableWindow> {
  readonly id: string
  readonly window: W
  /** Its saved placement was maximized and it has not been shown yet. */
  restoreMaximized?: boolean
}

/** Show, restore, re-maximize and focus THIS window. False for a destroyed one. */
export function revealOnly(record: RevealRecord): boolean {
  if (record.window.isDestroyed()) return false
  record.window.show()
  if (record.window.isMinimized()) record.window.restore()
  if (record.restoreMaximized) { record.restoreMaximized = false; record.window.maximize() }
  record.window.focus()
  return true
}

/** What a notification's reveal needs from the native host. */
export interface OrgRevealHost<R, E> {
  /** The registry's `queueReveal`: the window bound to that organization, or
   *  undefined after holding the event for the window about to be opened. */
  queueReveal(org: unknown, event: E): { id: string } | undefined
  record(id: string): R | undefined
  /** Bring that one window forward (`revealOnly` plus the host's bookkeeping). */
  reveal(record: R): void
  send(id: string, event: E): void
  /** Open the organization's own window (or focus it); the held event is
   *  delivered to it once it exists. */
  open(org: unknown): Promise<unknown>
}

/** A notification belongs to one organization: reveal that organization's
 *  window and hand it the event, or open one for it. The window the user is
 *  in keeps its organization and is not touched (decision 60). */
export async function revealInOrgWindow<R, E>(org: unknown, event: E, host: OrgRevealHost<R, E>): Promise<void> {
  const target = host.queueReveal(org, event)
  if (target) {
    const record = host.record(target.id)
    if (record) { host.reveal(record); host.send(target.id, event) }
    return
  }
  await host.open(org)
}
