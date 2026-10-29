import { getDocument, getWorkItem, getMailById } from '../api'

import { mailTitle } from './mailtitle'
import { knownStatus, statusLabel } from './docketstatus'
import { docStateTitle, docUnread } from './docviewed'
export type ObjectTooltipKind = 'ticket' | 'document' | 'mail'
const KIND = 'data-object-tooltip-kind', ID = 'data-object-tooltip-id', ORG = 'data-object-tooltip-org'

export function objectTooltipProps(kind: ObjectTooltipKind, id: string, org?: string) {
  return { [KIND]: kind, [ID]: id, [ORG]: org }
}

// Only concurrent reads are coalesced. A later hover must see renames and
// permission changes; there is no ever-growing retained identity catalog.
const reading = new Map<string, Promise<string | null>>()
async function titleOf(kind: string, org: string, id: string, box?: string | null, node?: string | null, actionLabel?: string | null, viewed = ''): Promise<string | null> {
  if (!org || !id || /[\\?#\u0000]/.test(id) || id === '.' || id === '..' || id.includes('/')) return null
  if (kind !== 'ticket' && kind !== 'document' && kind !== 'mail') return null
  if (kind === 'mail' && (id === '@user' || !(box === 'user' || box === 'org' || box === 'node' && node))) return null
  const key = JSON.stringify([kind, org, id, box, node, actionLabel, viewed])
  let request = reading.get(key)
  if (!request) {
    request = (kind === 'mail' ? getMailById(org, box as 'user'|'org'|'node', id, node || undefined).then(r => r.found && r.mail ? mailTitle(r.mail, actionLabel) : null)
      : kind === 'ticket' ? getWorkItem(org, id).then(({ item }) => {
        if (!item) return null
        // Read current state on every hover, never from a historical tool
        // result or a cached list row (user 2026-10-21). A ticket link draws
        // its title inline, so the hover names the SLUG instead (USER
        // 2026-10-29 m3ad5633675ff); only another org's item adds its org.
        const status = item.archived === true ? 'Archived'
          : knownStatus(item.status) ? statusLabel(item.status) : null
        const name = viewed && org !== viewed ? `${org}/${id}` : id
        return status ? `${status} · ${name}` : name
      })
      // a presentation unread or modified since read says so first, from the
      // same fresh read (USER 2026-10-27 m919f12828686)
      : getDocument(org, id).then(doc => doc?.title
        ? docStateTitle(docUnread(org, doc.id || id, doc.at, doc.viewed_at), doc.title) : null)).catch(() => null)
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
    const box = anchor.getAttribute('data-mail-box'), node = anchor.getAttribute('data-mail-node')
    const actionLabel = anchor.getAttribute('data-mail-action-label')
    void titleOf(kind, org, id, box, node, actionLabel, orgNow() || '').then(title => {
      if (live && title && active.get(anchor) === request && anchor.isConnected && anchor.ownerDocument === owner
        && anchor.getAttribute('data-mail-action-label') === actionLabel && anchor.getAttribute(KIND) === kind && anchor.getAttribute('data-mail-box') === box && anchor.getAttribute('data-mail-node') === node
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
