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

interface ReplyRow { reply_to?: unknown; ev?: unknown }

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
  const chat = replyContext(row.reply_to)
  if (chat) return <ReplyPreview reply={chat} available={Boolean(replyAvailable?.(chat))}
    onLocate={() => onLocateReply?.(chat)} />
  const reply = recordedMailReply(row, org)
  if (!reply) return null
  const target = reply.ref ? resolveRef(reply.ref, world ?? { org, handles: new Set() }) : null
  const unavailable = target?.outcome === 'absent'
    ? 'Reply to a message or item that is no longer available; quoted context is retained.'
    : !target || target.outcome !== 'ready' || !onOpen
      ? 'Original unavailable here; quoted context is retained.' : undefined
  return <ReplyPreviewFrame label="Reply context" unavailable={unavailable} action={<>
    <ReplyIcon fontSize="inherit" aria-hidden="true" />
    <span>In reply to{reply.from ? ` ${reply.from}` : ''}{reply.at ? ` · ${fmtFull(reply.at)}` : ''}</span>
    {target && <RefChip r={target} onOpen={onOpen} />}
  </>}>
    <blockquote>{reply.gist || 'Reply to a message that is no longer available.'}</blockquote>
  </ReplyPreviewFrame>
}
