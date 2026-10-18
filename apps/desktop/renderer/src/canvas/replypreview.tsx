import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { ReplyContext } from '../eventReply'
import { ObjectMenuBoundary } from './contextmenu'
import { ReplyIcon } from '../icons'
import { usePresentationTitle } from './presentationtitle'

/** The loaded conversation resolves exact reply snapshots, never text or a
 * newer revision of the same assistant message. Other surfaces keep quotes. */
const ReplySources = createContext<((reply: ReplyContext) => ReactNode) | null>(null)
export const ReplySourceProvider = ReplySources.Provider

/** The same annotation frame for transcript references and stored mail snapshots. */
export function ReplyPreviewFrame({ label, action, onRemove, children, unavailable, onActivate, actionTitle }: {
  label: string; action: ReactNode; onRemove?: () => void; children: ReactNode; unavailable?: string
  onActivate?:()=>void; actionTitle?:string
}) {
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
    }:undefined}>
    <div className="reply-preview-head">
      {action}
      {onRemove && <button type="button" aria-label="Remove reply" onClick={onRemove}>×</button>}
    </div>
    {children}
    {unavailable && <span className="dim">{unavailable}</span>}
  </aside>
}

export function ReplyPreview({ reply, available, onLocate, onRemove, presentationTitle }: {
  reply: ReplyContext; available: boolean; onLocate: () => void; onRemove?: () => void
  presentationTitle?:string
}) {
  // Composer, pending and sent replies share one annotation layout. Only
  // the composer supplies onRemove; read-only previews retain navigation.
  const resolve = useContext(ReplySources)
  const source = resolve?.(reply)
  const doc=usePresentationTitle(reply.org,reply.docId&&available?reply.docId:undefined,
    presentationTitle&&reply.docId?{org:reply.org,docs:new Map([[reply.docId,presentationTitle]])}:undefined)
  const reachable=available&&(!reply.docId||doc.ready)
  const actionTitle=reply.docId?doc.why:available?'Jump to the original message':'Original event is not in this loaded conversation'
  return <ReplyPreviewFrame label="Replying to chat event" onRemove={onRemove}
    onActivate={reachable?onLocate:undefined} actionTitle={actionTitle}
    unavailable={reply.docId?(!doc.ready?doc.why:undefined):!available ? (source ? 'Original event is not visible in this conversation.'
      : 'Original event unavailable here; quoted context is retained.') : undefined}
    action={
      <button className={'reply-preview-jump'+(reply.docId?' reply-presentation-link':'')} type="button" onClick={onLocate} disabled={!reachable}
        aria-label={reply.docId?doc.label:'jump to message'} title={actionTitle}>
        <ReplyIcon className="reply-preview-jump-icon" aria-hidden="true" focusable="false" fontSize="inherit" />
        <span>{reply.docId?doc.label:'jump to message'}</span>
      </button>}>
    {source ? <ObjectMenuBoundary className="reply-preview-content" role="region" aria-label="Referenced event" tabIndex={0}
      onContextMenu={e => e.stopPropagation()}>{source}</ObjectMenuBoundary>
      : <blockquote>{reply.quote || '(event without visible text)'}</blockquote>}
  </ReplyPreviewFrame>
}
