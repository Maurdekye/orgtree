interface FlashWindow {
  isDestroyed(): boolean
  isFocused(): boolean
  flashFrame(flag: boolean): void
}

/** THE WINDOWS TASKBAR PULSE (user ruling 2026-09-12): while any attached
 *  question, attention ticket or urgent mail is waiting, the taskbar button
 *  uses the platform's own attention behaviour — `flashFrame`, which is what
 *  every other Windows application uses to say "come back here".
 *
 *  The renderer publishes the whole qualifying IDENTITY SET on every poll
 *  rather than a boolean, because the two things this has to tell apart look
 *  identical to a boolean:
 *    · the same items seen again on the next poll — MUST NOT restart the
 *      pulse, or a five-second poll would flash the taskbar for ever;
 *    · one of several items resolving — MUST NOT clear or restart anything,
 *      because the rest are still waiting;
 *  while a genuinely NEW arrival must pulse, even though the taskbar was
 *  already "in attention" for an older item.
 *
 *  Windows cancels a flash the moment the window is activated, so `focused()`
 *  forgets that a flash is running. The known set is deliberately kept: a poll
 *  reporting the same items after the user has looked will not pulse again. */
export class TaskbarAttention {
  private known = new Set<string>()
  private flashing = false
  constructor(private target: () => FlashWindow | undefined) {}

  /** @returns whether this call started a pulse — for tests and for callers
   *  that want to log a real attention event rather than a poll. */
  set(ids: readonly string[]): boolean {
    const next = new Set(ids)
    const arrived = [...next].some(id => !this.known.has(id))
    this.known = next
    if (!next.size) { this.stop(); return false }
    if (!arrived) return false
    return this.start()
  }

  /** The window was activated: the platform has already stopped the flash. */
  focused(): void { this.flashing = false }

  /** Nothing is waiting any more. */
  private stop(): void {
    if (!this.flashing) return
    this.flashing = false
    const window = this.target()
    if (window && !window.isDestroyed()) window.flashFrame(false)
  }

  private start(): boolean {
    const window = this.target()
    // Flashing the window the user is already looking at says nothing.
    if (!window || window.isDestroyed() || window.isFocused()) return false
    window.flashFrame(true)
    this.flashing = true
    return true
  }
}

/** Validate the renderer's payload at the IPC boundary, exactly as the
 *  notification identities are validated: a string list, bounded. */
export function attentionIdentities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5000) throw new Error('Invalid attention identities')
  return value.map(id => {
    if (typeof id !== 'string' || !id || id.length > 400) throw new Error('Invalid attention identity')
    return id
  })
}
