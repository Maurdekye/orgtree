import { replyContext, MAX_REPLY_QUOTE } from '../eventReply'
import type { ReplyContext } from '../eventReply'
import { decodeEventRow, record } from '../events/decode'
import { eventReference } from '../events/card'
import { fmtFull } from '../timefmt'
import { ReplyIcon } from '../icons'
import { ReplyPreview, ReplyPreviewFrame } from './replypreview'
import { RefChip, resolveRef } from './reflinks'
import type { RefWorld, ResolvedRef } from './reflinks'
import type { TypedRef } from './workrefs'
import { usePresentationTitle } from './presentationtitle'

interface ReplyRow { reply_to?: unknown; replies?: unknown[]; ev?: unknown }

/** Reply snapshots predate transcript-event references and are still what
 * mailbox, presentation and docket replies store. Never infer an identity
 * from a quoted title/body, or guess which mailbox contains an old message. */
export function recordedMailReply(row: ReplyRow, org: string) {
  const snapshot = record(row.reply_to) ? row.reply_to : null
  const decoded = decodeEventRow(row, 'operator')
  const event = decoded.kind === 'known' ? decoded.event : null
  const linked = event && ['reply.mail', 'reply.document', 'reply.docket'].includes(event.variant)
  if (!snapshot && !linked) return null
  const text = (value: unknown) => typeof value === 'string' ? value : ''
  const quote = event?.variant === 'reply.mail' ? event.quote : null
  const id = text(snapshot?.id)
  let ref: TypedRef | null = linked ? eventReference(event, org) : null
  if (!ref && id) {
    const targetOrg = text(snapshot?.org) || org
    if (snapshot?.kind === 'work_item') ref = { kind: 'item', org: targetOrg, id }
    else if (snapshot?.kind === 'document') ref = { kind: 'doc', org: targetOrg, id }
    else if (snapshot?.kind === 'mail') {
      const box = snapshot.box
      if (box === 'user' || box === 'org') ref = { kind: 'mail', org: targetOrg, id, box }
      else if (box === 'node' && text(snapshot.node)) ref = { kind: 'mail', org: targetOrg, id, box, node: text(snapshot.node) }
    }
  }
  const title = event?.object && 'title' in event.object ? event.object.title : ''
  return {
    ref,
    title:text(snapshot?.title)||title,
    from: text(snapshot?.from) || quote?.from || '',
    at: text(snapshot?.at) || quote?.at || '',
    gist: (text(snapshot?.gist) || text(snapshot?.quoted_context) || quote?.gist || title).slice(0, MAX_REPLY_QUOTE),
  }
}

/** One reply renderer for pending desk mail, settled mail and mailbox panes. */
export function MailReplyPreview({ row, org, world, onOpen, replyAvailable, onLocateReply }: {
  row: ReplyRow; org: string; world?: RefWorld | null; onOpen?: (ref: ResolvedRef) => void
  replyAvailable?: (reply: ReplyContext) => boolean; onLocateReply?: (reply: ReplyContext) => void
}) {
  if (row.replies?.length) return <>{row.replies.slice(0, 50).map((reply, i) =>
    <MailReplyPreview key={i} row={{ reply_to: reply }} org={org} world={world} onOpen={onOpen}
      replyAvailable={replyAvailable} onLocateReply={onLocateReply} />)}</>
  const chat = replyContext(row.reply_to)
  if (chat) return <ReplyPreview reply={chat} available={Boolean(replyAvailable?.(chat))}
    onLocate={() => onLocateReply?.(chat)} />
  const reply = recordedMailReply(row, org)
  if (!reply) return null
  const target = reply.ref ? resolveRef(reply.ref, world ?? { org, handles: new Set() }) : null
  if(target?.ref.kind==='doc')return <PresentationReply reply={reply} target={target} world={world??{org}} onOpen={onOpen}/>
  const unavailable = target?.outcome === 'absent'
    ? 'Reply to a message or item that is no longer available; quoted context is retained.'
    : !target || target.outcome !== 'ready' || !onOpen
      ? 'Original unavailable here; quoted context is retained.' : undefined
  const activate=target?.outcome==='ready'&&onOpen?()=>onOpen(target):undefined
  return <ReplyPreviewFrame label="Reply context" unavailable={unavailable} onActivate={activate} actionTitle={activate?target!.why:unavailable} action={<>
    <ReplyIcon fontSize="inherit" aria-hidden="true" />
    <span>In reply to{reply.from ? ` ${reply.from}` : ''}{reply.at ? ` · ${fmtFull(reply.at)}` : ''}</span>
    {target && <RefChip r={target} onOpen={onOpen} />}
  </>}>
    <blockquote>{reply.gist || 'Reply to a message that is no longer available.'}</blockquote>
  </ReplyPreviewFrame>
}

function PresentationReply({reply,target,world,onOpen}:{reply:NonNullable<ReturnType<typeof recordedMailReply>>;target:ResolvedRef;world:RefWorld;onOpen?: (ref:ResolvedRef)=>void}){
  const title=usePresentationTitle(target.ref.org,target.ref.id,world,reply.title)
  const activate=title.ready&&target.outcome==='ready'&&onOpen?()=>onOpen({...target,label:title.label,why:title.why}):undefined
  return <ReplyPreviewFrame label="Reply context" onActivate={activate} actionTitle={title.why}
    unavailable={!title.ready?title.why:!activate?'Original unavailable here; quoted context is retained.':undefined} action={<>
      <ReplyIcon fontSize="inherit" aria-hidden="true"/>
      <span>In reply to{reply.from?` ${reply.from}`:''}{reply.at?` · ${fmtFull(reply.at)}`:''}</span>
      {activate?<button type="button" className="reply-preview-jump reply-presentation-link" title={title.why}
        onClick={e=>{e.stopPropagation();activate()}}><span>{title.label}</span></button>
        :<span className="reply-presentation-link" title={title.why}>{title.label}</span>}
    </>}>
    <blockquote>{reply.gist||'Retained presentation reply context.'}</blockquote>
  </ReplyPreviewFrame>
}
