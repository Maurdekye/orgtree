// canvas/projectdesk.tsx — the PROJECT DESK (docs/rust-engine/
// PROJECT-NODES.md; user 2026-10-17 19:38Z–20:10Z). A focused project card,
// and a pinned project window, show this desk in the agent desk's frame and
// header. A project takes no turns, so its main tab is not a chat: it holds
// the chat desk's jump cards (up to its parent, down to its members) and a
// large editor for its description, rendered as Markdown until it is focused
// and edited as monospace text (user 20:06Z). Beside it are the agent desk's
// three other tabs with the agent desk's own views, scoped to the project:
// inbox, docket (the items attached to it) and presented (the documents
// presented under it) (user 20:07Z). The header counts its agents, active out
// of hired, with the spinner while any is active (20:08Z), and has halt all,
// dissolve project (20:09Z) and the settings gear (20:09:45Z).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import PushPinIcon from '@mui/icons-material/PushPinOutlined'
import type { ToastFn, TreePayload, TurnStat } from '../types'
import { ArrowUpIcon, AttachIcon, AutorenewIcon, CampaignIcon, CloseIcon, FileIcon, FolderIcon, NotificationsActiveIcon, NotificationsIcon, SettingsIcon } from '../icons'
import { broadcastMessage, sendMessage, uploadFile } from '../api'
import { useComposerEnter } from '../enterkey'
import { ago, md, subtreeDocCount, subtreeDocs, USER } from './shared'
export { subtreeDocCount }
import type { CanvasNode, OpFn } from './shared'
import { InboxView } from './mail'
import { useWorkItems } from './useworkitems'
import { AgentDocketView, itemActorIds, teamItems, useNodeFacts } from './docket'
import { AgentGalleryView } from './gallery'
import { PanelCorner, revealAgentPanelTab } from './panelcorner'
import { AgentTeamView } from './team'
import { PopoutButton, PopoutWindowControls, useSurface } from '../popout'
import type { RefRoutes } from './reflinks'
import { ageClockNow, LastTurnAge, NavChip, subscribeAgeClock } from './desk'
import { PresentationCard, recentDocumentChips } from './docs'
import { DocIcon } from '../icons'
import { subtreeAgents } from './bulkcompact'
import { AgentBatchHaltConfirm, AgentRetireConfirm } from './agentmenu'
import { agentNavProps } from './agentnav'
import { PinFrame } from './modalpin'
import { AgentName } from './identity'
import type { PinRect } from './pins'
import { ConfirmModal } from './modals'
import { projectSlotState, slotCount, slotHeaderText, slotsFull } from './slots'
import { SlotsView } from './slotsdesk'

export const PROJECT_DESK_TABS = ['desk', 'inbox', 'docket', 'presented', 'team'] as const
/** the Slots tab joins them while the project has a slot count (user 2026-10-18) */
type Tab = typeof PROJECT_DESK_TABS[number] | 'slots'

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
    <span className="chip agents project-activity" title="active / hired agents under this project">
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
      .then(() => toast([`description of ${node.id} saved`]))
      .catch(() => setDraft(saved))   // `op` toasts the refusal
  }
  if (editing) {
    return <textarea ref={box} className="project-description-edit" value={draft} spellCheck={false}
      aria-label={`description of project ${node.id}`}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(saved); setEditing(false) }
      }} />
  }
  const empty = !saved.trim()
  return <div className={'project-description-md' + (empty ? ' dim' : '')} tabIndex={editable ? 0 : -1}
    role={editable ? 'textbox' : undefined} aria-label={`description of project ${node.id}`}
    title={editable ? 'click to edit; it is the standing charter of every agent under this project' : undefined}
    onMouseDown={(e) => {
      if (!editable || empty || e.button !== 0) return
      const shown = shownBefore(e.currentTarget, e.clientX, e.clientY)
      caret.current = shown === null ? null : sourceOffset(saved, shown)
    }}
    onFocus={() => { if (editable) setEditing(true) }}
    onClick={() => { if (editable) setEditing(true) }}
    {...(empty ? { children: editable ? 'Describe the project: every agent under it gets this as a standing charter.' : 'No description.' }
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
function ProjectComposer({ node, slug, toast, members }: {
  node: CanvasNode; slug: string; toast: ToastFn; members: number
}) {
  const [text, setText] = useState('')
  const [attached, setAttached] = useState<{ name: string; path: string; bytes: number }[]>([])
  const [notice, setNotice] = useState(false)
  const [megaphone, setMegaphone] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const enterKey = useComposerEnter()
  const can = node.state === 'live' && (!megaphone || members > 0)
  const attach = (file: File) => {
    uploadFile(slug, node.id, file)
      .then((r) => setAttached((a) => [...a, { name: file.name, path: r.path, bytes: r.bytes }]))
      .catch((e: Error) => toast([`upload error: ${e.message}`]))
  }
  const send = () => {
    if (!can || busy || (!text.trim() && attached.length === 0)) return
    setBusy(true)
    const asNotice = notice
    const files = attached.map((a) => a.path)
    // a failed audience grant leaves the mail delivered: say so (coordinator 09:43Z)
    const grant = (g?: { granted: boolean; error?: string } | null) => g && !g.granted
      ? [`sent, but the project's user audience couldn't be granted${g.error ? ` (${g.error})` : ''}`] : []
    const done = (lines: string[]) => { setText(''); setAttached([]); setNotice(false); toast(lines) }
    ;(megaphone
      ? broadcastMessage(slug, node.id, text, files, asNotice).then((r) => done([
        `sent to ${r.sent.length} of ${r.sent.length + r.refused.length} agents under ${node.id}`
          + (asNotice ? ' as a notice' : ''), ...r.refused.map((f) => `${f.to}: ${f.why}`), ...grant(r.audience_grant)]))
      : sendMessage(slug, node.id, text, files, undefined, undefined, asNotice).then((r) => done([
        `to project ${node.id}${asNotice ? ' as a notice' : ''}: ${r.delivery ?? 'sent'}`, ...grant(r.audience_grant)])))
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setBusy(false))
  }
  return <>
    {attached.length > 0 && <div className="attach-row">
      {attached.map((a, i) => <span key={a.path + i} className="attach-chip">
        <FileIcon fontSize="inherit" /> {a.name}
        <button className="chip-x" title="remove from this message"
          onClick={() => setAttached((x) => x.filter((_, j) => j !== i))}><CloseIcon fontSize="inherit" /></button>
      </span>)}
    </div>}
    <div className={'cc-composer project-composer' + (can ? '' : ' off') + (notice ? ' notice-armed' : '')
      + (megaphone ? ' broadcast-armed' : '')}>
      <div className="cc-btnstack">
        <button className={'cc-notice-toggle' + (notice ? ' armed' : '')} type="button" disabled={!can}
          aria-label={notice ? 'Notice-send armed: next message arrives as a passive notice' : 'Notice-send: send next message as a passive notice'}
          title={notice ? 'Notice-send armed: the next message arrives as a passive notice, waking nobody (Alt+N)'
            : 'Send the next message as a passive notice, waking nobody (Alt+N)'}
          onClick={() => setNotice((v) => !v)}>
          {notice ? <NotificationsActiveIcon fontSize="inherit" /> : <NotificationsIcon fontSize="inherit" />}
        </button>
        <button className="cc-attach" type="button" disabled={!can}
          title="attach a file: every agent under the project gets it" onClick={() => fileRef.current?.click()}>
          <AttachIcon fontSize="inherit" /></button>
      </div>
      <input type="file" ref={fileRef} style={{ display: 'none' }} multiple
        onChange={(e) => { [...e.target.files!].forEach(attach); e.target.value = '' }} />
      <textarea rows={2} value={text} disabled={!can} title={enterKey.hint}
        aria-label={`message every agent under project ${node.id}`}
        placeholder={node.state !== 'live' ? `project ${node.id} is ${node.state}`
          : !megaphone ? `message project ${node.id}: one agent under it takes it…`
            : `message all ${members} agent${members === 1 ? '' : 's'} under ${node.id}…`}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          if (e.clipboardData?.files?.length) { e.preventDefault(); [...e.clipboardData.files].forEach(attach) }
        }}
        onKeyDown={(e) => {
          if (e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); e.stopPropagation(); setNotice((v) => !v); return }
          if (enterKey.sends(e)) { e.preventDefault(); send() }
        }} />
      <div className="cc-btnstack">
        <button className={'cc-broadcast-toggle' + (megaphone ? ' armed' : '')} type="button"
          disabled={node.state !== 'live' || members === 0} aria-pressed={megaphone}
          aria-label={megaphone ? `Megaphone on: messages go to all ${members} agents under ${node.id}`
            : `Megaphone: send to all ${members} agents under ${node.id} instead of the project's inbox`}
          title={members === 0 ? `no agent works under ${node.id} yet`
            : megaphone ? `on: each message goes to all ${members} agents under ${node.id}; click to send to the project's inbox again`
              : `send to all ${members} agents under ${node.id} at once, instead of the project's inbox that one agent claims`}
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

export function ProjectDesk({ node, slug, tree, map, op, toast, refs, bare, onJump, onConfig, onPin, onPopout, onOpenDoc }: ProjectDeskProps) {
  const surface = useSurface()
  const [view, setView] = useState<Tab>('desk')
  const [asking, setAsking] = useState<'halt' | 'unhalt' | 'dissolve' | 'purge' | null>(null)
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
  const parent = node.parent && map.has(node.parent) && !(bare && node.parent === USER) ? map.get(node.parent)! : null
  const members = node.children.filter((c) => c.state === 'live')
  const slots = projectSlotState(node.id, slotCount(node), tree.slot_leases ?? [], tree.watchdogs ?? [])
  const tabs: Tab[] = slots.total > 0 ? [...PROJECT_DESK_TABS, 'slots'] : [...PROJECT_DESK_TABS]
  const shown: Tab = tabs.includes(view) ? view : 'desk'
  const count = (tab: Tab) => tab === 'inbox' ? node.mail_pending ?? 0
    : tab === 'docket' ? mine?.length ?? 0
      // its own presentations (point 27, user 2026-10-17 23:28Z)
      : tab === 'presented' ? (node.documents_count ?? node.documents?.length ?? 0) : 0
  const content = (
    <>
      <div className="cc-head">
        <div className="cc-head-top">
          <span className="cc-head-left" data-copy-agent-name={node.id} {...agentNavProps(node.id)}>
            <span className="project-mark" title="project node: runs no turns, holds no credits">
              <FolderIcon fontSize="inherit" />
            </span>
            <span className="name" title={`project ${node.id}`}>{node.id}</span>
            <ProjectActivity node={node} />
            <ProjectLastActivity node={node} />
            {/* slots held/total while slots are enabled; it opens the Slots tab (user 08:46Z) */}
            {slots.total > 0 && <button type="button" className={'chip project-slots-card' + (slotsFull(slots) ? ' full' : '')}
              title={`${slots.held.length} of ${slots.total} concurrency slot${slots.total === 1 ? '' : 's'} held`
                + (slots.held.length ? ' by ' + slots.held.map((l) => l.agent).join(', ') : '') + ': open the Concurrency slots tab'}
              onClick={() => setView('slots')}>{slotHeaderText(slots)}</button>}
            {!live && <span className="badge dim">{node.state}</span>}
          </span>
          <span className="spacer" aria-hidden="true" />
          <span className="cc-head-right">
            <span className="cc-actions">
              {live && agents.length > 0 && (
                <button className={allHalted ? '' : 'danger'} data-action="halt-all"
                  title={`${allHalted ? 'release' : 'halt'} all ${agents.length} live agents under this project`}
                  onClick={() => setAsking(allHalted ? 'unhalt' : 'halt')}>
                  {allHalted ? 'unhalt all' : 'halt all'}</button>
              )}
              {live && <button className="danger" data-action="dissolve"
                title="retire the project and every agent under it; context is kept and rehire brings each back"
                onClick={() => setAsking('dissolve')}>dissolve project</button>}
              {!live && node.state === 'archived' && <button data-action="restore"
                onClick={() => { void op({ op: 'rehire', node: node.id }).catch(() => {}) }}>restore</button>}
            </span>
            <span className="cc-tabs">
              {tabs.map((v) => (
                <button key={v} data-tab={v} className={shown === v ? 'on' : ''}
                  onClick={() => { if (!revealAgentPanelTab(v, slug, node.id, node.generation)) setView(v) }}>
                  {/* spelled out (user 2026-10-18 12:16Z); the id stays `slots` */}
                  {v === 'slots' ? 'concurrency slots' : v}{v === 'slots' ? <>{' '}<span className="tab-count">{slots.held.length}/{slots.total}</span></>
                    : count(v) > 0 ? <>{' '}<span className="tab-count">{count(v)}</span></> : ''}
                </button>
              ))}
            </span>
            {/* in its own window frame (the modal, pinned or popped out) the
                frame's pop-out, beside the tabs as on the agent desk (user 11:14Z) */}
            {surface && <PopoutButton />}
            {onPopout && !surface && (
              <button type="button" className="popout-button" title="Open in new window" aria-label="Open in new window"
                onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onPopout() }}>↗</button>
            )}
            {onPin && (
              <button className="cc-icon cc-pin" aria-label={`pin project ${node.id}'s desk as a window`}
                title="pin as a window — it stays put while the canvas moves" onClick={onPin}>
                <PushPinIcon fontSize="inherit" />
              </button>
            )}
            {onConfig && (
              <button className="cc-icon" aria-label={`settings for ${node.id}`}
                title={`settings for ${node.id}`} onClick={onConfig}>
                <SettingsIcon fontSize="inherit" />
              </button>
            )}
          </span>
          {/* the window controls, last on the header row as on a popped-out
              agent desk (user 2026-10-18 11:47Z); rendered only popped out */}
          <PopoutWindowControls />
        </div>
      </div>
      {/* its presentations and its subtree's, on their own strip under the
          header as on an agent desk (user 2026-10-17 22:47:29Z) */}
      {onOpenDoc && subtreeDocs(node).length > 0 && (
        <div className="desk-docs">
          {recentDocumentChips(subtreeDocs(node)).map((d) => (
            <PresentationCard key={d.id} slug={slug} doc={d} toast={toast}
              className="doc-badge" direct onOpen={onOpenDoc}>
              <DocIcon fontSize="inherit" /><span>{d.title}</span>
            </PresentationCard>
          ))}
        </div>
      )}
      {shown === 'desk' && <>
        {onJump && parent && <div className="desk-nav"><NavChip n={parent} dir="up" onJump={onJump} /></div>}
        <DescriptionEditor node={node} op={op} toast={toast} editable={live} />
        {onJump && members.length > 0 && <div className="desk-nav">
          {members.map((c) => <NavChip key={c.id} n={c} dir="down" onJump={onJump} />)}
        </div>}
      </>}
      {shown === 'inbox' && <div className="desk-tabpanel">
        <PanelCorner kind="node-inbox" slug={slug} nid={node.id} />
        {/* waiting mail nobody holds yet can be purged (user 2026-10-18 08:11Z) */}
        {live && (node.mail_pending ?? 0) > 0 && <div className="project-queue-tools">
          <button type="button" className="danger" data-action="purge-queue" onClick={() => setAsking('purge')}
            title="retract every mail waiting in this project's queue; mail already handed to an agent stays">
            Purge waiting mail</button>
        </div>}
        <InboxView slug={slug} nid={node.id} tier="project" unreadCount={node.mail_pending} toast={toast}
          tierOf={(id) => {
            const n = map.get(id)
            return n?.kind === 'project' ? 'project' : n?.tier
          }} hasAgent={(id) => map.has(id)}
          refs={refs} onFocusAgent={onJump} />
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
        <AgentGalleryView slug={slug} nid={node.id} node={node} toast={toast} onFocusAgent={onJump} refs={refs} />
      </div>}
      {shown === 'team' && <div className="desk-tabpanel team-tabpanel">
        <PanelCorner kind="agent-team" slug={slug} nid={node.id} />
        <AgentTeamView map={map} nid={node.id} onPick={onJump} refs={refs} compactAt={tree.compact_at} />
      </div>}
      {shown === 'slots' && <SlotsView node={node} state={slots} op={op} toast={toast} />}
      {/* under every tab, as the agent desk's composer is */}
      <ProjectComposer node={node} slug={slug} toast={toast} members={agents.length} />
    </>
  )
  return (
    <div className={bare ? 'desk-bare project-desk' : 'desk-over project-desk'} onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        // as the agent desk: only real controls claim the gesture, so a press
        // on the desk's own chrome still pans the canvas
        if ((e.target as Element).closest('button, input, textarea, select, a, label, .mailrow, .project-description-md')) {
          e.stopPropagation()
        }
      }}>
      <div className={bare ? 'desk-body eye-chat' : 'desk-inner desk-body'}>{content}</div>
      {(asking === 'halt' || asking === 'unhalt') && createPortal(
        <AgentBatchHaltConfirm targets={agents} unhalt={asking === 'unhalt'}
          scope={`all agents under project ${node.id}`} op={op} toast={toast}
          close={() => setAsking(null)} />, document.body)}
      {asking === 'dissolve' && createPortal(
        <AgentRetireConfirm kind={members.length > 0 ? 'dissolve' : 'retire'} node={node} op={op} toast={toast}
          close={() => setAsking(null)} />, document.body)}
      {asking === 'purge' && createPortal(
        <ConfirmModal title={`purge project ${node.id}'s waiting mail?`}
          body={`${node.mail_pending ?? 0} waiting mail${(node.mail_pending ?? 0) === 1 ? '' : 's'} will be retracted. `
            + 'Mail already handed to an agent, acked or dead-lettered stays.'}
          confirmLabel="purge" close={() => setAsking(null)}
          onConfirm={() => {
            op({ op: 'purge_mail_queue', node: node.id })
              .then((r) => toast([`purged ${String((r as { purged?: number }).purged ?? 0)} waiting mail from project ${node.id}`]))
              .catch(() => {})
          }} />, document.body)}
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
    <PinFrame kind="project-desk" title={`Project ${props.node.id}`}
      restore={{ agent: props.node.id }}
      // the agent temporary desk's frame, not a settings panel's type and
      // buttons, so it reads as the canvas desk does (user 2026-10-18 08:25Z);
      // pin-project: the org theme, as a pinned project window
      panel="tempdesk-panel pin-project project-desk-modal" close={close}
      // one title bar, as the agent desk's: folder and name, pin and close;
      // the desk below does not repeat the name (styles.css, user 11:14Z)
      deskTitle titleBar={<AgentName id={props.node.id} tier="project" nameClass="pinwin-name" />}
      pinElsewhere={pinAsWindow}>
      <ProjectDesk {...props} bare />
    </PinFrame>
  )
}
