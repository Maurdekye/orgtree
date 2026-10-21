import { getDocument, getWorkItem } from '../api'

export type ObjectTooltipKind = 'ticket' | 'document'
const KIND = 'data-object-tooltip-kind', ID = 'data-object-tooltip-id', ORG = 'data-object-tooltip-org'

export function objectTooltipProps(kind: ObjectTooltipKind, id: string, org?: string) {
  return { [KIND]: kind, [ID]: id, [ORG]: org }
}

// Only concurrent reads are coalesced. A later hover must see renames and
// permission changes; there is no ever-growing retained identity catalog.
const reading = new Map<string, Promise<string | null>>()
async function titleOf(kind: string, org: string, id: string): Promise<string | null> {
  if (!org || !id || /[\\?#\u0000]/.test(id) || id === '.' || id === '..' || id.includes('/')) return null
  if (kind !== 'ticket' && kind !== 'document') return null
  const key = JSON.stringify([kind, org, id])
  let request = reading.get(key)
  if (!request) {
    request = (kind === 'ticket' ? getWorkItem(org, id).then(({ item }) => item?.title || null)
      : getDocument(org, id).then(doc => doc?.title || null)).catch(() => null)
    reading.set(key, request)
    void request.then(() => { if (reading.get(key) === request) reading.delete(key) })
  }
  return request
}

/** Native titles resolve only the exact hovered identity. Register in each
 * adopted document; stale replies cannot decorate another target or window. */
export function registerObjectNativeTooltipDocument(owner: Document, orgNow: () => string | null = () => null): () => void {
  let live = true
  const active = new WeakMap<Element, object>()
  const target = (event: Event) => (event.target as Element | null)?.closest?.(`[${KIND}]`) as HTMLElement | null
  const show = (event: Event) => {
    const anchor = target(event)
    if (!anchor) return
    anchor.removeAttribute('title')
    const request = {}; active.set(anchor, request)
    const kind = anchor.getAttribute(KIND)!, id = anchor.getAttribute(ID) ?? ''
    const org = anchor.getAttribute(ORG) || orgNow() || ''
    void titleOf(kind, org, id).then(title => {
      if (live && title && active.get(anchor) === request && anchor.isConnected && anchor.ownerDocument === owner
        && anchor.getAttribute(ID) === id && (anchor.getAttribute(ORG) || orgNow() || '') === org) anchor.title = title
    })
  }
  const clear = (event: Event) => {
    const anchor = target(event)
    const related = (event as PointerEvent | FocusEvent).relatedTarget
    if (event.type !== 'contextmenu' && related && typeof related === 'object' && 'nodeType' in related
      && anchor?.contains(related as Node)) return
    if (anchor) { active.delete(anchor); anchor.removeAttribute('title') }
  }
  owner.addEventListener('pointerover', show, true); owner.addEventListener('focusin', show, true)
  owner.addEventListener('pointerout', clear, true); owner.addEventListener('focusout', clear, true)
  owner.addEventListener('contextmenu', clear, true)
  return () => {
    live = false
    owner.removeEventListener('pointerover', show, true); owner.removeEventListener('focusin', show, true)
    owner.removeEventListener('pointerout', clear, true); owner.removeEventListener('focusout', clear, true)
    owner.removeEventListener('contextmenu', clear, true)
  }
}
