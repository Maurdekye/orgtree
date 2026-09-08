import { readReply } from './eventReply'
import type { ReplyContext } from './eventReply'
const partSuffix = (key: string) => key.endsWith('-attachments') ? '-attachments' : key.endsWith('-reply') ? '-reply' : ''

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
const recoveryPrefix = 'orgtree-draft-recovery-'
const dismissedRecoveryPrefix = 'orgtree-draft-recovery-dismissed-'
function savedIdentity(key: string, prefix: string): unknown[] | null {
  try {
    const value = JSON.parse(key.slice(prefix.length, partSuffix(key) ? -partSuffix(key).length : undefined))
    return Array.isArray(value) && value.length === 3 ? value : null
  } catch { return null }
}
export function preserveRemovedDrafts(slug: string, ids: ReadonlyMap<string, unknown>) {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    for (const key of keys) {
      if (!key?.startsWith(activePrefix)) continue
      const identity = savedIdentity(key, activePrefix)
      if (!identity || identity[0] !== slug || ids.has(String(identity[1]))) continue
      const value = localStorage.getItem(key)
      if (value !== null) {
        localStorage.setItem(recoveryPrefix + key.slice(activePrefix.length), value)
        localStorage.removeItem(key)
      }
    }
  } catch { /* best effort persistence */ }
}
function dismissedRecoveryKey(slug: string, id: string) {
  return `${dismissedRecoveryPrefix}${JSON.stringify([slug, id])}`
}
function readDismissedGenerations(slug: string, id: string): Set<number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(dismissedRecoveryKey(slug, id)) || '[]')
    return new Set(Array.isArray(raw) ? raw.filter((g): g is number => typeof g === 'number' && Number.isInteger(g)) : [])
  } catch { return new Set() }
}
function saveDismissedGenerations(slug: string, id: string, generations: Set<number>) {
  try {
    if (generations.size) localStorage.setItem(dismissedRecoveryKey(slug, id), JSON.stringify([...generations].sort((a, b) => a - b)))
    else localStorage.removeItem(dismissedRecoveryKey(slug, id))
  } catch { /* best effort persistence */ }
}
function removeDraftGeneration(slug: string, id: string, generation: number, currentGeneration: number | undefined) {
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
  for (const key of keys) {
    if (!key) continue
    const prefix = key.startsWith(activePrefix) ? activePrefix : key.startsWith(recoveryPrefix) ? recoveryPrefix : null
    if (!prefix) continue
    const identity = savedIdentity(key, prefix)
    if (!identity || identity[0] !== slug || identity[1] !== id || identity[2] !== generation) continue
    if (prefix === activePrefix && generation === currentGeneration) continue
    const textKey = partSuffix(key) ? key.slice(0, -partSuffix(key).length) : key
    localStorage.removeItem(key)
    localStorage.removeItem(textKey)
    localStorage.removeItem(`${textKey}-attachments`)
    localStorage.removeItem(`${textKey}-reply`)
  }
}
/** Permanently dismiss one recovered generation for this desk. */
export function discardRecoverableDraft(slug: string, id: string, generation: number, currentGeneration?: number) {
  try {
    const dismissed = readDismissedGenerations(slug, id)
    dismissed.add(generation)
    saveDismissedGenerations(slug, id, dismissed)
    removeDraftGeneration(slug, id, generation, currentGeneration)
  } catch { /* unavailable storage */ }
}
/** Permanently dismiss the currently recovered generations for this desk. */
export function discardAllRecoverableDrafts(slug: string, id: string, generations: readonly number[], currentGeneration?: number) {
  try {
    const dismissed = readDismissedGenerations(slug, id)
    for (const generation of generations) dismissed.add(generation)
    saveDismissedGenerations(slug, id, dismissed)
    for (const generation of generations) removeDraftGeneration(slug, id, generation, currentGeneration)
  } catch { /* unavailable storage */ }
}
export function recoverableDrafts(slug: string, id: string, generation: number | undefined) {
  const drafts: { key: string; generation: number; text: string; attachments: DraftAttachment[]; reply: ReplyContext | null }[] = []
  try {
    const dismissed = readDismissedGenerations(slug, id)
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!
      const prefix = key.startsWith(activePrefix) ? activePrefix : key.startsWith(recoveryPrefix) ? recoveryPrefix : null
      if (!prefix) continue
      const identity = savedIdentity(key, prefix)
      if (!identity || identity[0] !== slug || identity[1] !== id || typeof identity[2] !== 'number'
        || (prefix === activePrefix && identity[2] === generation)) continue
      if (dismissed.has(identity[2])) continue
      const textKey = partSuffix(key) ? key.slice(0, -partSuffix(key).length) : key
      if (drafts.some(d => d.key === textKey)) continue
      drafts.push({ key: textKey, generation: identity[2], text: localStorage.getItem(textKey) || '', attachments: readAttachments(textKey), reply: readReply(textKey) })
    }
  } catch { /* unavailable storage */ }
  return drafts
}
