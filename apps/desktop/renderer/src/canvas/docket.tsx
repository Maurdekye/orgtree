// canvas/docket.tsx — the native work docket (docket-final-spec.md).
//
// SHAPED ON THE DOCUMENT GALLERY (same list-left/content-right structure,
// user spec) — wears the same `.settings.wide`/`.mailer`/`.mailer-list`/
// `.mailrow`/`.mailer-read` classes DocGalleryModal does, styled by its own
// `.docket-modal` scope the way `.gallery-modal` styles its own rows. The
// header follows the gallery's: the <h3> at the left and the filter checkboxes
// pushed to the RIGHT END, which is where the gallery's space-between layout
// puts its own — the grouping control sits on its own strip below so the header
// does not crowd.
//
// THREE GROUPINGS, ONE INVARIANT (user 2026-09-05): no group / by status / by
// agent. Whichever is chosen, the two filtered groups — backlog and archive —
// are APPENDED BELOW the current work, never mixed into it. Ticking a box adds
// a section at the end; it never re-sorts, reloads or resets what is already
// on screen, and never disturbs the selected item or a half-typed reply.
//
// Attached questions are NOT a second answering form: each is rendered as
// the real <AskCard> for the matching entry in `tree.asks` (which stays
// uncapped for every open ask), so answering here calls the exact same
// answerAsk/resolveBatch route the inbox/desk cards do. The item's own
// `questions` array (wire contract v3) is only used to know WHICH asks to
// look up and for the "who is asking" header — never to answer directly.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import type {
  AskInfo, ToastFn, TreeNode, TreePayload, WorkActor, WorkItem,
} from '../types'
import {
  deleteWorkItemAttachment, dismissWorkItemAttention, getWorkItems,
  replyWorkItem, uploadWorkItemAttachment, workItemAttachmentUrl,
} from '../api'
import { CloseIcon, DocketIcon, DownloadIcon, TuneIcon } from '../icons'
import { AttachThumb, fmtBytes, isImg } from './img'
import { AskCard } from './asks'
import { DocReader } from './docs'
import { closeIfCentred, PinFrame } from './modalpin'
import { AgentName } from './identity'
import { MailReplyBox } from './mail'
import { ago, jumpKey, useEsc, usePolled } from './shared'
import { fmtFull } from '../timefmt'
import { buildMentionIndex } from './workrefs'
import type { MentionIndex } from './workrefs'
import { RefProse, refToken } from './reflinks'
import { copyToClipboard, useContextMenu } from './contextmenu'
import type { MenuEntry } from './contextmenu'
import type { RefRoutes, RefWorld, ResolvedRef } from './reflinks'
import type { RefKind, TypedRef } from './workrefs'

// `review` is the AGENT check, not the user's (user ruling 2026-09-05)
const REVIEW_HELP ='Review by agents — a request for you rides the attention flag or a question'
const STATUS_LABEL: Record<string, string> = {
  backlogged: 'Backlogged',
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  // `waiting` was REMOVED as a state (user 2026-09-07): the backend serves a
  // row recorded as waiting as `blocked` with `legacy_status: "waiting"`, so
  // no label is needed for it; an older backend that still serves the word
  // falls through to the raw status
  review: 'Agent review',
  deploy_ready: 'Deploy Ready',
  done: 'Done',
  superseded: 'Superseded',
  dropped: 'Dropped',
}
// `blocked` names what it is stuck on and how the agent will hear of the
// answer or event; it is never nudged by the idle reminder (user 2026-09-07)
const BLOCKED_HELP = 'Cannot move until something outside the item happens — an answer, an event, another agent\'s work. It says what and how the agent will hear of it; it stays active and is never nudged by the idle reminder'
// the word on its own could be read as "finished with"; it means the opposite
// of Done, and the pane says which of the two ways it ended
const DROPPED_HELP = 'Ended WITHOUT being completed — cancelled, or failed in a way it cannot be recovered from. Closed and archived at once (no one-hour wait), but never Done'
// distinguishes it from both Blocked (stuck on something outside the item —
// this is not) and Done (not live yet — that is the whole reason it exists)
const DEPLOY_READY_HELP = 'Implementation is complete and awaiting deployment or publication. Active and actionable — not stuck on anything, and not yet live — so it stays on the desk and is nudged like any other in-flight status'
const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status
/** hover help, only where the status word can be read two ways */
const statusHelp = (status: string): string | undefined =>
  (status === 'review' ? REVIEW_HELP
    : status === 'blocked' ? BLOCKED_HELP
      : status === 'dropped' ? DROPPED_HELP
        : status === 'deploy_ready' ? DEPLOY_READY_HELP : undefined)

/** Group-by-status order, exactly as specified: effective attention first,
 *  then blocked, in_progress, review, deploy_ready, open, done, then
 *  everything else that is closed. (`waiting` had its own group until the
 *  state was removed, user 2026-09-07; such rows now arrive as blocked.) A
 *  status the backend adds later lands in "Other" rather than vanishing —
 *  an unknown row must still be reachable. */
const STATUS_GROUPS: { key: string; heading: string }[] = [
  { key: 'attention', heading: 'Needs attention' },
  { key: 'blocked', heading: 'Blocked' },
  { key: 'in_progress', heading: 'In progress' },
  { key: 'review', heading: 'Agent review' },
  { key: 'deploy_ready', heading: 'Deploy Ready' },
  { key: 'open', heading: 'Open' },
  { key: 'backlogged', heading: 'Backlogged' },
  { key: 'done', heading: 'Done' },
  { key: 'other', heading: 'Other closed' },
]

export type DocketGroupMode = 'none' | 'status' | 'agent'
const GROUP_MODES: { value: DocketGroupMode; label: string }[] = [
  { value: 'none', label: 'No group' },
  { value: 'status', label: 'Group by status' },
  { value: 'agent', label: 'Group by agent' },
]
/** app-local, per browser — a display preference, not org state */
const GROUP_KEY = 'orgtree.docket.group'

export function readGroupMode(): DocketGroupMode {
  try {
    const v = window.localStorage.getItem(GROUP_KEY)
    if (v === 'none' || v === 'status' || v === 'agent') return v
  } catch { /* storage disabled or unavailable — fall back to the default */ }
  return 'none'
}

function writeGroupMode(m: DocketGroupMode): void {
  try { window.localStorage.setItem(GROUP_KEY, m) } catch { /* ignore */ }
}

// THE ROW ORDER IS THE SERVER'S, and this file deliberately does not restate
// it. `ledger.work_list` already sorts every group by newest docket update
// first with the item id breaking a tie, which makes the order total and
// therefore stable across polls. Grouping here only PARTITIONS that sequence —
// `filter` and first-appearance bucketing both preserve relative order — so a
// group can never contradict the order the server chose, and there is no
// second copy of the comparator to drift out of step with it.
//
// ⚠ THE SORT SELECTOR DOES NOT WEAKEN THAT. `Updated` — the default, and what
// the docket has always shown — RETURNS THE SERVER'S ARRAY UNTOUCHED: there is
// still no client comparator on that path, so it cannot disagree with the
// server about anything. The two new orders are questions the server does not
// answer, so `sortItems` answers them here, with the SAME tie-break rule the
// server uses (the readable name, descending) — because the failure this
// prevents is not a wrong order, it is two rows trading places between two
// five-second polls while the reader's cursor is on one of them.

export type DocketSortMode = 'updated' | 'created' | 'status'
const SORT_MODES: { value: DocketSortMode; label: string; why: string }[] = [
  { value: 'updated', label: 'Last updated', why: 'most recently updated first' },
  { value: 'created', label: 'Newest first', why: 'most recently created first' },
  { value: 'status', label: 'Status changed', why: 'most recent status change first' },
]
const SORT_KEY = 'orgtree.docket.sort'

export function readSortMode(): DocketSortMode {
  try {
    const v = window.localStorage.getItem(SORT_KEY)
    if (v === 'updated' || v === 'created' || v === 'status') return v
  } catch { /* storage disabled or unavailable — fall back to the default */ }
  return 'updated'
}

function writeSortMode(m: DocketSortMode): void {
  try { window.localStorage.setItem(SORT_KEY, m) } catch { /* ignore */ }
}

/** The clock each mode reads.
 *
 *  ⚠ `status_at` IS SERVED FOR EVERY ITEM, including ones written before the
 *  field existed — the server derives those from retained history and falls
 *  back to their creation, never to a clock that moves for edits. So the
 *  fallback chain here is for a payload from an OLDER BACKEND, not for an
 *  older item, and it deliberately ends at `at`: falling through to
 *  `updated_at` would let a retitle read as a state change, which is the
 *  exact lie the durable field was added to remove. */
function sortStamp(it: WorkItem, mode: DocketSortMode): string {
  if (mode === 'created') return String(it.at ?? '')
  if (mode === 'status') return String(it.status_at ?? it.at ?? '')
  return String(it.docket_at ?? it.updated_at ?? '')
}

/** The row's AGE reads the SAME clock the list is sorted by (user 2026-09-07:
 *  "Newest first tickets show time since creation; Last status change shows
 *  time since the last status update"). One stamp, one function — `sortStamp`
 *  — so the order and the number beside each row can never disagree, and a
 *  progress note or a retitle cannot refresh a status age because the status
 *  clock is the durable `status_at` and nothing else. The tooltip names the
 *  clock and the full instant, so the bare "3h" is never ambiguous. */
const AGE_CLOCK: Record<DocketSortMode, string> = {
  updated: 'updated', created: 'created', status: 'last status change',
}
export function rowAge(it: WorkItem, mode: DocketSortMode): { text: string; title: string } {
  const stamp = sortStamp(it, mode)
  return { text: ago(stamp || it.at), title: `${AGE_CLOCK[mode]} ${fmtFull(stamp || it.at)}` }
}

/** One section's items in the chosen order, newest first.
 *
 *  ⚠ `updated` RETURNS THE INPUT ARRAY ITSELF. Not a copy, not a re-sort of an
 *  already-sorted list: the server's order IS this mode, and re-deriving it
 *  here would be a second comparator that agrees today and drifts later.
 *  ⚠ AND THE OTHERS ARE TOTAL. Same tie-break as `ledger.work_list` — the
 *  readable name, descending — so equal stamps cannot shuffle between polls. */
export function sortItems(items: WorkItem[], mode: DocketSortMode): WorkItem[] {
  if (mode === 'updated') return items
  return [...items].sort((a, b) => {
    const sa = sortStamp(a, mode)
    const sb = sortStamp(b, mode)
    if (sa !== sb) return sa < sb ? 1 : -1
    const na = String(a.slug ?? '')
    const nb = String(b.slug ?? '')
    return na < nb ? 1 : na > nb ? -1 : 0
  })
}

/** What we may honestly say about the agent an item points at. A node keeps
 *  its identity across session generations: when the node is live, the
 *  docket's name resolves to that live successor and its current model. Only
 *  a node that is actually retired gets the historical treatment. */
export type ActorFit = 'current' | 'retired' | 'gone'

export interface NodeFacts { tier: string; generation: number; live: boolean }

export function buildNodeFacts(roots?: TreeNode[]): Map<string, NodeFacts> {
  const map = new Map<string, NodeFacts>()
  const walk = (nodes?: TreeNode[]) => {
    for (const n of nodes ?? []) {
      if (n.id) {
        map.set(n.id, {
          tier: n.tier,
          generation: Number(n.generation ?? 0),
          live: n.state === 'live',
        })
      }
      walk(n.children)
    }
  }
  walk(roots)
  return map
}

export function actorFit(actor: WorkActor | null | undefined,
                         facts: Map<string, NodeFacts>):
  { fit: ActorFit; tier?: string } {
  if (!actor?.node) return { fit: 'gone' }
  const n = facts.get(actor.node)
  if (!n) return { fit: 'gone' }
  // The actor's generation records who wrote the item, but it does not turn
  // the node id into a different identity. A live node is therefore the
  // current destination even when the item names an archived predecessor.
  if (!n.live) return { fit: 'retired', tier: n.tier }
  return { fit: 'current', tier: n.tier }
}

const FIT_WHY: Record<ActorFit, string | null> = {
  current: null,
  // a RETIRED agent keeps its recorded model, so the chip stays and the row
  // explains itself
  retired: 'this agent has been retired',
  gone: 'this agent is no longer in the org',
}

/** An agent identity as it appears everywhere in this panel: the model chip
 *  only when we can honestly attribute it, the name truncating with a real
 *  ellipsis, and a jump to its desk. */
function ActorName({ actor, facts, onFocusAgent, close, availability }: {
  actor: WorkActor | null | undefined
  facts: Map<string, NodeFacts>
  onFocusAgent?: (agentId: string) => void
  close?: () => void
  availability?: 'live' | 'retired' | 'missing'
}) {
  if (!actor?.node) return null
  const identity = actorFit(actor, facts)
  const tier = identity.tier
  const fit = availability === 'live' ? 'current'
    : availability === 'missing' ? 'gone' : availability ?? identity.fit
  const why = FIT_WHY[fit]
  // ⚠ `why` STAYS ON THE WRAPPER, and `tier` is passed through EXACTLY as
  // actorFit returned it. A live node gets the model it wears now, even when
  // this work was written by an earlier generation; a missing node gets no
  // invented chip.
  return (
    <span className={'docket-actor fit-' + fit} title={why ?? undefined}>
      {/* the ellipsis lives on the NAME element, not on this inline-flex
          wrapper: text-overflow does nothing on a flex container, which is
          why the long name used to run under the Dismiss button instead of
          truncating (Astra review 2026-09-05) — hence `nameClass` */}
      <AgentName id={actor.node} tier={tier} nameClass="docket-actor-name"
        onFocus={onFocusAgent
          ? (id) => { close?.(); onFocusAgent(id) }
          : undefined} />
    </span>
  )
}

/** The by-agent grouping's heading: the agent itself, not a word about it.
 *
 *  ⚠ THE HEADING KEEPS ITS OWN TYPOGRAPHY — the stylesheet hands `.cc-name`
 *  the heading's font back, so this adds a chip and a click, not a restyle. */
function GroupAgentHead({ agent, items, facts, onFocusAgent, close }: {
  agent: string
  items: WorkItem[]
  facts: Map<string, NodeFacts>
  onFocusAgent?: (agentId: string) => void
  close?: () => void
}) {
  const { fit, tier, why } = groupIdentity(items, facts)
  return (
    <span className={'docket-group-agent' + (fit ? ' fit-' + fit : '')}>
      <AgentName id={agent} tier={tier} why={why} nameClass="docket-group-name"
        onFocus={onFocusAgent
          ? (id) => { close?.(); onFocusAgent(id) }
          : undefined} />
    </span>
  )
}

/** The item's readable name. The slug IS the name — there is no other
 *  identifier and no fallback; the server never serves an item without one. */
export const itemName = (item: WorkItem): string => item.slug

/** The name in the DETAIL pane: plain selectable text, no control.
 *
 *  ⚠ THIS WAS A BUTTON AND THE USER REMOVED IT (2026-09-05, twice — first from
 *  the list, then from here, from screenshots). A padded bordered copy chip
 *  ate the row's metadata space and truncated the agent name beside it to
 *  "c…", and it read as a control where the reader wanted a label. There is
 *  now NO copy affordance anywhere in this panel: the name is selectable text
 *  and the browser's own copy does the job. Do not reintroduce one without a
 *  new ruling. */
function SlugText({ item }: { item: WorkItem }) {
  return (
    <span className="docket-slug-text"
      >
      {itemName(item)}
    </span>
  )
}

export function DocketToolbarButton({ summary, onClick }: {
  summary?: { attention: number; active: number } | null
  onClick?: () => void
}) {
  const { attention, active } = summary ?? { attention: 0, active: 0 }
  // count > 0 is load-bearing: `{count && ...}` renders a literal `0` in React
  const count = attention > 0 ? attention : active
  return (
    <button className="iconbtn docket-bell"
      title={attention > 0
        ? `work docket — ${attention} item(s) need attention`
        : 'work docket'}
      onClick={onClick}>
      <DocketIcon fontSize="inherit" />
      {count > 0 && (
        <b className={'eye-count' + (attention > 0 ? ' docket-attn' : '')}>
          {count}</b>
      )}
    </button>
  )
}

/** the owner-less group's heading — named explicitly rather than left as a
 *  silent remainder at the bottom of the list (user 2026-09-05) */
export const UNASSIGNED = 'Unassigned'

export interface Section {
  key: string
  heading: string | null
  items: WorkItem[]
  /** styling hook for the two appended groups, so they read as set apart
   *  from current work rather than as two more status buckets */
  tone?: 'backlog' | 'archive'
  /** the AGENT this group is named after, when the heading is an agent id and
   *  not a word. Set only by the by-agent grouping, and never for the
   *  owner-less group — `Unassigned` is a label, not a name that resolves. */
  agent?: string
}

/** The identity a GROUP HEADING may claim.
 *
 *  ⚠ THE CHIP APPEARS ONLY WHEN EVERY OWNER IN THE GROUP ATTRIBUTES THE SAME
 *  MODEL. One heading names one agent, but its group can contain current,
 *  retired, missing, or mixed references. If those references do not resolve
 *  to one fit/tier, the heading claims no single model and says why. */
export function groupIdentity(items: WorkItem[], facts: Map<string, NodeFacts>):
  { fit?: ActorFit; tier?: string; why: string | null } {
  const seen = new Map<string, { fit: ActorFit; tier?: string }>()
  for (const it of items) {
    const r = actorFit(it.owner, facts)
    seen.set(r.fit + '/' + (r.tier ?? ''), r)
  }
  // an empty group is not a disagreement (and never reaches the screen)
  if (seen.size === 0) return { why: null }
  const only = seen.size === 1 ? [...seen.values()][0] : undefined
  if (!only) {
    return {
      why: 'this group holds references with different status or model '
        + 'identity, so no one model can be attributed to the group',
    }
  }
  return { fit: only.fit, tier: only.tier, why: FIT_WHY[only.fit] }
}

/** One rendered line: the item, how deep it sits, and how many children of
 *  ITS OWN are in this same section. */
export interface DocketRowInfo {
  item: WorkItem
  depth: number
  kids: number
}

/** One section's flat, server-ordered list as the nested display order.
 *
 *  ⚠ THE SERVER'S ORDER IS STILL THE ORDER: this only re-parents, so there is
 *  no second comparator to drift out of step with `ledger.work_list`.
 *  ⚠ A parent in ANOTHER section is not a parent here — the child renders as a
 *  root rather than vanishing, because losing a row would hide work.
 *  ⚠ It cannot hang on a cycle: the walk is bounded and strays are appended,
 *  so a bad document costs nesting and never the list. */
export function nestRows(items: WorkItem[],
                         collapsed: ReadonlySet<string>): DocketRowInfo[] {
  const here = new Set(items.map((i) => i.slug))
  const kids = new Map<string, WorkItem[]>()
  const roots: WorkItem[] = []
  for (const it of items) {
    const p = it.parent && here.has(it.parent) && it.parent !== it.slug
      ? it.parent : null
    if (!p) { roots.push(it); continue }
    const list = kids.get(p)
    if (list) list.push(it)
    else kids.set(p, [it])
  }
  // ⚠ REACHABILITY IGNORES THE FOLD; the display walk applies it. "Not drawn
  // because you folded it" and "not drawn because nothing leads here" are
  // different states, and only the second is rescued below.
  const reachable = new Set<string>()
  const mark = (it: WorkItem) => {
    if (reachable.has(it.slug)) return
    reachable.add(it.slug)
    for (const k of kids.get(it.slug) ?? []) mark(k)
  }
  for (const r of roots) mark(r)

  const out: DocketRowInfo[] = []
  const seen = new Set<string>()
  const walk = (it: WorkItem, depth: number) => {
    if (seen.has(it.slug)) return
    seen.add(it.slug)
    const mine = kids.get(it.slug) ?? []
    out.push({ item: it, depth, kids: mine.length })
    if (collapsed.has(it.slug)) return
    for (const k of mine) walk(k, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  // only what a CYCLE stranded — never what a fold hid
  for (const it of items) if (!reachable.has(it.slug)) walk(it, 0)
  return out
}

/** Every ancestor of `slug` present in `items`, nearest first — what has to be
 *  expanded for a row to be on screen at all. Bounded against a cycle. */
export function ancestorsOf(items: WorkItem[], slug: string): string[] {
  const by = new Map(items.map((i) => [i.slug, i]))
  const out: string[] = []
  const seen = new Set<string>([slug])
  let cur = by.get(slug)?.parent ?? null
  while (cur && by.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    out.push(cur)
    cur = by.get(cur)?.parent ?? null
  }
  return out
}

/** The whole list, in order. The contract this function exists to keep: the
 *  backlog and the archive are ALWAYS the last two sections, in that order, in
 *  every grouping mode — so ticking a box can only ever add something to the
 *  bottom of the list. */
export function buildSections(mode: DocketGroupMode, active: WorkItem[],
                              backlog: WorkItem[], archived: WorkItem[],
                              ownerName: (it: WorkItem) => string): Section[] {
  const out: Section[] = []
  const rest = active

  if (mode === 'status') {
    const bucket = (it: WorkItem): string => {
      if (it.effective_attention) return 'attention'
      if (STATUS_GROUPS.some((g) => g.key === it.status)) return it.status
      return 'other'
    }
    for (const g of STATUS_GROUPS) {
      const items = rest.filter((it) => bucket(it) === g.key)
      if (items.length) out.push({ key: 'st:' + g.key, heading: g.heading, items })
    }
  } else if (mode === 'agent') {
    const groups = new Map<string, WorkItem[]>()
    for (const it of rest) {
      const who = ownerName(it)
      const list = groups.get(who)
      if (list) list.push(it)
      else groups.set(who, [it])
    }
    // A Map keeps insertion order, and rows arrive newest-first, so the agents
    // come out in order of their most recent activity WITHOUT a second sort —
    // and therefore without a second chance to disagree with the server.
    for (const [who, items] of groups) {
      // the id travels SEPARATELY from the heading text, so the renderer
      // never guesses whether a heading is a name: `Unassigned` is a word
      if (who !== UNASSIGNED) {
        out.push({ key: 'ag:' + who, heading: who, items, agent: who })
      }
    }
    const un = groups.get(UNASSIGNED)
    // last, and always named rather than left as a silent remainder
    if (un) out.push({ key: 'ag:unassigned', heading: UNASSIGNED, items: un })
  } else if (rest.length) {
    out.push({ key: 'all', heading: null, items: rest })
  }

  // ALWAYS LAST, ALWAYS IN THIS ORDER, in every mode: ticking a filter may only
  // ever append a section to the bottom of the list (user 2026-09-05).
  if (backlog.length) {
    out.push({
      key: 'backlog', tone: 'backlog', items: backlog,
      heading: 'Backlogged — not yet approached',
    })
  }
  if (archived.length) {
    out.push({ key: 'archive', tone: 'archive', items: archived, heading: 'Archived' })
  }
  return out
}

export function DocketModal({ slug, toast, close, tree, onFocusAgent,
  jumpTo, jumpSeq, onJumpHandled, onOpenMail }: {
  slug: string
  toast: ToastFn
  close: () => void
  tree: TreePayload
  /** the existing presented-document agent navigation (gallery.tsx's
   *  DocPane) — user ruling 2026-09-05: agent identities in a mail-idiom
   *  detail pane are clickable links using this exact behavior everywhere
   *  it appears, docket included. */
  onFocusAgent?: (agentId: string) => void
  /** open AT this item: a tool chip's docket link names the item a work write
   *  acted on (user 2026-09-05). Consumed once — see the effect below. */
  jumpTo?: string | null
  /** the REQUEST's own identity, so a repeat click on the same target is a
   *  new request while an unrelated repoll is not (`jumpKey`) */
  jumpSeq?: number | null
  onJumpHandled?: () => void
  /** open a mail reference somewhere that actually owns a mailbox. The docket
   *  does not: the three boxes (the user's, the org's, a node's) are three
   *  different panels, and only the shell above this one can route between
   *  them.
   *
   *  ⚠ IT IS OPTIONAL, AND `handles` FOLLOWS IT. Absent, a mail token renders
   *  "not from here" — which stays TRUE, because nothing here would open it.
   *  Advertising mail unconditionally and then dropping the click on the floor
   *  is the live-looking control that does nothing. */
  onOpenMail?: (ref: TypedRef) => void
}) {
  // ⚠ ONE DOCUMENT READER, OPENED BY REFERENCE. The reader is `DocReader`, the
  // same one the canvas chips open, so the fetch is the EXACT get by id: it
  // tells "still loading" from "no such document" by itself, which is the
  // judgement this panel cannot make (it holds no document list).
  const [docView, setDocView] = useState<string | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const optionsToggle = useRef<HTMLButtonElement>(null)
  // ⚠ ESCAPE BELONGS TO THE TOP-MOST THING ON SCREEN. Both listeners sit on
  // `window`, so an unguarded Escape with the reader open closes the reader
  // AND the docket underneath it — the user asked to back out of a document
  // and lost the panel they were reading from.
  const escClose = useCallback(() => {
    if (docView) return
    if (optionsOpen && optionsToggle.current?.getClientRects().length) {
      setOptionsOpen(false); optionsToggle.current.focus()
    } else close()
  }, [docView, close, optionsOpen])
  // ⚠ AND A PINNED DOCKET DOES NOT CLOSE ITSELF TO GET OUT OF THE WAY. Every
  // jump below hands `navClose` down instead of `close`: centred, the panel
  // covers what it just opened and must go; pinned, it is a window the user
  // placed beside it. The header close button and Escape keep the real one.
  const navClose = useCallback(() => closeIfCentred('docket', close, slug), [close, slug])
  const [showArchived, setShowArchived] = useState(false)
  const [showBacklog, setShowBacklog] = useState(false)
  const [groupMode, setGroupMode] = useState<DocketGroupMode>(readGroupMode)
  const [sortMode, setSortMode] = useState<DocketSortMode>(readSortMode)
  const [bump, setBump] = useState(0)
  // ⚠ EVERYTHING REMEMBERED IS SCOPED TO THE ORG IT CAME FROM. This panel can
  // be handed a different `slug` while mounted; without the tag, the previous
  // org's cached rows and selected id would survive that change and the pane
  // would render one org's item while every action on it addressed another's
  // URL (Astra review 2026-09-05). Comparing the tag during RENDER rather than
  // clearing in an effect also means there is no frame in which the stale rows
  // are still on screen.
  const [cache, setCache] = useState<{ slug: string; archived: WorkItem[]; backlog: WorkItem[] }>(
    { slug, archived: [], backlog: [] })
  const [sel, setSel] = useState<{ slug: string; id: string } | null>(null)
  const archivedCache = cache.slug === slug ? cache.archived : []
  const backlogCache = cache.slug === slug ? cache.backlog : []

  // ⚠ BOTH GROUPS ARE ALWAYS FETCHED, AND THE CHECKBOXES ONLY DECIDE WHAT IS
  // SHOWN. A slug link must work when it points at a backlogged or archived
  // item — "reveal the row" is impossible if the row was never loaded, and a
  // mention that silently refuses to link because a checkbox is off would be
  // the worst of both worlds. `ledger.work_list` builds all three groups on
  // every call regardless of the flags (they gate the RESPONSE, not the work),
  // so this costs payload, not server time.
  //
  // deps is [slug] so ticking a filter does not clear data to null (which
  // would unmount the pane and wipe the user's in-flight reply draft).
  //
  // ⚠ THE TOGGLES STAY IN THE REFRESH KEY even though they no longer change the
  // REQUEST. They are what makes a tick refetch immediately instead of waiting
  // out the five-second poll, and that is load-bearing: the panel keeps a copy
  // of each group, and unticking is how a row that has just left the archive
  // gets replaced by its current self rather than by the copy we cached. Drop
  // them from the key and the stale copy survives on screen until the next
  // poll (caught by §31 of docket.test.tsx).
  const data = usePolled(() => getWorkItems(slug, true, true),
    [slug], 5000, `${bump}-${showArchived}-${showBacklog}`)

  useEffect(() => {
    if (!data?.archived && !data?.backlogged) return
    setCache((c) => ({
      slug,
      archived: data.archived ?? (c.slug === slug ? c.archived : []),
      backlog: data.backlogged ?? (c.slug === slug ? c.backlog : []),
    }))
  }, [slug, data?.archived, data?.backlogged])

  const facts = useMemo(() => buildNodeFacts(tree?.roots), [tree?.roots])

  const active = data?.items ?? []
  // while a toggle's first fetch is in flight the cached group keeps showing,
  // so the list grows once and never blinks
  const archived = showArchived ? (data?.archived ?? archivedCache) : []
  const backlog = showBacklog ? (data?.backlogged ?? backlogCache) : []
  const archivedCount = data?.counts?.archived ?? archivedCache.length
  const backlogCount = data?.counts?.backlogged ?? backlogCache.length

  const ownerName = useCallback((it: WorkItem) => it.owner?.node ?? UNASSIGNED, [])
  // ⚠ SORTED BEFORE GROUPING, and that ordering is load-bearing. Both
  // `buildSections` and `nestRows` PRESERVE the order they are handed —
  // filtering, first-appearance bucketing and re-parenting all do — so sorting
  // the flat lists here puts siblings in the chosen order inside their parent
  // and inside their group, without either of those two ever growing a
  // comparator of its own.
  const sections = useMemo(
    () => buildSections(groupMode,
                        sortItems(active, sortMode),
                        sortItems(backlog, sortMode),
                        sortItems(archived, sortMode), ownerName),
    [groupMode, sortMode, active, backlog, archived, ownerName])
  const rowCount = sections.reduce((n, s) => n + s.items.length, 0)

  // selection BY ID, not index — the list repolls under the user (G5)
  const selId = sel?.slug === slug ? sel.id : null
  // ⚠ CLEARED BY ANY DELIBERATE SELECTION. The notice answers ONE click; left
  // standing it would reappear the moment the reader deselected a row, long
  // after the reference that caused it.
  const setSelId = useCallback((id: string | null) => {
    setMissedJump(null)
    setSel(id ? { slug, id } : null)
  }, [slug])
  // ⚠ ORDER IS THE POINT. The CURRENT response is written LAST, so it wins over
  // anything held from an earlier one. Written the other way round — caches
  // last — an item that had just been reopened or promoted out of the archive
  // would be overwritten by its own stale archived copy, and the detail pane
  // would show the status and description it used to have (Astra review
  // 2026-09-05).
  const allKnown = useMemo(() => {
    const map = new Map<string, WorkItem>()
    for (const item of archivedCache) map.set(item.slug, item)
    for (const item of backlogCache) map.set(item.slug, item)
    for (const item of (data?.archived ?? [])) map.set(item.slug, item)
    for (const item of (data?.backlogged ?? [])) map.set(item.slug, item)
    for (const item of active) map.set(item.slug, item)
    return map
  }, [active, data?.archived, data?.backlogged, archivedCache, backlogCache])
  const cur = allKnown.get(selId ?? '')
  const asksById = new Map<string, AskInfo>((tree.asks ?? []).map((a) => [a.id, a]))

  // ---- names in prose become links to the item or the agent they name
  //
  // Built from `allKnown` and from the tree this panel was handed — exactly
  // what this org served this viewer — so a name from another org is in
  // neither map and is never marked. Same-org by construction, not by a check
  // somebody can forget.
  //
  // ⚠ AGENTS COME FROM `facts`, THE LIVE TREE: only a name that still resolves
  // to somebody links, and the tier it carries is that agent's CURRENT model,
  // which is what a mention navigates to. An agent dissolved out of the tree
  // leaves prose as prose.
  const refIndex = useMemo(
    () => buildMentionIndex(
      allKnown.values(),
      [...facts].map(([id, f]) => [id, f.tier] as const)),
    [allKnown, facts])
  // ---- and the CANONICAL references (`@item:org/slug`) in the same prose
  //
  // ⚠ A SEPARATE ITEM MAP, NOT `refIndex`. That one deliberately merges items
  // and agents into one namespace where a colliding name resolves to the item
  // — the right rule for a bare word. A canonical token has already said which
  // kind it means, so asking the merged map would let the bare-name collision
  // rule overrule an explicit `@agent:` token.
  //
  // ⚠ THE ITEM MAP IS AUTHORITATIVE HERE AND NOWHERE ELSE. This panel holds
  // every item the org served — active, archived and backlogged — so it can
  // say, truthfully, that a named item does not exist. Until the first
  // response lands it says `loading` instead, which is NOT the same claim: an
  // empty map would report every real reference as missing for as long as the
  // fetch takes, which is exactly when the panel is being read.
  //
  // ⚠ `handles` IS DERIVED FROM WHAT IS WIRED UP, NOT DECLARED. Items and
  // agents are always openable here; a document is openable because this
  // component now renders its own reader; mail is openable ONLY when a caller
  // handed down `onOpenMail`. Written as a literal list it would drift the
  // moment one of those callbacks was dropped from a call site, and the chip
  // would keep advertising an opener that no longer exists.
  //
  // ⚠ AND `docs` STAYS UNSET ON PURPOSE. This panel holds no document list, so
  // it must not judge one: `undefined` means "do not judge — the destination
  // will", and the destination is the reader below, which reports "could not
  // load the document: …" from the exact GET. An empty Map here would call
  // every real document missing.
  const refWorld = useMemo<RefWorld>(() => {
    const handles = new Set<RefKind>(['item', 'agent', 'doc'])
    if (onOpenMail) handles.add('mail')
    return {
      org: slug,
      items: data
        ? new Map([...allKnown.keys()].map((s) => [s, s]))
        : 'loading',
      agents: new Map([...facts.keys()].map((id) => [id, id])),
      // ⚠ A NODE'S INBOX IS ONLY REAL IF THE NODE IS. The user's box and the
      // org's box always exist; a NODE box named after somebody this org has
      // never had (or who was dissolved out of the tree) does not, and the
      // route below would have looked it up, found nothing and returned
      // silently — the live-looking control again, one layer down. The tree
      // this panel was handed is the same tree the canvas routes against, so
      // asking it here is the same question, asked before the click.
      mail: (r) => (r.box !== 'node' ? 'ready'
        : facts.has(String(r.node ?? '')) ? 'ready' : 'absent'),
      handles,
    }
  }, [slug, data, allKnown, facts, onOpenMail])
  const [flash, setFlash] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())
  // COLLAPSE IS OPT-IN. Everything starts expanded, because a docket that
  // hides work by default is worse than one that is long; the arrow is how
  // you make it shorter. Per-panel, not persisted — it is a reading posture,
  // not org state.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set<string>())
  const toggleFold = useCallback((name: string) => {
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(name)) next.add(name)
      return next
    })
  }, [])

  const goToItem = useCallback((id: string) => {
    const it = allKnown.get(id)
    if (!it) return           // not ours to show — never a broken selection
    // REVEAL BEFORE SELECT. A backlogged or archived item has no row while its
    // group is filtered out, and selecting an invisible row would look like
    // the link did nothing.
    if (it.archived) setShowArchived(true)
    else if (it.status === 'backlogged') setShowBacklog(true)
    // ⚠ AND OPEN ITS ANCESTORS: a collapsed parent means the row is not on
    // screen, so the link would appear to do nothing.
    const line = ancestorsOf([...allKnown.values()], id)
    if (line.length) {
      setCollapsed((c) => {
        if (!line.some((a) => c.has(a))) return c   // no needless re-render
        const next = new Set(c)
        for (const a of line) next.delete(a)
        return next
      })
    }
    setSel({ slug, id })
    setFlash(id)
  }, [allKnown, slug])

  /** a canonical reference clicked. ONLY the kinds `refWorld.handles` admits
   *  can arrive here — anything else was rendered inert and never became a
   *  button — but the switch is exhaustive anyway, because a silent no-op is
   *  how a control ends up looking live and doing nothing.
   *
   *  ⚠ THE `mail` ARM IS GUARDED BY THE SAME CALLBACK THAT PUT `mail` IN
   *  `handles`, so the two cannot disagree: no callback, no chip, no arm. */
  const openRef = useCallback((r: ResolvedRef) => {
    if (r.ref.kind === 'item') goToItem(r.ref.id)
    else if (r.ref.kind === 'agent') onFocusAgent?.(r.ref.id)
    else if (r.ref.kind === 'doc') setDocView(r.ref.id)
    else if (r.ref.kind === 'mail') onOpenMail?.(r.ref)
  }, [goToItem, onFocusAgent, onOpenMail])

  // the flash is a hint, not a state: it clears itself and never survives to
  // confuse the next visit
  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(null), 1800)
    return () => window.clearTimeout(t)
  }, [flash])

  // scroll AFTER the render that created the row — a freshly revealed group's
  // rows do not exist at the moment the link is clicked. `scrollIntoView` is
  // absent in jsdom and in older engines, hence the guard rather than a call.
  useEffect(() => {
    if (!flash) return
    const el = rows.current.get(flash)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [flash, sections])

  // ⚠ A JUMP WAITS FOR ITS ITEM, then is consumed once. The panel mounts
  // before the first poll answers, so acting immediately would silently do
  // nothing. A name this org does not have is discarded rather than held —
  // it may be unreadable to this viewer, or gone.
  //
  // ⚠ "ONCE" IS ENFORCED HERE, not by the parent clearing the prop: the deps
  // change identity on every poll, so a check on `jumpTo` alone re-fires and
  // drags the selection back each time the user moves it.
  //
  // ⚠ AND A JUMP THAT LANDS ON NOTHING SAYS SO. Discarding it silently left
  // the panel open on "select an item to view it" — the same thing it shows
  // when nobody clicked anything, so a reference to an item this viewer
  // cannot see was indistinguishable from a misclick. Naming the id is safe
  // here in a way naming a mail's subject is not: the id is what the reader
  // just clicked, so it discloses nothing they did not already have.
  // ⚠ THE LATCH IS ON THE REQUEST, NOT ON THE TARGET. Comparing ids alone
  // meant a second deliberate click on the same reference — after the reader
  // had selected something else — was refused as already handled, forever.
  // The latch still exists, because without it every poll re-runs the jump and
  // drags the reader back to a row they had moved away from.
  const doneJump = useRef<string | null>(null)
  const [missedJump, setMissedJump] = useState<string | null>(null)
  useEffect(() => {
    const key = jumpKey(jumpTo, jumpSeq)
    if (!jumpTo || !data || doneJump.current === key) return
    doneJump.current = key
    if (allKnown.has(jumpTo)) { setMissedJump(null); goToItem(jumpTo) }
    else setMissedJump(jumpTo)
    onJumpHandled?.()
  }, [jumpTo, jumpSeq, data, allKnown, goToItem, onJumpHandled])

  const onDismiss = (item: WorkItem) => {
    if (!item.manual_attention) return
    dismissWorkItemAttention(slug, item.slug, item.manual_attention.set_rev)
      .then(() => {
        toast([`dismissed the attention flag on “${item.title}”`])
        setBump((n) => n + 1)
      })
      // 409 (stale set_rev / already cleared) surfaces as an ordinary thrown
      // Error via req() — never a silent no-op or override
      .catch((e: Error) => toast([`error: ${e.message}`]))
  }

  const pickGroup = (m: DocketGroupMode) => { setGroupMode(m); writeGroupMode(m) }
  const pickSort = (m: DocketSortMode) => { setSortMode(m); writeSortMode(m) }

  return (
    <>
    <PinFrame kind="docket" title="Work docket" panel="settings wide docket-modal"
      close={close} onEsc={escClose}>
        {/* One mounted set of controls: inline when wide, disclosed when narrow. */}
        <div className="gallery-head docket-head" onKeyDown={e => {
          // Pinned and detached frames deliberately do not register modal Escape.
          if (e.key === 'Escape' && !e.defaultPrevented && optionsOpen
            && optionsToggle.current?.getClientRects().length) {
            e.preventDefault(); e.stopPropagation(); setOptionsOpen(false); optionsToggle.current.focus()
          }
        }}>
          <h3><DocketIcon fontSize="inherit" /> Work docket</h3>
          {/* user 2026-09-11: the words became the sliders glyph, and the ×
              that sat beside them is gone. That × was this modal's alone — no
              other centred surface here carries one — and it duplicated what
              the frame already provides: the backdrop closes an unpinned
              docket, Escape closes it, and a pinned one gets PinFrame's own
              × in the window bar.
              ⚠ THE LABEL IS NOT DECORATION. With the words gone, `aria-label`
              is the only accessible name this control has; without it the
              button announces as nothing and the disclosure becomes
              unreachable by name. The caret stays because it is what says
              visually that something opens, which `aria-expanded` says only
              to a screen reader. */}
          <button ref={optionsToggle} type="button" className="docket-options-toggle"
            title="View options" aria-label="View options"
            aria-expanded={optionsOpen} aria-controls="docket-view-options"
            onClick={() => setOptionsOpen(open => !open)}>
            <TuneIcon fontSize="inherit" />{optionsOpen ? '\u25b4' : '\u25be'}</button>
          <div id="docket-view-options" className="docket-options" data-open={optionsOpen}
            role="group" aria-label="Docket view options">
          <div className="docket-filterbar">
          <label className="checkline docket-showarchived"
            title="include archived work items — done items an hour after their last docket update, dropped items at once">
            <input type="checkbox" checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
            {archivedCount > 0 && <span className="dim"> · {archivedCount}</span>}
          </label>
          <label className="checkline docket-showbacklog"
            title="include work that has not been approached or approved yet">
            <input type="checkbox" checked={showBacklog}
              onChange={(e) => setShowBacklog(e.target.checked)} />
            Show backlogged
            {backlogCount > 0 && <span className="dim"> · {backlogCount}</span>}
          </label>
          </div>
        <div className="docket-sortbar">
          <label className="dim" htmlFor="docket-group">Arrange</label>
          <select id="docket-group" className="docket-group-select" value={groupMode}
            onChange={(e) => pickGroup(e.target.value as DocketGroupMode)}>
            {GROUP_MODES.map((g) =>
              <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
          <label className="dim" htmlFor="docket-sort">Sort</label>
          <select id="docket-sort" className="docket-group-select" value={sortMode}
            onChange={(e) => pickSort(e.target.value as DocketSortMode)}>
            {SORT_MODES.map((s) =>
              <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          {/* ⚠ THE CAPTION READS THE MODE. It used to be the literal sentence
              "most recently updated first", which was true of the only order
              there was; leaving it there while adding two more would have made
              the panel state an order it was not in. */}
          <span className="dim docket-sort-why">
            {SORT_MODES.find((s) => s.value === sortMode)?.why ?? SORT_MODES[0]!.why}
            {groupMode !== 'none' && ', inside each group'}
          </span>
        </div>
          </div>
        </div>
        <div className="mailpane">
          {!data
            ? <div className="dim pad">loading…</div>
            : rowCount === 0
              ? <div className="dim pad">no work items yet</div>
              : (
                <div className="mailer">
                  <div className="mailer-list">
                    {sections.map((s) => (
                      <div key={s.key}
                        className={'docket-section' + (s.tone ? ' tone-' + s.tone : '')}>
                        {s.heading && (
                          <div className="docket-group-head">
                            {/* an agent's head IS that agent; a status, the
                                backlog, the archive and `Unassigned` are
                                words and stay plain spans */}
                            {s.agent
                              ? <GroupAgentHead agent={s.agent} items={s.items}
                                  facts={facts} onFocusAgent={onFocusAgent}
                                  close={navClose} />
                              : <span>{s.heading}</span>}
                            <span className="dim docket-group-n">{s.items.length}</span>
                          </div>
                        )}
                        {nestRows(s.items, collapsed).map((row) => (
                          <DocketRow key={row.item.slug} item={row.item}
                            ageMode={sortMode} org={slug} toast={toast}
                            selected={row.item.slug === selId}
                            depth={row.depth} kids={row.kids}
                            folded={collapsed.has(row.item.slug)}
                            onFold={() => toggleFold(row.item.slug)}
                            onClick={() => setSelId(
                              row.item.slug === selId ? null : row.item.slug)}
                            onDismiss={onDismiss} facts={facts}
                            onFocusAgent={onFocusAgent} close={navClose}
                            flash={row.item.slug === flash}
                            rowRef={(el) => {
                              if (el) rows.current.set(row.item.slug, el)
                              else rows.current.delete(row.item.slug)
                            }} />
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="mailer-read">
                    {cur
                      ? <DocketPane key={cur.slug} slug={slug} item={cur} toast={toast}
                          asksById={asksById} onDismiss={onDismiss}
                          close={navClose} onFocusAgent={onFocusAgent} facts={facts}
                          refIndex={refIndex} onGoToItem={goToItem}
                          refWorld={refWorld} onOpenRef={openRef}
                          refresh={() => setBump((n) => n + 1)} />
                      : missedJump
                        ? <div className="pad mailer-none docket-nojump">
                            <b>{missedJump}</b> is not an item in this org, or
                            it is not one you can see.
                          </div>
                        : <div className="dim pad mailer-none">select an item to view it</div>}
                  </div>
                </div>
              )}
        </div>
        <div className="docket-foot dim">Done items archive after 1 hour without an update.</div>
    </PinFrame>
    {/* ⚠ A SIBLING, NOT A CHILD. Nested inside the docket's own `.overlay`,
        a click on the reader's backdrop would bubble into the docket's
        backdrop handler and close BOTH. As siblings the reader is simply the
        later element at the same z-index, so it paints on top and keeps its
        clicks to itself. */}
    {docView && (
      // `pinKind` is its OWN pin identity: the canvas can have a reader open
      // at the same time as this one, and one identity would make them one
      // window — same rect, same z, neither movable apart from the other.
      <DocReader pinKind="doc-docket" slug={slug} docId={docView} toast={toast}
        close={() => setDocView(null)}
        // ⚠ THE READER CLOSES BEFORE ITS REFERENCE OPENS, except when the
        // destination IS another document. The item and the agent live
        // BEHIND this overlay, so following one without closing would look
        // like the click did nothing — the same reason every other
        // cross-panel jump in this file closes what it is leaving.
        refs={{ world: refWorld, onOpen: (r) => {
          if (r.ref.kind !== 'doc') setDocView(null)
          openRef(r)
        } }} />
    )}
    </>
  )
}

/** The items ONE agent is answerable for: everything assigned to it, plus
 *  everything it was named to REVIEW (user 2026-09-05: "reviewer desk docket
 *  must expose reviews even if not owner").
 *
 *  ⚠ MATCHED BY NAME, AT ANY GENERATION. An item assigned to `worker` before
 *  a cheap compaction is still `worker`'s work; the generation is what the
 *  row's model chip reasons about, never what decides whose work this is.
 *
 *  Exported and pure so the desk's header chip counts EXACTLY the rows the tab
 *  will show — a chip counting one set beside a list showing another is the
 *  plausible-and-wrong surface this codebase keeps refusing. */
export function agentItems(data: {
  items?: WorkItem[]; archived?: WorkItem[]; backlogged?: WorkItem[]
} | null | undefined, nid: string, includeArchived = false): WorkItem[] | null {
  if (!data) return null
  return [...(data.items ?? []), ...(data.backlogged ?? []),
          ...(includeArchived ? (data.archived ?? []) : [])]
    .filter((it) => it.owner?.node === nid || it.reviewer?.node === nid)
}

/** THE AGENT'S OWN DOCKET — the desk tab (user ruling 2026-09-05 21:07: the
 *  Progress tab's contents are replaced entirely by the items assigned to this
 *  agent).
 *
 *  IT IS THE SAME DOCKET, FILTERED. Every row, every detail pane, the status
 *  vocabulary, the nesting, the reply box and the attention handling are the
 *  modal's own components called with a shorter list — so a rule added to the
 *  docket (a new status, a new column, a new pointer) appears here without
 *  anyone remembering to copy it, and the two can never disagree about what an
 *  item looks like. `docket-modal` rides the wrapper for exactly that reason:
 *  the row styling is scoped to that class, and reusing the class is what
 *  "reuse the layout" means here. It is not inside a modal, and does not
 *  pretend to be — no header, no filter checkboxes, no grouping control.
 *
 *  THE FILTER IS ASSIGNMENT, at ANY generation of the name. An item assigned
 *  to `worker` before a cheap compaction is still assigned to `worker`; the
 *  generation is what the row's chip reasons about, never what decides whether
 *  the work is yours. */
export function AgentDocketView({ slug, nid, mine, facts, toast, onFocusAgent,
  onChanged, showArchived = false, onShowArchived = () => {}, refs }: {
  slug: string
  nid: string
  /** this agent's items, already selected by `agentItems` — null while the
   *  desk's first poll is in flight. The DESK owns the poll, so the header
   *  chip and this tab count the same rows and there is one request, not two. */
  mine: WorkItem[] | null
  facts: Map<string, NodeFacts>
  toast: ToastFn
  onFocusAgent?: (agentId: string) => void
  /** ask the desk to refetch — a dismissal changes the server's copy */
  onChanged?: () => void
  showArchived?: boolean
  onShowArchived?: (show: boolean) => void
  /** THE DESK'S OWN REFERENCE WIRING, passed down whole rather than rebuilt.
   *  Required, not optional: a fallback world here would be a second answer to
   *  the same question on the same desk, and the two would drift. */
  refs: RefRoutes
}) {
  const controlsId = useId()
  const [showBacklog, setShowBacklog] = useState(false)
  const [sortMode, setSortMode] = useState<DocketSortMode>(readSortMode)
  const [groupMode, setGroupMode] = useState<DocketGroupMode>(readGroupMode)
  const [selId, setSelId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set<string>())
  const rows = mine ?? []
  const sections = buildSections(groupMode,
    sortItems(rows.filter(it => !it.archived && it.status !== 'backlogged'), sortMode),
    showBacklog ? sortItems(rows.filter(it => !it.archived && it.status === 'backlogged'), sortMode) : [],
    showArchived ? sortItems(rows.filter(it => it.archived), sortMode) : [],
    it => it.owner?.node ?? UNASSIGNED)
  const byName = useMemo(
    () => new Map(rows.map((it) => [it.slug, it])), [rows])
  const refIndex = useMemo(
    () => buildMentionIndex(byName.values(),
                            [...facts].map(([id, f]) => [id, f.tier] as const)),
    [byName, facts])
  const cur = byName.get(selId ?? '')
  /** THE DESK'S WORLD, WITH EXACTLY ONE ROUTE TAKEN OVER.
   *
   *  ⚠ THIS TAB USED TO BUILD ITS OWN NARROW WORLD (`handles` = item + agent),
   *  and the comment that justified it was wrong twice over. It said the tab
   *  has no document reader and no mailbox, so `doc` and `mail` had nothing
   *  behind them — but the desk builds routes for BOTH (`deskRoutes` in
   *  desk.tsx) and already renders its own message bodies against them, so one
   *  desk answered the same `@doc:`/`@mail:` token two ways: a live control in
   *  the chat, inert text in this tab. The capability was one prop away the
   *  whole time. It also judged `items` against this agent's own rows alone,
   *  which reported a real item somebody else owns as `absent` — "no docket
   *  item named X in this org" — a statement about the DATA caused by a limit
   *  of the PANEL, which is the exact mistake `RefWorld` warns about.
   *
   *  So the world is the desk's, unchanged, and only the ITEM CLICK is
   *  overridden below. `items` stays the desk's `undefined` ("do not judge —
   *  the destination will"), `destination` stays the desk's own (a bare desk
   *  is nobody's destination and its names must still navigate), and `handles`
   *  gains `item` because this tab can always open one: its own rows itself,
   *  anything else through the desk's work route. */
  const refWorld = useMemo<RefWorld>(() => ({
    ...refs.world,
    handles: refs.world.handles
      ? new Set<RefKind>([...refs.world.handles, 'item'])
      : undefined,
  }), [refs.world])
  /** An item this tab HOLDS selects in place — the row is right there, and
   *  navigating the whole canvas to the Work panel to show a row already on
   *  screen is the surprising behaviour. Anything else is the desk's, which is
   *  where `doc`, `mail`, `agent` and a foreign or unheld item all go.
   *
   *  ⚠ THE ORG IS CHECKED BEFORE THE MAP. Two orgs can hold the same slug, and
   *  `byName` is keyed by slug alone, so a token from elsewhere that happened
   *  to match would select a DIFFERENT item and look like it had worked.
   *  `resolveRef` already renders such a token `foreign`, but a click can still
   *  arrive from a keyboard or an older chip, so the refusal lives here too. */
  const openRef = useCallback((r: ResolvedRef) => {
    if (r.ref.kind === 'item' && r.ref.org === slug && byName.has(r.ref.id)) {
      setSelId(r.ref.id)
      return
    }
    refs.onOpen(r)
  }, [refs, slug, byName])
  const toggleFold = useCallback((name: string) => {
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(name)) next.add(name)
      return next
    })
  }, [])
  const onDismiss = (item: WorkItem) => {
    if (!item.manual_attention) return
    dismissWorkItemAttention(slug, item.slug, item.manual_attention.set_rev)
      .then(() => {
        toast([`dismissed the attention flag on “${item.title}”`])
        onChanged?.()
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
  }
  return (
    <div className="msgs docket-modal docket-agent">
      <div className="docket-filterbar">
      <label className="checkline docket-showarchived">
        <input type="checkbox" checked={showArchived}
          onChange={(e) => onShowArchived(e.target.checked)} />
        Show archived
      </label>
      <label className="checkline docket-showbacklog">
        <input type="checkbox" checked={showBacklog} onChange={e => setShowBacklog(e.target.checked)} />
        Show backlogged
      </label>
      </div>
      <div className="docket-sortbar">
        <label className="dim" htmlFor={controlsId + '-group'}>Arrange</label>
        <select id={controlsId + '-group'} className="docket-group-select" value={groupMode}
          onChange={e => { const mode=e.target.value as DocketGroupMode; setGroupMode(mode); writeGroupMode(mode) }}>
          {GROUP_MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select>
        <label className="dim" htmlFor={controlsId + '-sort'}>Sort</label>
        <select id={controlsId + '-sort'} className="docket-sort-select" value={sortMode}
          onChange={e => { const mode=e.target.value as DocketSortMode; setSortMode(mode); writeSortMode(mode) }}>
          {SORT_MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select>
        <span className="dim docket-sort-why">{SORT_MODES.find(mode => mode.value === sortMode)?.why}
          {groupMode !== 'none' && ', inside each group'}</span>
      </div>
      {mine === null
        ? <div className="dim pad">loading…</div>
        : sections.length === 0
          ? <div className="dim pad">
              no docket items are assigned to {nid} — assignment is ownership,
              so this is everything it is responsible for
            </div>
          : (
            <div className="mailer">
              <div className="mailer-list">
                {sections.map(section => <div key={section.key}
                  className={'docket-section' + (section.tone ? ' tone-' + section.tone : '')}>
                  {section.heading && <div className="docket-group-head">{section.heading}
                    <span className="dim docket-group-n">{section.items.length}</span></div>}
                {nestRows(section.items, collapsed).map((row) => (
                  <DocketRow key={row.item.slug} item={row.item}
                    org={slug} toast={toast} ageMode={sortMode}
                    selected={row.item.slug === selId}
                    depth={row.depth} kids={row.kids}
                    folded={collapsed.has(row.item.slug)}
                    onFold={() => toggleFold(row.item.slug)}
                    onClick={() => setSelId(
                      row.item.slug === selId ? null : row.item.slug)}
                    onDismiss={onDismiss} facts={facts}
                    onFocusAgent={onFocusAgent} />
                ))}
                </div>)}
              </div>
              <div className="mailer-read">
                {cur
                  ? <DocketPane key={cur.slug} slug={slug} item={cur} toast={toast}
                      asksById={new Map()} onDismiss={onDismiss}
                      close={() => setSelId(null)} onFocusAgent={onFocusAgent}
                      facts={facts} refIndex={refIndex}
                      onGoToItem={(id) => { if (byName.has(id)) setSelId(id) }}
                      refWorld={refWorld} onOpenRef={openRef}
                      refresh={() => onChanged?.()} />
                  : <div className="dim pad mailer-none">select an item to view it</div>}
              </div>
            </div>
          )}
    </div>
  )
}

/** One number per successful copy, anywhere in the docket — see the `id` note
 *  in DocketRow. It only has to DIFFER from the row's previous value, so a
 *  module counter is enough and needs no reset. */
let copyTicket = 0

function DocketRow({ item, selected, onClick, onDismiss, facts, onFocusAgent,
  close, flash, rowRef, depth = 0, kids = 0, folded = false, onFold,
  ageMode = 'updated', org, toast }: {
  item: WorkItem
  selected: boolean
  /** the org slug, for the context menu's "Copy reference" (`@item:org/slug`);
   *  omitted, the entry is absent rather than a token with a guessed org */
  org?: string
  /** the surface's toast, for the menu's copy confirmations */
  toast?: ToastFn
  /** which clock the row's age reads — the list's sort mode, so the number
   *  beside a row agrees with the order it sits in. The agent docket is served
   *  in updated order and has no selector, so it takes the default. */
  ageMode?: DocketSortMode
  /** w2d5fab0a elements 1 and 2: how deep this row sits, and whether it has
   *  children of its own to fold away. The connecting lines are drawn from
   *  `depth` in CSS rather than with spacer elements. */
  depth?: number
  kids?: number
  folded?: boolean
  onFold?: () => void
  onClick: () => void
  onDismiss: (item: WorkItem) => void
  facts: Map<string, NodeFacts>
  onFocusAgent?: (agentId: string) => void
  close?: () => void
  /** briefly true after a slug link brought the reader here, so the row the
   *  link meant is identifiable among rows that all look alike */
  flash?: boolean
  rowRef?: (el: HTMLDivElement | null) => void
}) {
  const attention = item.effective_attention
  // active (white) / attention (orange) / backlog (its own quiet colour) /
  // archived (grey, darker bg). Archived wins over backlog, and attention wins
  // over both — the backend never hands us an archived attention row, but the
  // precedence is written here so the row cannot be ambiguous either way.
  const state = item.archived
    ? 'archived'
    : attention
      ? 'attention'
      : item.status === 'backlogged' ? 'backlog' : 'active'
  const cls = ['mailrow', 'docket-row', state, 'status-' + item.status,
    selected ? 'on' : '', flash ? 'docket-flash' : '',
    depth > 0 ? 'docket-child' : '',
    kids > 0 ? 'docket-parent' : ''].filter(Boolean).join(' ')
  const label = attention ? 'Needs attention' : statusLabel(item.status)
  // Dismiss clears the MANUAL flag only — a question-only attention item has
  // nothing to dismiss (answering the question is the only way to clear it).
  const canDismiss = item.attention_sources.includes('manual')
  // DOUBLE-CLICK COPIES THE SLUG (user 2026-09-07 15:41Z). `Copied!` appears
  // only after the write RESOLVES: a clipboard that is absent, blocked or
  // denied says nothing rather than lying about what is on the clipboard.
  //
  // The position is stored as FRACTIONS of the row's box, not as pixels. This
  // modal renders in more than one place — the app's own overlay, a portal,
  // and a popped-out window — and inside the canvas a CSS `transform: scale()`
  // applies, under which `getBoundingClientRect()` is scaled while an
  // absolutely positioned child is laid out unscaled. A ratio cancels the
  // scale, so the bubble lands under the pointer in all of them.
  //
  // ⚠ TWO SEPARATE THINGS MAKE A REPEAT AT THE SAME PIXEL WORK, and they are
  // easy to confuse (root review 2026-09-07 16:32Z; the first cut stored a
  // bare number and had neither):
  //   * the state is an OBJECT, so a second success is never `Object.is` the
  //     first even at identical coordinates. React therefore does not bail
  //     out, the effect below re-runs, and the timer restarts — without this
  //     the first copy's timer would still fire and clear the second message.
  //   * `id` differs every time and the element is KEYED on it, so React
  //     remounts the span and the CSS animation replays from the start.
  //     Without it the bubble would sit there mid-animation, already faded.
  // Measured: a mutant that freezes `id` keeps the timer restart and loses
  // only the replay, which is why the suite checks the animation's own clock.
  const [copied, setCopied] = useState<{ id: number; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 900)
    return () => clearTimeout(t)
  }, [copied])
  // the write and the bubble, shared by the double-click and the context
  // menu's "Copy slug" (which anchors the bubble at the press that opened it)
  const copySlugAt = (row: HTMLElement, clientX: number, clientY: number) => {
    // the row's OWN window, not the global one: in a popped-out surface the
    // module-level `navigator` belongs to the opener (the same house pattern
    // as shared.ts's copyCodeFromEvent and deskhosts.tsx)
    const clip = row.ownerDocument.defaultView?.navigator?.clipboard
    if (!clip) return
    const rect = row.getBoundingClientRect()
    const ratio = (value: number, size: number) =>
      size ? Math.min(1, Math.max(0, value / size)) : 0.5
    const x = ratio(clientX - rect.left, rect.width)
    const y = ratio(clientY - rect.top, rect.height)
    // the EXACT slug off the item — never the rendered text
    void clip.writeText(item.slug)
      .then(() => setCopied({ id: ++copyTicket, x, y }))
      .catch(() => {})
  }
  const copySlug = (e: React.MouseEvent<HTMLDivElement>) => {
    // an embedded control owns its own double-click. `stopPropagation` on
    // those buttons' `click` does NOT stop `dblclick`, so the guard is here.
    if ((e.target as Element | null)?.closest?.(
      'button, input, textarea, select, a, .docket-copied')) return
    copySlugAt(e.currentTarget, e.clientX, e.clientY)
  }
  // THE ROW'S CONTEXT MENU (contextmenu.tsx, 2026-09-07). Every entry is a
  // thing this row or its pane already does: select (the click), copy the
  // slug (the double-click), fold (the arrow), open the owner (the actor
  // line), dismiss the manual flag (the Dismiss chip). Assigning, changing
  // status, raising the flag and adding a sub-item are agents' own acts
  // through the work tool and have no user-facing control here; the menu
  // does not invent them.
  const menu = useContextMenu()
  const rowMenu = (e: React.MouseEvent<HTMLDivElement>): MenuEntry[] => {
    const row = e.currentTarget
    const { clientX, clientY } = e
    const entries: MenuEntry[] = [
      { label: selected ? 'Close details' : 'Open details', onSelect: onClick },
    ]
    if (kids > 0 && onFold) {
      entries.push({ label: folded ? `Show ${kids} sub-item${kids === 1 ? '' : 's'}`
        : `Hide ${kids} sub-item${kids === 1 ? '' : 's'}`, onSelect: onFold })
    }
    const owner = item.owner?.node
    if (owner && onFocusAgent) {
      // the actor line's own rule: the jump is offered whenever a handler
      // exists (a retired node still has a desk to show); the fit's reason
      // rides the tooltip exactly as it does on the name
      const why = FIT_WHY[actorFit(item.owner, facts).fit]
      entries.push({ label: `Open owner (${owner})`, title: why ?? undefined,
        onSelect: () => { close?.(); onFocusAgent(owner) } })
    }
    entries.push('sep', { label: 'Copy slug', onSelect: () => copySlugAt(row, clientX, clientY) })
    if (org) {
      const ref = refToken({ kind: 'item', org, id: item.slug })
      entries.push({ label: 'Copy reference', title: ref,
        onSelect: () => { void copyToClipboard(row, ref).then((ok) =>
          toast?.([ok ? `copied the reference ${ref}` : 'could not copy — clipboard unavailable'])) } })
    }
    if (canDismiss) {
      entries.push('sep', { label: 'Dismiss attention flag', onSelect: () => onDismiss(item),
        title: 'clear this manually-raised flag' })
    }
    return entries
  }
  return (
    // THE NAME IN THE LIST IS THE SLUG (user 2026-09-05). The full descriptive
    // title is printed only in the detail pane; here it is the row's hover
    // title, so nothing is lost and the row stays one line of name.
    <div className={cls} title={item.title} onClick={onClick}
      onDoubleClick={copySlug} ref={rowRef}
      onContextMenu={(e) => menu.open(e, () => rowMenu(e))}
      style={depth ? { '--docket-depth': depth } as React.CSSProperties : undefined}>
      {menu.node}
      {copied && (
        <span key={copied.id} className="docket-copied" role="status"
          style={{ left: `${copied.x * 100}%`, top: `${copied.y * 100}%` }}>Copied!</span>
      )}
      <div className="l1">
        {/* TWO SEPARATE CLICK TARGETS (the approved design's own note): the
            arrow folds, the row selects. A parent's own details stay reachable
            even when it has children, so folding is never the only thing a
            click on a parent can do. */}
        {kids > 0 && (
          <button className={'docket-fold' + (folded ? ' folded' : '')}
            title={folded ? `show ${kids} sub-item${kids === 1 ? '' : 's'}`
              : `hide ${kids} sub-item${kids === 1 ? '' : 's'}`}
            aria-expanded={!folded}
            onClick={(e) => { e.stopPropagation(); onFold?.() }}>▾</button>
        )}
        <span className="mfrom docket-rowname">{itemName(item)}</span>
        {folded && kids > 0 && (
          <span className="dim docket-subcount" title="Direct sub-items in this view">
            {kids} sub-item{kids === 1 ? '' : 's'}
          </span>
        )}
        {(() => { const age = rowAge(item, ageMode)
          return <span className="mtime" title={age.title} aria-label={age.title}>{age.text}</span> })()}
      </div>
      <div className="l2">
        <span className={'docket-status status-' + item.status + (attention ? ' attention' : '')}
          title={attention ? undefined : statusHelp(item.status)}>
          {label}
        </span>
        {/* THE ASSIGNMENT, where the last updater used to be (user ruling
            2026-09-05: assignment is ownership, and it is what the docket
            names). An unowned item says so in words rather than leaving the
            slot blank, because an empty slot reads as "loading". */}
        <span className="docket-updater">
          {item.owner
            ? <ActorName actor={item.owner} facts={facts}
                onFocusAgent={onFocusAgent} close={close} />
            : <span className="dim">{UNASSIGNED}</span>}
        </span>
        {item.status === 'review' && item.reviewer?.node && (
          <span className="docket-reviewer">
            <span className="dim">Reviewer: </span>
            <ActorName actor={item.reviewer} facts={facts}
              onFocusAgent={onFocusAgent} close={close} />
          </span>
        )}
        {canDismiss && (
          <button className="badge docket-dismiss" title="clear this manually-raised flag"
            onClick={(e) => { e.stopPropagation(); onDismiss(item) }}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}

function DocketList({ heading, items, refIndex, onGoToItem, onGoToAgent, mark,
  refWorld, onOpenRef }: {
  heading: string
  items: string[]
  refIndex: MentionIndex
  onGoToItem?: (id: string) => void
  onGoToAgent?: (id: string) => void
  refWorld: RefWorld
  onOpenRef?: (r: ResolvedRef) => void
  /** w2d5fab0a element 4: the two progress lists get DIFFERENT bullets —
   *  a tick for what is finished, an arrow for what is still ahead. They sit
   *  one under the other and read as one wall of dots otherwise, and which
   *  list an entry is in is the single most important thing about it. */
  mark: 'done' | 'next'
}) {
  return (
    <div className="docket-list">
      <div className="docket-list-heading dim">{heading}</div>
      {items.length === 0
        ? <div className="dim docket-list-empty">None</div>
        : <ul className={'docket-list-items mark-' + mark}>
            {items.map((t, i) => (
              <li key={i}>
                <RefProse text={t} world={refWorld} onOpen={onOpenRef}
                  index={refIndex} onPick={onGoToItem} />
              </li>
            ))}
          </ul>}
    </div>
  )
}


/** the ATTACHMENTS section of the pane (user feature 2026-09-10): files and
 *  images ON the ticket itself. Images reuse the chat's own AttachThumb
 *  (bounded thumbnail, lightbox on click, download); everything else is the
 *  established attach-chip download link. Adding uses the same raw-body
 *  upload contract as the chat composer; removal is PERMANENT (record and
 *  bytes both), and the ✕ says so. */
function DocketAttachments({ slug, item, toast, refresh }: {
  slug: string
  item: WorkItem
  toast: ToastFn
  refresh: () => void
}) {
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const atts = item.attachments ?? []
  const add = (file: File) => {
    setBusy(true)
    uploadWorkItemAttachment(slug, item.slug, file)
      .then(() => refresh())
      .catch((e: Error) => toast([`attach ${file.name}: ${e.message}`]))
      .finally(() => setBusy(false))
  }
  const remove = (aid: string, name: string) => {
    deleteWorkItemAttachment(slug, item.slug, aid)
      .then(() => { toast([`removed ${name}`]); refresh() })
      .catch((e: Error) => toast([`remove ${name}: ${e.message}`]))
  }
  return (
    // NOT `.docket-list`: that class means "one of the two progress lists"
    // to tests and styles alike (§6 counts exactly two); this section keeps
    // the same margins via its own rule
    <div className="docket-attachments">
      <div className="docket-list-heading dim">ATTACHMENTS</div>
      {atts.length > 0 && (
        <div className="attach-row">
          {atts.map((a) => {
            const href = workItemAttachmentUrl(slug, item.slug, a.id)
            return isImg(a.name)
              ? <AttachThumb key={a.id} href={href} name={a.name}
                  meta={fmtBytes(a.bytes)}
                  removeTitle="remove from this item — permanent"
                  onRemove={() => remove(a.id, a.name)} />
              : <a key={a.id} className="attach-chip" href={href}
                  download={a.name} title="download">
                  <DownloadIcon fontSize="inherit" /> {a.name}
                  <span className="dim"> {fmtBytes(a.bytes)}</span>
                  <button className="chip-x" title="remove from this item — permanent"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation()
                      remove(a.id, a.name) }}>
                    <CloseIcon fontSize="inherit" /></button>
                </a>
          })}
        </div>
      )}
      <button type="button" className="badge docket-attach-add" disabled={busy}
        title="attach images or files to this item"
        onClick={() => fileRef.current?.click()}>
        {busy ? 'attaching…' : 'Attach files…'}</button>
      <input type="file" ref={fileRef} style={{ display: 'none' }} multiple
        aria-label="attach files to this item"
        onChange={(e) => {
          [...(e.target.files ?? [])].forEach(add)
          e.target.value = ''
        }} />
    </div>
  )
}

function DocketPane({ slug, item, toast, asksById, onDismiss, close, onFocusAgent,
  facts, refIndex, onGoToItem, refWorld, onOpenRef, refresh }: {
  slug: string
  item: WorkItem
  toast: ToastFn
  asksById: Map<string, AskInfo>
  onDismiss: (item: WorkItem) => void
  close: () => void
  onFocusAgent?: (agentId: string) => void
  facts: Map<string, NodeFacts>
  refIndex: MentionIndex
  onGoToItem?: (id: string) => void
  refWorld: RefWorld
  onOpenRef?: (r: ResolvedRef) => void
  /** immediate list refetch after an attachment mutation — the 5 s poll
   *  alone would leave the pane showing the pre-mutation copy */
  refresh: () => void
}) {
  const attention = item.effective_attention
  const label = attention ? 'Needs attention' : statusLabel(item.status)
  const canDismiss = item.attention_sources.includes('manual')
  const assignee = item.owner
  // The server includes archived predecessors which are absent from tree roots.
  // An older server can still display participants, but cannot route to them.
  const recipients = item.reply_recipients ?? [
    ...(assignee ? [{ node: assignee.node, role: 'owner' as const,
      state: item.owner_state === 'missing' ? 'missing' as const
        : item.owner_state === 'retired' ? 'retired' as const : 'live' as const }] : []),
    ...item.participants.filter((node) => node !== assignee?.node).map((node) => ({
      node, role: 'participant' as const, state: 'missing' as const,
    })),
  ]
  const participants = recipients.filter((r) => r.role === 'participant')
  // This pane is keyed by ticket slug. Polling must never redirect a draft.
  const [replyTo, setReplyTo] = useState(assignee?.node ?? '')
  const [replyBusy, setReplyBusy] = useState(false)
  const [recipientOpen, setRecipientOpen] = useState(false)
  const recipientSearch = useRef({ text: '', at: 0 })
  // Join the owning window's overlay stack: Escape closes this menu first.
  useEsc(() => setRecipientOpen(false), recipientOpen)
  const currentOwner = useRef(assignee?.node ?? '')
  currentOwner.current = assignee?.node ?? ''
  const recipient = recipients.find((r) => r.node === replyTo)
  const unavailable = !recipient || recipient.state === 'missing'
  const showRecipientPicker = participants.length > 0 || !replyTo
    || (!!replyTo && replyTo !== assignee?.node)
  const manualAttn = item.manual_attention
  // the state's own information, chosen BY THE CURRENT STATUS rather than by
  // whichever field happens to be populated: a stale value must never be
  // rendered as if it described where the item stands now
  const stateInfo =
    item.status === 'blocked'
      // a row recorded as `waiting` before the state was removed (user
      // 2026-09-07) arrives as blocked with legacy_status set and its
      // reason already carried into blocked_reason by the backend
      ? { heading: item.legacy_status === 'waiting'
            ? 'BLOCKED BECAUSE (recorded as waiting before 2026-09-07)'
            : 'BLOCKED BECAUSE',
          text: item.blocked_reason ?? '' }
      : item.status === 'waiting'
        // an OLDER backend that still serves the word: show what it sent
        ? { heading: 'WAITING FOR', text: item.waiting_reason ?? '' }
        : item.status === 'dropped'
          // the heading says the outcome, not just the field name: `Dropped`
          // is the status word, and what the reader needs beside it is that
          // this work ENDED and was not completed
          ? { heading: 'ENDED WITHOUT COMPLETING — WHY',
              text: item.dropped_reason ?? '' }
          : null
  // as an actor line does: close first, or the desk opens behind this modal
  const goToAgent = onFocusAgent
    ? (id: string) => { close(); onFocusAgent(id) }
    : undefined
  return (
    <>
      {/* THE ONLY PLACE THE FULL DESCRIPTIVE TITLE IS PRINTED (user
          2026-09-05) — the list is named by slug alone. */}
      <div className="mailer-head docket-pane-head">
        <b>{item.title || '(untitled)'}</b>
        <span className="spacer" />
        
        {canDismiss && (
          <button className="badge docket-dismiss" onClick={() => onDismiss(item)}>
            Dismiss
          </button>
        )}
      </div>
      <div className={'dim docket-pane-sub' + (attention ? ' docket-pane-sub-attn' : '')}>
        <span className={'docket-status status-' + item.status + (attention ? ' attention' : '')}
          title={attention ? undefined : statusHelp(item.status)}>
          {label}
        </span>
        <SlugText item={item} />
        {' · Updated ' + ago(item.docket_at ?? item.at)}
        {/* ASSIGNED TO, not "updated by": the docket names who HOLDS the item.
            Who wrote the latest status is history and stays in the history
            rows, where it is one entry among the others rather than the line
            the eye lands on. */}
        {assignee?.node && (
          <>
            {' · Assigned to '}
            <ActorName actor={assignee} facts={facts}
              onFocusAgent={onFocusAgent} close={close} />
          </>
        )}
        {item.status === 'review' && item.reviewer?.node && (
          <>
            {' · Reviewer '}
            <ActorName actor={item.reviewer} facts={facts}
              onFocusAgent={onFocusAgent} close={close} />
          </>
        )}
      </div>
      {participants.length > 0 && (
        <div className="docket-participants">
          <span className="dim">Participants</span>
          {participants.map((r) => (
            <span className="docket-participant" key={r.node}>
              <ActorName actor={{ node: r.node, generation: 0 }} facts={facts}
                availability={r.state} onFocusAgent={onFocusAgent} close={close} />
              {r.state !== 'live' && <span className="dim">
                {r.state === 'retired' ? '(retired)' : '(unavailable)'}
              </span>}
            </span>
          ))}
        </div>
      )}
      {/* THE DESCRIPTION, first thing in the pane (user 2026-09-05): the
          problem currently faced, then the proposed solution. Mandatory on
          every item created from now on; older items may genuinely have none,
          and that is said plainly rather than papered over. */}
      <div className="docket-desc">
        <div className="docket-list-heading dim">DESCRIPTION</div>
        {item.objective
          ? <div className="docket-desc-body">
              <RefProse text={item.objective} world={refWorld}
                onOpen={onOpenRef} index={refIndex} onPick={onGoToItem} />
            </div>
          : <div className="dim docket-list-empty">
              no description — this item predates the rule that every item
              states its problem and proposed solution
            </div>}
      </div>
      {/* STATE INFORMATION (user 2026-09-05). Blocked and dropped each owe an
          explanation, so the pane shows the one that belongs to the state the
          item is actually in. Older blocked items may carry none: say that
          rather than render an empty box. Reasons for states the item has
          left are not shown — the backend clears them. */}
      {stateInfo && (
        <div className="docket-desc">
          <div className="docket-list-heading dim">{stateInfo.heading}</div>
          {stateInfo.text
            ? <div className="docket-desc-body">{stateInfo.text}</div>
            : <div className="dim docket-list-empty">
                not recorded — this item entered {item.status} before the rule
                that the state says why
              </div>}
        </div>
      )}
      <DocketList heading="DONE SO FAR" items={item.done_so_far} mark="done"
        refIndex={refIndex} onGoToItem={onGoToItem} onGoToAgent={goToAgent}
        refWorld={refWorld} onOpenRef={onOpenRef} />
      <DocketList heading="WORKING ON / NEXT" items={item.working_on_next}
        mark="next" refIndex={refIndex} onGoToItem={onGoToItem}
        onGoToAgent={goToAgent}
        refWorld={refWorld} onOpenRef={onOpenRef} />
      <DocketAttachments slug={slug} item={item} toast={toast}
        refresh={refresh} />
      {manualAttn && (
        <div className="docket-attention-box">
          <div className="docket-question-head">
            Manual attention from{' '}
            <ActorName actor={manualAttn.by} facts={facts}
              onFocusAgent={onFocusAgent} close={close} />
          </div>
          {/* the reason is written as several lines; a plain <div> ran them together */}
          <div className="docket-attention-body">
            <RefProse text={manualAttn.reason} world={refWorld}
              onOpen={onOpenRef} index={refIndex} onPick={onGoToItem} />
          </div>
        </div>
      )}
      {item.questions.map((q) => {
        const ask = asksById.get(q.ask_id)
        // a batch card may cover tabs from OTHER items too (one agent, one
        // open batch) — the full card still answers ALL its tabs together
        // (Astra ruling: preserve original full-batch answer semantics,
        // never silently submit only the tabs shown here), so a note makes
        // that linkage explicit instead of implying this box is scoped to
        // just this item's tab.
        const otherTabs = ask?.tabs && ask.tabs.length > (q.tabs?.length ?? 0)
        return (
          <div key={q.ask_id} className="docket-question-box">
            <div className="docket-question-head">
              Question from{' '}
              <button className="cc-name cc-name-jump" title={`focus ${q.node}'s desk`}
                onClick={() => { close(); onFocusAgent?.(q.node) }}>
                {q.node}
              </button>
            </div>
            {otherTabs && (
              <div className="dim docket-question-note">
                this batch also covers other items — answering it resolves every tab at once
              </div>
            )}
            {ask
              ? <AskCard ask={ask} slug={slug} toast={toast} />
              : <div className="dim">this question is no longer open</div>}
          </div>
        )
      })}
      {assignee || recipients.length > 0 || replyTo ? (
        <>
          <div className="dim docket-reply-label">
            {showRecipientPicker ? (
              <div className="docket-reply-picker">
                Reply to
                <Select className="docket-reply-select" variant="standard" disableUnderline
                  displayEmpty value={replyTo} disabled={replyBusy}
                  open={recipientOpen} onOpen={() => { recipientSearch.current = { text: '', at: 0 }; setRecipientOpen(true) }}
                  onClose={() => setRecipientOpen(false)}
                  inputProps={{ 'aria-label': 'Reply to' }}
                  SelectDisplayProps={{ 'aria-description': recipient
                    ? `${recipient.role === 'owner' ? 'Assignee' : 'Participant'}${recipient.state === 'retired'
                      ? ' — retired; waits for rehire' : recipient.state === 'missing' ? ' — unavailable' : ''}`
                    : replyTo ? 'Unavailable recipient' : 'Choose a recipient' }}
                  renderValue={(node) => node ? <span className="docket-reply-identity">
                    <AgentName id={node} tier={recipient?.state === 'missing' || !recipient ? undefined : facts.get(node)?.tier} />
                  </span> : 'Choose a recipient'}
                  MenuProps={{ slotProps: {
                    paper: { className: 'docket-reply-menu' },
                    list: { onKeyDownCapture: (e: ReactKeyboardEvent<HTMLUListElement>) => {
                      // The badge has a letter too; typeahead must use the slug.
                      if (e.key.length !== 1 || e.key === ' ' || e.ctrlKey || e.metaKey || e.altKey) return
                      e.preventDefault(); e.stopPropagation()
                      const now = Date.now(), search = recipientSearch.current
                      const prefix = (now - search.at < 500 ? search.text : '') + e.key.toLowerCase()
                      recipientSearch.current = { text: prefix, at: now }
                      const match = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')]
                        .find((option) => option.getAttribute('aria-disabled') !== 'true'
                          && option.dataset.value?.toLowerCase().startsWith(prefix))
                      match?.focus()
                    } },
                  } }}
                  onChange={(e) => setReplyTo(e.target.value)}>
                  {!replyTo && <MenuItem value="" disabled>Choose a recipient</MenuItem>}
                  {replyTo && !recipient && (
                    <MenuItem value={replyTo} disabled aria-label={`${replyTo} — unavailable`}>
                      <AgentName id={replyTo} tier={facts.get(replyTo)?.tier} />
                    </MenuItem>
                  )}
                  {recipients.map((r) => (
                    <MenuItem key={r.node} value={r.node} disabled={r.state === 'missing'}
                      title={`${r.role === 'owner' ? 'Assignee' : 'Participant'}${r.state === 'retired'
                        ? ' — retired; waits for rehire' : r.state === 'missing' ? ' — unavailable' : ''}`}
                      aria-label={`${r.node}, ${r.role === 'owner' ? 'assignee' : 'participant'}${r.state === 'retired'
                        ? ', retired; waits for rehire' : r.state === 'missing' ? ', unavailable' : ''}`}>
                      <AgentName id={r.node} tier={r.state === 'missing' ? undefined : facts.get(r.node)?.tier} />
                    </MenuItem>
                  ))}
                </Select>
              </div>
            ) : <>
              Reply to{' '}
              <ActorName actor={assignee} facts={facts}
                onFocusAgent={onFocusAgent} close={close} />
              {' · assigned to this item'}
            </>}
          </div>
          {unavailable && <div className="dim docket-reply-note" role="status">
            {replyTo ? `${replyTo} is unavailable. Choose a recipient to send this draft.`
              : 'Choose a recipient to send this draft.'}
          </div>}
          {recipient?.state === 'retired' && <div className="dim docket-reply-note">
            {recipient.node} is retired — the reply waits for rehire.
          </div>}
          <MailReplyBox target={replyTo || undefined} slug={slug} toast={toast} sendDisabled={unavailable}
            onSend={(text, attachments) => {
              if (unavailable) return Promise.reject(new Error('Recipient unavailable'))
              setReplyBusy(true)
              return replyWorkItem(slug, item.slug, text, replyTo, attachments)
                .then((r) => {
                  const sentTo = r.to ?? replyTo
                  toast([r.deferred
                    ? `${sentTo} is archived — the reply waits for rehire`
                    : `sent to ${sentTo}`, ...(r.warnings ?? [])])
                  setReplyTo(currentOwner.current)
                })
                .catch((e: Error) => {
                  toast([`error: ${e.message}`])
                  throw e
                })
                .finally(() => setReplyBusy(false))
            }} />
        </>
      ) : (
        <div className="dim docket-reply-label">
          nobody is assigned to this item — there is nobody to reply to
        </div>
      )}
    </>
  )
}
