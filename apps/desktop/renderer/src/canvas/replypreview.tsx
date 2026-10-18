import { createContext, isValidElement, useContext } from 'react'
import type { ReactNode } from 'react'
import { getDocument } from '../api'
import type { ReplyContext } from '../eventReply'
import { useAgentNavRegistry } from './agentnav'
import { copyToClipboard, ObjectMenuBoundary, useContextMenu, useCopyFeedback } from './contextmenu'
import type { ContextMenuHandle, MenuEntry } from './contextmenu'
import { fetchMailRowForCopy, isMailByReferencePreview, mailRowNeedsFullFetch, resolveFullMailCopyText } from './copytext'
import type { CopyableMailRow } from './copytext'
import { senderMenuAction } from './objectactions'
import { ReplyIcon } from '../icons'
import { usePresentationTitle } from './presentationtitle'
import { replySourceCopyText, replySourceMailRow, replySourceSender } from './replysource'
import type { ReplySource } from './replysource'

/** The loaded conversation resolves exact reply snapshots, never text or a
 * newer revision of the same assistant message. Other surfaces keep quotes. */
const ReplySources = createContext<((reply: ReplyContext) => ReactNode) | null>(null)
export const ReplySourceProvider = ReplySources.Provider

/** The same annotation frame for transcript references and stored mail snapshots. */
export function ReplyPreviewFrame({ label, action, onRemove, children, unavailable, onActivate, actionTitle, menuEntries, onOpenMenu }: {
  label: string; action: ReactNode; onRemove?: () => void; children: ReactNode; unavailable?: string
  onActivate?:()=>void; actionTitle?:string
  menuEntries?: MenuEntry[] | ((anchor: HTMLElement) => MenuEntry[])
  onOpenMenu?: (anchor: HTMLElement, opening: number, menu: ContextMenuHandle) => void
}) {
  const menu = useContextMenu()
  return <aside className={'reply-preview' + (onRemove ? ' reply-preview-composing' : '')} aria-label={label}
    role={onActivate?'link':undefined} tabIndex={onActivate?0:undefined} title={actionTitle}
    onClick={onActivate?e=>{
      if(e.defaultPrevented||e.button!==0)return
      const nested=(e.target as Element).closest?.('a,button,input,select,textarea,summary,[role="button"],[role="link"],[contenteditable="true"]')
      if(nested&&nested!==e.currentTarget)return
      if(e.currentTarget.ownerDocument.getSelection()?.toString())return
      e.stopPropagation();onActivate()
    }:undefined}
    onKeyDown={onActivate?e=>{
      if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.stopPropagation();onActivate()}
    }:undefined}
    onContextMenu={menuEntries ? e => {
      const anchor = e.currentTarget
      const opening = menu.open(e, () => typeof menuEntries === 'function' ? menuEntries(anchor) : menuEntries, anchor)
      e.stopPropagation()
      if (opening !== undefined) onOpenMenu?.(anchor, opening, menu)
    } : e => e.stopPropagation()}>
    <div className="reply-preview-head">
      {action}
      {onRemove && <button type="button" aria-label="Remove reply" onClick={onRemove}>×</button>}
    </div>
    {children}
    {unavailable && <span className="dim">{unavailable}</span>}
    {menu.node}
  </aside>
}

export function ReplyPreview({ reply, available, onLocate, onRemove, presentationTitle, sender: senderProp }: {
  reply: ReplyContext; available: boolean; onLocate: () => void; onRemove?: () => void
  presentationTitle?: string; sender?: string
}) {
  // Composer, pending and sent replies share one annotation layout. Only
  // the composer supplies onRemove; read-only previews retain navigation.
  const resolve = useContext(ReplySources)
  const source = resolve?.(reply)
  const sourceData = isValidElement<{ source?: ReplySource }>(source) ? source.props.source : undefined
  const toast = useCopyFeedback()
  const nodeNav = useAgentNavRegistry()
  const doc=usePresentationTitle(reply.org,reply.docId&&available?reply.docId:undefined,
    presentationTitle&&reply.docId?{org:reply.org,docs:new Map([[reply.docId,presentationTitle]])}:undefined)
  const reachable=available&&(!reply.docId||doc.ready)
  const actionTitle=reply.docId?doc.why:available?'Jump to the original message':'Original event is not in this loaded conversation'

  const mailId = reply.mailId
    || (reply.eventId.startsWith('mail:') ? reply.eventId.slice(5) : undefined)
    || (sourceData?.kind === 'mail' ? sourceData.mail.id ?? undefined : undefined)
  const mailRow = replySourceMailRow(sourceData, mailId)
  const syncSender = senderProp || replySourceSender(sourceData, reply)
  const immediateText = sourceData ? (replySourceCopyText(sourceData, 'operator') || reply.quote || '') : (reply.quote || '')
  const needsMailFetch = Boolean(mailId && (!sourceData || isMailByReferencePreview(immediateText) || (mailRow && mailRowNeedsFullFetch(mailRow))))
  const needsDocFetch = Boolean(reply.docId && !sourceData)
  const canCopy = Boolean(immediateText.trim() !== '' || needsMailFetch || needsDocFetch)

  const copyContents = (anchor: HTMLElement) => {
    const done = (text: string) => {
      if (!text.trim()) {
        toast?.(['could not copy — message is empty'])
        return
      }
      void copyToClipboard(anchor, text).then(ok => toast?.([
        ok ? 'copied the message' : 'could not copy — clipboard unavailable',
      ]))
    }
    if (reply.docId) {
      void getDocument(reply.org, reply.docId)
        .then(d => done(d.body || immediateText))
        .catch(() => done(immediateText))
      return
    }
    if (needsMailFetch && mailId) {
      const baseRow: CopyableMailRow = mailRow && mailRowNeedsFullFetch(mailRow) ? mailRow : {
        ...(mailRow ?? {}),
        id: mailId,
        body: immediateText,
        truncated: true,
      }
      void resolveFullMailCopyText(
        baseRow,
        (id, chunk) => fetchMailRowForCopy(reply.org, id, { box: 'node', node: reply.agent, chunk }),
        'operator',
      ).then(full => done(full || immediateText)).catch(() => done(immediateText))
      return
    }
    done(immediateText)
  }

  const buildMenu = (anchor: HTMLElement): MenuEntry[] => {
    const agentId = syncSender?.replace(/^@/, '')
    const navEntries = syncSender && !syncSender.startsWith('@') && syncSender !== 'user' && agentId
      ? (nodeNav?.current?.(agentId, anchor) ?? []) : []
    const senderEntry = senderMenuAction(anchor, syncSender, navEntries, toast)
    return [
      { label: 'Copy contents', disabled: !canCopy, onSelect: () => copyContents(anchor) },
      ...(senderEntry ? [senderEntry] : []),
      ...(reachable ? ['sep' as const, { label: reply.docId ? 'Open presentation' : 'Jump to message', onSelect: onLocate }] : []),
    ]
  }

  const onOpenMenu = (anchor: HTMLElement, opening: number, menu: ContextMenuHandle) => {
    if (!syncSender && mailId) {
      void fetchMailRowForCopy(reply.org, mailId, { box: 'node', node: reply.agent }).then(m => {
        if (!m?.from) return
        const agentId = m.from.replace(/^@/, '')
        const navEntries = !m.from.startsWith('@') && m.from !== 'user' && agentId
          ? (nodeNav?.current?.(agentId, anchor) ?? []) : []
        const entry = senderMenuAction(anchor, m.from, navEntries, toast)
        if (entry) menu.append(entry, opening)
      }).catch(() => {})
    }
  }

  return <ReplyPreviewFrame label="Replying to chat event" onRemove={onRemove}
    onActivate={reachable?onLocate:undefined} actionTitle={actionTitle}
    menuEntries={buildMenu} onOpenMenu={onOpenMenu}
    unavailable={reply.docId?(!doc.ready?doc.why:undefined):!available ? (source ? 'Original event is not visible in this conversation.'
      : 'Original event unavailable here; quoted context is retained.') : undefined}
    action={
      <button className={'reply-preview-jump'+(reply.docId?' reply-presentation-link':'')} type="button" onClick={onLocate} disabled={!reachable}
        aria-label={reply.docId?doc.label:'jump to message'} title={actionTitle}>
        <ReplyIcon className="reply-preview-jump-icon" aria-hidden="true" focusable="false" fontSize="inherit" />
        <span>{reply.docId?doc.label:'jump to message'}</span>
      </button>}>
    {source ? <ObjectMenuBoundary className="reply-preview-content" role="region" aria-label="Referenced event" tabIndex={0}>{source}</ObjectMenuBoundary>
      : <blockquote>{reply.quote || '(event without visible text)'}</blockquote>}
  </ReplyPreviewFrame>
}
