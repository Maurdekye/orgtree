import { UrgentAgentOptions, type UrgentAgentMail } from './dnd'
import { resizeComposer } from '../composerautosize'
import { useDndRecipients } from '../nodemetadata'
// canvas/projectdesk.tsx — the PROJECT DESK (docs/rust-engine/
// PROJECT-NODES.md; user 2026-10-17 19:38Z–20:10Z). A focused project card,
// and a pinned project window, show this desk in the agent desk's frame and
// header. A project takes no turns, so its main tab is not a chat: it holds
// a large editor for its description, rendered as Markdown until it is focused
// and edited as monospace text (user 20:06Z). Beside it are the agent desk's
// three other tabs with the agent desk's own views, scoped to the project:
// inbox, docket (the items attached to it) and presented (the documents
// presented under it) (user 20:07Z). The header counts its agents, active out
// of hired, with the spinner while any is active (20:08Z), and has halt all,
// dissolve project (20:09Z) and the settings gear (20:09:45Z). The chat
// desk's jump cards, up to its parent and down to its members, stay on every
// tab as on the agent desk (user 2026-10-19 19:58Z).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import PushPinIcon from '@mui/icons-material/PushPinOutlined'
import type { ToastFn, TreePayload, TurnStat } from '../types'
import type { ReplyTarget } from '../generated/events'
import { ArrowUpIcon, AttachIcon, AutorenewIcon, CampaignIcon, CloseIcon, FileIcon, MailIcon, NotificationsActiveIcon, NotificationsIcon, SettingsIcon } from '../icons'
import { broadcastMessage, fileUrl, retractMail, sendMessage, uploadFile } from '../api'
import { useComposerEnter } from '../enterkey'
import { readHistory, recordSent, type HistoryEntry } from '../composerhistory'
import { draftKey, readAttachments, storeAttachments, type DraftAttachment } from '../draftstore'
import { appendReplyTarget, readReplies, replyFromRow, storeReplies, type ReplyContext } from '../eventReply'
import { isChatActive, isNoticeArmed, registerChat, setActiveChatKey, setNoticeArmed, toggleNoticeArmed, unregisterChat, useNoticeArmed } from '../noticestore'
import { setButtonAgent } from '../buttoncolours'
import { ago, md, subtreeDocCount, subtreeDocs, upJumpTargets, USER } from './shared'
export { subtreeDocCount }
import type { CanvasNode, OpFn } from './shared'
import { InboxView } from './mail'
import { ReplyPreview } from './replypreview'
import { AttachThumb, fmtBytes, isImg } from './img'
import { useWorkItems } from './useworkitems'
import { actionableTeamCount, AgentDocketView, itemActorIds, teamItems, useNodeFacts } from './docket'
import { AgentGalleryView } from './gallery'
import { PanelCorner, revealAgentPanelTab, useAgentSurfaceRoutes } from './panelcorner'
import { AgentTeamView, liveTeamCount } from './team'
import { PopoutButton, PopoutWindowControls, useSurface } from '../popout'
import type { RefRoutes } from './reflinks'
import { ageClockNow, DeskReportRow, HeldAudienceChips, LastTurnAge, NavChip, subscribeAgeClock } from './desk'
import { PresentationCard, recentDocumentChips } from './docs'
import { DocIcon } from '../icons'
import { subtreeAgents } from './bulkcompact'
import { focusComposerBackground } from '../composerfocus'
import { AgentBatchHaltConfirm, AgentRetireConfirm } from './agentmenu'
import { agentNavProps } from './agentnav'
import { useAgentMentions, useDeskMentionScope, useOrgMentionCandidates } from './agentmentions'
import { openFallbackObjectMenu, useContextMenu } from './contextmenu'
import { closeIfCentred, PinFrame } from './modalpin'
import { AgentLink, AgentName, nodeTierOf } from './identity'
import type { PinRect } from './pins'
import { ConfirmModal } from './modals'
import { projectSlotState, slotCount, slotHeaderText, slotsFull } from './slots'
import { SlotsView } from './slotsdesk'
import { DeadLettersView } from './deaddesk'
import { ListenersView } from './listenersdesk'
import { eventListenersOn, listenerCards, mailListenerState, mailQueueCard, projectListenerState, queueAckMode } from './listeners'
import { MailListenersView } from './maillisteners'
import { MailQueueJoin } from './mailqueuejoin'
import { InboxNoListeners, inboxListened } from './inboxwarning'
import { DeskJumpCards, superiorKept } from './deskjumpcards'
import { DeskDocsStrip, DeskHead, DeskMetaRow, DeskModalShell, DeskTabs, deskTabLabel } from './deskshell'
import { useDeskMemory } from './desktabs'

export const PROJECT_DESK_TABS = ['desk', 'inbox', 'docket', 'presented', 'team'] as const
/** the Slots tab joins them while the project has a slot count (user 2026-10-18) */
export type ProjectDeskTab = typeof PROJECT_DESK_TABS[number] | 'slots' | 'dead' | 'listeners'
type Tab = ProjectDeskTab
const ALL_TABS: readonly Tab[] = [...PROJECT_DESK_TABS, 'slots', 'dead', 'listeners']

/** The tabs a project desk offers now, in order. Team while a live node hangs
 *  directly under it, the agent desk's rule; Slots while it has a slot count,
 *  which is a setting (user 2026-10-19 21:20:24Z); Dead letters while it holds
 *  open ones; Listeners exactly while the project's event-listeners setting is
 *  on (user 2026-10-20 10:50Z, replacing "from the first registered listener,
 *  for good" of 06:22Z): an agent's first listener switches it on, a superior
 *  switches it either way. The project card's Team, Slots and Listeners
 *  shortcuts read this same list (user 2026-10-20 09:24Z), so a card never
 *  offers a tab its desk does not have. */
export function projectDeskTabs(node: CanvasNode, map: Map<string, CanvasNode>): ProjectDeskTab[] {
  return [...PROJECT_DESK_TABS, ...(slotCount(node) > 0 ? ['slots' as const] : []),
    ...((node.dead_letters ?? 0) > 0 ? ['dead' as const] : []), ...(eventListenersOn(node) ? ['listeners' as const] : [])]
    .filter((v) => v !== 'team' || liveTeamCount(map, node.id) > 0)
}
/** the Mail tab's folders (ProjectInbox) */
const MAIL_FOLDERS = ['inbox', 'sent', 'listeners'] as const

export interface ProjectDeskProps {
  node: CanvasNode
  slug: string
  tree: TreePayload
  map: Map<string, CanvasNode>
  op: OpFn
  toast: ToastFn
  refs: RefRoutes
  /** a pinned window's body: the desk unscaled, as DeskChat's `bare` */
  bare?: boolean
  onJump?: (id: string) => void
  /** the gear: the project's settings (ProjectConfig) */
  onConfig?: () => void
  /** pin this desk as a window (absent: no pin button) */
  onPin?: () => void
  /** open this desk in a window of its own: the agent desk's pop-out button
   *  (user 2026-10-18 07:15Z). Inside a movable surface (the modal, or the
   *  window itself) the frame's title bar carries it instead. */
  onPopout?: () => void
  /** open a presented document (the header's presentation strip) */
  onOpenDoc?: (id: string) => void
  /** hide an explicitly revealed retired project again (hide-retired
   *  setting), as an agent desk's `dismiss` does */
  onDismiss?: () => void
}

/** The agents under a project, nested projects crossed but not counted:
 *  hired = live agents, active = those with a turn executing — the org list's
 *  n/m rule (shell/orgrows.tsx), for this subtree only. */
export function projectCounts(node: CanvasNode): { active: number; hired: number; agents: CanvasNode[] } {
  const agents = subtreeAgents(node)
  return { active: agents.filter((a) => a.busy).length, hired: agents.length, agents }
}


/** The project's LAST ACTIVITY (user 2026-10-17 22:21Z): active while any
 *  live agent under it runs a turn; otherwise the newest turn end among them,
 *  nested projects included; null when none has ever run one. */
export function projectLastActivity(node: CanvasNode): { active: boolean; turn: TurnStat | null; since?: string | null } {
  const agents = subtreeAgents(node)
  if (agents.some((a) => a.busy)) return { active: true, turn: null, since: activeSince(agents) }
  let newest: TurnStat | null = null
  for (const a of agents) {
    const t = a.turns?.[a.turns.length - 1]
    if (t && (!newest || Date.parse(t.at) > Date.parse(newest.at))) newest = t
  }
  return { active: false, turn: newest }
}

/** When the project became active (user 2026-10-18 07:43Z): its first agent
 *  turning active after all were idle. The earliest turn still running, walked
 *  back through every finished turn that overlapped the run (`at` is a turn's
 *  end, `ms` its length); a turn that ended before the run began does not
 *  count. Null when no running turn says when it started. */
function activeSince(agents: CanvasNode[]): string | null {
  const running = agents.filter((a) => a.busy && a.inflight_at).map((a) => Date.parse(a.inflight_at!))
  if (!running.length) return null
  let start = Math.min(...running)
  const done = agents.flatMap((a) => a.turns ?? []).filter((t) => t.ms)
    .map((t) => ({ end: Date.parse(t.at), begin: Date.parse(t.at) - t.ms! }))
  for (let moved = true; moved;) {
    moved = false
    for (const t of done) if (t.end >= start && t.begin < start) { start = t.begin; moved = true }
  }
  return new Date(start).toISOString()
}

/** "Active <age>" / "Idle <age>", in the agent card's own words and style
 *  (user 2026-10-18 07:42Z-07:43Z; it said "active now" / "quiet for" before),
 *  on the desk header and the middle-zoom card beside the activity chip. */
export function ProjectLastActivity({ node }: { node: CanvasNode }) {
  useSyncExternalStore(subscribeAgeClock, ageClockNow, ageClockNow)
  const { active, turn, since } = projectLastActivity(node)
  if (active) {
    return <span className="project-last-activity" title="an agent under this project is running a turn">
      <span className="sq-idle working active">Active</span>
      <span className="sq-idle-time" title={since ? 'active since ' + since : undefined}>{since ? ago(since) : '—'}</span>
    </span>
  }
  if (!turn) return null
  return <span className="project-last-activity" title="since the newest turn of any agent under this project ended">
    <span className="sq-idle idle">Idle</span>
    <LastTurnAge turn={turn} variant="inline" /></span>
}

/** The project's agents as the app header's activity chip shows an org's
 *  (shell/treeinfo.tsx ActiveAgentSummary): the spinner while any is active,
 *  then active/hired. On the project desk's header and the project card at
 *  middle zoom (user 2026-10-17 20:08Z, 21:21Z). */
export function ProjectActivity({ node }: { node: CanvasNode }) {
  const { active, hired } = projectCounts(node)
  return (
    <span className="project-activity" title="active / hired agents under this project">
      {/* the spinner's slot only while it spins: an idle chip keeps no gap
          (coordinator visual review 2026-10-17 23:25Z) */}
      {active > 0 && <span className="org-activity">
        <span className="working-ct"
          title={`${active} agent${active === 1 ? '' : 's'} under this project active — a turn executing now`}>
          <AutorenewIcon fontSize="inherit" className="cc-spin" /></span>
      </span>}
      <span className="project-counts org-counts dim">{active}/{hired}</span>
    </span>
  )
}

/** Where in `source` the Markdown rendering's text `shown` ends: each visible
 *  character is matched to its next occurrence in the source, so markup
 *  (`#`, `**`, link targets) is stepped over. A character the source lacks
 *  is skipped. Rough by design (user 2026-10-18 07:14Z: "roughly where you
 *  clicked"). */
export function sourceOffset(source: string, shown: string): number {
  let at = 0
  for (const c of shown) {
    if (/\s/.test(c)) continue
    const i = source.indexOf(c, at)
    if (i >= 0) at = i + 1
  }
  return at
}

/** The rendered text before the point (x, y) inside `root`, or null when the
 *  point is outside it or the browser cannot say. */
function shownBefore(root: HTMLElement, x: number, y: number): string | null {
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null = null
  let offset = 0
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (pos) { node = pos.offsetNode; offset = pos.offset } else {
    const r = doc.caretRangeFromPoint?.(x, y)
    if (r) { node = r.startContainer; offset = r.startOffset }
  }
  if (!node || !root.contains(node)) return null
  const before = doc.createRange()
  before.selectNodeContents(root)
  before.setEnd(node, offset)
  return before.toString()
}

/** The description editor (user 2026-10-17 20:06Z): Markdown while it is not
 *  focused, raw monospace text while it is. A click opens the editor with the
 *  caret at about the clicked spot (user 2026-10-18 07:14Z). Leaving the editor saves a change
 *  with `set_description`; Escape drops the edit. */
function DescriptionEditor({ node, op, toast, editable }: {
  node: CanvasNode; op: OpFn; toast: ToastFn; editable: boolean
}) {
  const saved = node.charter ?? ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(saved)
  const box = useRef<HTMLTextAreaElement | null>(null)
  // the caret a click asked for, taken on mousedown, before focus opens the editor
  const caret = useRef<number | null>(null)
  useEffect(() => { if (!editing) setDraft(saved) }, [saved, editing])
  useEffect(() => {
    if (!editing) return
    const el = box.current
    el?.focus({ preventScroll: true })
    if (el && caret.current !== null) el.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [editing])
  const commit = () => {
    setEditing(false)
    if (draft.trim() === saved.trim()) return
    op({ op: 'set_description', node: node.id, description: draft })
        .then(() => toast([`Summary of ${node.id} saved`]))
      .catch(() => setDraft(saved))   // `op` toasts the refusal
  }
  if (editing) {
    return <textarea ref={box} className="project-description-edit" value={draft} spellCheck={false}
      aria-label={`Summary of project ${node.id}`}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(saved); setEditing(false) }
      }} />
  }
  const empty = !saved.trim()
  return <div className={'project-description-md' + (empty ? ' dim' : '')} tabIndex={editable ? 0 : -1}
    role={editable ? 'textbox' : undefined} aria-label={`Summary of project ${node.id}`}
    title={editable ? 'click to edit the Summary; it is the standing charter of every agent under this project' : undefined}
    onMouseDown={(e) => {
      if (!editable || empty || e.button !== 0) return
      const shown = shownBefore(e.currentTarget, e.clientX, e.clientY)
      caret.current = shown === null ? null : sourceOffset(saved, shown)
    }}
    onFocus={() => { if (editable) setEditing(true) }}
    onClick={() => { if (editable) setEditing(true) }}
    {...(empty ? { children: editable ? 'Add a Summary: every agent under this project gets it as a standing charter.' : 'No Summary.' }
      : { dangerouslySetInnerHTML: md(saved) })} />
}

/** The project desk's message box (user 2026-10-18 07:33Z, 07:43Z): the
 *  agent composer's notice toggle (Alt+N, one message at a time), attach
 *  button and Enter-key rule. By default a send is ONE mail to the project's
 *  own mailbox, the fair-queue project mail one agent under it claims
 *  (`sendMessage` to the project node). With the megaphone on (it stays on
 *  until turned off, and the box's border brightens) a send reaches every
 *  live agent under the project, nested projects included
 *  (`broadcastMessage`). Attachments upload into the project's own uploads
 *  folder and ride either kind of send. No slash commands: a project has no
 *  CLI. */
function ProjectComposer({ node, slug, tree, map, toast, members, recipients, bare, replies, onReplies, replyAvailable,
  onLocateReply, docTitle, focusRequest, onRegisterMention, onRegisterAttach }: {
  node: CanvasNode; slug: string; tree: TreePayload; map: Map<string, CanvasNode>; toast: ToastFn; members: number; recipients: CanvasNode[]
  /** a window or another host's frame: the box does not take focus on open */
  bare?: boolean
  /** the presentations this message replies to, kept with the draft (ProjectDesk owns them) */
  replies: ReplyContext[]
  onReplies: (next: ReplyContext[]) => void
  replyAvailable: (r: ReplyContext) => boolean
  onLocateReply: (r: ReplyContext) => void
  docTitle: (id: string) => string | undefined
  focusRequest: number
  onRegisterMention?: (capture: ((agentId: string) => (() => void) | null) | null, noteRightDown: () => void) => void
  /** the desk's drop zone hands its files to the box's own upload */
  onRegisterAttach?: (attach: ((file: File) => void) | null) => void
}) {
  const messageDraftKey = draftKey(slug, `project:${node.id}`, 0)
  // the notice toggle's key in the agent desk's store (noticestore.ts): one
  // armed state per desk, the same in every view of it, kept across closing
  // and reopening it, with Alt+N anywhere inside the desk (G12)
  const chatKey = `${slug}/${node.id}`
  const [text, setTextState] = useState(() => {
    try { return localStorage.getItem(messageDraftKey) || '' } catch { return '' }
  })
  const setText = (next: string) => {
    setTextState(next)
    try {
      if (next) localStorage.setItem(messageDraftKey, next)
      else localStorage.removeItem(messageDraftKey)
    } catch { /* best-effort browser persistence, like the agent composer */ }
  }
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => { if (focusRequest) textareaRef.current?.focus({ preventScroll: true }) }, [focusRequest])
  const [sentHistory, setSentHistory] = useState<HistoryEntry[]>(() => readHistory(slug, node.id))
  const [histAt, setHistAt] = useState<number | null>(null)
  const histStash = useRef('')
  const histCaret = useRef(false)
  // staged attachments ride the draft, as the agent composer's do: closing
  // and reopening the desk keeps them (G9)
  const [attached, setAttachedRaw] = useState<DraftAttachment[]>(() => readAttachments(messageDraftKey))
  const setAttached = useCallback((next: DraftAttachment[] | ((previous: DraftAttachment[]) => DraftAttachment[])) => {
    setAttachedRaw((previous) => {
      const value = typeof next === 'function' ? next(previous) : next
      storeAttachments(messageDraftKey, value)
      return value
    })
  }, [messageDraftKey])
  const notice = useNoticeArmed(chatKey)
  useEffect(() => {
    registerChat(chatKey)
    return () => { unregisterChat(chatKey) }
  }, [chatKey])
  const toggleNotice = () => { setActiveChatKey(chatKey); toggleNoticeArmed(chatKey) }
  const [megaphone, setMegaphone] = useState(false)
  const [urgentMail,setUrgentMail]=useState<UrgentAgentMail | undefined>()
  const dndRecipients=useDndRecipients(slug,recipients)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const enterKey = useComposerEnter()
  const can = node.state === 'live' && (!megaphone || members > 0)
  // nobody listens on the inbox: say so before the user sends (user 2026-10-20 11:04Z)
  const unheard = node.state === 'live' && !megaphone && !inboxListened(node.id, tree.watchdogs ?? [])
  const mentionCandidates = useOrgMentionCandidates(slug, tree, map)
  const mentions = useAgentMentions({
    value: text,
    onChange: setText,
    inputRef: textareaRef,
    candidates: mentionCandidates,
    disabled: !can,
  })
  onRegisterMention?.(can ? mentions.captureMention : null, mentions.noteRightClickDown)
  const attach = (file: File) => {
    uploadFile(slug, node.id, file)
      .then((r) => setAttached((a) => [...a, { name: file.name, path: r.path, bytes: r.bytes }]))
      .catch((e: Error) => toast([`upload error: ${e.message}`]))
  }
  onRegisterAttach?.(can ? attach : null)
  // Shared with the agent composer: thirty extra lines beyond the base rows,
  // also following width changes that rewrap the draft (G8).
  const grow = useCallback(() => {
    resizeComposer(textareaRef.current)
  }, [])
  useLayoutEffect(grow, [text, grow])
  const composerRO = useRef<ResizeObserver | null>(null)
  const attachComposer = useCallback((el: HTMLTextAreaElement | null) => {
    composerRO.current?.disconnect()
    composerRO.current = null
    textareaRef.current = el
    if (!el) return
    // the canvas desk takes the caret when it opens, as the agent desk's
    // does (G13); a window or another host's frame (bare) does not
    if (!bare && !el.dataset.f) {
      el.dataset.f = '1'
      el.focus({ preventScroll: true })
    }
    if (typeof ResizeObserver === 'undefined') return
    let width = -1
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      grow()
    })
    composerRO.current = ro
    ro.observe(el)
  }, [bare, grow])
  // Alt+N (notice) and Alt+B (broadcast) anywhere inside the desk, as the
  // agent desk's Alt+N: outside every desk they go to the active one
  useEffect(() => {
    const win = textareaRef.current?.ownerDocument.defaultView ?? window
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.altKey) return
      const key = e.key.toLowerCase()
      if (key !== 'n' && key !== 'b') return
      const root = textareaRef.current?.closest('.project-desk')
      if (!root) return
      const target = e.target as Element | null
      const active = root.ownerDocument.activeElement
      const inside = (!!target && root.contains(target)) || (!!active && root.contains(active))
      if (!inside) {
        if (typeof target?.closest === 'function' && target.closest('.desk-control-scope, .desk-bare, .desk-over')) return
        if (typeof active?.closest === 'function' && active.closest('.desk-control-scope, .desk-bare, .desk-over')) return
        if (!isChatActive(chatKey)) return
      }
      e.preventDefault()
      e.stopImmediatePropagation?.()
      setActiveChatKey(chatKey)
      if (key === 'n') toggleNoticeArmed(chatKey)
      else if (node.state === 'live' && members > 0) setMegaphone((v) => !v)
    }
    win.addEventListener('keydown', onKey)
    return () => win.removeEventListener('keydown', onKey)
  }, [chatKey, node.state, members])
  const send = () => {
    if (!can || busy || (!text.trim() && attached.length === 0)) return
    setBusy(true)
    const asNotice = isNoticeArmed(chatKey)
    const files = attached.map((a) => a.path)
    // the replies' typed document targets: the engine resolves them for each
    // recipient (http/nodes.rs), so a broadcast keeps them too
    const targets: ReplyTarget[] = replies.flatMap((r) => r.docId ? [{ kind: 'document' as const, org: r.org, id: r.docId }] : [])
    // a failed audience grant leaves the mail delivered: say so (coordinator 09:43Z)
    const grant = (g?: { granted: boolean; error?: string } | null) => g && !g.granted
      ? [`sent, but the project's user audience couldn't be granted${g.error ? ` (${g.error})` : ''}`] : []
    const done = (lines: string[]) => {
      if (recordSent(slug, node.id, text)) setSentHistory(readHistory(slug, node.id))
      setText(''); setAttached([]); setNoticeArmed(chatKey, false)
      if (replies.length) onReplies([])
      if (megaphone) setMegaphone(false)
      setHistAt(null); histStash.current = ''
      toast(lines)
    }
    ;(megaphone
      ? broadcastMessage(slug, node.id, text, files, asNotice, dndRecipients.length ? urgentMail : undefined,
        targets.length ? targets : undefined).then((r) => done([
        `sent to ${r.sent.length} of ${r.sent.length + r.refused.length} agents under ${node.id}`
          + (asNotice ? ' as a notice' : ''), ...r.refused.map((f) => `${f.to}: ${f.why}`), ...grant(r.audience_grant)]))
      : sendMessage(slug, node.id, text, files, undefined, undefined, asNotice, undefined,
        targets.length ? targets : undefined).then((r) => done([
        `to project ${node.id}${asNotice ? ' as a notice' : ''}: ${r.delivery ?? 'sent'}`, ...grant(r.audience_grant)])))
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setBusy(false))
  }
  const histBack = () => {
    if (!sentHistory.length) return false
    if (histAt === null) histStash.current = text
    const next = histAt === null ? 0 : Math.min(histAt + 1, sentHistory.length - 1)
    const entry = sentHistory[sentHistory.length - 1 - next]
    if (next === histAt || !entry) return false
    setHistAt(next); setText(entry.text); histCaret.current = true
    return true
  }
  const histForward = () => {
    if (histAt === null) return false
    if (histAt === 0) {
      setHistAt(null); setText(histStash.current); histCaret.current = true
      return true
    }
    const next = histAt - 1
    const entry = sentHistory[sentHistory.length - 1 - next]
    if (!entry) return false
    setHistAt(next); setText(entry.text); histCaret.current = true
    return true
  }
  useLayoutEffect(() => {
    if (!histCaret.current) return
    histCaret.current = false
    const el = textareaRef.current
    if (el) el.selectionStart = el.selectionEnd = el.value.length
  }, [text])
  return <>
    {/* the agent composer's reply previews (G11): one per target, a remove
        ✕ on each, "Cancel all replies" for several, Escape on the desk */}
    {replies.map((r) => <ReplyPreview key={`${r.agent}/${r.generation}/${r.eventId}/${r.mailId ?? ''}/${r.docId ?? ''}`}
      reply={r} available={replyAvailable(r)} onLocate={() => onLocateReply(r)}
      onRemove={() => onReplies(replies.filter((x) => x !== r))}
      presentationTitle={r.docId ? docTitle(r.docId) : undefined} />)}
    {replies.length > 1 && <button className="link" onClick={() => onReplies([])}>Cancel all replies</button>}
    {/* staged attachments, an image as its thumbnail, as on the agent desk (G9) */}
    {attached.length > 0 && <div className="attach-row">
      {attached.map((a, i) => (isImg(a.name)
        ? <AttachThumb key={a.path + i} href={fileUrl(slug, node.id, a.path)}
            name={a.name} meta={fmtBytes(a.bytes)}
            onRemove={() => setAttached((x) => x.filter((_, j) => j !== i))} />
        : <span key={a.path + i} className="attach-chip">
            <FileIcon fontSize="inherit" /> {a.name}
            <span className="dim"> {fmtBytes(a.bytes)}</span>
            <button className="chip-x" title="remove from this message"
              onClick={() => setAttached((x) => x.filter((_, j) => j !== i))}><CloseIcon fontSize="inherit" /></button>
          </span>))}
    </div>}
    {unheard && <InboxNoListeners project={node.id} />}
    <div className={'cc-composer project-composer' + (can ? '' : ' off') + (notice ? ' notice-armed' : '')
      + (megaphone ? ' broadcast-armed' : '') + (urgentMail ? ' urgent-armed' : '')} onClick={focusComposerBackground}>
      {mentions.menu}
      <div className="cc-btnstack">
        <button className={'cc-notice-toggle' + (notice ? ' armed' : '')} type="button" disabled={!can}
          aria-label={notice ? 'Notice-send armed: next message arrives as a passive notice' : 'Notice-send: send next message as a passive notice'}
          title={notice ? 'Notice-send armed: the next message arrives as a passive notice, waking nobody (Alt+N)'
            : 'Send the next message as a passive notice, waking nobody (Alt+N)'}
          onClick={toggleNotice}>
          {notice ? <NotificationsActiveIcon fontSize="inherit" /> : <NotificationsIcon fontSize="inherit" />}
        </button>
        <button className="cc-attach" type="button" disabled={!can}
          title="attach a file: every agent under the project gets it" onClick={() => fileRef.current?.click()}>
          <AttachIcon fontSize="inherit" /></button>
      </div>
      <input type="file" ref={fileRef} style={{ display: 'none' }} multiple
        onChange={(e) => { [...e.target.files!].forEach(attach); e.target.value = '' }} />
      <textarea ref={attachComposer} rows={2} value={text} disabled={!can} title={enterKey.hint}
        aria-label={`message every agent under project ${node.id}`}
        placeholder={node.state !== 'live' ? `project ${node.id} is ${node.state}`
          : unheard ? `message project ${node.id}…`
          : !megaphone ? `message project ${node.id}: one agent under it takes it…`
            : `message all ${members} agent${members === 1 ? '' : 's'} under ${node.id}…`}
        onChange={(e) => { setText(e.target.value); grow(); mentions.syncCaret() }}
        onSelect={mentions.syncCaret}
        onClick={mentions.syncCaret}
        onKeyUp={mentions.syncCaret}
        onFocus={() => setActiveChatKey(chatKey)}
        onPaste={(e) => {
          if (e.clipboardData?.files?.length) { e.preventDefault(); [...e.clipboardData.files].forEach(attach) }
        }}
        onKeyDown={(e) => {
          if (mentions.onKeyDown(e)) return
          if (e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); e.stopPropagation(); toggleNotice(); return }
          if (e.altKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); e.stopPropagation(); setMegaphone((v) => !v); return }
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown')
            && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            const el = e.currentTarget
            const from = el.selectionStart ?? 0
            const to = el.selectionEnd ?? 0
            const edge = e.key === 'ArrowUp'
              ? !el.value.slice(0, from).includes('\n')
              : !el.value.slice(to).includes('\n')
            if (from === to && edge && (e.key === 'ArrowUp' ? histBack() : histForward())) {
              e.preventDefault()
              return
            }
          }
          if (enterKey.sends(e)) { e.preventDefault(); send() }
        }} />
      <div className="cc-btnstack">
        <UrgentAgentOptions active={megaphone && dndRecipients.length>0} value={urgentMail} onChange={setUrgentMail} />
        <button className={'cc-broadcast-toggle' + (megaphone ? ' armed' : '')} type="button"
          disabled={node.state !== 'live' || members === 0} aria-pressed={megaphone}
          aria-label={megaphone ? `Megaphone on: messages go to all ${members} agents under ${node.id}`
            : `Megaphone: send to all ${members} agents under ${node.id} instead of the project's inbox`}
          title={members === 0 ? `no agent works under ${node.id} yet`
            : megaphone ? `on: each message goes to all ${members} agents under ${node.id}; click or press Alt+B to send to the project's inbox again`
              : `send to all ${members} agents under ${node.id} at once, instead of the project's inbox that one agent claims (Alt+B)`}
          onClick={() => setMegaphone((v) => !v)}>
          <CampaignIcon fontSize="inherit" />
        </button>
        <button className="cc-send" type="button" title={enterKey.hint}
          disabled={!can || busy || (!text.trim() && attached.length === 0)} onClick={send}>
          <ArrowUpIcon fontSize="inherit" /></button>
      </div>
    </div>
  </>
}

/** The PROJECT'S MAILBOX, one view wherever it shows, as an agent's inbox
 *  tab and its inbox window are one InboxView: the desk's inbox tab and the
 *  inbox window (the menu's Project mailbox, the tab's pin and pop-out) both
 *  have the project mail rows, the listeners folder and the purge button. A
 *  project belongs to no provider, so its unread count wears no provider's
 *  colour (the desk's own tab counts don't either). `retract` offers the
 *  user's own waiting mail back, as the agent desk's inbox tab does (the
 *  engine's retract takes a project's queued mail the same way). */
export function ProjectInbox({ node, slug, tree, map, op, toast, refs, onJump, retract = false, collapsible,
  folderAsk, onPickFolder, jumpTo, jumpSeq, onOpenMail }: {
  node: CanvasNode; slug: string; tree: TreePayload; map: Map<string, CanvasNode>; op: OpFn; toast: ToastFn
  refs?: RefRoutes
  onJump?: (id: string) => void
  retract?: boolean
  collapsible?: boolean
  folderAsk?: { folder: string; seq: number } | null
  /** a folder picked in the folder strip (the desk remembers it) */
  onPickFolder?: (folder: string) => void
  jumpTo?: string | null
  jumpSeq?: number | null
  /** the listeners folder's link to a held job */
  onOpenMail: (id: string) => void
}) {
  const [purging, setPurging] = useState(false)
  const mailListeners = mailListenerState(node.id, tree.watchdogs ?? [])
  const waiting = node.mail_pending ?? 0
  return <>
    {/* waiting mail nobody holds yet can be purged (user 2026-10-18 08:11Z) */}
    {node.state === 'live' && waiting > 0 && <div className="project-queue-tools">
      <button type="button" className="danger" data-action="purge-queue" onClick={() => setPurging(true)}
        title="retract every mail waiting in this project's queue; mail already handed to an agent stays">
        Purge waiting mail</button>
    </div>}
    <InboxView slug={slug} nid={node.id} projectMail unreadCount={node.mail_pending} toast={toast} collapsible={collapsible}
      tierOf={(id) => {
        const n = map.get(id)
        return n?.kind === 'project' ? 'project' : n?.tier
      }} hasAgent={(id) => map.has(id)}
      refs={refs} onFocusAgent={onJump}
      onRetract={retract ? (m) => retractMail(slug, node.id, m.id)
        // rethrow: InboxView's optimistic hide rolls back on rejection
        .catch((e: Error) => { toast([`error: ${e.message}`]); throw e }) : undefined}
      jumpTo={jumpTo ?? null} jumpSeq={jumpSeq ?? null}
      onFolderPick={onPickFolder}
      extraFolders={[{ id: 'listeners', count: mailListeners.armed.length,
        tools: node.state === 'live' ? <MailQueueJoin node={node} state={mailListeners} op={op} toast={toast} /> : undefined,
        render: (rows) => <MailListenersView node={node} state={mailListeners} map={map} onJump={onJump}
          rows={rows} ack={queueAckMode(node)} onOpenMail={onOpenMail} op={op} toast={toast} dogs={tree.watchdogs ?? []} refs={refs} /> }]}
      folderAsk={folderAsk} />
    {purging && createPortal(
      <ConfirmModal title={`purge project ${node.id}'s waiting mail?`}
        body={`${waiting} waiting mail${waiting === 1 ? '' : 's'} will be retracted. `
          + 'Mail already handed to an agent, acked or dead-lettered stays.'}
        confirmLabel="purge" close={() => setPurging(false)}
        onConfirm={() => {
          op({ op: 'purge_mail_queue', node: node.id })
            .then((r) => toast([`purged ${String((r as { purged?: number }).purged ?? 0)} waiting mail from project ${node.id}`]))
            .catch(() => {})
        }} />, document.body)}
  </>
}

export function ProjectDesk({ node, slug, tree, map, op, toast, refs, bare, onJump, onConfig: configProp, onPin, onPopout, onOpenDoc, onDismiss }: ProjectDeskProps) {
  const surface = useSurface()
  // a host that passes no settings handler gets the shell's own opener, so
  // the gear is never missing or dead, as on the agent desk (AgentSurfaceRoutes)
  const surfaceRoutes = useAgentSurfaceRoutes()
  const onConfig = configProp
    ?? (surfaceRoutes?.settings ? () => surfaceRoutes.settings?.(node.id) : undefined)
  // the tab last picked on this desk, and the Mail folder last picked in its
  // folder strip (desktabs.ts, user 2026-10-20 06:22Z)
  const [view, setView] = useDeskMemory<Tab>(slug, node.id, 'tab', 'desk', ALL_TABS)
  const [mailFolder, setMailFolder] = useDeskMemory<string>(slug, node.id, 'mail', 'inbox', MAIL_FOLDERS)
  const teamCount = liveTeamCount(map, node.id)
  // the presentations the next message replies to: the agent composer's reply
  // targets (G11), kept with the composer's draft, so closing the desk or a
  // host switching projects (the Attention panel) never mixes them up
  const replyKey = draftKey(slug, `project:${node.id}`, 0)
  const [replyState, setReplyState] = useState(() => ({ key: replyKey, list: readReplies(replyKey) }))
  const replies = replyState.key === replyKey ? replyState.list : readReplies(replyKey)
  useEffect(() => {
    setReplyState((s) => s.key === replyKey ? s : { key: replyKey, list: readReplies(replyKey) })
  }, [replyKey])
  const setReplies = (list: ReplyContext[]) => { setReplyState({ key: replyKey, list }); storeReplies(replyKey, list) }
  const [replyFocus, setReplyFocus] = useState(0)
  // the desk's drop zone hands files to the composer's upload (G10)
  const dropAttach = useRef<((file: File) => void) | null>(null)
  // the inbox folder the mail card asks for (user 2026-10-19 19:05Z): a new
  // seq is a new click; opening the inbox from its tab forgets it, and the
  // tab opens the folder last picked in its strip instead (user 2026-10-20)
  const [inboxAsk, setInboxAsk] = useState<{ folder: string; seq: number } | null>(null)
  // a mail the listeners folder links to (a held job, user 2026-10-19 19:30Z)
  const [inboxJump, setInboxJump] = useState<{ id: string; seq: number } | null>(null)
  const openInbox = (folder: string) => {
    setInboxAsk((a) => ({ folder, seq: (a?.seq ?? 0) + 1 }))
    setView('inbox')
  }
  const [asking, setAsking] = useState<'halt' | 'unhalt' | 'dissolve' | null>(null)
  const fallbackMenu = useContextMenu(toast)
  const mentionRef = useRef<{
    capture: ((agentId: string) => (() => void) | null) | null
    noteRightDown: (() => void) | null
  }>({ capture: null, noteRightDown: null })
  const mentionScope = useDeskMentionScope(
    (agentId: string) => mentionRef.current.capture?.(agentId) ?? null,
    () => mentionRef.current.noteRightDown?.(),
  )
  // the docket tab: the items attached to this project (slice 2), one poll,
  // as the agent docket modal does
  const [showArchived, setShowArchived] = useState(false)
  const [showBacklog, setShowBacklog] = useState(false)
  const [bump, setBump] = useState(0)
  const [pageFilter, setPageFilter] = useState<import('../workpages').WorkPageOptions>({})
  const workFeed = useWorkItems(slug, view === 'docket' && showArchived, view === 'docket' && showBacklog,
    15000, bump, { ...pageFilter, agent: node.id })
  const work = workFeed.value
  // every item owned by an agent under the project, through nested projects
  // (user 2026-10-17 22:21Z; items no longer attach to projects)
  const mine = useMemo(() => teamItems(work, node.id, tree.roots, showArchived),
    [work, node.id, tree.roots, showArchived])
  const facts = useNodeFacts(slug, tree, useMemo(() => itemActorIds(mine), [mine]))
  const live = node.state === 'live'
  const { agents } = projectCounts(node)
  const allHalted = agents.length > 0 && agents.every((a) => a.halt?.phase === 'halted')
  // up through projects, as the agent desk's up row: the nearest agent
  // superior, then every project between it and this one, outermost first
  // (user 2026-10-17 22:13Z); a pinned window drops the switchboard's card
  const up = onJump ? upJumpTargets(node, map).filter((n) => !(bare && n.id === USER)) : []
  const members = node.children.filter((c) => c.state === 'live')
  const slots = projectSlotState(node.id, slotCount(node), tree.slot_leases ?? [], tree.watchdogs ?? [])
  // its event listeners (cyan cards + the listeners tab) and mail queue
  // (the magenta card), user 2026-10-19
  const listenerState = projectListenerState(node.id, tree.watchdogs ?? [])
  const listenersArmed = listenerState.armed.length
  const listenerHeaderCards = listenerCards(node.id, listenerState)
  const queue = mailQueueCard(node.id, node.mail_pending ?? 0, node.mail_held ?? 0, queueAckMode(node), tree.watchdogs ?? [])
  // ⚠ ONE ROW of header cards on every tab (user 2026-10-19 19:02Z, 19:15Z:
  // "make sure they're all on the same row in the full desk header"): the
  // cyan listener cards, the magenta mail card, the amber slots card and the
  // held audiences. The cards wear the near-zoom badge rules and NOT the
  // generic `.chip`, whose grey (later in styles.css, same specificity)
  // repainted every outlined card.
  const headCards = listenerHeaderCards.length > 0 || !!queue || slots.total > 0
    || (node.audiences_held?.length ?? 0) > 0
  // the superior's cards are NOT among them: they are the agent desk's up row,
  // their own `.desk-nav` under the header on every tab (user 2026-10-19
  // 21:05:53Z "superior jump cards go in a different row than the header
  // cards", 21:06:08Z "same as agent desk headers"); a long row folds only
  // its projects, never the agent superior (user 2026-10-20 09:42Z, 09:50Z)
  const upRow = onJump && up.length > 0 ? <div className="desk-nav">
    <DeskJumpCards ids={up.map((n) => n.id)} keep={superiorKept(up)} label="projects" render={(id) =>
      <NavChip key={id} n={up.find((n) => n.id === id)!} dir="up" onJump={onJump} />} />
  </div> : null
  // the tabs it offers now, by the rules the card's shortcuts share
  const deadLetters = node.dead_letters ?? 0
  const tabs = projectDeskTabs(node, map)
  const shown: Tab = tabs.includes(view) ? view : 'desk'
  // A TAB THE DESK DOES NOT OFFER (no team, slots, dead letters or listeners
  // any more, or remembered from an earlier visit) gives way to Summary, and
  // the desk keeps Summary when the tab comes back: an open desk never
  // changes tab by itself. The agent desk's Team rule, for every tab.
  useEffect(() => {
    if (shown !== view) setView('desk')
  }, [shown, view])
  const count = (tab: Tab) => tab === 'team' ? teamCount : tab === 'inbox' ? node.mail_pending ?? 0
    // the agent badge's rule: actionable tickets owned, here by its agents
    : tab === 'docket' ? actionableTeamCount(mine)
      // its own presentations (point 27, user 2026-10-17 23:28Z)
      : tab === 'presented' ? (node.documents_count ?? node.documents?.length ?? 0)
        : tab === 'dead' ? deadLetters : tab === 'listeners' ? listenersArmed : 0
  const replyToDoc = (doc: { id: string; title: string }) => {
    // the agent desk's presentation reply source (replyToPresentation): the
    // document's event id, its title as the quote, the project as sender
    const source = replyFromRow(slug, node.id, node.generation ?? 0, { event_id: `doc:${doc.id}` },
      `document: ${doc.title || '(untitled)'}`)
    if (!source || !live) return
    try { setReplies(appendReplyTarget(replies, { ...source, sender: node.id, docId: doc.id })) }
    catch (e) { toast([String((e as Error).message)]); return }
    setReplyFocus((v) => v + 1)
  }
  const content = (
    <>
      <DeskHead nodeId={node.id}
        left={<>
            {/* the agent desk's name (G14): plain on the focused desk, which
                is where a click would take you; a link from every other host
                (popped out, the Attention panel) */}
            <AgentName id={node.id} tier="project" nameClass="name" atDestination={!bare}
              onFocus={onJump ? (id: string) => onJump(id) : undefined} nativeTitle={false} />
            <ProjectActivity node={node} />
            <ProjectLastActivity node={node} />
            {!live && <span className="badge dim">{node.state}</span>}
        </>}
        actions={<>
              {live && agents.length > 0 && (
                <button className={allHalted ? '' : 'danger'} data-action="halt-all"
                  title={`${allHalted ? 'release' : 'halt'} all ${agents.length} live agents under this project`}
                  onClick={() => setAsking(allHalted ? 'unhalt' : 'halt')}>
                  {allHalted ? 'unhalt all' : 'halt all'}</button>
              )}
              {live && <button className="danger" data-action="dissolve"
                title="retire the project and every agent under it; context is kept and rehire brings each back"
                onClick={() => setAsking('dissolve')}>dissolve</button>}
              {!live && node.state === 'archived' && <button data-action="restore"
                onClick={() => { void op({ op: 'rehire', node: node.id }).catch(() => {}) }}>restore</button>}
              {!live && onDismiss && (
                <button data-action="dismiss" onClick={onDismiss} title="dismiss — hide this retired project again">
                  dismiss
                </button>
              )}
        </>}
        tabs={<DeskTabs shown={shown} tabs={tabs.map((v) => ({ id: v, label: deskTabLabel(v), count: count(v), showCount: v !== 'slots' }))} onShow={(v) => {
          if (v === 'inbox') { setInboxAsk(null); setInboxJump(null) }
          if (!revealAgentPanelTab(v, slug, node.id, node.generation)) setView(v as Tab)
        }} />}
        rightExtras={<>
            {/* in its own window frame (the modal, pinned or popped out) the
                frame's pop-out, beside the tabs as on the agent desk (user 11:14Z) */}
            {surface && <PopoutButton />}
            {onPopout && !surface && (
              <button type="button" className="popout-button" title="Open in new window" aria-label="Open in new window"
                onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onPopout() }}>↗</button>
            )}
        </>}
        pin={onPin ? { ariaLabel: `pin project ${node.id}'s desk as a window`, onPin } : null}
        settings={onConfig ? { label: node.id, onConfig } : null}
        meta={headCards && <DeskMetaRow className="project-head-cards">
          {listenerHeaderCards.map((c) => <button key={c.key} type="button"
            className={'project-listeners-card' + (c.bright ? ' bright' : '')}
            title={c.title} onClick={() => setView('listeners')}>{c.text}</button>)}
          {queue && <button type="button" className={'project-queue-card' + (queue.bright ? ' bright' : '')}
            title={queue.title} onClick={() => openInbox(queue.listeners > 0 ? 'listeners' : 'inbox')}>{queue.text}</button>}
          {slots.total > 0 && <button type="button" className={'project-slots-card' + (slotsFull(slots) ? ' full' : '')}
            title={'open the Concurrency slots tab' + (slots.held.length ? ` — held by ${slots.held.map(h => h.agent).join(', ')}` : '')} onClick={() => setView('slots')}>{slotHeaderText(slots)}</button>}
          {/* no holder links here (user 2026-10-19 17:12Z): the holders are on the slots tab */}
          {/* the audiences it holds, as on the agent desk's header (G15) */}
          <HeldAudienceChips node={node} map={map} slug={slug} toast={toast} />
        </DeskMetaRow>} />
      {upRow}
      {/* its presentations and its subtree's, on their own strip under the
          header as on an agent desk (user 2026-10-17 22:47:29Z) */}
      {onOpenDoc && subtreeDocs(node).length > 0 && (
        <DeskDocsStrip slug={slug} docs={subtreeDocs(node)} toast={toast} onOpen={onOpenDoc} onReply={live ? replyToDoc : undefined} replyLabel="Reply" />
      )}
      {shown === 'desk' && <DescriptionEditor node={node} op={op} toast={toast} editable={live} />}
      {shown === 'inbox' && <div className="desk-tabpanel">
        <PanelCorner kind="node-inbox" slug={slug} nid={node.id} />
        <ProjectInbox node={node} slug={slug} tree={tree} map={map} op={op} toast={toast} refs={refs} onJump={onJump}
          retract jumpTo={inboxJump?.id ?? null} jumpSeq={inboxJump?.seq ?? null}
          // a card's folder, else the one last picked (seq 0 is never a click)
          folderAsk={inboxAsk ?? { folder: mailFolder, seq: 0 }} onPickFolder={setMailFolder}
          onOpenMail={(id) => { setInboxJump((j) => ({ id, seq: (j?.seq ?? 0) + 1 })); openInbox('inbox') }} />
      </div>}
      {shown === 'docket' && <div className="desk-tabpanel">
        <PanelCorner kind="agent-docket" slug={slug} nid={node.id} />
        <AgentDocketView slug={slug} nid={node.id} mine={mine} facts={facts} toast={toast}
          showArchived={showArchived} onShowArchived={setShowArchived} onShowBacklog={setShowBacklog}
          references={work?.references} boundedReferences workRevision={work?.revision}
          paging={{ ...workFeed.paging, setFilter: setPageFilter }}
          onChanged={() => setBump((n) => n + 1)} refs={refs} onFocusAgent={onJump}
          /* a project owns no tickets itself (user 2026-10-18 07:26Z) */
          emptyText={<>no docket items are owned by the agents under {node.id}. A project owns no
            tickets itself; this tab lists every item owned by an agent under it, nested projects included</>} />
      </div>}
      {shown === 'presented' && <div className="desk-tabpanel">
        <PanelCorner kind="agent-gallery" slug={slug} nid={node.id} />
        {/* nid = the project: the engine widens a project's gallery to its subtree */}
        <AgentGalleryView slug={slug} nid={node.id} node={node} toast={toast} onFocusAgent={onJump} refs={refs}
          projectBroadcastMembers={agents.length}
          onReplyToDoc={(doc) => replyToDoc(doc)}
          onBroadcast={(_presenter, text, target, attachments, notice) =>
            broadcastMessage(slug, node.id, text, attachments, notice, undefined, [target]).then((r) => {
              toast([`sent to ${r.sent.length} of ${r.sent.length + r.refused.length} agents under ${node.id}`
                + (notice ? ' as a notice' : ''), ...r.refused.map((f) => `${f.to}: ${f.why}`)])
              if (!r.sent.length) throw new Error(r.refused.map((f) => f.why).join('; ') || 'broadcast was not accepted')
              return r
            })} />
      </div>}
      {shown === 'team' && <div className="desk-tabpanel team-tabpanel">
        <AgentTeamView map={map} nid={node.id} onPick={onJump} refs={refs} compactAt={tree.compact_at}
          actions={<PanelCorner kind="agent-team" slug={slug} nid={node.id} />} />
      </div>}
      {shown === 'slots' && <SlotsView node={node} state={slots} map={map} onJump={onJump} op={op} toast={toast} refs={refs}
        actions={<PanelCorner kind="project-slots" slug={slug} nid={node.id} />} />}
      {shown === 'dead' && <DeadLettersView node={node} map={map} onJump={onJump} op={op} toast={toast} />}
      {shown === 'listeners' && <ListenersView node={node} dogs={tree.watchdogs ?? []} map={map} onJump={onJump} op={op} toast={toast} refs={refs} />}
      {/* the members' jump cards under every tab, above the message box, as
          the agent desk's reports are (user 2026-10-19 19:58Z: "superior and
          subordinate jump cards persist across agent desk tabs, should be the
          same for project tabs"), in the agent desk's own row: nested
          projects' members too, retired ones behind its retired controls; the
          superior's cards are the up row under the header */}
      <DeskReportRow node={node} map={map} onJump={onJump} org={slug} />
      {/* under every tab, as the agent desk's composer is */}
      <ProjectComposer key={slug + ':' + node.id} node={node} slug={slug} tree={tree} map={map} toast={toast}
        members={agents.length} recipients={agents} bare={bare} focusRequest={replyFocus}
        replies={replies} onReplies={setReplies}
        replyAvailable={(r) => !!r.docId && (Boolean(onOpenDoc) || subtreeDocs(node).some((d) => d.id === r.docId))}
        onLocateReply={(r) => { if (r.docId) onOpenDoc?.(r.docId) }}
        docTitle={(id) => subtreeDocs(node).find((d) => d.id === id)?.title}
        onRegisterMention={(capture, noteRightDown) => { mentionRef.current = { capture, noteRightDown } }}
        onRegisterAttach={(attach) => { dropAttach.current = attach }} />
    </>
  )
  return (
    <div className={bare ? 'desk-bare project-desk' : 'desk-over project-desk'} onWheel={(e) => e.stopPropagation()}
      // the desk a click or keystroke was in is the last desk ("Focus last
      // desk") and the active chat (Alt+N outside every desk), as an agent
      // desk's is in each of its hosts (G17)
      onFocusCapture={() => { setActiveChatKey(`${slug}/${node.id}`); setButtonAgent(slug, node.id) }}
      // ESCAPE CANCELS A PREPARED REPLY, as on the agent desk: anything that
      // already took this Escape (a menu, a popover, the Summary editor, an
      // IME composition) goes first (G11)
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !replies.length || e.defaultPrevented || e.nativeEvent.isComposing
          || e.currentTarget.ownerDocument.querySelector('.lb-overlay, .picker-overlay')) return
        e.preventDefault(); e.stopPropagation(); setReplies([])
      }}
      // a file dropped anywhere on the desk is attached, as on the agent desk
      // (G10); other drags keep their own drop behaviour
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        if (!e.dataTransfer?.files?.length) return
        e.preventDefault()
        ;[...e.dataTransfer.files].forEach((f) => dropAttach.current?.(f))
      }}
      onPointerDown={(e) => {
        setActiveChatKey(`${slug}/${node.id}`)
        setButtonAgent(slug, node.id)
        // as the agent desk: only real controls claim the gesture, so a press
        // on the desk's own chrome still pans the canvas
        if ((e.target as Element).closest('button, input, textarea, select, a, label, .mailrow, .project-description-md')) {
          e.stopPropagation()
        }
      }}>
      <div {...mentionScope} className={bare ? 'desk-body eye-chat' : 'desk-inner desk-body'}
        onContextMenu={(e) => {
          if (!e.defaultPrevented && !e.currentTarget.closest('.object-menu-boundary')) {
            openFallbackObjectMenu(e, fallbackMenu)
          }
        }}>{content}</div>
      {fallbackMenu.node}
      {(asking === 'halt' || asking === 'unhalt') && createPortal(
        <AgentBatchHaltConfirm targets={agents} unhalt={asking === 'unhalt'}
          scope={`all agents under project ${node.id}`} op={op} toast={toast}
          close={() => setAsking(null)} />, document.body)}
      {asking === 'dissolve' && createPortal(
        <AgentRetireConfirm kind={members.length > 0 ? 'dissolve' : 'retire'} node={node} op={op} toast={toast}
          close={() => setAsking(null)} />, document.body)}
    </div>
  )
}

/** The project desk as a MODAL (user 2026-10-17 23:28Z, 23:29:47Z): the menu's
 *  "Open desk" glances at it without moving the camera, as the agent menu's
 *  temporary desk does, and "Desk in a separate window" asks this same surface to
 *  pop itself out (`requestSurfaceAction('project-desk', …, 'popout')`). One
 *  surface per org: a second project's desk replaces the first. */
export function ProjectDeskModal({ close, pinAsWindow, ...props }: ProjectDeskProps & {
  close: () => void
  /** pin it as the agent pin layer's window (window px), as an agent's
   *  temporary desk pins (user 2026-10-18 11:47Z); absent: the modal pin */
  pinAsWindow?: (rect: PinRect) => void
}) {
  return (
    // the agent temporary desk's frame, not a settings panel's type and
    // buttons, so it reads as the canvas desk does (user 2026-10-18 08:25Z);
    // pin-project: the org theme, as a pinned project window; one title
    // bar, as the agent desk's: folder and name, pin and close — the desk
    // below does not repeat the name (styles.css, user 11:14Z)
    <DeskModalShell kind="project-desk" title={`Project ${props.node.id}`}
      nodeId={props.node.id} tier="project"
      panel="tempdesk-panel pin-project project-desk-modal" close={close}
      pinElsewhere={pinAsWindow}>
      <ProjectDesk {...props} bare />
    </DeskModalShell>
  )
}

/** A project's INBOX WINDOW: the menu's Project mailbox and its desk's inbox
 *  tab pinned or popped out. NodeInboxModal's frame (the `node-inbox` kind, so
 *  pins, pop-outs and restores are the agent inbox window's), with the
 *  project's own mailbox inside rather than an agent's. */
export function ProjectInboxModal({ node, slug, tree, map, op, toast, refs, close, jumpTo, jumpSeq, onFocusAgent }: {
  node: CanvasNode; slug: string; tree: TreePayload; map: Map<string, CanvasNode>; op: OpFn; toast: ToastFn
  refs?: RefRoutes
  close: () => void
  jumpTo?: string | null
  jumpSeq?: number | null
  onFocusAgent?: (id: string) => void
}) {
  // the listeners folder's link to a held job; a negative seq, so it is never
  // the same request as a jump the canvas asked for
  const [held, setHeld] = useState<{ id: string; seq: number } | null>(null)
  const [ask, setAsk] = useState<{ folder: string; seq: number } | null>(null)
  useEffect(() => { setHeld(null) }, [jumpTo, jumpSeq])
  // ⚠ A REFERENCE CLOSES THIS MODAL ON THE WAY OUT, as NodeInboxModal's do:
  // everything a token can open is under this overlay
  const leaving = useMemo(() => refs && {
    world: refs.world,
    onOpen: (r: Parameters<RefRoutes['onOpen']>[0]) => { closeIfCentred('node-inbox', close, slug); refs.onOpen(r) },
  }, [refs, close, slug])
  return (
    <PinFrame kind="node-inbox" restore={{ agent: node.id, generation: node.generation }} title={`${node.id} · mail`}
      panel="settings wide" close={close}>
      <h3 data-copy-agent-name={node.id}><MailIcon fontSize="inherit" /> {node.id} <span className="dim">· mail</span></h3>
      <ProjectInbox node={node} slug={slug} tree={tree} map={map} op={op} toast={toast} refs={leaving} collapsible
        onJump={onFocusAgent ? (id) => { closeIfCentred('node-inbox', close, slug); onFocusAgent(id) } : undefined}
        jumpTo={held?.id ?? jumpTo} jumpSeq={held?.seq ?? jumpSeq} folderAsk={ask}
        onOpenMail={(id) => {
          setHeld((h) => ({ id, seq: Math.min(h?.seq ?? 0, 0) - 1 }))
          setAsk((a) => ({ folder: 'inbox', seq: (a?.seq ?? 0) + 1 }))
        }} />
    </PinFrame>
  )
}
