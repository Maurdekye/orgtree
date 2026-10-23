import { DocumentDownload } from './download'
// canvas/gallery.tsx — FR-03 org-wide presented-document list.
//
// The per-node chips on the canvas are how a card is noticed the moment it
// arrives. This is how it is found an hour later: one toolbar-launched panel
// over the available entries in the flat `documents` list (eviction log rows
// have no readable content and stay out), not a second store or a tree walk.
//
// SHAPED ON THE MAIL UI, which the user named as the reference (2026-09-03:
// "the gallery ui should probably resemble the mail ui: a list of entries on
// the left with their titles, submitted agent, and submission time, and a
// the scrollable document viewer on the right"). It wears mail's own
// classes — `.mailer` / `.mailer-list` / `.mailrow` / `.mailer-read` — and
// selection BY IDENTITY (the list repolls under you), the newest visible
// oldest unread/changed document selected on open (newest when all read).
// Every opening also includes the newest end, independently of that selection.
// It does NOT reuse MailList itself: that component is built on MailRow
// (sender, kind, an inline body, replies, notice piles) and a document row
// is a title + agent + time whose body is fetched on click. Sharing the
// look without pretending the data is mail is the honest half.
//
// The BODY half is shared for real: `useDoc` + `dismissDoc` from docs.tsx
// are the same fetch and the same dismiss the overlay reader uses.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { DocRow } from '../api'
import { fileBase, mockupUrl } from '../api'
import { onLiveBump } from '../livebus'
import { ReplySelectionSurface } from './replyselection'
import type { SelectionTarget } from '../replySelection'
type PresentationReplyTarget = ReplyTarget | SelectionTarget | (ReplyTarget | SelectionTarget)[]
import { sendLinkedReply } from '../events/reply'
import type { ReplyTarget } from '../generated/events'
import type { ToastFn, TreeNode } from '../types'
import { CloseIcon, DocIcon } from '../icons'
import type { LoadedDoc } from './docs'
import { dismissDoc, MockupBadge, MockupOpen, presentationMenu, useDoc } from './docs'
import { docUnread, useDocViewedVersion } from './docviewed'
import { useContextMenu } from './contextmenu'
import { objectTooltipProps } from './objecttooltip'
import { PinFrame, raisePinnedModal } from './modalpin'
import { useReaderHandle } from './readers'
import { lastReaderItem, readerScope, rememberReaderItem, resumedReaderItem, useReaderResume, useReaderSelection } from './readeropening'
import { instanceKind } from '../modalkinds'
import { revealDetachedPanel } from '../windowlife'
import type { JumpReq } from './shared'
import { jumpTo as newJump } from './shared'
import { CollapsibleMailer, NARROW_DOCS_WIDTH } from './narrowlist'
import { usePanelSteps } from './panelsteps'
import { RefMdBody } from './refmd'
import type { RefWorld, ResolvedRef } from './reflinks'
import { resolveRef } from './reflinks'
import { openLightboxIfEligibleImage } from './lightbox'
import { fmtFull } from '../timefmt'
import { MailReplyBox } from './mail'
import { ago, md, TIER_LETTER, tierLabel } from './shared'

/** the presenting agent's model card. MOVED to canvas/identity.tsx, which is
 *  now the one place an agent's chip-and-name is drawn; re-exported here so
 *  every existing importer keeps working and no call site had to change to
 *  make the move. */
import { AgentName, TierChip } from './identity'
import { useAgentNavRegistry } from './agentnav'
export { TierChip }

/** why a row is secondary, for the tooltip. NOT a badge any more (user,
 *  2026-09-03: "dont put a big 'retired' card in their row; just grey them
 *  out slightly") — the state is carried by the row's own dimming, and the
 *  words stay available on hover for the case where grey is ambiguous. */
/** a card presented under a project (user 2026-10-18 07:30Z, replacing the
 *  22:47:51Z rule that named only the agent): the PROJECT is its presenter
 *  wherever one is named, and the agent that presented it is named beneath
 *  (`PresentedBy`). An agent's own card names the agent, as before. */
const viaProject = (r: DocRow): boolean => !!r.presented_by && !!r.node && r.presented_by !== r.node
const presenterOf = (r: DocRow): string => viaProject(r) ? r.node : r.presented_by || r.node

function Presenter({ r, onFocus, tierOf }: { r: DocRow; onFocus?: (id: string) => void; tierOf?: (id: string) => string | null | undefined }) {
  const id = presenterOf(r)
  const tier = viaProject(r) || !r.presented_by ? r.tier : r.presenter_tier ?? r.tier
  return <span className="event-actor"><AgentName id={id || '?'}
    tier={tier ?? (id ? tierOf?.(id) : null)}
    onFocus={onFocus && id ? (who) => onFocus(who) : undefined} /></span>
}

/** List identities are text: a press anywhere selects the document. Keep the
 * shared navigable identities in the details pane and the context menu. */
function RowIdentity({ r, tierOf }: { r: DocRow; tierOf?: (id: string) => string | null | undefined }) {
  const owner = presenterOf(r) || '?'
  const tier = viaProject(r) || !r.presented_by ? r.tier : r.presenter_tier ?? r.tier
  return <>
    <span className="event-actor">
      <AgentName id={owner}
        tier={tier ?? (owner !== '?' ? tierOf?.(owner) : null)}
        why={owner}
        nameClass="doc-row-owner" />
    </span>
    {viaProject(r) && <span className="doc-row-attribution dim"
      title={`Presented by ${r.presented_by}`}>by {r.presented_by}</span>}
  </>
}

/** "presented by <agent>" under a project's card; nothing for an agent's own */
function PresentedBy({ r, onFocus, sentence = false, tierOf }: {
  r: DocRow; onFocus?: (id: string) => void; sentence?: boolean; tierOf?: (id: string) => string | null | undefined
}) {
  if (!viaProject(r)) return null
  const id = r.presented_by!
  return <span className="doc-presented-by dim">
    {sentence ? 'this presentation was presented by ' : 'presented by '}
    <span className="event-actor"><AgentName id={id}
      tier={r.presenter_tier ?? tierOf?.(id)}
      onFocus={onFocus ? (who) => onFocus(who) : undefined} /></span>
  </span>
}

const STATE_WHY: Record<DocRow['node_state'], string | null> = {
  live: null,
  archived: 'this agent has been retired',
  unrecoverable: 'this agent is unrecoverable',
  deleted: 'this agent has been deleted',
}

/** the user's rule (2026-09-03): the default list is cards from agents that
 *  are CURRENTLY HIRED. Asked directly whether that should hide the rest —
 *  every card in the live org today is from a retired agent, so the strict
 *  filter opens empty — they chose "default hired + 'show retired'". */
/** the OPEN document repeats that wording — except for a plain retirement.
 *  (user, 2026-09-04: "there's no reason to have a redundant 'this agent has
 *  been retired' in the full view, since that's implied by the entry being
 *  visually separated from the active agent entries".) DELETED and
 *  UNRECOVERABLE stay: the layout separates hired from not-hired, so it
 *  implies retirement, but it does not say which of the three it is. */
const PANE_STATE_WHY: Record<DocRow['node_state'], string | null> =
  { ...STATE_WHY, archived: null }

const isHired = (r: DocRow) => r.node_state === 'live'

/** Same rule for bootstrap/older-server rows and the engine's opening query. */
export function openingPresentation(slug: string, rows: DocRow[], last: string | null = null): string | null {
  const visible = rows.filter(r => !r.evicted)
  const unread = visible.filter(r => docUnread(slug, r.id, r.at, r.viewed_at))
  if (!unread.length) return visible.find(row => row.id === last)?.id ?? visible[0]?.id ?? null
  const candidates = unread
  let chosen = candidates[0]
  for (const row of candidates) {
    if (chosen && (unread.length ? Date.parse(row.at) < Date.parse(chosen.at) : Date.parse(row.at) > Date.parse(chosen.at))) chosen = row
  }
  return chosen?.id ?? null
}

// ── CONTINUOUS LOADING ───────────────────────────────────────────────────
//
// This panel used to carry "Newer" and "Older" buttons over a fixed page.
// Every comparable list in the app loads as you scroll instead — the mail
// list grows its window from `onScroll` (canvas/mail.tsx), the desk transcript
// pages history in at the boundary (convo.ts) — and the user asked for the
// same here.
//
// ⚠ THE WINDOW IS REPLACED, NOT ACCUMULATED PAGE BY PAGE. `documents` is
// newest-first and moves underneath a reader: a card is presented, another is
// dismissed, and an offset that addressed row 100 one poll ago addresses a
// different row the next. docwindow refreshes each loaded range, deduplicates
// their joins and keeps the newest end loaded on every opening. A nearby
// unread target shares one contiguous prefix; a distant target adds its own
// page with an explicit gap that fills as it approaches the viewport. Every
// individual read remains bounded even after the user expands the list.

export { DOC_PAGE } from './docwindow'
import { useDocWindow } from './docwindow'
import type { DocWindow } from './docwindow'
const DOC_EDGE = 240
type OpeningReveal = { id: string; done: boolean }

function unreadReveal(slug: string, rows: DocRow[] | null, id: string | null): OpeningReveal | null {
  const row = rows?.find(r => r.id === id)
  return row && docUnread(slug, row.id, row.at, row.viewed_at) ? {id:row.id,done:false} : null
}

/** The list column both galleries render: the scroller that asks for the next
 *  older page as the reader nears the bottom, and the end marker that says
 *  what the list is doing. Rows are the caller's — the two galleries filter
 *  and decorate their own. */
function LazyDocList({ w, label, children, reveal }: {
  w: DocWindow
  reveal?: OpeningReveal | null
  /** what this scroller IS, announced when it takes focus. It is a tab stop
   *  (see below) and a tab stop with nothing to say is a dead end for anyone
   *  not looking at the screen. */
  label: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  // Opening selection is independent of the newest end we always load. Keep
  // the request outside this list so a remount/poll cannot re-arm it. Capture
  // unread at selection time: the reading pane immediately marks it read.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !reveal || reveal.done) return
    const row = [...el.querySelectorAll<HTMLElement>('.doc-gallery-row.on')]
      .find(r => r.dataset.docId === reveal.id)
    if (!row) return
    const show = () => {
      if (reveal.done || el.clientHeight <= 0) return
      const box = row.getBoundingClientRect()
      if (box.height <= 0) return // hidden/collapsed surfaces wait for layout
      const top = el.getBoundingClientRect().top + el.clientTop
      if (box.top < top) el.scrollTop += box.top - top
      else if (box.bottom > top + el.clientHeight) el.scrollTop += box.bottom - top - el.clientHeight
      reveal.done = true
    }
    show()
    if (reveal.done) return
    const Observer = (el.ownerDocument.defaultView as (Window & typeof globalThis) | null)?.ResizeObserver
      ?? globalThis.ResizeObserver
    if (!Observer) return
    const observer = new Observer(show)
    observer.observe(el); observer.observe(row)
    return () => observer.disconnect()
  })
  /** ⚠ AN UNMEASURED SCROLLER REPORTS THREE ZEROES, which subtract to "at the
   *  bottom" — and would page the entire history in without a gesture, in
   *  jsdom and in any panel rendered before layout. No measurable box, no
   *  demand. */
  const nearEnd = () => {
    const el = ref.current
    return !!el && el.clientHeight > 0
      && el.scrollHeight - el.scrollTop - el.clientHeight < DOC_EDGE
  }
  const nearGap = () => {
    const el = ref.current
    if (!el || el.clientHeight <= 0) return
    const bounds = el.getBoundingClientRect()
    for (const gap of el.querySelectorAll<HTMLElement>('[data-doc-gap]')) {
      const box = gap.getBoundingClientRect()
      if (box.height > 0 && box.bottom >= bounds.top - DOC_EDGE && box.top <= bounds.bottom + DOC_EDGE) {
        w.fillGap(gap.dataset.docGap!); return true
      }
    }
  }
  // THE LIST CAN BE SHORTER THAN ITS SCROLLER and still have history behind it
  // — "show retired agents" unticked over a window whose hired cards are two,
  // say. No overflow means no scroll event means nothing would ever ask for
  // the next page, so the boundary is re-checked after every commit as well.
  // `grow` is a no-op while a page is in flight, exhausted or failed, so this
  // settles instead of looping.
  useEffect(() => { if (!nearGap() && nearEnd()) w.grow() })
  return (
    // ⚠ A TAB STOP, DELIBERATELY. Scrolling is now the ONLY way to reach older
    // documents — the "Newer"/"Older" buttons this replaced were the two
    // controls a keyboard could reach, and deleting them without putting the
    // scroller in the tab order would take the older half of the history away
    // from anyone not using a pointer. Chromium 127+ makes a scroll container
    // with no focusable children focusable by itself, which would cover the
    // packaged app today — but that is a platform default, not this list's
    // contract, and it evaporates the moment a row gains a focusable child.
    // Stating it here is what makes the keyboard path OURS to keep.
    <div className="mailer-list" ref={ref} tabIndex={0} aria-label={label}
      onScroll={() => { if (!nearGap() && nearEnd()) w.grow() }}>
      {w.newer && <button className="doc-list-newer" onClick={w.growNewer}>Load newer documents</button>}
      {children}
      <DocListEnd w={w} />
    </div>
  )
}

function visibleGaps(w: DocWindow, rows: DocRow[]): Map<string, string> {
  const visible = new Set(rows.map(r => r.id)), result = new Map<string, string>()
  const all = w.rows ?? []
  for (const gap of w.gapBefore) {
    const start = all.findIndex(r => r.id === gap)
    const first = all.slice(start).find(r => visible.has(r.id))
    if (first) result.set(first.id, gap)
  }
  return result
}

function DocRangeGap({ w, id }: { w: DocWindow; id?: string }) {
  return id ? <div className="doc-list-end dim" data-doc-gap={id}>
    <button onClick={() => w.fillGap(id)} disabled={w.busy}>Load documents between these pages</button>
  </div> : null
}

/** What the bottom of the list says, and nothing more than it has to: a page
 *  is on its way, the last one failed and can be asked for again, or that was
 *  the whole history. Silent while there is nothing to report. */
function DocListEnd({ w }: { w: DocWindow }) {
  if (w.error) {
    return (
      <div className="doc-list-end ask-warn" role="alert">
        could not load more documents: {w.error}{' '}
        <button className="doc-list-retry" onClick={w.retry}>Retry</button>
      </div>
    )
  }
  if (w.busy) {
    return <div className="doc-list-end dim" role="status" aria-live="polite">
      loading more documents…</div>
  }
  // the end marker is worth drawing only once there is a list to be at the end
  // of: an empty gallery already says so in the pane beside it
  if (!w.more && (w.rows?.length ?? 0) > 0) {
    return <div className="doc-list-end dim">
      end of the list · {w.total} document{w.total === 1 ? '' : 's'}</div>
  }
  return null
}

/** ⚠ THE FAILURE THAT HAS NO LIST TO SIT UNDER. `DocListEnd` lives inside the
 *  scroller, so it can only speak once there are rows — and the request most
 *  worth reporting is the FIRST one, which leaves none. Both surfaces render
 *  their empty state through here so a panel that could not read the gallery
 *  at all says so, and offers the same way back, instead of sitting on
 *  "loading…" for as long as it is left open. */
function DocListEmpty({ w, className, children }: {
  w: DocWindow; className: string; children: ReactNode
}) {
  if (w.error) {
    return (
      <div className={'ask-warn pad ' + className} role="alert">
        could not load the presented documents: {w.error}{' '}
        <button className="doc-list-retry" onClick={w.retry}>Retry</button>
      </div>
    )
  }
  return <div className={'dim pad ' + className}>{children}</div>
}

export function DocGalleryModal({ slug, toast, close, onFocusAgent, onReply,
  refs, onOpenDocument, jumpTo: shellJump, onJumpHandled }: {
  slug: string
  jumpTo?: { id: string; seq: number } | null
  onJumpHandled?: () => void
  onOpenDocument?: (id: string) => void
  toast: ToastFn
  close: () => void
  onFocusAgent?: (agentId: string) => void
  onReply?: (node: string, text: string, target: PresentationReplyTarget, attachments?: string[], notice?: boolean) => Promise<unknown> | void
  /** canonical references written inside a document, and where they go. A
   *  presented plan names items, agents and the mail it answers; this panel
   *  can open none of those itself, so the shell supplies the routes and
   *  what it does not supply reads as "not opened from here". */
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
}) {
  // THE GLOBAL READER (docket several-instances-of-the-same-modal-team-slots-i,
  // USER 2026-10-20 19:03:28Z): a document opening elsewhere that this reader
  // can show comes here (canvas/readers.ts) as its own jump request, beside
  // the shell's; the newer request wins
  const resume = useReaderResume(slug,'gallery')
  const scope = readerScope('presented',slug)
  const [ownJump, setOwnJump] = useState<JumpReq | null>(() => resume ? newJump(resume) : null)
  const jumpTo = ownJump && (!shellJump || ownJump.seq > shellJump.seq) ? ownJump : shellJump
  const jumpHandled = ownJump && jumpTo === ownJump ? () => setOwnJump(null) : onJumpHandled
  const w = useDocWindow(slug, '', jumpTo?.id ?? '', jumpTo?.seq ?? 0, false, resume === undefined, true)
  const all = useMemo(() => w.rows?.filter(r => !r.evicted), [w.rows])
  const [showRetired, setShowRetired] = useState(false)
  // ONE list, grouped — not two views (user, 2026-09-03: "one tab with a
  // checkbox to show retired agents, which appear in the same list, sorted
  // below the active agents"). The server already returns newest-first, and
  // a stable partition keeps that order WITHIN each group while lifting the
  // hired ones above the retired: two filters, not a comparator, because a
  // sort would have to re-establish the recency order the server just set.
  //
  // Dismissed cards never arrive here at all — the server drops them from
  // `documents`, and the DELETE bumps the livebus so the window above refetches
  // without this panel wiring a refresh of its own.
  const hired = (all ?? []).filter(isHired)
  const retired = (all ?? []).filter((r) => !isHired(r))
  const rows = all && (showRetired ? [...hired, ...retired] : hired)
  const rowGaps = visibleGaps(w, rows ?? [])
  const retiredCt = retired.length
  // ⚠ A FILTER CAN EMPTY THE WINDOW WITHOUT EMPTYING THE HISTORY. The default
  // list is currently-hired agents only, and the newest page can be entirely
  // retired ones — with nothing rendered there is no scroller to reach the
  // bottom of, so LazyDocList's own boundary check never runs and the demand
  // has to come from here. Without it the panel would settle on "no cards have
  // been presented yet" over a gallery that has plenty, which is the exact
  // state the checkbox exists to rescue. `grow` is a no-op while a page is in
  // flight, exhausted or failed, so this walks the history once and stops.
  useEffect(() => { if (rows && rows.length === 0 && w.more) w.grow() })
  // selection is BY ID, not index — the list repolls, and the filter above
  // narrows it, so an index would silently address a different document
  const [selId, setSelId] = useReaderSelection(scope, resume || null)
  const openingReveal = useRef<OpeningReveal | null>(null)
  const opening = useRef({ slug, pending: resume === undefined })
  useEffect(() => {
    if (opening.current.slug !== slug) {
      opening.current = { slug, pending: resume === undefined }
      openingReveal.current = null
      setSelId(resume || null)
      setOwnJump(resume ? newJump(resume) : null)
      return // useDocWindow clears the previous organization's rows too
    }
    if (!opening.current.pending) return
    // An explicit document reference owns selection, even if its lookup is
    // still loading. Clearing the handled jump must not select the newest.
    if (jumpTo) { opening.current.pending = false; return }
    if (w.rows == null) return
    opening.current.pending = false
    const id = w.openingId !== undefined ? w.openingId : openingPresentation(slug, rows ?? [], lastReaderItem(scope))
    openingReveal.current = unreadReveal(slug, w.rows, id)
    setSelId(id)
  }, [slug, rows, jumpTo, w.rows, w.openingId])
  // A JUMP IS ANSWERED BY THE RESPONSE THAT CARRIED IT, which is why the latch
  // compares the request's own `seq` (shared.ts JumpReq) and not the id: a
  // repeat click on the same reference is a new request, an unrelated poll is
  // not. The window has already grown far enough to hold the located row — it
  // reads from zero, so "found" and "in the list" are the same thing now,
  // where the paged list had to move its offset to the row's page first.
  useEffect(() => {
    if (!jumpTo || w.seq !== jumpTo.seq) return
    if (w.error) { toast([w.error]); jumpHandled?.(); return }
    if (w.located !== jumpTo.id) return
    const row = w.rows?.find(r => r.id === jumpTo.id && !r.evicted)
    if (!row) return
    setShowRetired(on => on || !isHired(row))
    setSelId(row.id)
    jumpHandled?.()
  }, [w.rows, w.seq, w.error, w.located, jumpTo, jumpHandled, toast])
  useReaderHandle(slug, { kind: 'global' }, () => selId, (doc) => {
    const row = all?.find(r => r.id === doc)
    if (row) { setShowRetired(on => on || !isHired(row)); setSelId(doc) }
    else setOwnJump(newJump(doc))
    if (!revealDetachedPanel('gallery', slug)) raisePinnedModal('gallery', slug)
  })
  // THE ROW'S CONTEXT MENU (contextmenu.tsx, 2026-09-07): open/close is the
  // row's own select; dismiss is the pane's dismiss (same `dismissDoc`, same
  // toast, same deselect); copy/download come from the shared builder
  const menu = useContextMenu()
  const nodeNav = useAgentNavRegistry()
  const rowMenu = (e: ReactMouseEvent<HTMLElement>, r: DocRow) =>
    presentationMenu(e.currentTarget, slug, r, {
      nodeMenu: (id, el) => nodeNav?.current?.(id, el) ?? [],
      // ⚠ ONE ENTRY, TWO EFFECTS — so it TOGGLES. The label below already said
      // Close on the open row while the action was a plain `openDocument`,
      // which re-selected the row it was already on: no state change, so the
      // menu shut and the document stayed open (user report 2026-09-12). The
      // agent-scoped gallery below has always toggled; this is the same rule.
      // Selecting `null` is exactly how the pane empties — Close is a
      // deselection, never a dismissal, so no card is deleted by it.
      open: () => setSelId((id) => id === r.id ? null : r.id),
      openLabel: r.id === selId ? 'Close' : 'Open',
      toast,
      dismiss: () => dismissDoc(slug, r.id, r.title, toast,
        () => setSelId((id) => id === r.id ? null : id)),
    })
  const openDocument = (id: string) => {
    setSelId(id)
  }
  const cur = rows?.find((r) => r.id === selId)
  useEffect(() => { if (cur) rememberReaderItem(scope,cur.id) }, [scope,cur?.id])
  const steps = usePanelSteps((rows ?? []).map(row => row.id), selId, openDocument, '.doc-gallery-row')
  // ⚠ A DOCUMENT REFERENCING A DOCUMENT STAYS HERE. This panel IS the
  // document reader; sending the reader off to the shell's copy would close
  // the list the reader is part of, to show the same kind of thing somewhere
  // else. Only a document this panel does not list falls through to the
  // shell (which has the exact fetch, and reports what it finds).
  //
  // ⚠ IT MATCHES AGAINST `all`, NOT `rows`. `rows` is the filtered view, so
  // a reference to a RETIRED agent's document would fall through whenever the
  // "show retired" box happened to be unticked — the panel deciding what it
  // holds by what it is currently showing.
  const paneRefs = useMemo(() => (refs && {
    world: refs.world,
    onOpen: (r: ResolvedRef) => {
      if (r.ref.kind === 'doc' && (all ?? []).some((d) => d.id === r.ref.id)) {
        setShowRetired((on) => on || !(all ?? []).some(
          (d) => d.id === r.ref.id && isHired(d)))
        openDocument(r.ref.id)
        return
      }
      refs.onOpen?.(r)
    },
  }) || undefined, [refs, all, onOpenDocument])
  return (
    // same fix as DocReader (docs.tsx) — an eligible image is opened from
    // `onPanelClick`, which the frame runs BEFORE the stopPropagation every
    // other click in the modal still needs to keep the backdrop from closing
    <PinFrame kind="gallery" title="Presented documents" restore={{selection:selId ?? ''}}
      panel="settings wide gallery-modal" close={close}
      onPanelClick={openLightboxIfEligibleImage}>
        <div className="gallery-head">
          <h3><DocIcon fontSize="inherit" /> Presented documents</h3>
          {/* one control, not two views: the retired cards JOIN the list
              below the active ones rather than replacing them. The count
              rides the label so the archive is discoverable even while it
              is hidden — which is doing real work here, because the
              default list is empty whenever no currently-hired agent has
              presented anything. Inline with the header (user ruling,
              accepted docket styling), not its own line below it. */}
          <label className="checkline gallery-showretired">
            <input type="checkbox" checked={showRetired}
              onChange={(e) => setShowRetired(e.target.checked)} />
            Show retired agents
            {retiredCt > 0 && <span className="dim"> · {retiredCt}</span>}
          </label>
        </div>
        <div className="mailpane">
          {all == null || rows!.length === 0
            ? <DocListEmpty w={w} className="">
                {/* ⚠ "EMPTY WINDOW" IS NOT "EMPTY HISTORY" while more is still
                    coming — saying "no cards have been presented yet" over a
                    history the effect above is still walking would be a plain
                    untruth. Once it is exhausted, the count below is the WHOLE
                    gallery's rather than one page's. */}
                {all == null || w.busy || w.more
                  ? 'loading…'
                  : !showRetired && retiredCt > 0
                    ? `no cards from currently-hired agents — ${retiredCt} from `
                      + 'retired ones, behind the checkbox above'
                    : 'no cards have been presented yet'}
              </DocListEmpty>
            : (
                <CollapsibleMailer collapsible threshold={NARROW_DOCS_WIDTH} listLabel="document list"
                  tabIndex={-1} rootRef={steps.rootRef} onKeyDown={steps.onKeyDown}
                  list={
                  <LazyDocList w={w} label="Presented documents" reveal={openingReveal.current}>
                    {menu.node}
                    {rows!.map((r) => (
                      <Fragment key={r.id}><DocRangeGap w={w} id={rowGaps.get(r.id)} /><GalleryEntry slug={slug} row={r}
                        className={'mailrow doc-gallery-row'
                          // `.active`/`.past` — styled in styles.css, scoped
                          // to `.gallery-modal` only (accepted docket
                          // styling supersedes the 2026-09-03 orange-flare
                          // ruling: active rows read white, retired rows
                          // read muted grey)
                          + (isHired(r) ? ' active' : ' past')
                          + (r.id === selId ? ' on' : '')
                          + (r.evicted ? ' evicted' : '')
                          + (r.format === 'html' ? ' doc-mockup' : '')}
                        {...objectTooltipProps('document', r.id, slug)} title={r.title}
                        onClick={() => openDocument(r.id)}
                        onContextMenu={(e) => menu.open(e, () => rowMenu(e, r))}>
                        <div className="l1">
                          <span className="mfrom">{r.title || '(untitled)'}</span>
                          <span className="mtime">{ago(r.at)}</span>
                        </div>
                        <div className="l2" data-copy-agent-name={presenterOf(r) || undefined}>
                          <RowIdentity r={r} tierOf={(id) => refs?.world.tierOf?.(id)} />
                          {r.format === 'html' && <MockupBadge />}
                          {r.evicted && <span className="badge evicted">content evicted</span>}
                        </div>
                      </GalleryEntry></Fragment>
                    ))}
                  </LazyDocList>
                  }>
                  <div className="mailer-read">
                    {cur
                      ? <DocPane key={cur.id} slug={slug} row={cur} toast={toast}
                          onDismissed={() => setSelId(null)}
                          close={close}
                          onFocusAgent={onFocusAgent}
                          onReply={onReply} refs={paneRefs} />
                      : <div className="dim pad mailer-none">
                          select a document to read it</div>}
                  </div>
                </CollapsibleMailer>
              )}
        </div>
    </PinFrame>
  )
}

/** Every format selects its preview inside this collection. HTML execution
 *  is offered separately by the preview's explicit new-tab action. */
function GalleryEntry({ slug, row, children, ...props }: {
  slug: string; row: DocRow; children: ReactNode
  className: string; title: string; onClick: () => void
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void
}) {
  useDocViewedVersion()
  const unread = row.evicted ? null : docUnread(slug, row.id, row.at, row.viewed_at)
  return <div {...props} className={props.className + (unread ? ' unread' : '')}
    data-doc-id={row.id} data-doc-unread={unread ?? undefined}>{children}</div>
}

/** the right-hand viewer: the same fetch and the same dismiss the overlay
 *  reader runs (docs.tsx), in the mail reading pane's chrome. Dismiss lives
 *  HERE rather than on each row (user request 2026-09-03: "allow the
 *  dismissal of them from the viewer directly") — one control, on the thing
 *  you are actually looking at. Title sits on its own separate line; the
 *  dismiss button mirrors the desk view document card (right-aligned chip-x
 *  with CloseIcon).
 *  Agent name links directly to focus the agent (same as switchboard).
 *  A reply box below the body allows messaging the owning agent directly
 *  (only if not retired). */
function DocPane({ slug, row, toast, onDismissed, close, onFocusAgent, onReply,
  onBroadcast, projectBroadcast, refs, preloaded }: {
  preloaded?: LoadedDoc
  slug: string
  row: DocRow
  toast: ToastFn
  onDismissed: () => void
  close: () => void
  onFocusAgent?: (agentId: string) => void
  onReply?: (node: string, text: string, target: PresentationReplyTarget, attachments?: string[], notice?: boolean) => Promise<unknown> | void
  onBroadcast?: (node: string, text: string, target: PresentationReplyTarget, attachments?: string[], notice?: boolean) => Promise<unknown> | void
  projectBroadcast?: { project: string; members: number }
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
}) {
  // an evicted row has no body to fetch — say so instead of spending a
  // request to render the 404 the endpoint would answer with
  const { doc, err } = useDoc(slug, row.evicted ? '' : row.id, preloaded)
  const replyable = !row.evicted && isHired(row) && Boolean(row.node && !row.node.startsWith('@'))
  const tierOf = (id: string) => refs?.world.tierOf?.(id)
  return (
    <>
      <div className="mailer-head doc-pane-head">
        {/* METADATA FIRST, title second (user, 2026-09-04: "swap that row with
            the title row, it should be first, the title second"). */}
        <div className="doc-pane-meta-row">
          {row.node ? (
            <Presenter r={row} tierOf={tierOf} onFocus={onFocusAgent && ((id) => { close(); onFocusAgent(id) })} />
          ) : (
            // no node recorded at all: there is no identity to draw, and
            // inventing one is the thing this panel must not do
            <span className="dim">?</span>
          )}
          {PANE_STATE_WHY[row.node_state] &&
            <span className="dim">{PANE_STATE_WHY[row.node_state]}</span>}
          <span className="dim">{fmtFull(row.at)}</span>
        </div>
        {row.node && <PresentedBy r={row} sentence tierOf={tierOf} onFocus={onFocusAgent && ((id) => { close(); onFocusAgent(id) })} />}
        <div className="doc-pane-title-row">
          <ReplySelectionSurface source={{org:slug,target:{kind:'document',org:slug,id:row.id},part:{part:'document.title'},text:row.title,format:'plain'}}><b>{row.title || '(untitled)'}</b></ReplySelectionSurface>
          {!row.evicted && <DocumentDownload slug={slug} id={row.id} title={row.title} format={row.format} />}
          <span className="spacer" />
          {!row.evicted && (
            <button className="chip-x" title="dismiss"
              onClick={() => dismissDoc(slug, row.id, row.title, toast, onDismissed)}>
              <CloseIcon fontSize="inherit" />
            </button>
          )}
        </div>
      </div>
      {row.evicted
        ? <div className="dim pad">
            the content of this card is gone — later presentations pushed it off
            the list (newest 10 per agent, 100 org-wide are kept). Its title and
            sender survive in the org log, which is why it is still listed here.
          </div>
        : (
          <>
            {err && <div className="ask-warn">could not load the document: {err}</div>}
            {/* relative image srcs resolve against the PRESENTING node's
                files — `![](outbox/chart.png)` embeds a figure that agent saved */}
            {doc?.format === 'html' && <MockupOpen slug={slug} docId={row.id} />}
            {doc && doc.format !== 'html' && <ReplySelectionSurface source={{org:slug,target:{kind:'document',org:slug,id:row.id},part:{part:'document.body'},text:doc.body}}><RefMdBody className="mailer-body md"
              html={md(doc.body, fileBase(slug, doc.node))}
              world={refs?.world} onOpen={refs?.onOpen} /></ReplySelectionSurface>}
            {!doc && !err && <div className="dim pad">loading…</div>}
            {replyable && (
              <MailReplyBox target={row.node} slug={slug} toast={toast} broadcast={projectBroadcast} selectionActions={doc?.format!=='html'}
                onSend={(text, attachments, notice, broadcast, objectTarget, selections) => {
                  const target: PresentationReplyTarget = selections?.length ? [...(objectTarget?[objectTarget]:[]),...selections] : objectTarget ?? { kind: 'document', org: slug, id: row.id }
                  if (broadcast && onBroadcast) return onBroadcast(row.node, text, target, attachments, notice)
                  if (onReply) return onReply(row.node, text, target, attachments, notice)
                  return sendLinkedReply(slug, row.node, text, target, attachments, notice)
                    .then((r) => { if (r.warnings?.length) toast(r.warnings) })
                    .catch((e: Error) => {
                      toast([`error: ${e.message}`])
                      throw e
                    })
                }} />
            )}
          </>
        )}
    </>
  )
}

export interface AgentGalleryViewProps {
  slug: string
  nid: string
  node?: TreeNode | { id: string; documents?: any[] | null; state?: string; tier?: string | null; generation?: number }
  toast: ToastFn
  onFocusAgent?: (agentId: string) => void
  onReply?: (node: string, text: string, target: PresentationReplyTarget, attachments?: string[], notice?: boolean) => Promise<unknown> | void
  onBroadcast?: (node: string, text: string, target: PresentationReplyTarget, attachments?: string[], notice?: boolean) => Promise<unknown> | void
  projectBroadcastMembers?: number
  /** Desk context-menu action: stages a reply to this presentation in the
   *  desk composer (using the same reply-target chip as replying to mail). */
  onReplyToDoc?: (doc: DocRow) => void
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
  onChanged?: () => void
  initialDocument?: string
  initialLoaded?: LoadedDoc
  continuedSelection?: string
  selectedRow?: DocRow
  pinKind?: string
  /** Report the row currently in the reading pane — null when nothing is
   *  selected. Only the modal wrapper passes it, so it can publish what its
   *  WINDOW is showing; the desk's inline gallery has no window and omits it. */
  onShown?: (id: string | null) => void
  /** collapse the list into an overlay panel when the surface is narrow. The
   *  MODAL wrapper sets it; the same view on the agent desk keeps its
   *  persistent column (see CollapsibleMailer). */
  collapsible?: boolean
  /** TEAM presentations (user 2026-10-17 22:47Z): this node's and everyone's
   *  under it, passing through projects. A project's gallery is always so. */
  team?: boolean
  onTeam?: (team: boolean) => void
  /** Desk filter; omitted by standalone readers to preserve their view. */
  showRetired?: boolean
  onShowRetired?: (show:boolean) => void
  /** a document to show, located by the list itself (a REQUEST: a repeat is
   *  a new one) — a reader asked to show a document it can show */
  jumpTo?: JumpReq | null
}

/** Agent-scoped presentation gallery opened from a card action.  The list and
 * reader remain AgentGalleryView's single implementation; this wrapper only
 * gives that view the same movable/pinnable shell as inbox and docket. */
export function AgentGalleryModal({ slug, nid, node, toast, close, onFocusAgent,
  onReply, refs, onChanged, initialDocument, initialLoaded, selectedRow, pinKind: pinKindProp, team, onTeam, onShown }: AgentGalleryViewProps & { close: () => void }) {
  // ONE READER PER AGENT OR PROJECT, AND ONE PER TEAM (docket
  // several-instances-of-the-same-modal-team-slots-i, USER 2026-10-20
  // 19:03:28Z). The window is the scope's instance; the canvas passes it, and
  // a reader mounted anywhere else keeps the scope it opened with.
  const [ownKind] = useState(() => instanceKind(team ? 'team-gallery' : 'agent-gallery', nid))
  const pinKind = pinKindProp ?? ownKind
  /** WHICH PRESENTATION THIS SURFACE IS SHOWING — the row on screen right now,
   *  NOT the one it was opened on.
   *
   *  ⚠ THE READER IS THE GALLERY. `DocReader` renders this modal with
   *  `initialDocument`, and picking another row from the list beside the
   *  reading pane is this surface's PRIMARY interaction, not a corner of it.
   *  `initialDocument` never follows that: it is the id the surface was
   *  mounted with and it stays put for the life of the mount.
   *
   *  So a restore built from `initialDocument` describes a window that may
   *  have been showing something else for an hour. Two things then go wrong at
   *  once, and the second is worse than the first — a click on the card for
   *  the document actually on screen opens a SECOND reader for it, and a click
   *  on the card for the document this window merely used to show raises this
   *  window (where it is not) and swallows the click, so it can never be
   *  opened at all. Found by team-docket reviewing the first candidate, with
   *  an executable probe; kept honest by §8 in presentfocus.test.tsx.
   *
   *  `setShown` is a useState setter, so its identity is stable and the
   *  report-upward effect below does not re-run on the render it causes. */
  const [continued] = useState(() => resumedReaderItem(slug,pinKind))
  const [continuedTeam] = useState(!!team)
  const [shown, setShown] = useState<string | null>(initialDocument ?? continued ?? null)
  // Keep the parent marker writer informed without changing the view's
  // stable setShown callback or reporting again for unrelated parent renders.
  const reportShown = useRef(onShown)
  reportShown.current = onShown
  useEffect(() => { reportShown.current?.(shown) }, [shown])
  const [localTeam, setLocalTeam] = useState(!!team)
  useEffect(() => { setLocalTeam(!!team) }, [team])
  const effectiveTeam = onTeam ? !!team : localTeam
  const handleTeam = (next: boolean) => { setLocalTeam(next); onTeam?.(next) }
  // what a document opening elsewhere can ask of this reader (readers.ts)
  const [jump, setJump] = useState<JumpReq | null>(null)
  useReaderHandle(slug, { kind: effectiveTeam ? 'team' : 'agent', id: nid }, () => shown, (doc) => {
    setJump(newJump(doc))
    if (!revealDetachedPanel(pinKind, slug)) raisePinnedModal(pinKind, slug)
  })
  return (
    <PinFrame kind={pinKind} title={effectiveTeam ? `Team presentations for ${nid}` : `Presented documents for ${nid}`}
      restore={{ agent: nid, generation: node?.generation, selection:shown ?? '', ...(shown ? {document:shown} : {}), ...(effectiveTeam ? { team: true } : {}) }}
      panel="settings wide gallery-modal" close={close}
      onPanelClick={openLightboxIfEligibleImage}>
      <AgentGalleryView slug={slug} nid={nid} node={node} toast={toast}
        onFocusAgent={onFocusAgent} onReply={onReply} refs={refs} onShown={setShown}
        onChanged={onChanged} initialDocument={initialDocument ?? (effectiveTeam===continuedTeam ? continued || undefined : undefined)} initialLoaded={initialLoaded} selectedRow={selectedRow} continuedSelection={effectiveTeam===continuedTeam ? continued : undefined}
        collapsible team={effectiveTeam} onTeam={handleTeam} jumpTo={jump} />
    </PinFrame>
  )
}

/** The agent-scoped presentations view rendered on the agent desk.
 *  Shares the org presentation layout (.mailer with left-hand list and
 *  right-hand reading pane) and behaviors (inline markdown reading, HTML
 *  mockup new-tab link, viewer dismiss, reply box, selection by ID),
 *  limited strictly to presentations made by the selected agent (or its
 *  subtree when the "Team" checkbox is checked). */
export function AgentGalleryView({ slug, nid, node, toast, onFocusAgent, onReply, onBroadcast,
  onReplyToDoc, projectBroadcastMembers, refs, onChanged, initialDocument, initialLoaded, selectedRow, onShown,
  collapsible, team, onTeam, jumpTo, continuedSelection, showRetired, onShowRetired }: AgentGalleryViewProps) {
  const [localTeam, setLocalTeam] = useState(!!team)
  useEffect(() => { setLocalTeam(!!team) }, [team])
  const isProject = (node as { kind?: string } | undefined)?.kind === 'project'
  const effectiveTeam = onTeam ? !!team : localTeam
  const setTeam = (next: boolean) => { setLocalTeam(next); onTeam?.(next) }
  const w = useDocWindow(slug, nid, jumpTo?.id ?? initialDocument ?? continuedSelection ?? '', jumpTo?.seq ?? 0, effectiveTeam, !initialDocument && continuedSelection === undefined, showRetired===false, showRetired!==undefined)
  // a team list holds other nodes' cards, and a project's own list may hold
  // cards presented under its old name (the engine reads a project by id,
  // point 27): the engine scoped both, so their rows are not narrowed to `nid`
  // here (review of f50fc1e)
  const wide = effectiveTeam || isProject
  const [dismissed, setDismissed] = useState<string[]>([])
  const fallbackRows: DocRow[] = useMemo(() => {
    return (node?.documents ?? []).map((d) => ({
      id: d.id,
      node: nid,
      title: d.title,
      at: d.at,
      viewed_at: d.viewed_at,
      format: d.format,
      bytes: d.bytes,
      evicted: false,
      node_state: (node?.state as DocRow['node_state']) ?? 'live',
      tier: node?.tier ?? null,
      presented_by: d.presented_by ?? null,
      presenter_tier: d.presenter_tier ?? null,
    }))
  }, [node, nid])

  const rows = useMemo(() => {
    const polled = w.rows?.filter((r) => (wide || r.node === nid) && !r.evicted)
    // A response is authoritative even when its filtered result is empty:
    // falling back then resurrects dismissed, evicted, or stale node rows.
    // Node payloads are only a bootstrap fallback while the list is absent.
    const source = w.rows ? (polled ?? []) : fallbackRows
    const includeSelected = selectedRow && (wide || selectedRow.node === nid) && !source.some(r => r.id === selectedRow.id)
      ? [selectedRow, ...source] : source
    return includeSelected.filter((r) => !dismissed.includes(r.id) && (showRetired!==false || isHired(r)))
  }, [w.rows, nid, fallbackRows, dismissed, selectedRow, wide, showRetired])
  const rowGaps = visibleGaps(w, rows)

  const scope=readerScope('presented',slug,nid,effectiveTeam)
  const [selId, setSelId] = useReaderSelection(scope, initialDocument ?? continuedSelection ?? null)
  const openingReveal = useRef<OpeningReveal | null>(null)
  useEffect(() => {setSelId(initialDocument ?? continuedSelection ?? null); setDismissed([])}, [scope, initialDocument, continuedSelection])
  // Opening selects the oldest unread/changed card, otherwise scoped last-viewed then topmost.
  // A document the surface was opened to keeps selection, and a
  // later deselect or dismissal is never undone.
  const opening = useRef({ key: '', pending: true })
  useEffect(() => {
    const key = JSON.stringify([slug, nid, effectiveTeam, initialDocument ?? null, showRetired])
    if (opening.current.key !== key) {
      opening.current = { key, pending: !initialDocument && continuedSelection === undefined }
      openingReveal.current = null
    }
    if (!opening.current.pending || w.rows == null) return
    opening.current.pending = false
    const id = w.openingId !== undefined ? w.openingId : openingPresentation(slug, rows, lastReaderItem(scope))
    openingReveal.current = unreadReveal(slug, w.rows, id)
    setSelId(id)
  }, [slug, nid, initialDocument, rows, w.rows, w.openingId])
  const chooseDocument: typeof setSelId = choice => {
    opening.current.pending = false
    setSelId(choice)
  }
  // a reader asked to show a document: select it once its page is here
  const answered = useRef<number | null>(null)
  useEffect(() => {
    if (!jumpTo || answered.current === jumpTo.seq || w.seq !== jumpTo.seq) return
    if (w.error) { answered.current = jumpTo.seq; toast([w.error]); return }
    if (w.located !== jumpTo.id || !w.rows?.some(r => r.id === jumpTo.id)) return
    answered.current = jumpTo.seq
    opening.current.pending = false
    setSelId(jumpTo.id)
  }, [jumpTo, w.seq, w.error, w.located, w.rows, toast])
  const cur = rows.find((r) => r.id === selId)
  useEffect(() => { if (cur) rememberReaderItem(scope,cur.id) }, [scope,cur?.id])
  // Clear an out-of-scope or missing selection once authoritative rows arrive.
  useEffect(() => {
    if (w.rows != null && !w.busy && !opening.current.pending && selId !== null && !cur) setSelId(null)
  }, [w.rows, w.busy, selId, cur])
  // Tell an owning window WHAT IS ON SCREEN, every time it changes — a row
  // picked from the list, a document opened by reference from the pane, a
  // dismissal that clears the selection. Whoever holds the window publishes
  // this as the surface's identity; see AgentGalleryModal.
  const shownId = cur?.id ?? (w.rows == null ? selId : null)
  useEffect(() => { onShown?.(shownId) }, [shownId, onShown])
  const steps = usePanelSteps(rows.map(row => row.id), selId, chooseDocument, '.doc-gallery-row')
  // the row's context menu — the same entries as the org gallery's rows, with
  // this view's own dismiss bookkeeping (the optimistic `dismissed` list)
  const menu = useContextMenu()
  const nodeNav = useAgentNavRegistry()
  const rowMenu = (e: ReactMouseEvent<HTMLElement>, r: DocRow) =>
    presentationMenu(e.currentTarget, slug, r, {
      nodeMenu: (id, el) => nodeNav?.current?.(id, el) ?? [],
      open: () => chooseDocument(r.id === selId ? null : r.id),
      openLabel: r.id === selId ? 'Close' : 'Open',
      reply: onReplyToDoc && !r.evicted ? () => onReplyToDoc(r) : undefined,
      toast,
      dismiss: () => dismissDoc(slug, r.id, r.title, toast, () => {
        setDismissed((d) => [...d, r.id])
        setSelId((id) => id === r.id ? null : id)
        onChanged?.()
      }),
    })

  const paneRefs = useMemo(() => (refs && {
    world: refs.world,
    onOpen: (r: ResolvedRef) => {
      if (r.ref.kind === 'doc' && rows.some((d) => d.id === r.ref.id)) {
        chooseDocument(r.ref.id)
        return
      }
      refs.onOpen?.(r)
    },
  }) || undefined, [refs, rows])
  const tierOf = (id: string) => refs?.world.tierOf?.(id)

  return (
    <section className="msgs gallery-modal gallery-agent desk-presented"
      aria-label={`presented documents for ${nid}`}
      onClick={openLightboxIfEligibleImage}>
      <div className="gallery-head desk-presented-head">
        <b>Presented</b>
        <span className="dim" data-copy-agent-name={nid}>documents and HTML previews from {nid}{effectiveTeam ? ' and the agents under it' : ''}</span>
        {(!isProject || onTeam) && (
          <label className="docket-check gallery-team-check"
            title="include presentations from every agent under this one">
            <input type="checkbox" checked={effectiveTeam}
              onChange={(e) => setTeam(e.target.checked)} />
            Team
          </label>
        )}
        {onShowRetired && <label className="docket-check">
          <input type="checkbox" checked={!!showRetired} onChange={e=>onShowRetired(e.target.checked)} />
          Show retired
        </label>}
      </div>
      {rows.length === 0 ? (
        <DocListEmpty w={w} className="desk-presented-empty">
          {w.busy ? 'Loading…' : 'No presented documents.'}</DocListEmpty>
      ) : (
        <CollapsibleMailer collapsible={collapsible} threshold={NARROW_DOCS_WIDTH} listLabel="document list"
          tabIndex={-1} rootRef={steps.rootRef} onKeyDown={steps.onKeyDown}
          list={
          <LazyDocList w={w} label={`Presented documents from ${nid}`} reveal={openingReveal.current}>
            {menu.node}
            {rows.map((r) => (
              <Fragment key={r.id}><DocRangeGap w={w} id={rowGaps.get(r.id)} /><GalleryEntry slug={slug} row={r}
                className={'mailrow doc-gallery-row desk-presented-card'
                  + (isHired(r) ? ' active' : ' past')
                  + (r.id === selId ? ' on' : '')
                  + (r.evicted ? ' evicted' : '')
                  + (r.format === 'html' ? ' doc-mockup' : '')}
                {...objectTooltipProps('document', r.id, slug)} title={r.title}
                onClick={() => chooseDocument(r.id === selId ? null : r.id)}
                onContextMenu={(e) => menu.open(e, () => rowMenu(e, r))}>
                <div className="l1">
                  <span className="mfrom">{r.title || '(untitled)'}</span>
                  <span className="mtime">{ago(r.at)}</span>
                </div>
                <div className="l2" data-copy-agent-name={presenterOf(r) || undefined}>
                  <RowIdentity r={r} tierOf={tierOf} />
                  {r.format === 'html' && <MockupBadge />}
                  {r.evicted && <span className="badge evicted">content evicted</span>}
                </div>
              </GalleryEntry></Fragment>
            ))}
          </LazyDocList>
          }>
          <div className="mailer-read">
            {cur ? (
              <DocPane key={cur.id} slug={slug} row={cur} toast={toast} onBroadcast={onBroadcast}
                projectBroadcast={isProject ? { project: nid, members: projectBroadcastMembers ?? 0 } : undefined}
                preloaded={cur.id === initialDocument && cur.at === initialLoaded?.at ? initialLoaded : undefined}
                onDismissed={() => {
                  setDismissed((d) => [...d, cur.id])
                  setSelId(null)
                  onChanged?.()
                }}
                close={() => {}}
                onFocusAgent={onFocusAgent}
                onReply={onReply}
                refs={paneRefs} />
            ) : (
              <div className="dim pad mailer-none">select a document to read it</div>
            )}
          </div>
        </CollapsibleMailer>
      )}
    </section>
  )
}
