import { recordStranded, renameHistory } from './composerhistory'
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
export function preserveRemovedDrafts(slug: string, ids: ReadonlyMap<string, unknown>) {
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
    }
  } catch { /* best effort persistence */ }
}
