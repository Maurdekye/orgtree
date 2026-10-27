import { mailIdentityAt, mailMenuEntries } from './mailidentity'
import { refToken } from './reflinks'
import { MAIL_COPY_FAILED, mailRowCopyText, mailRowNeedsFullFetch, resolveFullMailCopyText } from './copytext'
import { getMailById, getDocument, getWorkItem, getWatchdog, watchdogAction } from '../api'
import { presentationMenu } from './docs'
import { captureObjectActions } from './composerobjects'
import type { ToastFn, Watchdog } from '../types'
import { copyToClipboard } from './contextmenu'
import type { MenuEntry } from './contextmenu'
import { nodeMenuAction, watchdogActions } from './objectactions'
import { captureTicketMention, ticketMenuEntries, ticketStaffable } from './ticketmenu'
import { quickStaffPath } from './quickstaff'
import type { QuickStaffPreview } from './quickstaff'
import { peekQuickStaff, prefetchQuickStaff } from './staffingoptions'
import { useAgentNavRegistry } from './agentnav'
import { useProvideObjectNav } from './objectnav'
import { appRefRow, panelRefRow } from './apprefs'
import { appLinkMenu, panelLinkMenu } from './apps/links'
import { refNames } from './refnames'

/** The current org's existing routes, shared by links and direct object menus. */
export function ObjectNavHost({ org, dogs, openDog, openTicket, openDocument, openMail, focusAgent, toast, isProject }:
  { org: string; dogs: Watchdog[]; openDog: (id: string) => void;
    openTicket?: (id: string) => void; openDocument?: (id: string) => void; openMail?: (mail: { id: string; to: string }) => void;
    focusAgent?: (id: string) => void; toast: ToastFn; isProject?: (id:string)=>boolean }) {
  const agents = useAgentNavRegistry()
  useProvideObjectNav((kind, id, targetOrg, anchor) => {
    if (targetOrg !== org) return []
    if (!id || /[\\?#\u0000]/.test(id) || id === '.' || id === '..') return []
    const copy = (text: string) => { void copyToClipboard(anchor, text).then(ok => toast([ok ? 'Copied!' : 'Clipboard unavailable'])) }
    if (kind === 'mail') {
      const ref = mailIdentityAt(anchor, org, id)
      if (!ref) return []
      const fetchRow = (id: string, chunk?: number) => getMailById(org, ref.box, id, ref.node, chunk).then(r => r.found ? r.mail : null)
      return fetchRow(id).then(row => {
        if (!row) return []
        const reference = refToken({ kind: 'mail', ...ref })
        const immediate = mailRowCopyText(row), needsFetch = mailRowNeedsFullFetch(row)
        return mailMenuEntries({ leading: openMail ? [{ label: 'Open', onSelect: () => openMail({ id,
          to: ref.box === 'user' ? 'user_inbox' : ref.box === 'org' ? `@org:${org}` : ref.node! }) }] : [],
          canCopy: Boolean(immediate.trim() || needsFetch), reference, copyReference: () => copy(reference),
          copy: () => {
            const done = (text: string) => text.trim() ? copy(text) : toast(['could not copy — message is empty'])
            if (needsFetch) void resolveFullMailCopyText(row, fetchRow)
              .then(done).catch(() => toast([MAIL_COPY_FAILED]))
            else done(immediate)
          } })
      })
    }
    if (kind === 'document') {
      let slug = (refNames.row(org, 'doc', id) as { id?: string } | undefined)?.id || id
      // Capture the owning composer and caret before the read; only the token
      // changes when an uncached legacy id resolves to its canonical slug.
      const composer = captureObjectActions(anchor, () => refToken({ kind: 'doc', org, id: slug }))
      return getDocument(org, id).then(doc => {
        const docId = doc.id || slug
        slug = docId
        return presentationMenu(anchor, org, { ...doc, id: docId }, {
          composer,
          // A host without a reader route can still copy/download; never
          // manufacture an operative Open action for a read-only embedding.
          open: openDocument ? () => openDocument(docId) : undefined,
          nodeMenu: (name, el) => agents?.current?.(name, el) ?? [], toast,
        })
      })
    }
    if (kind === 'watchdog') {
      const dog = dogs.find(d => d.id === id)
      const menu = (dog:Watchdog|undefined): MenuEntry[] => {
      if (!dog || dog.spent || dog.state === 'spent') {
        if (anchor.getAttribute('data-object-stale') !== 'true') return []
        const name = anchor.getAttribute('data-object-name') || dog?.name || id.split('/').pop() || id
        return [{ label: 'Watchdog no longer exists', disabled: true, onSelect: () => {} }, 'sep',
          { label: 'Copy watchdog name', onSelect: () => copy(name) },
          { label: 'Copy watchdog id', onSelect: () => copy(id) }]
      }
      const project=typeof dog.target==='string'?dog.target.replace(/^@/,''):''
      const projectEntry=isProject?.(project)?nodeMenuAction('Project…',anchor,project,agents?.current?.(project,anchor)??[],toast):undefined
      return [{ label: 'Open details', onSelect: () => openDog(dog.id) },
        ...(projectEntry?[projectEntry]:[]),
        ...watchdogActions(dog, action => {
          void watchdogAction(org, dog.id, action).then(r => toast([`${dog.name}: ${r.state}`]))
            .catch((error: Error) => toast([`error: ${error.message}`]))
        }), 'sep', { label: 'Copy watchdog name', onSelect: () => copy(dog.name) },
        { label: 'Copy watchdog id', onSelect: () => copy(dog.id) }]
      }
      return !dog && anchor.getAttribute('data-object-stale') !== 'true'
        ? getWatchdog(org,id).then(page=>menu(page.watchdogs.find(w=>w.id===id))) : menu(dog)
    }
    // App/panel links and Apps rows share their management menu. A missing
    // target has no actions; deletion re-reads it before showing a confirmation.
    if (kind === 'app') {
      const row = appRefRow(org, id)
      return row ? appLinkMenu(org, row.id, anchor) : []
    }
    if (kind === 'panel') {
      const row = panelRefRow(org, id)
      return row ? panelLinkMenu(org, row, anchor) : []
    }
    if (!openTicket || id.includes('/')) return []
    // before the read: the caret it inserts at is the one the right-click found
    const mention = captureTicketMention(anchor, org, id)
    const reply = captureObjectActions(anchor, '').reply
    return getWorkItem(org, id).then(async ({ item }) => {
      const name = item.owner?.node
      const entries = name ? agents?.current?.(name) ?? [] : []
      let staffing: QuickStaffPreview | undefined, staffError: string | undefined
      if (ticketStaffable(org, item)) {
        const path = quickStaffPath(org, item.slug)
        staffing = peekQuickStaff<QuickStaffPreview>(path)
        if (!staffing) {
          try { staffing = await prefetchQuickStaff<QuickStaffPreview>(path) }
          catch (error) { staffError = error instanceof Error ? error.message : String(error) }
        }
      }
      return ticketMenuEntries({ org, item, anchor, ownerEntries: entries,
        open: () => openTicket(item.slug), toast, staffing, staffError, mention, reply })
    })
  }, org, openMail ? () => openMail({ id: '@user', to: 'user_inbox' }) : undefined)
  return null
}
