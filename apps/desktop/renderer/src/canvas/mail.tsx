import { hasMailAttention } from '../mailattention'
import { beginOpen, useOpenCommit } from '../opentiming'
import { useRecordMailbox } from '../recordpanelhooks'
import { useMailboxHistory } from '../usemailhistory'
import { useStaging, StagingRows } from './staging'
// canvas/mail.tsx — the mail interfaces: the shared webmail MailList +
// MailFolders, a node's InboxView tab and its modal form (NodeInboxModal),
// the org-inbox viewer (OrgInboxModal), and the org record. One mail
// interface everywhere (user ruling: the user's and the agents' inboxes
// function identically). Extracted verbatim from Canvas.tsx in the phase-3
// split.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { mailTagKey, mailTagHue, mailMatchesTags, toggleMailTag } from './mailtags'
import { MailTagPicker } from './mailtagpicker'
import type { MailTagPickerProps } from './mailtagpicker'
import type { InboxPayload, MailQueueState, OrgEvent, OrgInboxEntry, ToastFn, TreePayload } from '../types'
import {
  audienceAction, fileBase, fileUrl, getMailById, getOrgInbox, orgInboxRead,
  uploadFile,
} from '../api'
import { AttachThumb, fmtBytes, isImg } from './img'
import { TransferPanel } from './transfers'
import {
  AttachIcon, CampaignIcon, CloseIcon, DownloadIcon, FileIcon, HearingIcon,
  MailIcon, NotificationsActiveIcon, NotificationsIcon, PublicIcon,
} from '../icons'
import {
  EXTERN, fmtCredits, isMailNotice, isSystemNotice, jumpKey, md, pileNotices, providerOf, SYSTEM, USER,
  useHideRetired,
} from './shared'
import type { CanvasNode, MailRow } from './shared'
import { AgentLink, AgentName } from './identity'
import { HubContactChip, useAgentMentions, useOrgMentionCandidates } from './agentmentions'
import { RefMdBody } from './refmd'
import { refToken } from './reflinks'
import type { RefWorld, ResolvedRef } from './reflinks'
import { useComposerEnter } from '../enterkey'
import { isMobile } from '../mobile'
import { closeIfCentred, PinFrame } from './modalpin'
import { CollapsibleMailer } from './narrowlist'
import { CopyFeedback, copyToClipboard, useContextMenu } from './contextmenu'
import type { MenuEntry } from './contextmenu'
import { fetchMailRowForCopy, mailRowCopyText, mailRowNeedsFullFetch, resolveFullMailCopyText } from './copytext'
import type { CopyableMailRow } from './copytext'
import { fmtFull, fmtShort } from '../timefmt'
import { decodeEventRow } from '../events/decode'
import { eventSummary, projectEvent } from '../events/project'
import type { EventView } from '../events/project'
import { EventCard, eventSurface } from '../events/card'
import { MailReplyPreview, recordedMailReply } from './mailreply'
import { centerTranscriptTarget } from './deskscroll'
import type { InboxSelectionRequest } from '../inboxselection'

// One mail interface, everywhere (user ruling: the user's and the agents'
// inboxes function identically), laid out like a webmail client: the list on
// the left (sender · time · truncated brief — mails have no subjects), the
// selected message opened in the reading pane on the right. Unread mail is
// HIGHLIGHTED but never moved.
export interface MailListProps {
  /** Org outbox attribution owns the header's left side; metadata trails it. */
  compoundHeader?: boolean
  selectionRequest?: InboxSelectionRequest
  hiddenUnread?: {count:number;onOpen:()=>void}
  hideMailReplyKind?: boolean
  /** a project's own mailbox (projectdesk.tsx): every row that has chips
   *  carries them on the meta line, as a row with a queue state does
   *  anywhere, so its rows read alike whether or not an agent holds them */
  projectMail?: boolean
  tagFilter?: MailTagPickerProps
  onLoadMore?: () => void
  hasMore?: boolean
  loadingMore?: boolean
  org?: string
  pending?: MailRow[]
  delivered?: MailRow[]
  waitLabel?: ReactNode
  /** custom head-identity renderer; receives the counterparty id + the mail */
  sender?: (id: string, m: MailRow) => ReactNode
  /** custom LIST-ROW identity renderer, for the one call site whose `sender`
   *  is a compound line ("@agent as @org → @recipient") that would not fit a
   *  row.
   *
   *  ⚠ IT DEFAULTS TO `sender`, AND THE DIRECTION OF THAT DEFAULT IS THE
   *  POINT. The row and the reading pane name the same party, so a call site
   *  that declared its counterparty plain text — the org inbox, whose peers
   *  came from OUTSIDE this org — gets plain text in the row too, WITHOUT
   *  having to remember a second prop. Forgetting `rowSender` can only ever
   *  make the row agree with the pane; it can never make the row resolve an
   *  identity the pane refused to. */
  rowSender?: (id: string, m: MailRow) => ReactNode
  outgoing?: boolean
  onRead?: (m: MailRow) => void
  /** `notice` is set only when the reply box's notice toggle was armed at
   *  send; the host forwards it to its own send call. */
  onReply?: (m: MailRow, text: string, attachments?: string[], notice?: boolean, targets?: MailRow[]) => void
  /** Fixed-transcript callers omit this. The global user inbox supplies the
   * recipient agent so a collected reply cannot span several transcripts. */
  replyConversation?: (m: MailRow) => string
  /** Which rows may be answered from here. Default: incoming mail from a
   *  plain agent id (the @-sentinels route elsewhere). */
  canReply?: (m: MailRow) => boolean
  onRetract?: (m: MailRow) => void
  /** User-inbox-only permanent deletion. Other MailList surfaces omit it. */
  onDeleteUserMail?: (m: MailRow) => void
  jumpTo?: string | null
  /** Only human per-message unread mail opts in; agent delivery is not read state. */
  selectOldestUnread?: boolean
  /** User inbox only: restore a prior selection after its owner verifies that
   *  no new mail arrived and that the row is still included by current filters. */
  restoreSelectionId?: string | null
  /** Called when an inbox mail is selected into the reading pane. */
  onOpenMail?: (id: string) => void
  /** the REQUEST's identity: a repeat click on the same target is a new
   *  request, an unrelated repoll is not (`jumpKey`) */
  jumpSeq?: number | null
  /** ASK FOR ONE MESSAGE BY ID, when a reference lands outside the loaded
   *  window. Omitted = this surface cannot ask, and it then says only that
   *  the message is not in the folder rather than that it does not exist. */
  lookup?: (id: string) => Promise<MailRow | null>
  /** the exact lookup answered. The owner of the folders decides where that
   *  message belongs — this list only knows it was not in its own window. */
  onFound?: (m: MailRow) => void
  /** the FOLDER OWNER's question about `jumpTo`, for a list that has no
   *  `lookup` of its own and so is not the one asking. Such a list can only
   *  say "not in this folder", which is an answer about the message and is
   *  not one to give while the question is open or has failed. Set with
   *  `onAskRetry`; never with `lookup`, which makes this list the asker. */
  askState?: 'asking' | 'failed' | null
  /** re-ask the OWNER's question: the retry the failure notice offers */
  onAskRetry?: () => void
  /** FR-21: the mail rides along so a call site whose files live under the
   *  SENDER's scratch (the user inbox — each row a different agent's outbox)
   *  can key the URL on `m.from`; fixed-node call sites ignore it. Returning
   *  '' declares THIS row's files unreachable (e.g. a Sent row whose
   *  recipient is unknown) — its attachments fall back to plain chips. */
  fileHref?: (path: string, m: MailRow) => string
  /** the /file URL prefix relative `![](…)` image srcs in THIS row's body
   *  resolve against (md's imgBase) — same per-row keying as fileHref;
   *  '' = don't resolve */
  mdBase?: (m: MailRow) => string
  /** custom reading-pane body — return non-null to REPLACE the md body AND
   *  the reply UI (asks: the response form IS the body, user ruling
   *  2026-08-04). Null falls through to the normal rendering. */
  renderBody?: (m: MailRow) => ReactNode | null
  /** per-ROW status mark (redteam §9.2: the delivery glyph lived only in the
   *  reading pane, so finding the one wedged send meant opening every mail) */
  rowMark?: (m: MailRow) => ReactNode
  /** user ruling 2026-09-05: agent identities in right pane metadata are clickable jumps */
  onFocusAgent?: (agentId: string) => void
  /** the model chip beside a sender's name. A RESOLVER, not a map: a caller
   *  that cannot answer omits it and no chip is drawn, which is the honest
   *  outcome rather than a guessed one. */
  tierOf?: (id: string) => string | null | undefined
  /** does the tree on screen hold a node by this id? EXISTENCE, never tier:
   *  a real agent whose model is unknown still navigates, without a chip.
   *  Omitted = this caller cannot say, so no local jump is claimed. */
  hasAgent?: (id: string) => boolean
  /** canonical references (`@item:org/slug`) inside the READING PANE's body.
   *  A body is rendered markdown, not React children, so this is the DOM pass
   *  in refmd.tsx rather than the ordinary renderer.
   *
   *  ⚠ ONE OPTION, NOT TWO. The world says what a token resolves to and the
   *  handler says what happens when it is clicked; a caller that supplies
   *  neither gets plain prose, which is the honest rendering for a surface
   *  with nowhere to send anybody. */
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
  /** the canonical `@mail:` token for a row, for the context menu's "Copy
   *  reference" (2026-09-07). The FOLDER OWNER knows which box a row is in;
   *  this list does not. Omitted, or answering null, the entry is absent —
   *  a Sent folder holds COPIES of mail that lives in other boxes, so it has
   *  no reference of its own to offer, and a made-up one would be worse
   *  than none (the rule refs.py's `mail()` already follows). */
  refOf?: (m: MailRow) => string | null
  /** the surface's toast, for the menu's copy confirmations */
  toast?: ToastFn
  /** MODAL SURFACES ONLY. A modal can be pinned, resized and popped out down
   *  to 320px, and at those widths the list beside the reading pane is not a
   *  list any more — so it collapses into an overlay panel (narrowlist.tsx).
   *  The agent desk draws the same list at a size it controls itself and
   *  keeps the persistent column, so this is opt-in rather than automatic. */
  collapsible?: boolean
}

const MAIL_WINDOW = 40

export function MailList({ org, pending = [], delivered = [], waitLabel, sender, rowSender,
  compoundHeader,
  outgoing, onRead, onReply, replyConversation, canReply: canReplyTo, onRetract, onDeleteUserMail, jumpTo, jumpSeq, selectOldestUnread, restoreSelectionId, onOpenMail, lookup, onFound,
  askState, onAskRetry, fileHref, mdBase, renderBody, rowMark,
  onFocusAgent, tierOf, hasAgent, refs, refOf, toast, collapsible, tagFilter, onLoadMore, hasMore, loadingMore, hideMailReplyKind,selectionRequest,hiddenUnread,
  projectMail }: MailListProps) {
  // ONE order, by send time, always — never grouped, never re-grouped.
  //
  // Unread used to sort as its own block on top, which meant the list
  // reordered itself AS YOU READ IT: every mail you opened jumped out of the
  // top group and down into the body, moving everything around it (user bug
  // 2026-08-03: "that keeps reordering them as i read them which is
  // confusing"). Reading is now a purely visual change — the row highlights
  // and stays exactly where it was.
  //
  // Sorting by SEND time rather than trusting list position stays, and matters
  // independently: the user-mail archive was appended in READ order, so
  // position was click order, not chronology (user bug 2026-08-02). Sorting
  // here also repairs archives already written out of order, which a
  // server-side fix alone cannot. `at` is ISO-8601 Z, so a plain string
  // compare IS a time compare.
  //
  // `pending` and `delivered` still arrive as separate lists because they are
  // different server-side facts (undelivered vs delivered); `_wait` carries
  // that distinction into the row's styling, which is now all it drives.
  const profile = 'operator'
  const [replyTargets, setReplyTargets] = useState<MailRow[]>([])
  const [replyError, setReplyError] = useState('')
  useEffect(() => { setReplyTargets([]); setReplyError('') }, [org, outgoing])
  const collectReply = (m: MailRow) => {
    if (!m.id) { setReplyError('This message has no durable reply reference yet.'); return false }
    if (replyConversation && replyTargets.some(r => replyConversation(r) !== replyConversation(m))) { setReplyError('A multi-reply can only answer messages in one conversation.'); return false }
    if (replyTargets.some(r => r.id === m.id)) return true
    if (replyTargets.length >= 50) { setReplyError('A multi-reply can answer at most 50 messages.'); return false }
    setReplyTargets([...replyTargets, m]); setReplyError(''); return true
  }
  const views = new WeakMap<MailRow, EventView | null>()
  const typedView = (m: MailRow) => {
    if (views.has(m)) return views.get(m)!
    const result = decodeEventRow(m, profile)
    const view = result.kind === 'known' ? projectEvent(result.event) : null
    views.set(m, view)
    return view
  }
  const messageContent = (m: MailRow, standalone = false) => {
    const decoded = decodeEventRow(m, profile)
    return decoded.kind === 'legacy'
      ? <RefMdBody className={'mailer-body md' + (standalone && isMailNotice(m) ? ' event-notice' : '')} html={md(m.body, mdBase?.(m) || undefined)}
          world={refs?.world} onOpen={refs?.onOpen} />
      : <div className="mailer-body"><EventCard part={standalone ? undefined : "body"} row={m} profile={profile}
          hideKind={hideMailReplyKind && decoded.kind === 'known' && decoded.event.variant === 'reply.mail'}
          org={org ?? refs?.world.org ?? ''} imgBase={mdBase?.(m) || undefined}
          world={refs?.world} onOpen={refs?.onOpen} actor={id => S(id, m)} /></div>
  }
  const newestFirst = (a: MailRow, b: MailRow) =>
    (a.at ?? '') < (b.at ?? '') ? 1 : (a.at ?? '') > (b.at ?? '') ? -1 : 0
  const all = [
    ...pending.map((m) => ({ ...m, _wait: true })),
    ...delivered,
  ].sort(newestFirst)
  // selection is BY IDENTITY, not index. The list no longer reshuffles on
  // read, but identity is still the right key: the window pages, the filter
  // narrows, and new mail arrives — an index would silently land elsewhere
  const keyOf = (m: MailRow | undefined) =>
    m?.id ?? `${m?.at}|${m?.from}|${(m?.body ?? '').slice(0, 24)}`
  // jumpTo (user spec 2026-07-31): a chat's inline mail link opens the box
  // SELECTED on that mail — identity selection means the reading pane shows
  // it; the scroll + flash happen on the row ref below. Human unread inboxes
  // select their oldest unread mail on this initial, loaded mount only. If no
  // unread mail exists, fall back to the oldest unanswered request. All-read
  // and agent-delivery folders keep the unselected opening; later arrivals
  // never steal the selection. Clicking a selected row still deselects it.
  const [initialSelection] = useState(() => {
    if (!selectOldestUnread || jumpTo || outgoing || selectionRequest) return undefined
    const oldestFirst = [...all].reverse()
    return oldestFirst.find(m => m._wait && !m._ask)
      ?? oldestFirst.find(m => m._wait && m._ask)
  })
  const [selId, setSelId] = useState<string | null>(jumpTo ?? selectionRequest?.id ?? (initialSelection ? keyOf(initialSelection) : null))
  // ⚠ WHICH JUMP HAS BEEN HANDLED, NOT WHETHER ONE HAS. A boolean latch meant
  // the FIRST link into an open mailbox worked and every one after it did
  // nothing at all — the box was already mounted, so the initial `useState`
  // never ran again and the latch was already spent. Holding the id makes a
  // second click on a different reference move the selection and scroll again,
  // and a repeat click on the SAME one stay put.
  // ⚠ THE LATCH IS ON THE REQUEST, NOT ON THE TARGET: comparing ids alone
  // refuses a second deliberate click on the same message once the reader has
  // selected something else. The latch still exists, or every poll drags them
  // back to a row they moved away from.
  const jumpedRef = useRef<string | null>(jumpKey(jumpTo, jumpSeq))
  // scrolling is tracked SEPARATELY from selecting. They are handled in
  // different places — an effect and a row ref — and a single latch shared
  // between them means whichever fires first spends it for the other.
  const scrolledRef = useRef<string | null>(null)
  useEffect(() => {
    const key = jumpKey(jumpTo, jumpSeq)
    if (!jumpTo || key === jumpedRef.current) return
    jumpedRef.current = key
    setSelId(jumpTo)
  }, [jumpTo, jumpSeq])
  // №26: hunting an hour-old message decayed your unread set click by click —
  // a plain client-side filter over sender+body, no index, no server
  const [q, setQ] = useState('')
  // windowed like the transcript: a long-lived org's folders grow without
  // bound and every row is a live DOM node. Newest MAIL_WINDOW render, the
  // rest page in. ⚠ the filter runs over the WHOLE set before the window, so
  // hunting an old message never depends on how far you have paged.
  const [vis, setVis] = useState(() => Math.max(MAIL_WINDOW,
    initialSelection ? all.findIndex(m => keyOf(m) === keyOf(initialSelection)) + 1 : 0))
  // ONE page per commit. A flick emits a burst of scroll events and React
  // batches them, so every event in the burst reads the same `vis` and every
  // one of them adds a window: measured at eight events rendering a whole
  // 200-row folder in a single gesture, which is exactly the windowing this
  // exists to provide, gone. `vis` growing monotonically stops it oscillating
  // — it never stopped it over-shooting. The latch clears on the commit that
  // renders the page, so a gesture that keeps going keeps paging.
  const paging = useRef(false)
  useEffect(() => { paging.current = false }, [vis])
  const isAgentId = (id: string) => Boolean(id && !id.startsWith('@') && id !== USER && id !== 'system' && id !== 'SYSTEM')
  const defaultIdentity = (id: string) => {
    if (id === USER) return <span>@user</span>
    if (id.startsWith('@net:') || id.startsWith('@org:')) return <HubContactChip address={id} />
    if (!isAgentId(id)) return <span>{id}</span>
    // …and neither is a name this tree does not hold: a since-retired agent or
    // an id off an archived envelope was drawn as a jump that focused nothing.
    // No resolver = the caller cannot vouch for the id, so no jump is offered.
    // ⚠ CALLED WITH THE ID ALONE, NEVER HANDED OVER WHOLE. `AgentName` invokes
    // `onFocus(id, event)` because pins.tsx has to tell a pointer activation
    // from a keyboard one. `onFocusAgent` is declared `(agentId: string) =>
    // void`, and the value behind it at the desk is `centerOn(id, z = null)` —
    // so passing the function straight through delivered the CLICK EVENT AS
    // THE ZOOM, and navigation landed nowhere. TypeScript cannot see it: a
    // one-argument function is assignable to a two-argument slot, and a
    // trailing optional parameter makes centerOn assignable to the
    // one-argument declaration, so two legal steps compose into a call nobody
    // declared. Measured in a hydrated browser by coordinator-astra at
    // 392767b, and reproduced on the real camera by mailnav.test.tsx §1.
    // Omitted, not stubbed, when there is nowhere to go.
    const focus = onFocusAgent
    return <AgentName id={id} tier={tierOf?.(id)}
      onFocus={hasAgent?.(id) && focus ? (aid: string) => focus(aid) : undefined} />
  }
  const S: (id: string, m: MailRow) => ReactNode = sender ?? defaultIdentity
  // user ruling 2026-09-05, reiterated: the model chip and the click-to-desk
  // belong on the sender in the LIST as well as in the reading pane — the row
  // is the surface you read a mailbox from, and it was the bare name.
  const R: (id: string, m: MailRow) => ReactNode = rowSender ?? S
  // Routing still uses the stored sender/recipient. Canonical authorship is a
  // display fact: engine-authored rows may be routed from USER.
  const partyOf = (m: MailRow) => (outgoing ? m.to : m.from)
  const displayParty = (m: MailRow) => {
    const actor = !outgoing && typedView(m)?.event.actor
    return actor ? actor.kind === 'user' ? USER : actor.kind === 'system' ? SYSTEM : actor.id : partyOf(m)
  }
  const qn = q.trim().toLowerCase()
  const tagged = tagFilter?.selected.length ? all.filter(m => mailMatchesTags(m.tags,tagFilter.selected)) : all
  const shown = qn
    ? tagged.filter((m) => String(partyOf(m) ?? '').toLowerCase().includes(qn)
      || String(m.body ?? '').toLowerCase().includes(qn))
    : tagged
  const filterKey=JSON.stringify([org??'',tagFilter?.selected.map(mailTagKey).sort()??[],qn])
  const previousFilter=useRef(filterKey)
  useEffect(()=>{
    const changed=previousFilter.current!==filterKey
    previousFilter.current=filterKey
    if(changed&&selId!==null&&!jumpTo&&!shown.some(m=>keyOf(m)===selId))setSelId(null)
  },[filterKey,selId,jumpTo,shown])
  // …then consecutive system notices fold into one ROW (user, 2026-08-28).
  // AFTER the filter, because the fold is about what is on screen: filtering
  // to "@system" should show you the pile, not a run broken by rows the
  // filter removed. Before the window, so `vis` pages entries and not
  // members — otherwise a 40-notice run would spend a whole page on one row.
  const piles = pileNotices(shown, (a, b) => {
    if(JSON.stringify(a.tags??[])!==JSON.stringify(b.tags??[]))return false
    const left = typedView(a), right = typedView(b)
    if (!left || !right) return decodeEventRow(a, profile).kind === 'legacy'
      && decodeEventRow(b, profile).kind === 'legacy'
    return left.event.variant === right.event.variant
      && left.event.object?.kind === right.event.object?.kind
  })
  const restoreAttempted = useRef(false)
  useEffect(() => {
    if (restoreAttempted.current || !selectOldestUnread || jumpTo || outgoing || !restoreSelectionId) return
    restoreAttempted.current = true
    const rowIndex = piles.findIndex((group) => group.some((m) => keyOf(m) === restoreSelectionId))
    if (rowIndex < 0) return // absent, unretained, or excluded by the active filters
    setSelId(restoreSelectionId)
    setVis((n) => Math.max(n, rowIndex + 1))
  }, [piles, restoreSelectionId, selectOldestUnread, jumpTo, outgoing])
  const selectionHandled=useRef<string|null>(null)
  useEffect(()=>{
    if(!selectionRequest||jumpTo||selectionHandled.current===selectionRequest.key)return
    selectionHandled.current=selectionRequest.key;setSelId(selectionRequest.id)
  },[selectionRequest?.key,jumpTo])
  useEffect(()=>{
    const id=jumpTo??selectionRequest?.id
    if(!id)return
    const index=piles.findIndex(group=>group.some(m=>keyOf(m)===id))
    if(index>=0)setVis(n=>Math.max(n,index+1))
  },[piles,jumpTo,selectionRequest?.key])
  // selection is still BY ROW IDENTITY, but it resolves through the pile: a
  // notice selected on its own stays selected when a newer one arrives and
  // folds it into a run (the key would otherwise address a row that no
  // longer renders, and the reading pane would silently empty)
  // ⚠ WAS THE LINKED MESSAGE ACTUALLY FOUND? Asked over `all`, NOT over
  // `shown`: the search box filters what is listed, and a jump that lands
  // while a filter is typed must not be reported as a missing message.
  //
  // This list only ever renders once its box has loaded — its callers show
  // "loading…" until then — so "not in `all`" here means NOT IN THE LOADED
  // WINDOW, which is a smaller fact than "absent".
  //
  // ⚠ EVERY BOX ROUTE RETURNS A SLICE, so a retained message outside it is
  // still there: saying it is gone from a window is a claim about the message
  // made from what we happen to hold. With a `lookup` we ask; without one we
  // say only that it is not in this folder.
  const outsideWindow = Boolean(jumpTo)
    && !all.some((m) => keyOf(m) === jumpTo)
  // ⚠ `failed` IS SEPARATE FROM A NULL ROW: "the box does not hold it" and
  // "the question got no answer" are different facts, and only the first is
  // about the message.
  const [ask, setAsk] = useState<
    { asking: boolean; row: MailRow | null; failed: boolean } | null>(null)
  // a deliberate retry: bumping this re-runs the effect. Nothing else does —
  // a failed lookup that retried itself would be a poll on an error path.
  const [retry, setRetry] = useState(0)
  const foundRef = useRef(onFound); foundRef.current = onFound
  const key = jumpKey(jumpTo, jumpSeq)
  useEffect(() => {
    if (!outsideWindow || !jumpTo || !lookup) return
    let live = true
    setAsk({ asking: true, row: null, failed: false })
    // one id, once, only because a reference landed outside the window —
    // never on the poll that keeps the list fresh
    Promise.resolve(lookup(jumpTo))
      .then((m) => {
        if (!live) return
        setAsk({ asking: false, row: m ?? null, failed: false })
        if (m) foundRef.current?.(m)
      })
      .catch(() => {
        if (live) setAsk({ asking: false, row: null, failed: true })
      })
    return () => { live = false }
  }, [outsideWindow, jumpTo, key, lookup, retry])
  // ⚠ THE ANSWER IS MATCHED TO THE QUESTION BY THE ROW'S OWN ID: `lookup` is
  // the caller's, so a row that is not the message asked for is refused.
  // ⚠ EITHER THIS LIST IS ASKING OR ITS OWNER IS — never both, because a list
  // given a `lookup` is never also given an `askState`.
  const lookingUp = outsideWindow
    && ((Boolean(lookup) && (!ask || ask.asking)) || askState === 'asking')
  const lookupFailed = outsideWindow && (Boolean(ask?.failed) || askState === 'failed')
  const foundOutside = ask && !ask.asking && ask.row
    && keyOf(ask.row) === jumpTo ? ask.row : null
  // ⚠ THE THREE OUTCOMES ARE DECIDED BY THE READING PANE'S BRANCH ORDER, not
  // by flags repeating it here: a found message becomes `cur` so the notice
  // never renders, and `lookingUp` is checked before this. This line owns one
  // fact — the reference landed outside the window.
  const jumpMissing = outsideWindow
  const curPile = selId == null ? undefined
    : piles.find((g) => g.some((m) => keyOf(m) === selId))
  // ⚠ A MESSAGE FOUND OUTSIDE THE WINDOW IS STILL THE MESSAGE THEY ASKED
  // FOR. It is not in the list — the list is a window — so it is read from
  // the pane directly rather than pretended into the list, where it would
  // sit in the wrong place in a run of send times.
  const cur = curPile?.[0] ?? (foundOutside ?? undefined)
  const openedMailId = cur && !cur._ask && selectOldestUnread ? cur.id : null
  useEffect(() => {
    if (openedMailId) onOpenMail?.(openedMailId)
  }, [openedMailId, onOpenMail])
  useOpenCommit('mail-item',`${org ?? refs?.world.org ?? ''}/${keyOf(cur)}`,!!cur,cur)
  // per-mail read (user ruling): a VIEWED unread mail is marked read the
  // moment you click OFF it — select another mail, or leave the list
  const curRef = useRef<MailRow | undefined>(undefined); curRef.current = cur
  const readRef = useRef(onRead); readRef.current = onRead
  // ask rows are not real mail — their ids must never reach markRead
  const leave = (m: MailRow | undefined) => {
    if (m?._wait && m.id && !m._ask) readRef.current?.(m)
  }
  useEffect(() => () => leave(curRef.current), [])
  const party = partyOf
  // a custom sender renderer owns the whole head identity (it receives the
  // mail too — the org inbox uses this for "@agent as @org → @recipient")
  const customS = outgoing && sender != null
  // reply from where you read (№11): only for incoming mail whose sender is a
  // plain agent id — @-sentinels (@user/@system/@ext:/@org:/@mcp:) route
  // elsewhere, and slugify guarantees no agent name starts with '@'
  const answerable = (m: MailRow) => canReplyTo ? canReplyTo(m) : !String(party(m) ?? '').startsWith('@')
  const replyable = Boolean(onReply && cur && !outgoing && !cur._ask && answerable(cur))
  // THE ROW'S CONTEXT MENU (contextmenu.tsx, 2026-09-07). One menu for the
  // whole list; the pressed row's entries are built on open. Every entry is
  // something the row or the reading pane already does: select, reply (the
  // pane's box, under the same `replyable` test), mark read (the click-off
  // rule, made explicit), retract (the row's own ✕). Copy text / copy
  // reference are the two new conveniences the proposal named.
  const menu = useContextMenu()
  const rootRef = useRef<HTMLDivElement>(null)
  // "Reply" selects the row and then puts the caret in the reply box once
  // that pane has rendered — the effect runs after the selection commits
  const [replyFocus, setReplyFocus] = useState<string | null>(null)
  useEffect(() => {
    if (!replyFocus || !cur || keyOf(cur) !== replyFocus) return
    setReplyFocus(null)
    rootRef.current?.querySelector<HTMLTextAreaElement>('.mailer-read .mail-reply textarea')
      ?.focus()
  }, [replyFocus, cur])
  const rowMenu = (m: MailRow): MenuEntry[] => {
    const isCur = Boolean(cur && keyOf(m) === keyOf(cur))
    const select = () => {
      if (isCur) return
      leave(cur)
      setSelId(keyOf(m))
    }
    const entries: MenuEntry[] = [
      isCur
        ? { label: 'Close', onSelect: () => { leave(cur); setSelId(null) } }
        : { label: 'Open', onSelect: select },
    ]
    const canReply = Boolean(onReply && !outgoing && !m._ask && answerable(m))
    if (canReply) entries.push({ label: 'Reply', onSelect: () => { if (collectReply(m)) { select(); setReplyFocus(keyOf(m)) } } })
    if (m._wait && m.id && !m._ask && onRead) {
      entries.push({ label: 'Mark as read', onSelect: () => onRead(m) })
    }
    if (m._wait && m.id && onRetract) {
      entries.push({ label: 'Retract (undelivered)', onSelect: () => onRetract(m) })
    }
    if (!outgoing && onDeleteUserMail && m.id && !m._ask) {
      entries.push({ label: 'Delete', onSelect: () => onDeleteUserMail(m) })
    }
    entries.push('sep')
    const el = rootRef.current
    const copied = (what: string) => (ok: boolean) => toast?.([ok ? `copied ${what}` : `could not copy ${what} — clipboard unavailable`])
    const copyRow = m as CopyableMailRow
    const immediateBody = mailRowCopyText(copyRow, profile)
    const needsFetch = mailRowNeedsFullFetch(copyRow)
    const canCopy = Boolean(immediateBody.trim() !== '' || needsFetch)
    entries.push({
      label: 'Copy message text',
      disabled: !canCopy,
      onSelect: () => {
        const done = (fullText: string) => {
          if (!fullText.trim()) {
            toast?.(['could not copy — message is empty'])
            return
          }
          void copyToClipboard(el, fullText).then(copied('the message text'))
        }
        if (needsFetch) {
          const slug = org ?? refs?.world.org ?? ''
          const nodeHint = typeof m.to === 'string' && !m.to.startsWith('@') ? m.to
            : typeof m.from === 'string' && !m.from.startsWith('@') ? m.from : undefined
          void resolveFullMailCopyText(
            copyRow,
            async (id, chunk) => {
              if (chunk === undefined && lookup) {
                try {
                  const looked = await lookup(id)
                  if (looked) return looked as CopyableMailRow
                } catch { /* fall through to fetchMailRowForCopy */ }
              }
              if (!slug) return null
              return fetchMailRowForCopy(slug, id, { node: nodeHint, chunk })
            },
            profile,
          ).then(full => done(full || immediateBody)).catch(() => done(immediateBody))
          return
        }
        done(immediateBody)
      },
    })
    const ref = refOf?.(m) ?? null
    if (ref) {
      entries.push({
        label: 'Copy reference', title: ref,
        onSelect: () => { void copyToClipboard(el, ref).then(copied('the reference ' + ref)) },
      })
    }
    return entries
  }
  const custom = cur ? renderBody?.(cur) ?? null : null
  const surface = cur && !(curPile && curPile.length > 1) ? eventSurface(cur, profile) : { className: '' }
  // alt+↑/↓ walks the list (user feature 2026-08-17) — but never while an
  // ask card owns the chord: focus inside a credit request steps the grant
  // (asks.tsx preventDefaults), and switching mail mid-answer would unmount
  // the card and lose the draft, so ANY ask-card focus opts out, not just
  // credit ones. tabIndex −1 on the root: clicking a (non-focusable) mail
  // row focuses the nearest tabindex ancestor, so the keydown bubbles here —
  // the same focus routing the ask cards use.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    if (e.defaultPrevented) return
    if ((e.target as HTMLElement).closest?.('.askcard')) return
    e.preventDefault()
    // one step = one ROW, so a folded run of notices is one stop, not five
    const list = piles.slice(0, vis).map((g) => g[0]!)
    if (!list.length) return
    const idx = cur ? list.findIndex((m) => keyOf(m) === keyOf(cur)) : -1
    const next = idx < 0 ? 0
      : e.key === 'ArrowDown' ? Math.min(list.length - 1, idx + 1)
        : Math.max(0, idx - 1)
    const m = list[next]!
    if (cur && keyOf(m) === keyOf(cur)) return
    leave(cur)
    setSelId(keyOf(m))
    // rendered rows mirror list order, so the index addresses the row —
    // no attribute-selector escaping games with the composite fallback key
    e.currentTarget.querySelectorAll('.mailrow')[next]
      ?.scrollIntoView({ block: 'nearest' })
  }
  // ⚠ AN EMPTY WINDOW IS A FACT ABOUT THE FOLDER, NOT ABOUT A MESSAGE — so it
  // cannot stand as the answer to a reference. An explicit jump renders its
  // own outcome below (found, still asking, or absent) even with nothing in
  // the window; with no jump, this is the whole of what there is to say.
  if (!all.length && !jumpTo && !tagFilter) return <div className="dim pad">no mail yet</div>
  // the text filter: inside the tag field when this list has one, else the field
  const filterBox = <input className="mail-filter" placeholder="filter…" value={q}
    onChange={(e) => setQ(e.target.value)} />
  return (
    <CopyFeedback.Provider value={toast}>
    <CollapsibleMailer collapsible={collapsible} listLabel="message list"
      tabIndex={-1} onKeyDown={onKey} rootRef={rootRef}
      list={
      /* paging is automatic: within a screen of the bottom, the next window
          is already rendered (user ruling 2026-08-04 — reaching the end of a
          list should not then ask you to press something). `vis` only ever
          grows and is guarded against `shown.length`, so it cannot thrash and
          stops once everything is on screen; the `paging` latch keeps ONE
          gesture to ONE window (see above). */
      <div className="mailer-list"
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 240
            && vis < piles.length && !paging.current) {
            paging.current = true
            setVis((v) => v + MAIL_WINDOW)
          } else if (el.scrollHeight - el.scrollTop - el.clientHeight < 240 && vis >= piles.length && hasMore && !loadingMore) {
            onLoadMore?.()
          }
        }}>
        {(tagFilter || all.length > 4 || q) && (
          <div className="mail-list-controls">
            {tagFilter ? <MailTagPicker {...tagFilter}>{filterBox}</MailTagPicker> : filterBox}
          </div>
        )}
        {tagFilter?.selected.length&&hiddenUnread&&hiddenUnread.count>0?<button type="button" className="mail-hidden-unread"
          title="Clear tag filters and open the oldest unread mail" onClick={hiddenUnread.onOpen}>({hiddenUnread.count} unread)</button>:null}
        {shown.length === 0 && <div className="dim pad">no matches</div>}
        {/* windowed like the transcript: a long-lived org's folders grow
            without bound and every row is a live DOM node. Newest MAIL_WINDOW
            render; the rest page in on demand. The filter searches the WHOLE
            set (`shown`), not just the window — hunting an old message must
            not depend on how far you have paged. */}
        {piles.slice(0, vis).map((g) => {
          // the run's FIRST member is the row: the list is newest-first, so
          // that is the newest, and the row keeps its place in the ordering
          const m = g[0]!
          const view = typedView(m)
          return (
          <MailRowView key={keyOf(m)} m={m} pile={g.length} view={view} hideMailReplyKind={hideMailReplyKind} projectMail={projectMail}
            onFocusAgent={onFocusAgent} hasAgent={hasAgent} tierOf={tierOf}
            selected={m === cur} outgoing={outgoing}
            flash={Boolean(jumpTo && g.some((x) => keyOf(x) === jumpTo))}
            party={R(displayParty(m)!, m)} mark={rowMark?.(m)} onRetract={onRetract} onTag={tagFilter ? tag=>tagFilter.onChange(toggleMailTag(tagFilter.selected,tag)):undefined}
            rowRef={(el) => {
              // a jump aimed at a folded member lands on the row that now
              // carries it, not on nothing
              const target = jumpTo ?? selectionRequest?.id ?? restoreSelectionId ?? (initialSelection ? keyOf(initialSelection) : null)
              const request = jumpTo ? jumpKey(jumpTo, jumpSeq)
                : selectionRequest ? selectionRequest.key : restoreSelectionId ? `restore-selection:${restoreSelectionId}` : 'initial-selection'
              if (el && target && g.some((x) => keyOf(x) === target)
                && scrolledRef.current !== request) {
                scrolledRef.current = request
                centerTranscriptTarget(el.closest<HTMLElement>('.mailer-list'),el)
              }
            }}
            onClick={() => {
              if (cur && keyOf(m) === keyOf(cur)) {
                // toggling the selected row off — reading it counts as read
                leave(cur)
                setSelId(null)
              } else {
                beginOpen('mail-item',`${org ?? refs?.world.org ?? ''}/${keyOf(m)}`)
                leave(cur)
                setSelId(keyOf(m))
              }
            }}
            onContextMenu={(e) => menu.open(e, () => rowMenu(m))} />
          )
        })}
        {piles.length > vis && (
          <div className="dim pad loadolder-status">
            {piles.length - vis} earlier
          </div>)}
      </div>
      }>
      {menu.node}
      <div {...surface} className={"mailer-read " + surface.className}>
        {replyError && <div role="alert">{replyError}</div>}
        {replyTargets.map(m => <div className="mail-reply-target" key={m.id}>
          <span>{m.from}: {String(m.body ?? '').slice(0, 160)}</span>
          <button aria-label="Remove reply target" onClick={() => setReplyTargets(replyTargets.filter(r => r.id !== m.id))}>×</button>
        </div>)}
        {replyTargets.length > 0 && <button className="link" onClick={() => setReplyTargets([])}>Cancel all replies</button>}
        {cur && (
          <MailReadPane cur={cur} members={curPile} org={org} refs={refs} hideMailReplyKind={hideMailReplyKind}
            compoundHeader={compoundHeader}
            onFocusAgent={onFocusAgent} hasAgent={hasAgent} tierOf={tierOf}
            mdBase={mdBase} fileHref={fileHref} sender={S} outgoing={outgoing}
            customSender={customS} waitLabel={waitLabel} custom={custom}
            party={displayParty(cur)!}
            onReply={replyable
              ? async (text, attachments, notice) => {
                const targets = replyTargets.length ? replyTargets : [cur]
                if (replyConversation && targets.some(m => replyConversation(m) !== replyConversation(cur))) { setReplyError('Open a message in the reply targets\' conversation before sending.'); throw Error('A multi-reply needs one conversation') }
                await onReply!(targets[0]!, text, attachments, notice, targets)
                setReplyTargets(current => current.filter(m => !targets.some(t => t.id === m.id)))
              }
              : undefined}
            toast={toast} onTag={tagFilter ? tag=>tagFilter.onChange(toggleMailTag(tagFilter.selected,tag)):undefined} />
        )}
        {!cur && (
          <div className="dim pad mailer-none">
            {/* ⚠ A LINK THAT LANDED ON NOTHING MUST SAY SO. Falling through to
                "select a mail to read it" is the silent failure: the panel
                opens, looks perfectly normal, and the reader concludes they
                misclicked. It says nothing ABOUT the message — no sender, no
                subject, no body — because the reason it is not here may be
                that this viewer is not allowed to see it, and an explanation
                that discloses the thing it is refusing is not a refusal. */}
            {lookingUp
              /* the question is in flight: not an answer yet, so not "gone" */
              ? <span className="mailer-nojump looking">
                  Looking for that message…
                </span>
              : lookupFailed
                /* ⚠ A FAILED QUESTION IS NOT A NEGATIVE ANSWER — the message
                   may be there. The retry is deliberate: an error path that
                   retries itself is a storm. */
                ? <span className="mailer-nojump failed">
                    Could not check whether that message is here.{' '}
                    <button type="button" className="mailer-retry"
                      onClick={onAskRetry ?? (() => setRetry((n) => n + 1))}>
                      try again
                    </button>
                  </span>
                : jumpMissing
                  ? <span className="mailer-nojump">
                      That message is not in this folder. It may have been
                      retracted, or it may not be one you can open.
                    </span>
                  : shown.length ? 'select a mail to read it' : ''}
          </div>
        )}
      </div>
    </CollapsibleMailer>
    </CopyFeedback.Provider>
  )
}

function TagChips({tags,onTag,preview=false}:{tags?:string[];onTag?:(tag:string)=>void;preview?:boolean}) {
  const collapsed=preview&&(tags?.length??0)>=3
  const shown=collapsed?tags?.slice(0,1):tags
  return <>{shown?.map(tag=>{
    const key=mailTagKey(tag),style={'--mail-tag-hue':mailTagHue(key)} as CSSProperties
    return onTag ? <button type="button" className="mail-tag" data-tag-key={key} style={style} key={key}
      title={`Filter by ${tag}`} onClick={e=>{e.stopPropagation();onTag(tag)}}>{tag}</button>
      : <span className="mail-tag" data-tag-key={key} style={style} key={key} title={tag}>{tag}</span>
  })}{collapsed&&tags&&<span className="mail-tag mail-tag-more" title={tags.slice(1).join(', ')}>+{tags.length-1}</span>}</>
}

const briefLine = (b: string | null | undefined) => (b ?? '').trim().replace(/\s+/g, ' ').slice(0, 90)

/** ONE MAILBOX ROW — the row every mail list draws, exported so the Attention
 *  view lists an urgent mail or a question with this exact row (user
 *  2026-09-29: "the list elements should each look identical to how they each
 *  look in their respective lists") rather than a lookalike that could drift.
 *  `MailList` renders its rows through it; `pile` is the size of a folded run
 *  of system notices (1 = a single message). */
export function MailRowView({ m, pile = 1, view, selected, outgoing, flash, party, mark,
  onRetract, onClick, onContextMenu, rowRef, onTag, hideMailReplyKind, onFocusAgent, hasAgent, tierOf, projectMail }: {
  /** a project's own mailbox: chips always take the meta line (MailListProps) */
  projectMail?: boolean
  onFocusAgent?: (id: string) => void
  hasAgent?: (id: string) => boolean
  /** the model card of an agent the queue state names (MailListProps.tierOf) */
  tierOf?: (id: string) => string | null | undefined
  hideMailReplyKind?: boolean
  m: MailRow
  onTag?: (tag:string)=>void
  pile?: number
  /** the typed event this row decodes to, or null for plain mail */
  view: EventView | null
  selected: boolean
  outgoing?: boolean
  /** the row a reference just jumped to */
  flash?: boolean
  /** the row's identity, already rendered by the list's sender renderer */
  party: ReactNode
  /** per-row status mark (redteam §9.2) */
  mark?: ReactNode
  onRetract?: (m: MailRow) => void
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void
  rowRef?: (el: HTMLDivElement | null) => void
}) {
  const isPile = pile > 1
  const reply = recordedMailReply(m, '')
  // A PROJECT MAIL TAKES THREE LINES (user 2026-10-18 14:24Z: "maybe a third
  // row of content per mail item in the list for project mail is
  // necessary?"). Its queue state names an agent, and line 1 cannot hold the
  // sender, a kind chip, that name and the time: the name wrapped letter by
  // letter and the kind chip stretched with it. So a row that shows a queue
  // state moves its chips and that state to a line under the sender, and
  // line 1 is the sender and the time, as in every other mailbox. In a
  // project's own mailbox every row with chips does, so a mail no agent
  // holds yet reads like the rest. Any other row is unchanged.
  const queued = !m._ask && showsQueueState(m.queue)
  const kind = !m._ask && view && view.event.variant !== 'ordinary.message'
    && view.event.variant !== 'ordinary.notice'
    && !(hideMailReplyKind && view.event.variant === 'reply.mail') ? view.title : null
  const noticeRun = !m._ask && isMailNotice(m) && isPile
  const urgent = !m._ask && Boolean(m.urgent)
  const metaLine = queued || (Boolean(projectMail) && Boolean(kind || m._ask || noticeRun || urgent))
  const chips = <>
    {kind && <span className="event-row-kind">{kind}</span>}
    {m._ask && <span className="askkind">{m.kind ?? 'ask'}</span>}
    {/* Plain notices are unmarked. A folded run keeps its existing
        count so its hidden members remain discoverable. */}
    {noticeRun
      && <span className="noticekind"
        title={`${pile} system notices — open to read them`}>
        {pile} notices</span>}
    {/* the FILLED chip — every other chip in this list is an
        outline, so filled is the one step up the vocabulary that
        was still unused. Its tooltip carries the sender's reason,
        which is the whole point of requiring one: the user judges
        the interruption instead of just receiving it. */}
    {urgent
      && <span className="urgentkind" title={m.urgent_reason
        ? `urgent — ${m.urgent_reason}` : 'urgent'}>urgent</span>}
  </>
  return (
    <div ref={rowRef}
      className={'mailrow' + (view ? ' event-row event-' + view.family : '') + (selected ? ' on' : '') + (m._wait ? ' unread' : '')
        /* request mails wear the askcard's accent family in the list
           (user spec 2026-08-06); resolved asks keep a quiet edge */
        + (m._ask ? (m._ask.status === 'open' || m._ask.status === 'pending'
          ? ' ask' : ' ask askdone') : '')
        /* passive notices (orgtree_send_notice) stand apart too — but
           quietly: a dashed neutral edge, never the ask accent */
        + (!m._ask && isMailNotice(m) ? ' notice' : '')
        /* …and a SYSTEM notice shrinks to a single line (user,
           2026-08-28). ⚠ The `from` test is what keeps this off an
           AGENT's notice, which stays full height: the user asked only
           for the machine's own chatter to be de-emphasised, and in a
           node mailbox agent-to-agent notices are the common case.
           This is a DIFFERENT predicate from the read-on-arrival rule,
           which is every notice whatever its source — the two must not
           be collapsed into one test. */
        + (isSystemNotice(m) ? ' sysnotice' : '')
        /* a FOLDED RUN of them is that same row carrying a count — see
           pileNotices. No new edge, no new tint: this is meant to read
           as more of the one-line system row, not as a new species.
           (`notepile`, not `pile` — `.pile-*` is the retired-sibling
           stack on the canvas and the two share nothing.) */
        + (isPile ? ' notepile' : '')
        /* D-169: urgent mail sits at the TOP of that same ladder — one
           notch above an open ask on the one axis this list already
           uses (edge + tint + chip), not a new colour. It does NOT
           pulse: the user asked the INBOX to pulse and the ROW to be
           pronounced, and two pulsing rows would read as an alarm
           where two strong rows still read as a list. */
        + (!m._ask && hasMailAttention(m) ? ' urgent' : '')
        /* …and it FLASHES on the same test it scrolls on: a jump at a
           folded member must not scroll to a row that then sits there
           unmarked */
        + (flash ? ' jflash' : '')
        + (queued || projectMail ? ' project-mail' : '')}
      onClick={onClick}
      onContextMenu={onContextMenu}>
      <div className="l1">
        {/* the row's identity. ⚠ It is a CLICK TARGET inside a row that
            is itself a click target (selection): every name renderer
            that navigates must stop the bubble, or focusing an agent
            would also select — or deselect — the mail you clicked from.
            `AgentName` does that itself; `SenderChip` was made to. */}
        <span className="mfrom">
          {outgoing ? '→ ' : ''}{party}
        </span>
        {!metaLine && chips}
        {mark}
        {!m._ask && m.dnd_held && <span className="dnd-mail-state">held (do not disturb)</span>}
        {!m._ask && m.dnd_read && <span className="dnd-mail-state">read</span>}
        <span className="mtime">{fmtShort(m.at)}</span>
        {m._wait && m.id && onRetract && (
          <button className="chip-x" title="retract (undelivered)"
            onClick={(e) => { e.stopPropagation(); onRetract(m) }}>
            <CloseIcon fontSize="inherit" /></button>)}
      </div>
      {metaLine && <div className="lmeta">
        {chips}
        {queued && <QueueChip q={m.queue!} onFocusAgent={onFocusAgent} hasAgent={hasAgent} tierOf={tierOf} />}
      </div>}
      {/* the preview line is what makes a row two lines tall, so a
          SYSTEM notice simply does not render one (user, 2026-08-28:
          "much narrower in height"). Not hidden in CSS — not built:
          a long-lived org's mailbox carries a lot of these, and a
          display:none preview is a DOM node per row that nobody can
          ever see. The body is still one click away in the reading
          pane, and the `l1` header keeps the row identifiable. */}
      {!isSystemNotice(m)
        && <div className="l2">
          <TagChips tags={m.tags} onTag={onTag} preview/>
          <span className="mail-preview-text">{reply && <span className="dim" title={[reply.from, reply.at && fmtFull(reply.at), reply.gist].filter(Boolean).join(' · ')}>
            ↩ {briefLine(reply.gist || 'original unavailable')} · </span>}
          {briefLine(view ? eventSummary(view.event) : m.body)}</span></div>}
    </div>
  )
}

/** ONE MESSAGE'S READING PANE — what every mailbox shows for the selected
 *  row, exported for the Attention view's body for an urgent mail or a
 *  question (user 2026-09-29: "the bodies should look identical to how they
 *  look in their respective details"). It renders INSIDE the host's
 *  `.mailer-read`; `MailList` itself draws its pane through it. `onReply` is
 *  passed only when this message may be replied to from here. */
export function MailReadPane({ cur, members, org, refs, mdBase, fileHref, sender, party,
  outgoing, customSender, waitLabel, custom, onReply, toast, onTag, hideMailReplyKind, onFocusAgent, hasAgent, tierOf, compoundHeader }: {
  compoundHeader?: boolean
  onFocusAgent?: (id: string) => void
  hasAgent?: (id: string) => boolean
  /** the model card of an agent the queue state names (MailListProps.tierOf) */
  tierOf?: (id: string) => string | null | undefined
  hideMailReplyKind?: boolean
  cur: MailRow
  onTag?: (tag:string)=>void
  /** a folded run of system notices, newest first; one entry = no run */
  members?: MailRow[]
  org?: string
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
  mdBase?: (m: MailRow) => string
  fileHref?: (path: string, m: MailRow) => string
  sender: (id: string, m: MailRow) => ReactNode
  /** the displayed party of `cur` (the event actor, else the sender) */
  party: string
  outgoing?: boolean
  /** the sender renderer owns the whole head identity (the org inbox) */
  customSender?: boolean
  waitLabel?: ReactNode
  /** a caller-supplied body that replaces the message AND the reply box
   *  (asks: the response form IS the body) */
  custom?: ReactNode | null
  onReply?: (text: string, attachments?: string[], notice?: boolean) => Promise<unknown> | void
  toast?: ToastFn
}) {
  const profile = 'operator'
  const typed = (m: MailRow) => {
    const result = decodeEventRow(m, profile)
    return result.kind === 'known' ? projectEvent(result.event) : null
  }
  const S = sender
  const messageContent = (m: MailRow, standalone = false) => {
    const decoded = decodeEventRow(m, profile)
    return <>
      <MailReplyPreview row={m} org={org ?? refs?.world.org ?? ''} world={refs?.world} onOpen={refs?.onOpen} />
      {decoded.kind === 'legacy'
      ? <RefMdBody className={'mailer-body md' + (standalone && isMailNotice(m) ? ' event-notice' : '')} html={md(m.body, mdBase?.(m) || undefined)}
          world={refs?.world} onOpen={refs?.onOpen} />
      : <div className="mailer-body"><EventCard part={standalone ? undefined : "body"} row={m} profile={profile}
          org={org ?? refs?.world.org ?? ''} imgBase={mdBase?.(m) || undefined}
          world={refs?.world} onOpen={refs?.onOpen} actor={id => S(id, m)} /></div>}
    </>
  }
  const run = members && members.length > 1 ? members : null
  const metadata = <>
    <span className="dim">{run ? `${run.length} notices` : typed(cur) ? null : cur.kind}</span>
    {cur.urgent && <span className="urgentkind">urgent</span>}
    <TagChips tags={cur.tags} onTag={onTag}/>
    {cur.relationship && <span className="dim">{cur.relationship}</span>}
    {!cur._ask && cur.queue && <QueueChip q={cur.queue} onFocusAgent={onFocusAgent} hasAgent={hasAgent} tierOf={tierOf} />}
    <span className="dim">{fmtFull(cur.at)}</span>
    {cur._wait && <span className="wait">{waitLabel}</span>}
  </>
  return (
    <>
      <div className={'mailer-head event-head' + (compoundHeader ? ' compound-header' : '')}>
        {!run && <EventCard part="header" row={cur} profile={profile}
          hideKind={hideMailReplyKind && typed(cur)?.event.variant === 'reply.mail'}
          org={org ?? refs?.world.org ?? ""} world={refs?.world} onOpen={refs?.onOpen} actor={id => S(id, cur)} />}
        {outgoing && !customSender && <span className="dim">to</span>}
        {(outgoing || !typed(cur)) && (customSender ? S(party, cur) : <span className="event-actor">{S(party, cur)}</span>)}
        {compoundHeader ? <span className="mail-head-meta">{metadata}</span> : metadata}
      </div>
      {/* D-169: WHY you are being interrupted, in the sender's own
          words, on its own line above the mail. The reason exists to be
          READ — an urgent flag whose justification were merely stored
          would be a tax on the sender and no check at all, whereas one
          shown here makes the claim accountable to the person whose
          attention it took. */}
      {cur.urgent && cur.urgent_reason && (
        <div className="urgent-why">{cur.urgent_reason}</div>
      )}
      {/* A FOLDED RUN OPENS AS THE LIST OF WHAT IT FOLDED (user,
          2026-08-28: "display them in a list in the full mail view to
          the right"), modelled on the block an agent gets on its next
          turn — supervisor._envelope's `[ORG NOTICES — n change(s)]`,
          which the user named as the thing to copy. Same shape as that
          block: one line per notice, `at` then text, OLDEST FIRST, so a
          run reads forward like the log it is. The list itself is
          newest-first and stays that way; this is a different axis.
          ⚠ Nothing is summarised or elided — every folded entry's whole
          body is here. The row is a shorter way IN, not a shorter
          version OF. */}
      {custom
        ? <div className="mailer-body">{custom}</div>
        : run
          ? <div className="mailer-body notepile">
              {run.slice().reverse().map((n, i) => (
                <div className="notepile-row" key={n.id ?? i}>
                  <span className="notepile-at">{fmtShort(n.at)}</span>
                  {/* a folded notice is a body like any other — a
                      reference written in one is followed the same way */}
                  {messageContent(n, true)}
                </div>
              ))}
            </div>
          : messageContent(cur)}
      {(cur.attachments ?? []).length > 0 && (
        <div className="attach-row">
          {/* extern-shaped attachments may lack `path` — a download
              link would point at "undefined"; show a plain chip.
              Images render viewable in place (user spec 2026-08-25). */}
          {cur.attachments!.map((a) => {
            const href = (a.path && fileHref?.(a.path, cur)) || ''
            const name = a.name ?? a.path ?? 'file'
            return href && isImg(name)
              ? <AttachThumb key={a.path} href={href} name={name}
                  meta={a.bytes != null ? `${Math.round(a.bytes / 1024)} KB` : undefined} />
              : href
                ? <a key={a.path} className="attach-chip" title="download"
                    href={href} download={a.name}>
                    <DownloadIcon fontSize="inherit" /> {a.name}
                    <span className="dim"> {a.bytes != null ? `${Math.round(a.bytes / 1024)} KB` : ''}</span></a>
                : <span key={a.path ?? a.name} className="attach-chip">
                    <FileIcon fontSize="inherit" /> {a.name}</span>
          })}
        </div>
      )}
      {onReply && (
        /* ⚠ `org ?? refs?.world.org` — THE SAME RESOLUTION THE HEAD USES
           (above, and the body's `imgBase`). `org` is an OPTIONAL prop, and
           the user's own inbox — the one MailList in the app that supplies
           `onReply`, so the only one that ever renders this box — omits it
           and passes `refs` instead. Read as bare `org` this handed the
           composer `undefined`, which is exactly what `attachable` gates on,
           so the user's paperclip was permanently grey (reported
           2026-09-17). NOT `?? ''` like the head: an absent org must stay
           ABSENT so the composer degrades the way its `slug?:` contract says. */
        <MailReplyBox target={outgoing ? cur.to : cur.from} slug={org ?? refs?.world.org} toast={toast}
          onSend={(text, attachments, notice) => onReply(text, attachments, notice)} />
      )}
    </>
  )
}

/** №11: inline mail reply box — textarea + reply button.
 *  Shared between the mailbox reader (mail.tsx), the presented documents
 *  viewer (gallery.tsx) and the docket's own item reply (docket.tsx) —
 *  ONE composer, THREE contextual reply areas (allow-attachments-in-
 *  contextual-reply-composers).
 *
 *  Attachments upload through the SAME `uploadFile` a node's own desk
 *  composer uses (desk.tsx's `attach()`), landing in `target`'s scratch
 *  folder — `target` already names that node in every caller (it is what
 *  the reply prose already says "reply to X…" about), so no new node-id
 *  prop is needed beyond `slug`, which callers did not previously have to
 *  pass because nothing here touched the API layer directly. */
export function MailReplyBox({ target, slug, onSend, placeholder, sendDisabled = false,
  toast, broadcast }: {
  target?: string
  /** required to actually upload anything — omit it and the attach button
   *  stays disabled, the same graceful-degradation shape as `sendDisabled`. */
  slug?: string
  /** `notice` is true only for a send the user ARMED as a passive notice; the
   *  host decides what that means on its own wire and the server decides
   *  whether it is possible at all (see the toggle's comment below). */
  onSend: (text: string, attachments?: string[], notice?: boolean, broadcast?: boolean) => void | Promise<unknown>
  placeholder?: string
  /** Keep the draft editable while its selected recipient is unavailable. */
  sendDisabled?: boolean
  toast?: ToastFn
  /** Present only for a project presentation reader. */
  broadcast?: { project: string; members: number }
}) {
  const [draft, setDraft] = useState('')
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionCandidates = useOrgMentionCandidates(slug)
  const mentions = useAgentMentions({
    value: draft,
    onChange: setDraft,
    inputRef: taRef,
    candidates: mentionCandidates,
    disabled: sendDisabled,
  })
  const enterKey = useComposerEnter()
  // what happened to the last send, said in the box: `sending` from the click,
  // `sent` once the server accepted it, `failed` (with the reason) when it
  // refused — the text is back in the box by then
  const [sendState, setSendState] = useState<
    { state: 'sending' | 'sent' } | { state: 'failed'; error: string } | null>(null)
  const sendSeq = useRef(0)
  const [attached, setAttached] = useState<{ name: string; path: string; bytes: number }[]>([])
  // PER-COMPOSER, never shared and never persisted (user 2026-09-17): opening
  // a ticket reply must not inherit whatever the mail composer was last set
  // to. Deliberately local state rather than the desk's `noticestore`
  // singleton, which is global by design because the desk has one composer.
  const [noticeArmed, setNoticeArmed] = useState(false)
  const [broadcastArmed, setBroadcastArmed] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const attachable = Boolean(slug && target) && !sendDisabled
  const staging = useStaging((file, options) => slug && target ? uploadFile(slug, target, file, options.signal) : Promise.reject(Error('Choose a recipient first')),
    (file, r) => setAttached(a => [...a, {name:file.name,path:r.path,bytes:r.bytes}]))
  const attach = staging.add
  const send = () => {
    const t = draft.trim()
    if ((!t && !attached.length) || sendDisabled || staging.blocked()) return
    const paths = attached.map((a) => a.path)
    // DISARMS ON SEND ONLY — not on Escape, not on clearing the text, not on
    // switching recipient. Same rule as the desk composer (b38d9d9 §3), and
    // disarmed at submission rather than on success, so a refused send does
    // not leave a live notice armed behind a toast the user already read.
    const armed = noticeArmed
    if (noticeArmed) setNoticeArmed(false)
    // THE BOX EMPTIES ON THE CLICK (docket v3-sending-a-reply-to-a-mail-
    // takes-about-half-a, 2026-09-30): it used to stay locked on the typed
    // text until the server answered, and the inbox's answer includes marking
    // the replied-to mail read, so a reply took about half a second to
    // register. Same principle as an answered card (point 31). A refused send
    // puts the text and attachments back, so nothing typed is lost; if the
    // user has typed more since, the refused text goes first.
    const sentDraft = draft
    const sentAttached = attached
    setDraft(''); setAttached([]); staging.newDraft()
    const sendingBroadcast = broadcastArmed
    const res = onSend(t || '(file attached)', paths.length ? paths : undefined, armed, sendingBroadcast)
    if (res && typeof (res as Promise<unknown>).then === 'function') {
      const mine = ++sendSeq.current
      setSendState({ state: 'sending' })
      Promise.resolve(res)
        .then(() => {
          if (sendSeq.current === mine) {
            setSendState({ state: 'sent' })
            if (sendingBroadcast) setBroadcastArmed(false)
          }
        })
        .catch((e: unknown) => {
          setDraft((cur) => (cur.trim() ? sentDraft + '\n\n' + cur : sentDraft))
          setAttached((cur) => [...sentAttached, ...cur])
          if (sendSeq.current === mine) {
            setSendState({ state: 'failed', error: e instanceof Error ? e.message : String(e) })
          }
        })
    }
  }
  return (
    <>
      {attached.length > 0 && (
        <div className="attach-row">
          {attached.map((a, i) => (isImg(a.name)
            ? <AttachThumb key={a.path + i} href={fileUrl(slug!, target!, a.path)}
                name={a.name} meta={fmtBytes(a.bytes)}
                onRemove={() => setAttached((x) => x.filter((_, j) => j !== i))} />
            : <span key={a.path + i} className="attach-chip">
                <FileIcon fontSize="inherit" /> {a.name}
                <span className="dim"> {fmtBytes(a.bytes)}</span>
                <button className="chip-x" title="remove from this reply"
                  onClick={() => setAttached((x) => x.filter((_, j) => j !== i))}>
                  <CloseIcon fontSize="inherit" /></button>
              </span>
          ))}
        </div>
      )}
      <StagingRows staging={staging} />
      <div className={'mail-reply' + (noticeArmed ? ' notice-armed' : '') + (broadcastArmed ? ' broadcast-armed' : '')}
        data-panel-draft={draft.length > 0 || attached.length > 0 || staging.rows.length > 0
          || sendState?.state === 'sending' || undefined}>
        {/* the composer's left column, exactly as the desk composer builds it
            (b38d9d9): the notice toggle ABOVE the attach button, both in the
            same `.cc-btnstack`, the stack's bottom on the composer baseline.
            Reuses .cc-attach / .cc-notice-toggle / .cc-btnstack rather than
            inventing new classes — same 24px circle family, no scoping hazard
            the way `aside`/`.event-row-kind` had, since none of them was ever
            a bare-tag rule to begin with. */}
        <div className="cc-btnstack">
          {/* NO DISABLED STATE FOR AN UNSUPPORTED RECIPIENT, on purpose
               (b38d9d9 §4): the server decides whether a notice is possible
               and silently sends ordinary mail when it is not, so greying the
               button would be this renderer guessing at a rule it does not
               own. It follows `sendDisabled` only, like the draft. */}
          <button className={'cc-notice-toggle' + (noticeArmed ? ' armed' : '')}
              type="button"
              disabled={sendDisabled}
              aria-label={noticeArmed ? 'Notice-send armed: this reply arrives as a passive notice' : 'Notice-send: send this reply as a passive notice'}
              title={noticeArmed ? 'Notice-send armed: this reply will arrive as a passive notice without waking the recipient (Alt+N)' : 'Send this reply as a passive notice without waking the recipient (Alt+N)'}
              onClick={() => setNoticeArmed((v) => !v)}>
              {noticeArmed ? <NotificationsActiveIcon fontSize="inherit" /> : <NotificationsIcon fontSize="inherit" />}
          </button>
          {broadcast && <button className={'cc-broadcast-toggle' + (broadcastArmed ? ' armed' : '')}
              type="button" disabled={sendDisabled || broadcast.members === 0} aria-pressed={broadcastArmed}
              aria-label={broadcastArmed ? `Megaphone on: reply goes to all ${broadcast.members} agents under ${broadcast.project}`
                : `Megaphone: send this reply to all ${broadcast.members} agents under ${broadcast.project}`}
              title={broadcast.members === 0 ? `no agent works under ${broadcast.project} yet`
                : broadcastArmed ? `on: this reply goes to all ${broadcast.members} agents under ${broadcast.project}; click or press Alt+B to turn it off`
                  : `send this reply to all ${broadcast.members} agents under ${broadcast.project} (Alt+B)`}
              onClick={() => setBroadcastArmed((v) => !v)}>
              <CampaignIcon fontSize="inherit" />
          </button>}
          <button type="button" className="cc-attach" disabled={!attachable}
            title={slug && target ? 'attach a file' : 'attachments need a recipient first'}
            onClick={() => fileRef.current?.click()}>
            <AttachIcon fontSize="inherit" /></button>
        </div>
        <input type="file" ref={fileRef} style={{ display: 'none' }} multiple
          onChange={(e) => {
            [...(e.target.files ?? [])].forEach(attach)
            e.target.value = ''
          }} />
        <textarea ref={taRef} rows={2} value={draft}
          title={enterKey.hint}
          placeholder={placeholder ?? (target ? `reply to ${target}…` : 'reply…')}
          onChange={(e) => { setDraft(e.target.value); mentions.syncCaret() }}
          onSelect={mentions.syncCaret}
          onClick={mentions.syncCaret}
          onKeyUp={mentions.syncCaret}
          onPaste={(e) => {
            if (attachable && e.clipboardData?.files?.length) {
              e.preventDefault()
              ;[...e.clipboardData.files].forEach(attach)
            }
          }}
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return
            // Alt+N, the desk composer's own shortcut. Checked BEFORE Enter so
            // the two can never race, and it returns rather than falling
            // through — Alt+N is not a send.
            if (e.altKey && (e.key === 'n' || e.key === 'N')) {
              e.preventDefault()
              if (!sendDisabled) setNoticeArmed((v) => !v)
              return
            }
            if (broadcast && e.altKey && (e.key === 'b' || e.key === 'B')) {
              e.preventDefault()
              e.stopPropagation()
              if (!sendDisabled && broadcast.members > 0) setBroadcastArmed((v) => !v)
              return
            }
            if (enterKey.sends(e) && (draft.trim() || attached.length) && !sendDisabled) {
              e.preventDefault()
              send()
            }
          }} />
        {mentions.menu}
        {/* a stable class, not `.mail-reply button:last-of-type` — this used
            to be the ONLY button `.mail-reply` had, and several tests query
            it that way; the new attach button ahead of it made that
            positional match silently pick the wrong element instead of
            failing loudly, which is worse */}
        <button className="mail-reply-send"
          title={enterKey.hint}
          disabled={(!draft.trim() && !attached.length) || sendDisabled || staging.rows.length>0} onClick={send}>
          reply
        </button>
      </div>
      {sendState && (
        <div className={'mail-reply-state dim' + (sendState.state === 'failed' ? ' failed' : '')}
          role={sendState.state === 'failed' ? 'alert' : 'status'}>
          {sendState.state === 'failed'
            ? `not sent: ${sendState.error} — your text is back in the box`
            : `${sendState.state === 'sending' ? 'sending' : 'sent'}${target ? ` to ${target}` : ''}`
              + (sendState.state === 'sending' ? '…' : '')}
        </div>
      )}
    </>
  )
}
/** Audience chip rows fold their RETIRED entries behind one toggle chip
 *  (user feature 2026-08-17, "all audience holding types") — the same
 *  collapse as the desk footer's retired reports (F-01). `ids` are the
 *  retired entries only; the host draws its own chip shape via `render`,
 *  so the fold works for user-audience holders, org-inbox holders, and a
 *  desk's held-audience badges alike. */
export function RetiredFold({ ids, render }: {
  ids: string[]
  render: (id: string) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const hideRetired = useHideRetired()
  if (hideRetired || !ids.length) return null
  return (<>
    <button type="button" className="badge dim retired-fold"
      title={open ? 'collapse the retired entries' : ids.join(', ')}
      onClick={() => setOpen((o) => !o)}>
      {open ? 'hide retired' : `${ids.length} retired`}
    </button>
    {open && ids.map(render)}
  </>)
}

// Audience holders are a reader-facing list in both mail surfaces. Seven fit
// on one row in the standard mail panel; the eighth begins a second, so eight
// is the first point where the list costs a whole extra line. Unlike retired
// entries (which have their own lifecycle fold above), this fold is for LIVE
// holders and starts shut: a busy org should open its mail to the useful
// summary, not a wall of revoke chips. It deliberately shares RetiredFold's
// local, per-open-panel disclosure behaviour rather than storing a preference:
// expanding is an inspection, not a browser-wide change of how audiences work.
export const AUDIENCE_FOLD_LIMIT = 8

export function AudienceFold({ ids, label, alert = false, render, limit = AUDIENCE_FOLD_LIMIT }: {
  ids: string[]
  /** plural visible noun, e.g. "audience holders" */
  label: string
  /** org inboxes expect one holder: a larger folded count is an anomaly */
  alert?: boolean
  render: (id: string) => ReactNode
  /** folds from this many ids up; the desk's jump cards pass their own */
  limit?: number
}) {
  const [open, setOpen] = useState(false)
  if (!ids.length) return null
  if (ids.length < limit) return <>{ids.map(render)}</>
  const summary = `${ids.length} ${label}`
  return (<>
    <button type="button"
      className={'badge dim audience-fold' + (alert ? ' alert' : '')}
      data-audience-fold aria-expanded={open}
      title={open ? `collapse ${summary}` : `show ${summary}: ${ids.join(', ')}`}
      onClick={() => setOpen((o) => !o)}>
      {alert && '⚠ '}{open ? `hide ${summary}` : summary}
    </button>
    {open && ids.map(render)}
  </>)
}

// The node's own mailbox (user ruling: its own tab, separate from history),
// with the same folders as the user's: inbox + sent.
interface InboxViewProps {
  slug: string
  nid: string
  /** Same authoritative total as canvas badges; mailbox rows are windowed. */
  unreadCount?: number
  /** must RETURN the retract promise (and rethrow on failure) — the optimistic
   *  hide below rolls back on rejection, and a swallowed error would leave the
   *  mail on the server but invisible here until remount */
  onRetract?: (m: MailRow) => Promise<unknown> | void
  jumpTo?: string | null
  /** the REQUEST's identity: a repeat click on the same target is a new
   *  request, an unrelated repoll is not (`jumpKey`) */
  jumpSeq?: number | null
  /** the inbox owner's tier: its unread count wears that agent's provider */
  tier?: string | null
  onFocusAgent?: (agentId: string) => void
  /** the SENDERS' models, for the chip beside each name. Resolved by the
   *  caller because only it holds the tree; omitted, no chip is drawn. */
  tierOf?: (id: string) => string | null | undefined
  /** does the tree hold a node by this id? Same contract as MailList's. */
  hasAgent?: (id: string) => boolean
  /** canonical references in the READING PANE's mail bodies. Forwarded
   *  verbatim to `MailList`, which owns the rendering — this panel adds no
   *  judgement of its own, because a second opinion about the same token is
   *  exactly what one shared world exists to prevent. */
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
  /** the surface's toast, for the row menu's copy confirmations */
  toast?: ToastFn
  /** forwarded to MailList: collapse the list into an overlay panel when the
   *  surface around it is narrow. The MODAL form sets it; the same view on the
   *  agent desk does not (see MailListProps.collapsible). */
  collapsible?: boolean
  /** a project's mailbox: forwarded to both folders (MailListProps.projectMail) */
  projectMail?: boolean
}

// Only a plain delivery uses the compact marker. Ack/release/dead-letter
// states retain their distinct labels; the recorded claim time is not sent-at.
const plainDelivery = (q: MailQueueState) =>
  Boolean(q.held_by && !q.ack && !q.acked_at && !q.ack_of && !q.dead_letter && !q.purged && !q.released)
interface QueueLabel {
  text: string
  title: string
  /** the agent the label names, split out of its words: [before, id, after] */
  named?: [string, string, string]
}
/** every other queue state's label and tooltip; an empty label shows nothing */
function queueLabel(q: MailQueueState): QueueLabel {
  const naming = (before: string, id: string | undefined, after: string, title: string): QueueLabel =>
    ({ text: before + (id ?? '?') + after, title, named: id ? [before, id, after] : undefined })
  return q.ack_of ? { text: `ack of ${q.ack_of}`, title: `the completion record that acks mail ${q.ack_of}` }
    : q.dead_letter ? { text: 'dead letter', title: `handed out ${q.dead_letter.attempts ?? '?'} times without an ack; the last holder, `
      + `${q.dead_letter.by ?? '?'}, ${q.dead_letter.why ?? 'let it go'}. It will not be handed out again.` }
    : q.purged ? { text: 'purged', title: `purged from the queue by ${q.purged.by ?? '?'} before anyone took it` }
    : q.released ? naming('released (', q.released.by, ')', `back in the queue: ${q.released.by ?? 'its holder'} ${q.released.why ?? 'let it go'}`)
      : q.acked_at ? naming('acked by ', q.held_by, '', `${q.held_by} acked it${q.ack_mail ? ` with ${q.ack_mail}` : ''}`)
        : q.ack ? naming('', q.held_by, ' · awaiting ack', `handed to ${q.held_by}, who gets no more project mail until it acks this one`)
          : q.held_by ? { text: `delivered to ${q.held_by}`, title: `the project's queue delivered it to ${q.held_by}`
            + (q.ack_waived_at ? ' (its ack was waived when the queue left ack mode)' : '') } : { text: '', title: '' }
}
/** does this queue state draw a QueueChip? A row that shows one gives it a
 *  line of its own (MailRowView). */
export const showsQueueState = (q: MailQueueState | undefined) =>
  Boolean(q && (plainDelivery(q) || queueLabel(q).text))

/** A project mail's queue state, on its row's meta line and in the reading
 *  pane's header (user 2026-10-18 08:01Z): handed to an agent, waiting for
 *  its ack, acked, released back to the queue, or an ack record. Every agent
 *  it names is the shared `AgentName` wearing that agent's model card, as the
 *  sender beside it does (user 2026-10-18 17:01Z: "recipients are still
 *  missing model icon cards in project mailboxes"). `queue-agent`: an outline
 *  chip whose words name that agent. */
export function QueueChip({ q, onFocusAgent, hasAgent, tierOf }: {
  q: MailQueueState
  onFocusAgent?: (id: string) => void
  hasAgent?: (id: string) => boolean
  /** the named agent's model, for its card: MailListProps.tierOf's contract */
  tierOf?: (id: string) => string | null | undefined
}) {
  const focus = onFocusAgent
  const agent = (id: string, why: string, prefix?: string) => <AgentName id={id} prefix={prefix} why={why}
    tier={tierOf?.(id)} onFocus={focus && hasAgent?.(id) ? (aid: string) => focus(aid) : undefined} />
  if (plainDelivery(q) && q.held_by) {
    const title = `delivered to ${q.held_by}`
      + (q.held_at ? ` at ${fmtFull(q.held_at)}` : ' — delivery time not recorded')
      + (q.ack_waived_at ? ' (its ack was waived when the queue left ack mode)' : '')
    return <span className="queuekind queue-delivery" title={title}>
      <span aria-hidden="true">→</span>
      {agent(q.held_by, title, '@')}
    </span>
  }
  const { text, title, named } = queueLabel(q)
  if (!text) return null
  const cls = 'queuekind' + (q.ack && !q.acked_at && !q.released ? ' awaiting' : '') + (q.dead_letter ? ' dead' : '')
  if (!named) return <span className={cls} title={title}>{text}</span>
  const [before, id, after] = named
  return <span className={cls + ' queue-agent'} title={title}>{before}{agent(id, title)}{after}</span>
}

export function InboxView({ slug, nid, unreadCount, onRetract, jumpTo, jumpSeq, tier, onFocusAgent, toast,
  tierOf, hasAgent, refs, collapsible, projectMail }: InboxViewProps) {
  const [folder, setFolder] = useState('inbox')
  // G5: was a fetch keyed on the `pulse` prop, which meant it refreshed on turn
  // events and on nothing else — and a mail DELIVERY is not a turn event, so
  // the one panel whose whole job is showing mail was the one that did not
  // learn when mail arrived. Polled while mounted instead.
  const mailbox = useRecordMailbox(slug, nid)
  const history = useMailboxHistory(slug, mailbox.value, folder, true, 0, nid)
  const box = history.box
  // the exact question, for a reference that landed outside the window this
  // poll returns. Same box, same access — it is the one-row form of the
  // fetch above, not a wider one.
  const nodeLookup = useCallback(
    (id: string) => getMailById(slug, 'node', id, nid).then((r) => r.mail as MailRow | null),
    [slug, nid])
  // the ONE piece of local state left here: mails this user just retracted,
  // held only until the server's copy agrees. That is an uncommitted operation,
  // not a mirror of server data — the distinction the whole refactor turns on.
  const [dropped, setDropped] = useState<string[]>([])
  const pending = (box?.pending ?? []).filter((m) => !dropped.includes(m.id ?? ''))
  // ⚠ A LINK MUST OPEN THE FOLDER THE MESSAGE IS ACTUALLY IN. This box has
  // two, the panel opens on `inbox`, and the Sent list was not even given the
  // jump — so a reference to a message this agent SENT could never be found,
  // and the panel opened looking ordinary with the mail one unmarked click
  // away. The org inbox has always done this; the node box had not.
  //
  // Keyed on the JUMP, not on the box: switching whenever the data changes
  // would drag the reader back out of a folder they had chosen by hand every
  // time the poll returned. `box` is in the deps because the answer is not
  // knowable until it has loaded, and the panel mounts before that.
  const foldedJump = useRef<string | null>(null)
  // the panel's own question about `jumpTo`, for the folder that has no
  // `lookup` and so is not the one asking. Not keyed on the request: every
  // path through the effect writes it, and the one path that does not run
  // (no `box`) renders "loading…" over any list that could read it.
  const [jumpAsk, setJumpAsk] = useState<'asking' | 'failed' | null>(null)
  // a deliberate retry, as in the list: nothing re-asks on its own
  const [askAgain, setAskAgain] = useState(0)
  // ⚠ THE LIVE REQUEST, AND THE ONLY THING ALLOWED TO ANSWER. In a ref rather
  // than the effect's closure: `box` is in the deps and the poll replaces it
  // every few seconds, so an effect-scoped cancel abandons any answer slower
  // than one tick. Superseded by a NEWER REQUEST or by unmount, never by a
  // re-run of the same one.
  const askKey = useRef<string | null>(null)
  useEffect(() => () => { askKey.current = null }, [])
  useEffect(() => {
    // a retry is a new attempt at the same request: it must pass the latch
    const req = jumpKey(jumpTo, jumpSeq) + '#' + askAgain
    if (foldedJump.current === req) return
    // ⚠ THE CLAIM IS STAKED BEFORE ANYTHING IS DECIDED ABOUT THE NEW REQUEST,
    // because the branches below RETURN. A target already in a loaded list
    // needs no question of its own, and staking the claim after those returns
    // leaves the previous question live to answer over the top of it.
    askKey.current = req
    setJumpAsk(null)
    if (!jumpTo || !box) return
    foldedJump.current = req
    const here = (rows: MailRow[] | undefined) =>
      (rows ?? []).some((m) => m.id === jumpTo)
    if (here(box.delivered) || here(box.pending)) { setFolder('inbox'); return }
    if (here(box.sent)) { setFolder('sent'); return }
    // ⚠ IN NEITHER LOADED LIST: THE PANEL ASKS, not the list. A list knows
    // only that the id is missing from ITS window, so the Sent list would ask
    // for a message the inbox list is holding and pull the reader out of the
    // folder they chose. The answer's folder is decided here:
    // `@mail:org/node/<nid>/<id>` names that node's RECEIVED mail.
    setJumpAsk('asking')
    Promise.resolve(nodeLookup(jumpTo))
      .then((m) => {
        if (askKey.current !== req) return
        setJumpAsk(null)
        if (m) setFolder('inbox')
      })
      .catch(() => {
        if (askKey.current !== req) return
        setJumpAsk('failed')
      })
    // ⚠ `jumpSeq` IS IN THE DEPS because this effect READS it. Without it a
    // repeat request never re-runs, and the latch compares a new key the
    // effect is never woken to look at.
  }, [jumpTo, jumpSeq, box, nodeLookup, askAgain])
  useEffect(() => {         // let go as soon as the server has caught up
    if (!box) return
    setDropped((d) => d.filter((id) => box.pending.some((m) => m.id === id)))
  }, [box])
  return (
    <div className="mailwrap" ref={mailbox.ref} onFocusCapture={mailbox.onFocus}>
      <TransferPanel slug={slug} agent={nid} />
      <MailFolders folder={folder} setFolder={setFolder}
        unread={unreadCount === undefined ? pending.length : Math.max(0, unreadCount
          - (box?.pending ?? []).filter(m => dropped.includes(m.id ?? '')).length)} tier={tier} />
      <div className="mailpane">
        {history.error&&<div role="alert">Could not load older mail. <button onClick={history.retry}>Retry</button></div>}
        {mailbox.error ? <div className="dim pad" role="alert">Could not load mailbox. <button onClick={mailbox.retry}>Retry</button></div> : box == null
          ? <div className="dim pad">loading…</div>
          : folder === 'inbox'
            ? <MailList org={slug} pending={pending} delivered={box.delivered}
                hasMore={history.hasMore} loadingMore={history.loading} onLoadMore={history.loadMore}
                collapsible={collapsible} projectMail={projectMail}
                tierOf={tierOf} hasAgent={hasAgent} refs={refs} toast={toast}
                /* the row's reference: this folder IS the node's received
                   box, so the token is exact (`@mail:org/node/<nid>/<id>`).
                   The Sent list below passes none — see MailListProps.refOf */
                refOf={(m) => m.id ? refToken({ kind: 'mail', org: slug, box: 'node', node: nid, id: m.id }) : null}
                waitLabel="awaiting next turn" jumpTo={jumpTo} jumpSeq={jumpSeq}
                lookup={nodeLookup}
                fileHref={(p) => fileUrl(slug, nid, p)}
                mdBase={() => fileBase(slug, nid)}
                onFocusAgent={onFocusAgent}
                onRetract={onRetract
                  ? (m) => {
                      const id = m.id ?? ''
                      setDropped((d) => [...d, id])
                      // rollback on failure: the sweep above only RELEASES ids
                      // the server no longer lists, so without this a failed
                      // retract hid the mail here while it stayed on the server
                      Promise.resolve(onRetract(m))
                        .then(() => history.acknowledge(id))
                        .catch(() => setDropped((d) => d.filter((x) => x !== id)))
                    }
                  : undefined} />
            // sent-to-user attachments were COPIED into this node's own
            // outbox/ on send (api.py routes them through _agent_send_file),
            // so the same scratch-keyed href serves the Sent folder too
            /* ⚠ NO `lookup` HERE. The Sent rows are copies of mail that lives
               in other boxes, so an exact answer never belongs in this folder
               — the panel above asks, and opens the folder that holds it. It
               hands down the OUTCOME of that question (`askState`) so this
               list does not read an unfinished or failed one as an absence. */
            : <MailList org={slug} delivered={box.sent ?? []} outgoing jumpTo={jumpTo}
                hasMore={history.hasMore} loadingMore={history.loading} onLoadMore={history.loadMore}
                collapsible={collapsible} projectMail={projectMail}
                jumpSeq={jumpSeq} tierOf={tierOf} hasAgent={hasAgent} refs={refs} toast={toast}
                askState={jumpAsk}
                onAskRetry={() => setAskAgain((n) => n + 1)}
                onFocusAgent={onFocusAgent}
                fileHref={(p) => fileUrl(slug, nid, p)}
                mdBase={() => fileBase(slug, nid)} />}
      </div>
    </div>
  )
}
export interface MailFoldersProps {
  folder: string
  setFolder: (f: string) => void
  unread: number
  folders?: string[]
  /** provider-themes the inbox count by the mailbox OWNER (absent for the
   *  user's own inbox and the org inbox, which belong to no provider) */
  tier?: string | null
}

export function MailFolders({ folder, setFolder, unread, folders, tier }: MailFoldersProps) {
  return (
    <div className="mail-folders">
      {(folders ?? ['inbox', 'sent']).map((f) => (
        <button key={f} className={folder === f ? 'on' : ''}
          onClick={() => setFolder(f)}>
          {f}{f === 'inbox' && unread > 0
            ? <>{' '}<span className={'tab-count'
                + (tier ? ' prov-' + providerOf(tier) : '')}>{unread}</span></>
            : ''}
        </button>
      ))}
    </div>
  )
}
// №10: the org record — every ledger operation (the overseer was the only
// node never told what changed). Renders the events log the server has kept
// all along; the §4.6 cascade warnings ride each row.
export interface OrgRecordProps {
  events?: OrgEvent[] | null
  /** the filter is LIFTED (perf-review round 2): the owner fetches a bounded
   *  tail for the plain view and the FULL record while a search is active,
   *  so the query has to live where the fetch is decided. Uncontrolled
   *  fallback keeps old call sites working. */
  query?: string
  onQuery?: (q: string) => void
}

export function OrgRecord({ events, query, onQuery }: OrgRecordProps) {
  const [qLocal, setQLocal] = useState('')
  const q = query ?? qLocal
  const setQ = onQuery ?? setQLocal
  const qn = q.trim().toLowerCase()
  const rows = [...(events ?? [])].reverse().filter((ev) => !qn
    || JSON.stringify(ev).toLowerCase().includes(qn))
  const when = fmtShort
  const gist = (ev: OrgEvent) => {
    const d = ev.detail || {}
    const bits = [d.node, d.from != null || d.to != null
      ? `${d.from ?? 'top'} → ${d.to ?? 'top'}` : null,
    d.freed != null ? `freed ${typeof d.freed === 'number' ? fmtCredits(d.freed) : d.freed}` : null,
    d.grant != null ? `grant ${typeof d.grant === 'number' ? fmtCredits(d.grant) : d.grant}` : null,
    d.reason, d.predecessor].filter(Boolean)
    return bits.join(' · ')
  }
  if (!rows.length && !qn) return <div className="dim pad">nothing yet</div>
  return (
    <div className="record">
      <input className="mail-filter" placeholder="filter…" value={q}
        onChange={(e) => setQ(e.target.value)} />
      {rows.slice(0, 200).map((ev, i) => (
        <div className="rec-row" key={i}>
          <span className="mtime">{when(ev.at)}</span>
          <b className="rec-kind">{ev.op}</b>
          <span className="rec-actor">{ev.actor === USER ? 'you' : ev.actor}</span>
          <span className="dim">{gist(ev)}</span>
          {(ev.warnings ?? []).map((w, k) => (
            <div className="rec-warn" key={k}>⚠ {w}</div>
          ))}
        </div>
      ))}
    </div>
  )
}
// ✉ on a card — the node's inbox as a modal, the same interface the eye's
// ✉ opens for the user's own inbox.
interface NodeInboxModalProps {
  node: CanvasNode
  slug: string
  close: () => void
  jumpTo?: string | null
  /** the REQUEST's identity: a repeat click on the same target is a new
   *  request, an unrelated repoll is not (`jumpKey`) */
  jumpSeq?: number | null
  onFocusAgent?: (agentId: string) => void
  tierOf?: (id: string) => string | null | undefined
  hasAgent?: (id: string) => boolean
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
  /** the surface's toast, for the row menu's copy confirmations */
  toast?: ToastFn
}

export function NodeInboxModal({ node, slug, close, jumpTo, jumpSeq, onFocusAgent,
  tierOf, hasAgent, refs, toast }: NodeInboxModalProps) {
  return (
    <PinFrame kind="node-inbox" restore={{ agent: node.id, generation: node.generation }} title={`${node.id} · inbox`} panel="settings wide"
      close={close}>
        <h3 data-copy-agent-name={node.id}><MailIcon fontSize="inherit" /> {node.id} <span className="dim">· inbox</span></h3>
        {/* ⚠ A REFERENCE CLOSES THIS MODAL ON THE WAY OUT, as the name beside
            it does. Everything a token can open is UNDER this overlay, so
            following one without closing looks like a click that did nothing.
            The world is untouched; only the handler is wrapped, with one
            argument. */}
        <InboxView slug={slug} nid={node.id} unreadCount={node.mail_pending} jumpTo={jumpTo} jumpSeq={jumpSeq}
          tier={node.tier} toast={toast} collapsible
          tierOf={tierOf} hasAgent={hasAgent}
          refs={refs && {
            world: refs.world,
            onOpen: refs.onOpen && ((r: ResolvedRef) => {
              closeIfCentred('node-inbox', close, slug); refs.onOpen!(r) }),
          }}
          onFocusAgent={onFocusAgent
            ? (id) => { closeIfCentred('node-inbox', close, slug); onFocusAgent(id) }
            : undefined} />
        {/* no footer `close` button (user 2026-09-28), as in the user's own
            inbox: Escape, a backdrop click, the title bar's menu and — when
            pinned — its ✕ close it */}
    </PinFrame>
  )
}
// the ORG INBOX viewer (user spec): the org's correspondence with the outside
// world — chatq sessions and other orgs — as one chronological thread. Also
// where the user staffs the "client contact" role: grant/revoke org-inbox
// audiences so chosen sub-agents read and answer outside mail.
interface OrgInboxModalProps {
  inbox: TreePayload['org_inbox'] | undefined
  net?: TreePayload['net']            // F-06: hubs + rosters + status
  map: Map<string, CanvasNode>
  slug: string
  toast: ToastFn
  close: () => void
  jumpTo?: string | null
  /** the REQUEST's identity: a repeat click on the same target is a new
   *  request, an unrelated repoll is not (`jumpKey`) */
  jumpSeq?: number | null
  /** canonical references in org-mail bodies, forwarded to the lists */
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
  onFocusAgent?: (agentId: string) => void
}

export function OrgInboxModal({ inbox, net, map, slug, toast, close, jumpTo,
  jumpSeq, refs, onFocusAgent }: OrgInboxModalProps) {
  // reworked (user spec 2026-08-05): no blurb, mailservers on their own TAB,
  // holders as bare chips with a drag-to-grant tip
  const [tab, setTab] = useState<'mail' | 'servers'>('mail')
  // a jump to an OUTBOUND mail (an agent's @ext:/@org: send) opens on sent
  const [folder, setFolder] = useState(() =>
    jumpTo && (inbox?.entries ?? []).some((e) => e.id === jumpTo
      && e.dir === 'out') ? 'sent' : 'inbox')
  const holders = inbox?.holders ?? []
  // ⚠ THE TREE'S `entries` IS A PREVIEW — the newest few, for the canvas's
  // one-line summary. The real log is fetched HERE, when the panel opens,
  // because it was 105,310 B of an 844 KB tree payload on every 6 s poll for
  // a panel that is usually closed (MEASURED 2026-09-03).
  //
  // ⚠ THE PREVIEW IS THE INITIAL PAINT, NOT A BLANK. `full ?? preview` means
  // opening the panel shows the newest mail immediately and then fills in;
  // it must never show an empty mailbox that has mail in it.
  const [full, setFull] = useState<{ rows: OrgInboxEntry[]; total: number } | null>(null)
  // ⚠ THE ORG LOG IS WINDOWED AT 100, so a reference to an older row landed
  // on 'not in this folder' — a claim about the message made from a slice.
  // One id, asked once, only when that happens.
  const orgLookup = useCallback(
    (id: string) => getMailById(slug, 'org', id).then((r) => r.mail as MailRow | null),
    [slug])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let dead = false          // a close mid-flight must not set state
    setLoadErr(null)
    getOrgInbox(slug)
      .then((r) => { if (!dead) setFull({ rows: r.entries, total: r.total }) })
      .catch((e: Error) => { if (!dead) setLoadErr(e.message || 'failed') })
    return () => { dead = true }
  }, [slug, reload])
  const entries = full?.rows ?? inbox?.entries ?? []
  // ⚠ LOG LENGTH, never `entries.length`. `entries` is a TAIL of the log
  // whose length now CHANGES mid-session — the preview first, the fetched
  // rows a moment later — so every count and every boundary below is kept in
  // log coordinates and converted at the point of use. Deriving any of them
  // from the rendered slice would silently move the unread line when the
  // fetch landed.
  const logLen = full?.total ?? inbox?.total ?? entries.length
  const hubsVisible = (net?.hubs ?? []).some((h) => !h.hidden)
  // the org inbox tracks read state as ONE high-water mark over the log — the
  // tail beyond it renders as unread; any read action clears the whole mark
  //
  // ⚠ These rows come from the TREE payload (a prop), which refreshes on a 6 s
  // heartbeat — so the mark used to sit there for seconds after the read POST
  // had already returned (user bug 2026-08-07, same shape as the user inbox's).
  // `ackLen` is a LOCAL high-water: everything that existed when the read
  // landed is read, whatever the prop still says. Stored as a LENGTH, not a
  // count — a count would subtract against a later `unread` that had grown
  // with new arrivals and silently mark genuinely-new mail read. Set only
  // when the POST RESOLVES (D-089: never arm state on a failed write), and
  // monotone: max() with the server's own mark, so it can only ever agree
  // sooner, never disagree.
  //
  // ⚠ `ackLen` IS A LOG LENGTH, NOT A ROW COUNT, since 2026-09-03. It used to
  // be `entries.length` at the moment of the read, which was the same thing
  // only because `entries` was always the whole (capped) log. Now the panel
  // opens on a 3-row preview and fills in, so a read acked during that window
  // would have stored 3 and then re-marked ninety-odd rows unread the instant
  // the fetch landed — the exact bug this mechanism exists to prevent.
  const [ackLen, setAckLen] = useState(0)
  // the first UNREAD position, in log coordinates
  const unreadFrom = Math.max(logLen - (inbox?.unread ?? 0), ackLen)
  // …converted to an index into the rendered tail. Equivalent to the old
  // expression whenever `entries` is the whole log, and correct when it is
  // not — row `i` sits at log index `logLen - entries.length + i`.
  const readFrom = unreadFrom - logLen + entries.length
  const rows: MailRow[] = entries.map((e, i) => ({
    id: e.id, at: e.at, body: e.body, from: e.peer, to: e.peer, _by: e.by,
    kind: e.dir === 'in' ? 'message' : 'reply', _wait0: i >= readFrom,
    _state: e.state, _state_at: e.state_at, _tries: e.tries, _err: e.last_err,
    attachments: e.attachments?.map((a) => ({ ...a, path: a.name })),
    relationship: e.dir === 'in'
      ? 'outside party — addressed to the whole org' : undefined,
    // the quote of what it answers; a bare hub reference (a message this
    // org never had) shows nothing
    reply_to: e.reply_to?.gist ? { id: e.reply_to.id ?? '', kind: 'mail', box: 'org', org: slug,
      from: e.reply_to.from ?? '', at: e.reply_to.at ?? '', gist: e.reply_to.gist } : undefined,
    replies: e.replies,
  }))
  const inn = rows.filter((r) => r.kind === 'message')
  const out = rows.filter((r) => r.kind === 'reply')
  const markRead = () => {
    if (!inbox?.unread) return
    const len = logLen                  // captured BEFORE the round trip
    orgInboxRead(slug).then(() => setAckLen((n) => Math.max(n, len)))
      .catch(() => {})                  // a failed write arms nothing (D-089)
  }
  // F-06: the @net: delivery ladder glyph — ▫ queued · ✓ sent (hub custody)
  // · ✓✓ delivered · ✓✓ read (green). "Delivered, not yet read" is the
  // diagnostic that matters (peer down/busy) — the tooltip says it plainly.
  const glyph = (m: MailRow) => {
    if (!m._state) return null
    // §10: a queued row whose wire tries keep failing says so — the ⚠ and
    // its reason were previously trapped in net_spool where nothing reads
    if (m._state === 'queued' && m._err) {
      return <span className="net-state stuck"
        title={`delivery failing (${m._tries ?? '?'} tries) — ${m._err}. `
          + 'Retries continue; a stale address fails forever — check the '
          + 'recipient on the mailservers tab'}> ⚠</span>
    }
    const g = m._state === 'queued' ? '▫'
      : m._state === 'sent' ? '✓' : '✓✓'
    const tip = m._state === 'queued' ? 'queued — not yet at the hub'
      : m._state === 'sent' ? 'at the hub — the peer has not fetched it yet'
      : m._state === 'delivered'
        ? `delivered ${fmtShort(m._state_at)} — no agent has read it yet`
        : 'read — a peer agent\'s turn consumed it'
    return <span className={'net-state' + (m._state === 'read' ? ' read' : '')}
      title={tip}> {g}</span>
  }
  const holderChip = (h: string, dim = false) => (
    <span key={h} className={'badge ' + (dim ? 'dim' : 'free')}>
      <HearingIcon fontSize="inherit" />{h}
      <button className="chip-x" title="revoke this inbox audience"
        onClick={() => audienceAction(slug, 'revoke', h, EXTERN)
          .then(() => toast([`org-inbox audience for ${h} rescinded`]))
          .catch((e: Error) => toast([`error: ${e.message}`]))}>
        <CloseIcon fontSize="inherit" /></button>
    </span>
  )
  return (
    <PinFrame kind="org-inbox" title="The org inbox" panel="settings wide"
      close={close}>
        <h3><PublicIcon fontSize="inherit" /> The org inbox</h3>
        {hubsVisible && (
          <div className="adv-tabs">
            <button className={'adv-tab' + (tab === 'mail' ? ' on' : '')}
              onClick={() => setTab('mail')}>mail</button>
            <button className={'adv-tab' + (tab === 'servers' ? ' on' : '')}
              onClick={() => setTab('servers')}>mailservers</button>
          </div>
        )}
        {tab === 'mail' ? (<>
          <TransferPanel slug={slug} />
          <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <AudienceFold
              ids={holders.filter((h) => map.get(h)?.state === 'live')}
              label="org inbox audience holders"
              // One holder is the org's standing safety rule. Folding must
              // save space, never make a second external-mail recipient read
              // as ordinary: the count remains visible and becomes a warning.
              alert={holders.filter((h) => map.get(h)?.state === 'live').length > 1}
              render={(h) => holderChip(h)} />
            <RetiredFold
              ids={holders.filter((h) => map.get(h)?.state !== 'live')}
              render={(h) => holderChip(h, true)} />
            <span className="dim" style={{ fontSize: 11.5 }}>
              {holders.length === 0
                ? 'inbound mail auto-grants the senior top-level agent — or drag an agent onto the mailbox to choose who reads it'
                : 'these agents read and answer outside mail — drag an agent onto the mailbox to add one'}
              {/* D-125 ④: granting stays drag-only by explicit ruling — the
                  tap path was offered and not taken, so the compact gap is
                  SURFACED here rather than papered over */}
              {isMobile && ' (dragging needs the desktop view)'}
            </span>
          </div>
          {/* the SAME webmail interface as every other inbox (user ruling) —
              folders + list + reading pane; only the outbound sender
              attribution differs */}
          <div className="mailwrap">
            <MailFolders folder={folder} setFolder={setFolder}
              unread={inn.filter((r) => r._wait0).length} />
            {/* ⚠ THE MAILBOX IS NEVER SILENTLY SHORT. The list below shows
                the tree's preview until the full log arrives, so a slow
                fetch reads as "the newest few, still loading" rather than
                as a mailbox that lost its history. A FAILED fetch says so
                and offers a retry — the one outcome that must never look
                like an empty inbox. */}
            {loadErr !== null && (
              <div className="mailload err" role="alert">
                showing the newest {entries.length} only — the rest of the
                mailbox could not be loaded ({loadErr}){' '}
                <button className="linkish"
                  onClick={() => setReload((n) => n + 1)}>retry</button>
              </div>
            )}
            {loadErr === null && full === null && logLen > entries.length && (
              <div className="mailload" role="status">
                loading {logLen - entries.length} older message
                {logLen - entries.length === 1 ? '' : 's'}…
              </div>
            )}
            <div className="mailpane">
              {folder === 'inbox'
                ? <MailList org={slug} pending={inn.filter((r) => r._wait0)}
                    collapsible
                    delivered={inn.filter((r) => !r._wait0)}
                    waitLabel="unread" onRead={markRead} jumpTo={jumpTo}
                    jumpSeq={jumpSeq} refs={refs} lookup={orgLookup} toast={toast}
                    refOf={(m) => m.id ? refToken({ kind: 'mail', org: slug, box: 'org', id: m.id }) : null}
                    /* ⚠ AN INCOMING ORG-INBOX SENDER IS EXTERNAL BY
                       PROVENANCE, AND A NAME MATCH IS NOT EVIDENCE OTHERWISE.
                       These rows came from OUTSIDE this org, so the peer is an
                       outside party even when it spells itself exactly like
                       one of our agents — an external `luna-reserve` is not
                       our `luna-reserve`, and resolving against `map` would
                       hand it our agent's model chip and a jump into our tree.
                       Hub addresses (@net:/@org:) render as hub contact links.
                       (The OUTGOING side below differs:
                       `_by` is recorded locally as the agent that sent, so it
                       stays eligible.) */
                    sender={(id) => (id.startsWith('@net:') || id.startsWith('@org:')) ? <HubContactChip address={id} /> : <b>{id}</b>} />
                : <MailList org={slug} delivered={out} outgoing compoundHeader jumpTo={jumpTo}
                    collapsible
                    jumpSeq={jumpSeq} refs={refs} lookup={orgLookup} toast={toast}
                    rowMark={glyph}
                    /* the list row names the RECIPIENT only — the pane's
                       "@agent as @org → @recipient" line is three identities
                       and does not belong in a row. */
                    rowSender={(id) => (id.startsWith('@net:') || id.startsWith('@org:')) ? <HubContactChip address={id} /> : <b>{id}</b>}
                    sender={(id, m) => {
                      const byIsLocalAgent = Boolean(m?._by && map.has(m._by))
                      return (
                        /* outbound attribution (user spec): @agent as @org → @recipient */
                        <span className="org-mail-attribution">
                            {byIsLocalAgent ? (
                              <AgentLink id={m!._by!} label={'@' + m!._by!}
                                tier={map.get(m!._by!)?.tier}
                                onFocus={onFocusAgent
                                  ? (id) => { closeIfCentred('org-inbox', close, slug); onFocusAgent(id) }
                                  : undefined} />
                            ) : (
                              // not an agent of this org — the sigil and the
                              // recorded text, with nothing inferred
                              <span>{m?._by ? `@${m._by}` : '@?'}</span>
                            )}
                          <span className="org-mail-via"><span className="dim">as </span><b>@{slug}</b></span>
                          <span className="org-mail-recipient"><span className="dim">→ </span>
                            {(id.startsWith('@net:') || id.startsWith('@org:')) ? <HubContactChip address={id} /> : <b>{id}</b>}
                            {m && glyph(m)}
                          </span>
                        </span>
                      )
                    }} />}
            </div>
          </div>
        </>) : (
          <NetSection net={net} />
        )}
        <div className="row">
          <span className="spacer" />
          <button onClick={close}>close</button>
        </div>
    </PinFrame>
  )
}

// ---- F-06: every mailserver, its status, and all clients on each ----
function NetSection({ net }: { net?: TreePayload['net'] }) {
  return (
    <div className="oi-net">
      {net?.slug && <div className="dim" style={{ paddingBottom: 4 }}>
        this org is <b>{net.slug}</b></div>}
      {(net?.hubs ?? []).filter((h) => !h.hidden).map((h) => (
        <div key={h.id} className="oi-hub">
          <div className="oi-hub-head">
            <span className={'oi-dot' + (h.connected ? ' ok' : '')} />
            <b>{h.name || 'unnamed hub'}</b>
            <span className="dim mono-sm">{h.address}</span>
            <span className="dim">
              {h.connected ? `connected · hub version ${h.version || 'unknown'}` : h.enabled
                ? (h.error ? `retrying — ${h.error}` : 'connecting…')
                : 'disabled'}
              {h.queued > 0 ? ` · ${h.queued} queued outbound` : ''}
            </span>
            {(h.stuck ?? 0) > 0 && (
              <span className="oi-stuck" title={h.stuck_err}>
                ⚠ {h.stuck} failing — {h.stuck_err}
              </span>
            )}
          </div>
          {h.roster.length > 0 && (() => {
            // FR-11 parity in-app: group by ORIGIN — the slug's username
            // segment, shared by every org and session registered from one
            // machine profile — so "who is this cluster of clients" reads
            // at a glance, same as the hub's own web UI
            const groups = new Map<string, typeof h.roster>()
            for (const r of h.roster) {
              const origin = r.slug.split('.')[1] ?? '?'
              groups.set(origin, [...(groups.get(origin) ?? []), r])
            }
            return [...groups.entries()].sort().map(([origin, rs]) => (
              <div key={origin}>
                <div className="oi-origin">{origin} · {rs.length}</div>
                <div className="oi-roster">
                  {rs.map((r) => (
                    <span key={r.slug} className="oi-peer"
                      title={(r.blurb || '') + (r.last_seen
                        ? ` · last seen ${fmtShort(r.last_seen)}` : '')
                        + ' · reachable via: '
                        + (r.transports ?? ['net']).join(', ')}>
                      <span className={'oi-dot' + (r.online ? ' ok' : '')} />
                      {r.org_name || r.slug.split('.')[0]}
                      {(r.kind === 'chat' || r.kind === 'person') &&
                        <span className="dim"> ({r.kind})</span>}
                      <span className="dim mono-sm">·{r.slug.split('.').pop()}</span>
                      <span className="dim"> {(r.transports ?? ['net']).join('·')}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))
          })()}
          {h.connected && !h.roster.length &&
            <div className="dim pad-s">no other orgs on this hub yet</div>}
        </div>
      ))}
    </div>
  )
}
