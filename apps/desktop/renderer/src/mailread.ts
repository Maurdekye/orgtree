// Mail the user has just read, shown read AT ONCE (docket
// v3-marking-a-mail-as-read-takes-about-half-a-sec, user 2026-09-30: "it
// takes about half a second before the mail shows as read").
//
// A read used to show only after the save returned AND the inbox and the tree
// had been fetched again. Now the click records the mail here and every view
// that shows the user's unread state reads this store: the inbox list moves
// the row out of unread, the unread counts and the header bell drop, and the
// header dot drops an urgent or failure mail. The save runs in the
// background. A refused save forgets the entry, so the mail is unread again,
// and the caller says why.
//
// An accepted save is kept until both server views agree: an inbox read
// that no longer lists the mail as unread (`settleReadsFromBox`), and a tree
// read that STARTED after the save returned (`settleReadsFromTree`, because
// the tree's counts are what the bell shows). Forgetting it any earlier
// would flash the mail back to unread for one poll. Kept in memory per
// window, like the submitted-card store (asksubmitted.ts).
import { useSyncExternalStore } from 'react'

interface LocalRead {
  slug: string
  id: string
  urgent: boolean
  state: 'saving' | 'saved'
  savedAt?: number
  boxAgrees?: boolean
  treeAgrees?: boolean
}

const entries = new Map<string, LocalRead>()
const listeners = new Set<() => void>()
let version = 0
const key = (slug: string, id: string) => JSON.stringify([slug, id])
function emit() {
  version += 1
  for (const l of [...listeners]) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** Re-render on any change to the store. */
export function useLocalReads(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

/** Show `mail` read now and save it with `save`. Resolves when the save is
 *  accepted; rejects (after putting the mail back to unread) when refused. */
export function markReadNow(slug: string, mail: { id: string; urgent?: boolean },
  save: () => Promise<unknown>): Promise<void> {
  const k = key(slug, mail.id)
  if (entries.has(k)) return Promise.resolve()      // already read here
  const mine: LocalRead = { slug, id: mail.id, urgent: !!mail.urgent, state: 'saving' }
  entries.set(k, mine)
  emit()
  return save().then(() => {
    if (entries.get(k) === mine) {
      mine.state = 'saved'
      mine.savedAt = Date.now()
      emit()
    }
  }, (e: unknown) => {
    if (entries.get(k) === mine) { entries.delete(k); emit() }
    throw e
  })
}

/** The user read this mail here; the server may not say so yet. */
export function readLocally(slug: string, id: string | null | undefined): boolean {
  return id != null && entries.has(key(slug, String(id)))
}

/** How many of the tree's unread counts are reads it has not caught up
 *  with: subtract from `user_inbox_count` / `urgent_unread`. */
export function unconfirmedReads(slug: string): { all: number; urgent: number } {
  let all = 0, urgent = 0
  for (const e of entries.values()) {
    if (e.slug !== slug || e.treeAgrees) continue
    all++
    if (e.urgent) urgent++
  }
  return { all, urgent }
}

function drop(e: LocalRead) {
  if (e.boxAgrees && e.treeAgrees) entries.delete(key(e.slug, e.id))
}

/** An inbox read of `slug`: its unread ids. A saved read the box no longer
 *  lists as unread is confirmed there. */
export function settleReadsFromBox(slug: string, pendingIds: Iterable<string>) {
  const pending = new Set(pendingIds)
  let changed = false
  for (const e of [...entries.values()]) {
    if (e.slug !== slug || e.state !== 'saved' || e.boxAgrees || pending.has(e.id)) continue
    e.boxAgrees = true
    drop(e)
    changed = true
  }
  if (changed) emit()
}

/** A tree read of `slug` that started at `startedAt` (ms): every read saved
 *  before then is in its counts. */
export function settleReadsFromTree(slug: string, startedAt: number) {
  let changed = false
  for (const e of [...entries.values()]) {
    if (e.slug !== slug || e.state !== 'saved' || e.treeAgrees
        || (e.savedAt ?? Infinity) > startedAt) continue
    e.treeAgrees = true
    drop(e)
    changed = true
  }
  if (changed) emit()
}

/** Test hook: empty the store. */
export function resetLocalReads() {
  entries.clear()
  emit()
}
