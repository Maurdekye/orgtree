import { getDocument } from '../api'
import { replyContext, MAX_REPLY_QUOTE } from '../eventReply'
import type { ReplyContext } from '../eventReply'
import { decodeEventRow, record } from '../events/decode'
import { eventReference } from '../events/card'
import { fmtFull } from '../timefmt'
import { ReplyIcon } from '../icons'
import { useAgentNavRegistry } from './agentnav'
import { copyToClipboard, useCopyFeedback } from './contextmenu'
import type { ContextMenuHandle, MenuEntry } from './contextmenu'
import { fetchMailRowForCopy, resolveFullMailCopyText } from './copytext'
import { senderMenuAction } from './objectactions'
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
  const kind = text(snapshot?.kind) || (event?.variant === 'reply.mail' ? 'mail'
    : event?.variant === 'reply.document' ? 'document'
    : event?.variant === 'reply.docket' ? 'work_item' : '')
  return {
    ref,
    id,
    kind,
    body: text(snapshot?.body),
    title: text(snapshot?.title) || title,
    from: text(snapshot?.from) || quote?.from || '',
    at: text(snapshot?.at) || quote?.at || '',
    gist: (text(snapshot?.gist) || text(snapshot?.quoted_context) || quote?.gist || title).slice(0, MAX_REPLY_QUOTE),
  }
}

function buildMailReplyMenu(
  anchor: HTMLElement,
  org: string,
  reply: NonNullable<ReturnType<typeof recordedMailReply>>,
  target: ResolvedRef | null,
  activate: (() => void) | undefined,
  nodeNav: ReturnType<typeof useAgentNavRegistry>,
  toast: ReturnType<typeof useCopyFeedback>,
): MenuEntry[] {
  const fallbackText = reply.body || reply.gist || ''
  const isDoc = target?.ref.kind === 'doc' || reply.ref?.kind === 'doc' || reply.kind === 'document'
  const isItem = target?.ref.kind === 'item' || reply.ref?.kind === 'item' || reply.kind === 'work_item'
  const mailId = !isDoc && !isItem ? (reply.ref?.id || reply.id) : ''
  const docId = isDoc ? (reply.ref?.id || reply.id) : ''
  const canCopy = Boolean(fallbackText.trim() !== '' || mailId || docId)

  const copyContents = () => {
    const done = (text: string) => {
      if (!text.trim()) {
        toast?.(['could not copy — message is empty'])
        return
      }
      void copyToClipboard(anchor, text).then(ok => toast?.([
        ok ? 'copied the message' : 'could not copy — clipboard unavailable',
      ]))
    }
    if (docId) {
      const docOrg = reply.ref?.org || org
      void getDocument(docOrg, docId)
        .then(d => done(d.body || fallbackText))
        .catch(() => done(fallbackText))
      return
    }
    if (mailId) {
      const mailOrg = reply.ref?.org || org
      const box = reply.ref?.kind === 'mail' ? reply.ref.box : undefined
      const node = reply.ref?.kind === 'mail' ? reply.ref.node
        : (reply.from && !reply.from.startsWith('@') ? reply.from : undefined)
      void resolveFullMailCopyText(
        { id: mailId, body: fallbackText, truncated: true },
        (id, chunk) => fetchMailRowForCopy(mailOrg, id, { box, node, chunk }),
        'operator',
      ).then(full => done(full || fallbackText)).catch(() => done(fallbackText))
      return
    }
    done(fallbackText)
  }

  const from = reply.from
  const agentId = from.replace(/^@/, '')
  const navEntries = from && !from.startsWith('@') && from !== 'user' && agentId
    ? (nodeNav?.current?.(agentId, anchor) ?? []) : []
  const senderEntry = senderMenuAction(anchor, from || undefined, navEntries, toast)
  const openLabel = isDoc ? 'Open presentation' : isItem ? 'Open details' : 'Open mail'
  return [
    { label: 'Copy contents', disabled: !canCopy, onSelect: copyContents },
    ...(senderEntry ? [senderEntry] : []),
    ...(activate ? ['sep' as const, { label: openLabel, onSelect: activate }] : []),
  ]
}

/** One reply renderer for pending desk mail, settled mail and mailbox panes. */
export function MailReplyPreview({ row, org, world, onOpen, replyAvailable, onLocateReply }: {
  row: ReplyRow; org: string; world?: RefWorld | null; onOpen?: (ref: ResolvedRef) => void
  replyAvailable?: (reply: ReplyContext) => boolean; onLocateReply?: (reply: ReplyContext) => void
}) {
  const toast = useCopyFeedback()
  const nodeNav = useAgentNavRegistry()
  if (row.replies?.length) return <>{row.replies.slice(0, 50).map((reply, i) =>
    <MailReplyPreview key={i} row={{ reply_to: reply }} org={org} world={world} onOpen={onOpen}
      replyAvailable={replyAvailable} onLocateReply={onLocateReply} />)}</>
  const chat = replyContext(row.reply_to)
  const reply = recordedMailReply(row, org)
  if (chat) return <ReplyPreview reply={chat} sender={chat.sender || reply?.from || undefined}
    available={Boolean(replyAvailable?.(chat))}
    onLocate={() => onLocateReply?.(chat)} />
  if (!reply) return null
  const target = reply.ref ? resolveRef(reply.ref, world ?? { org, handles: new Set() }) : null
  if(target?.ref.kind==='doc')return <PresentationReply reply={reply} target={target} world={world??{org}} onOpen={onOpen}/>
  const unavailable = target?.outcome === 'absent'
    ? 'Reply to a message or item that is no longer available; quoted context is retained.'
    : !target || target.outcome !== 'ready' || !onOpen
      ? 'Original unavailable here; quoted context is retained.' : undefined
  const activate=target?.outcome==='ready'&&onOpen?()=>onOpen(target):undefined
  const onOpenMenu = (anchor: HTMLElement, opening: number, menu: ContextMenuHandle) => {
    const mailId = reply.ref?.kind === 'mail' ? reply.ref.id : (!reply.ref ? reply.id : '')
    if (!reply.from && mailId) {
      const mailOrg = reply.ref?.org || org
      const box = reply.ref?.kind === 'mail' ? reply.ref.box : undefined
      const node = reply.ref?.kind === 'mail' ? reply.ref.node : undefined
      void fetchMailRowForCopy(mailOrg, mailId, { box, node }).then(m => {
        if (!m?.from) return
        const agentId = m.from.replace(/^@/, '')
        const navEntries = !m.from.startsWith('@') && m.from !== 'user' && agentId
          ? (nodeNav?.current?.(agentId, anchor) ?? []) : []
        const entry = senderMenuAction(anchor, m.from, navEntries, toast)
        if (entry) menu.append(entry, opening)
      }).catch(() => {})
    }
  }
  return <ReplyPreviewFrame label="Reply context" unavailable={unavailable} onActivate={activate} actionTitle={activate?target!.why:unavailable}
    menuEntries={anchor => buildMailReplyMenu(anchor, org, reply, target, activate, nodeNav, toast)}
    onOpenMenu={onOpenMenu}
    action={<>
    <ReplyIcon fontSize="inherit" aria-hidden="true" />
    <span>In reply to{reply.from ? ` ${reply.from}` : ''}{reply.at ? ` · ${fmtFull(reply.at)}` : ''}</span>
    {target && <RefChip r={target} onOpen={onOpen} />}
  </>}>
    <blockquote>{reply.gist || 'Reply to a message that is no longer available.'}</blockquote>
  </ReplyPreviewFrame>
}

function PresentationReply({reply,target,world,onOpen}:{reply:NonNullable<ReturnType<typeof recordedMailReply>>;target:ResolvedRef;world:RefWorld;onOpen?: (ref:ResolvedRef)=>void}){
  const toast = useCopyFeedback()
  const nodeNav = useAgentNavRegistry()
  const title=usePresentationTitle(target.ref.org,target.ref.id,world,reply.title)
  const activate=title.ready&&target.outcome==='ready'&&onOpen?()=>onOpen({...target,label:title.label,why:title.why}):undefined
  return <ReplyPreviewFrame label="Reply context" onActivate={activate} actionTitle={title.why}
    menuEntries={anchor => buildMailReplyMenu(anchor, world.org, reply, target, activate, nodeNav, toast)}
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
