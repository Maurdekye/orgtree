interface FlashWindow {
  isDestroyed(): boolean
  isFocused(): boolean
  flashFrame(flag: boolean): void
}

/** One thing waiting on the user. `org` is the organization it belongs to and
 *  is what decides WHICH window pulses; an item without one falls back to the
 *  last-used window, which is also how the v2 payload (a bare identity list)
 *  keeps working. */
export interface AttentionItem { id: string; org?: string }

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
 *  reporting the same items after the user has looked will not pulse again.
 *
 *  ⚠ WHICH WINDOW PULSES (user ruling 2026-09-21, relayed through
 *  coordinator-sol). The pulse belongs to the ORGANIZATION that owns the
 *  affected item: an item in organization A flashes A's own window, and only
 *  falls back to the last-used main window when that organization has no
 *  window open. Every main window is NEVER flashed — one arrival must not
 *  light up the whole taskbar — and the pulse must not follow the window that
 *  happens to hold the app-wide notification duties, which is an unrelated
 *  window chosen on unrelated grounds.
 *
 *  Routing is by organization identity, supplied by the resolver, never by a
 *  window id the caller chose. This class never learns what a window id is.
 *
 *  Nothing else about the rule changed: the new-arrival trigger, the known-set
 *  baseline, the refusal to flash a window the user is already looking at and
 *  the clearing on activation are all exactly as they were. */
export class TaskbarAttention {
  private known = new Set<string>()
  /** The windows with a flash currently running. v2 held one boolean, which
   *  was the same statement when there was one window. */
  private flashing = new Set<FlashWindow>()
  constructor(private target: (org?: string) => FlashWindow | undefined) {}

  /** @returns whether this call started a pulse — for tests and for callers
   *  that want to log a real attention event rather than a poll. */
  set(items: readonly (AttentionItem | string)[]): boolean {
    const next = new Map<string, string | undefined>()
    for (const item of items) {
      if (typeof item === 'string') next.set(item, undefined)
      else next.set(item.id, item.org)
    }
    const arrived = [...next].filter(([id]) => !this.known.has(id))
    this.known = new Set(next.keys())
    if (!next.size) { this.stopAll(); return false }
    if (!arrived.length) return false
    // One pulse per affected window even when several items arrive for it at
    // once, and only for the windows actually affected.
    const targets = new Set<FlashWindow>()
    for (const [, org] of arrived) {
      const window = this.target(org)
      if (window) targets.add(window)
    }
    let started = false
    for (const window of targets) if (this.start(window)) started = true
    return started
  }

  /** A window was activated: the platform has already stopped its flash.
   *  Called without one, every flash is forgotten — which is what a single
   *  window meant before there were several. */
  focused(window?: FlashWindow): void {
    if (window) this.flashing.delete(window)
    else this.flashing.clear()
  }

  /** Nothing is waiting any more, anywhere. */
  private stopAll(): void {
    for (const window of this.flashing) {
      if (!window.isDestroyed()) window.flashFrame(false)
    }
    this.flashing.clear()
  }

  private start(window: FlashWindow): boolean {
    // Flashing the window the user is already looking at says nothing.
    if (window.isDestroyed() || window.isFocused()) return false
    window.flashFrame(true)
    this.flashing.add(window)
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

/** THE BOUNDARY FOR THE PAYLOAD THE PULSE ROUTING CONSUMES.
 *
 *  ⚠ WHY THIS DOES NOT PARSE THE IDENTITY STRING, even though the
 *  organization is sitting right there in it. `summarizePending` encodes each
 *  row as `JSON.stringify([row.org, row.id])`, and reading the organization
 *  back out of that was the first thing tried here. The shell owner's
 *  objection is correct and is the reason it is gone: that string is the
 *  renderer's DEDUP ENCODING, not a contract. It exists so two aggregates can
 *  be compared with `===`, and it is free to change the day the dedup key
 *  needs to - at which point nothing would fail to compile, no test on either
 *  side would go red, and the pulse would simply stop reaching the right
 *  window. A coupling that cannot break loudly is worse than no coupling.
 *
 *  So the organization arrives as data. `setPendingAttention(ids, items)` is
 *  ADDITIVE: `ids` keeps its meaning and its order exactly, so nothing that
 *  ignores `items` changes behaviour, and `items[i]` is the same row as
 *  `ids[i]` because both come out of one sorted pass in `summarizePending`.
 *  Without `items` the organization is simply unknown, which routes to the
 *  last-used window - the behaviour a bare identity list always had.
 *
 *  ⚠ THE IDENTITY IS NEVER REWRITTEN. `id` is the whole original string, so
 *  the genuinely-new dedup compares exactly what it compared before and the
 *  qualifying kinds are untouched. `org` is carried for routing only. */
/** Pair the identity list with the organizations the renderer supplied
 *  alongside it. The correspondence is positional and STRUCTURAL - both halves
 *  come out of one pass - so a length mismatch is a real disagreement about
 *  what was published and is refused rather than zipped as far as it goes. */
export function attentionPayload(ids: unknown, items: unknown): AttentionItem[] {
  const identities = attentionIdentities(ids)
  if (items === undefined || items === null) return identities.map(id => ({ id }))
  const rows = attentionItems(items)
  if (rows.length !== identities.length) throw new Error('Invalid attention identities')
  return identities.map((id, index) => {
    const org = rows[index]?.org
    return org === undefined ? { id } : { id, org }
  })
}

export function attentionItems(value: unknown): AttentionItem[] {
  if (!Array.isArray(value) || value.length > 5000) throw new Error('Invalid attention identities')
  return value.map(item => {
    if (typeof item === 'string') {
      if (!item || item.length > 400) throw new Error('Invalid attention identity')
      return { id: item }
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid attention identity')
    const record = item as Record<string, unknown>
    for (const key of Object.keys(record)) if (!['id', 'org'].includes(key)) throw new Error('Invalid attention identity')
    if (typeof record.id !== 'string' || !record.id || record.id.length > 400) throw new Error('Invalid attention identity')
    if (record.org !== undefined && (typeof record.org !== 'string' || !record.org || record.org.length > 128)) throw new Error('Invalid attention identity')
    return record.org === undefined ? { id: record.id } : { id: record.id, org: record.org as string }
  })
}
