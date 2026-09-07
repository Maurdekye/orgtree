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
      const attachment = key.endsWith('-attachments')
      const encoded = key.slice(prefix.length, attachment ? -12 : undefined)
      let identity: unknown
      try { identity = JSON.parse(encoded) } catch { continue }
      if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== slug || identity[1] !== from) continue
      const target = `${prefix}${JSON.stringify([slug, to, identity[2]])}${attachment ? '-attachments' : ''}`
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
function savedIdentity(key: string, prefix: string): unknown[] | null {
  try {
    const value = JSON.parse(key.slice(prefix.length, key.endsWith('-attachments') ? -12 : undefined))
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
export function recoverableDrafts(slug: string, id: string, generation: number | undefined) {
  const drafts: { key: string; generation: number; text: string; attachments: DraftAttachment[] }[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!
      const prefix = key.startsWith(activePrefix) ? activePrefix : key.startsWith(recoveryPrefix) ? recoveryPrefix : null
      if (!prefix) continue
      const identity = savedIdentity(key, prefix)
      if (!identity || identity[0] !== slug || identity[1] !== id || typeof identity[2] !== 'number'
        || (prefix === activePrefix && identity[2] === generation)) continue
      const textKey = key.endsWith('-attachments') ? key.slice(0, -12) : key
      if (drafts.some(d => d.key === textKey)) continue
      drafts.push({ key: textKey, generation: identity[2], text: localStorage.getItem(textKey) || '', attachments: readAttachments(textKey) })
    }
  } catch { /* unavailable storage */ }
  return drafts
}
