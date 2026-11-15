import { preserveRemovedStashes, recordStranded, renameHistory } from './composerhistory'
const partSuffix = (key: string) => key.endsWith('-attachments') ? '-attachments' : key.endsWith('-replies') ? '-replies' : key.endsWith('-reply') ? '-reply' : ''

export interface DraftAttachment { name: string; path: string; bytes: number }
export const draftKey = (slug: string, id: string, generation: number) =>
  `orgtree-draft-v2-${JSON.stringify([slug, id, generation])}`
export function readAttachments(key: string): DraftAttachment[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(`${key}-attachments`) || '[]')
    return Array.isArray(raw) ? raw.filter((a): a is DraftAttachment => !!a && typeof a === 'object'
      && typeof a.name === 'string' && typeof a.path === 'string'
      && typeof a.bytes === 'number' && Number.isFinite(a.bytes)) : []
  } catch { return [] }
}
export function storeAttachments(key: string, attachments: DraftAttachment[]) {
  try {
    if (attachments.length) localStorage.setItem(`${key}-attachments`, JSON.stringify(attachments))
    else localStorage.removeItem(`${key}-attachments`)
  } catch { /* Same best-effort browser persistence as composer text. */ }
}

/** A validated rename changes only the name, never a draft's generation. */
export function renameDrafts(slug: string, from: string, to: string) {
  // The agent's sent-message history is keyed on the node id and NOT on the
  // generation, so a rename is the one event that would otherwise lose it.
  renameHistory(slug, from, to)
  try {
    const prefix = 'orgtree-draft-v2-'
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    for (const key of keys) {
      if (!key?.startsWith(prefix)) continue
      const suffix = partSuffix(key)
      const encoded = key.slice(prefix.length, suffix ? -suffix.length : undefined)
      let identity: unknown
      try { identity = JSON.parse(encoded) } catch { continue }
      if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== slug || identity[1] !== from) continue
      const target = `${prefix}${JSON.stringify([slug, to, identity[2]])}${suffix}`
      const value = localStorage.getItem(key)
      if (value !== null && localStorage.getItem(target) === null) {
        localStorage.setItem(target, value)
        localStorage.removeItem(key)
      }
      // A conflicting destination is retained alongside the old recovery key.
    }
  } catch { /* best effort persistence */ }
}

const activePrefix = 'orgtree-draft-v2-'
function savedIdentity(key: string, prefix: string): unknown[] | null {
  try {
    const value = JSON.parse(key.slice(prefix.length, partSuffix(key) ? -partSuffix(key).length : undefined))
    return Array.isArray(value) && value.length === 3 ? value : null
  } catch { return null }
}
/** A draft belonging to a node that has left the org is STRANDED, and it now
 *  goes straight into that agent's sent-message history instead of into the
 *  `orgtree-draft-recovery-` keys and the panel that read them. It is marked
 *  as never-delivered and reached with Up like anything else. If the agent is
 *  rehired the history is still there, because the history key carries no
 *  generation. */
export function preserveRemovedDrafts(slug: string, ids: Pick<ReadonlyMap<string, unknown>, 'has'>) {
  preserveRemovedStashes(slug, ids)
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    for (const key of keys) {
      if (!key?.startsWith(activePrefix)) continue
      const identity = savedIdentity(key, activePrefix)
      if (!identity || identity[0] !== slug || ids.has(String(identity[1]))) continue
      const suffix = partSuffix(key)
      const textKey = suffix ? key.slice(0, -suffix.length) : key
      const value = localStorage.getItem(textKey)
      if (value) recordStranded(slug, String(identity[1]), value)
      localStorage.removeItem(textKey)
      localStorage.removeItem(`${textKey}-attachments`)
      localStorage.removeItem(`${textKey}-reply`)
      localStorage.removeItem(`${textKey}-replies`)
    }
  } catch { /* best effort persistence */ }
}

// ------------------------------------------------------------ one composer per desk identity
// Every place a desk is open renders its own live desk (USER 2026-11-15 mbf1f1ca2cfe9, "it should always show in both
// locations at once"), so the unsent draft can no longer live in one desk's useState. Each part of it (the text, its
// attachments, its reply targets) is ONE shared value per storage key: every open view of the desk reads it here, a
// write from any of them reaches all of them, and the storage keys stay exactly what they were.
//
// The snapshot is keyed by the RAW stored strings, so a writer that goes straight to localStorage (carryDraftForward,
// renameDrafts, a failed send restoring its text) is seen at the next read without having to know about this store,
// and an unchanged raw value returns the same parsed object, which useSyncExternalStore requires.
interface SharedPart { raw: string; value: unknown }
const sharedParts = new Map<string, SharedPart>()
const sharedListeners = new Map<string, Set<() => void>>()
const rawOf = (keys: readonly string[]) => keys.map((k) => {
  try { return localStorage.getItem(k) ?? '\u0001' } catch { return '\u0002' }
}).join('\u0000')

/** The current shared value stored under `keys` (the first names the part). */
export function sharedDraftPart<T>(keys: readonly string[], read: () => T): T {
  const raw = rawOf(keys)
  const held = sharedParts.get(keys[0])
  if (held && held.raw === raw) return held.value as T
  const value = read()
  sharedParts.set(keys[0], { raw, value })
  return value
}
/** Write a shared part and tell every view holding it. */
export function setSharedDraftPart<T>(keys: readonly string[], value: T, write: (value: T) => void): void {
  write(value)
  // a storage that refuses the write still updates every open view: the value is what they show
  sharedParts.set(keys[0], { raw: rawOf(keys), value })
  for (const fn of [...(sharedListeners.get(keys[0]) ?? [])]) fn()
}
export function subscribeDraftPart(key: string, fn: () => void): () => void {
  let set = sharedListeners.get(key)
  if (!set) sharedListeners.set(key, set = new Set())
  set.add(fn)
  return () => { set!.delete(fn); if (!set!.size) sharedListeners.delete(key) }
}
/** test seam: forget every cached part (the tests clear localStorage between cases) */
export function resetSharedDrafts(): void { sharedParts.clear() }
