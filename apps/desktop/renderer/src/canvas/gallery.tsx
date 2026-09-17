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
// mail's rules: selection BY IDENTITY (the list repolls under you), nothing
// selected on open, the filter box only once a list is worth filtering.
// It does NOT reuse MailList itself: that component is built on MailRow
// (sender, kind, an inline body, replies, notice piles) and a document row
// is a title + agent + time whose body is fetched on click. Sharing the
// look without pretending the data is mail is the honest half.
//
// The BODY half is shared for real: `useDoc` + `dismissDoc` from docs.tsx
// are the same fetch and the same dismiss the overlay reader uses.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { DocRow } from '../api'
import { BASE, fileBase, getDocuments, mockupUrl } from '../api'
import { onLiveBump } from '../livebus'
import { sendLinkedReply } from '../events/reply'
import type { ReplyTarget } from '../generated/events'
import type { ToastFn, TreeNode } from '../types'
import { CloseIcon, DocIcon } from '../icons'
import type { LoadedDoc } from './docs'
import { dismissDoc, MockupBadge, MockupOpen, presentationMenu, useDoc } from './docs'
import { useContextMenu } from './contextmenu'
import { PinFrame } from './modalpin'
import { CollapsibleMailer } from './narrowlist'
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
export { TierChip }

/** why a row is secondary, for the tooltip. NOT a badge any more (user,
 *  2026-09-03: "dont put a big 'retired' card in their row; just grey them
 *  out slightly") — the state is carried by the row's own dimming, and the
 *  words stay available on hover for the case where grey is ambiguous. */
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

// ── CONTINUOUS LOADING ───────────────────────────────────────────────────
//
// This panel used to carry "Newer" and "Older" buttons over a fixed page.
// Every comparable list in the app loads as you scroll instead — the mail
// list grows its window from `onScroll` (canvas/mail.tsx), the desk transcript
// pages history in at the boundary (convo.ts) — and the user asked for the
// same here.
//
// ⚠ THE WINDOW IS READ FROM ZERO, NOT ACCUMULATED PAGE BY PAGE. `documents` is
// newest-first and moves underneath a reader: a card is presented, another is
// dismissed, and an offset that addressed row 100 one poll ago addresses a
// different row the next. Asking for rows [0, win) makes every response a
// complete PREFIX of the list, so duplicates and gaps are not handled, they
// are impossible — and the rows already on screen come back identical, which
// is what keeps a growth from moving the reader. It is the transcript's own
// rule (its poll carries the whole loaded window in `last`), not a new one.

/** the first window, and what each growth adds. Bounded so opening the panel
 *  is one small request however long the history is. */
export const DOC_PAGE = 40
/** mirrors DOCUMENTS_MAX_WINDOW in engine/backend/orgtree/api.py — the server
 *  will not serve a larger single window, so growth stops here rather than
 *  asking for one it cannot have. Reached only after scrolling past 5000 rows. */
const DOC_MAX_WINDOW = 5000
/** the mail list's own threshold, for the same gesture */
const DOC_EDGE = 240

export interface DocWindow {
  /** null until the first response lands. "nothing yet" is not "nothing". */
  rows: DocRow[] | null
  total: number
  /** the server holds older rows past the loaded window */
  more: boolean
  /** the first window, or a growth, is in flight */
  busy: boolean
  /** the last request failed — `rows` is whatever survived it */
  error: string
  /** the `locate` the last completed response answered… */
  located: string
  /** …and the request identity it belonged to, for the jump latch */
  seq: unknown
  /** ask for the next older page. A no-op while busy, exhausted or failed, so
   *  it is safe to call from a scroll handler and from a render effect. */
  grow: () => void
  /** ask again after a failure */
  retry: () => void
}

interface DocWindowState {
  rows: DocRow[] | null
  total: number
  more: boolean
  /** the window size THESE rows were read with, which is how an outstanding
   *  growth is told from a settled one */
  win: number
  located: string
  seq: unknown
  error: string
}

const EMPTY_WINDOW: DocWindowState = {
  rows: null, total: 0, more: false, win: 0, located: '', seq: undefined, error: '',
}

/** The gallery's list half: a growing newest-first window over `documents`,
 *  kept live by the same heartbeat every other panel uses (usePolled's
 *  interval plus the livebus bump, canvas/shared.ts).
 *
 *  ⚠ A GROWTH MUST NOT BLANK THE LIST. `usePolled` resets to null whenever its
 *  deps change, which is right for an identity change and wrong for "same list,
 *  one page more" — it would unmount every row and drop the reader back to the
 *  top. So this hook keeps its own state and resets only on `slug`/`node`. */
function useDocWindow(slug: string, node: string, locate = '',
  seq: unknown = 0): DocWindow {
  const ident = `${slug}/${node}`
  const [want, setWant] = useState(DOC_PAGE)
  const [attempt, setAttempt] = useState(0)
  const [last, setLast] = useState<DocWindowState>(EMPTY_WINDOW)
  /** ⚠ ONE RE-AIM PER JUMP, AND NO MORE. See the `locate` branch below. */
  const aimed = useRef('')
  // a different org or agent is a different list, not a refresh of this one:
  // its rows must not stay on screen under the new identity, and its window
  // size must not carry over either
  useEffect(() => {
    setWant(DOC_PAGE); setAttempt(0); setLast(EMPTY_WINDOW); aimed.current = ''
  }, [ident])
  useEffect(() => {
    let dead = false
    const tick = () => {
      getDocuments(slug, 0, node, locate, want).then((d) => {
        if (dead) return
        // A `locate` for a row BELOW the window answers with that row's own
        // page rather than a prefix from zero (api.py snaps the offset to
        // `index // limit * limit`). Adopt a window that reaches it and ask
        // again — rendering a slice that starts in the middle is exactly the
        // gap this design excludes.
        //
        // ⚠ ONLY FOR A `locate`, AND ONLY ONCE. Without a locate the server
        // echoes the offset it was sent, which is always zero here, so
        // correcting on it would be reacting to our own request. And one
        // correction is all a healthy answer can need: a window wide enough to
        // reach the row snaps to zero by that same arithmetic. A SECOND
        // non-zero offset means no width will ever reach it — the row sits
        // past the widest window this server will serve — and re-aiming again
        // is an unbounded request loop rather than a slow success. Say so
        // instead; the jump is then answered (and cleared) by the panel above,
        // and the plain window read that follows still lists.
        const at = locate ? d.offset ?? 0 : 0
        if (at > 0) {
          const aim = `${ident}|${locate}|${String(seq)}`
          if (aimed.current !== aim) {
            aimed.current = aim
            setWant((w) => Math.min(DOC_MAX_WINDOW, Math.max(w, at + w)))
            return
          }
          setLast((p) => ({ ...p, seq,
            error: 'that document is too far down the list to open from here' }))
          return
        }
        const rows = d.documents ?? []
        setLast({
          rows, total: d.total ?? rows.length, win: want,
          // a short answer means the server gave everything it was willing to
          // in one window, so asking for a wider one would only repeat it
          more: d.next_offset != null && rows.length >= want && want < DOC_MAX_WINDOW,
          located: d.located ?? '', seq, error: '',
        })
      }, (e: Error) => {
        // the rows already read stay on screen — a dropped poll is not a
        // reason to empty a list the reader is using
        if (!dead) setLast((p) => ({ ...p, seq, error: String(e?.message ?? e) }))
      })
    }
    tick()
    const t = setInterval(tick, 5000)
    const off = onLiveBump(tick)
    return () => { dead = true; clearInterval(t); off() }
  }, [ident, slug, node, locate, seq, want, attempt])
  const settled = last.win >= want
  const grow = useCallback(() => {
    setWant((w) => (last.rows != null && last.win >= w && last.more && !last.error)
      ? w + DOC_PAGE : w)
  }, [last])
  const retry = useCallback(() => {
    setLast((p) => ({ ...p, error: '' }))
    setAttempt((a) => a + 1)
  }, [])
  return {
    rows: last.rows, total: last.total, more: last.more, error: last.error,
    busy: !last.error && (last.rows == null || !settled),
    located: last.located, seq: last.seq, grow, retry,
  }
}

/** The list column both galleries render: the scroller that asks for the next
 *  older page as the reader nears the bottom, and the end marker that says
 *  what the list is doing. Rows are the caller's — the two galleries filter
 *  and decorate their own. */
function LazyDocList({ w, label, children }: {
  w: DocWindow
  /** what this scroller IS, announced when it takes focus. It is a tab stop
   *  (see below) and a tab stop with nothing to say is a dead end for anyone
   *  not looking at the screen. */
  label: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  /** ⚠ AN UNMEASURED SCROLLER REPORTS THREE ZEROES, which subtract to "at the
   *  bottom" — and would page the entire history in without a gesture, in
   *  jsdom and in any panel rendered before layout. No measurable box, no
   *  demand. */
  const nearEnd = () => {
    const el = ref.current
    return !!el && el.clientHeight > 0
      && el.scrollHeight - el.scrollTop - el.clientHeight < DOC_EDGE
  }
  // THE LIST CAN BE SHORTER THAN ITS SCROLLER and still have history behind it
  // — "show retired agents" unticked over a window whose hired cards are two,
  // say. No overflow means no scroll event means nothing would ever ask for
  // the next page, so the boundary is re-checked after every commit as well.
  // `grow` is a no-op while a page is in flight, exhausted or failed, so this
  // settles instead of looping.
  useEffect(() => { if (nearEnd()) w.grow() })
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
      onScroll={() => { if (nearEnd()) w.grow() }}>
      {children}
      <DocListEnd w={w} />
    </div>
  )
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
  refs, onOpenDocument, jumpTo, onJumpHandled }: {
  slug: string
  jumpTo?: { id: string; seq: number } | null
  onJumpHandled?: () => void
  onOpenDocument?: (id: string) => void
  toast: ToastFn
  close: () => void
  onFocusAgent?: (agentId: string) => void
  onReply?: (node: string, text: string, target: ReplyTarget, attachments?: string[], notice?: boolean) => Promise<unknown> | void
  /** canonical references written inside a document, and where they go. A
   *  presented plan names items, agents and the mail it answers; this panel
   *  can open none of those itself, so the shell supplies the routes and
   *  what it does not supply reads as "not opened from here". */
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
}) {
  const w = useDocWindow(slug, '', jumpTo?.id ?? '', jumpTo?.seq ?? 0)
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
  const [selId, setSelId] = useState<string | null>(null)
  // A JUMP IS ANSWERED BY THE RESPONSE THAT CARRIED IT, which is why the latch
  // compares the request's own `seq` (shared.ts JumpReq) and not the id: a
  // repeat click on the same reference is a new request, an unrelated poll is
  // not. The window has already grown far enough to hold the located row — it
  // reads from zero, so "found" and "in the list" are the same thing now,
  // where the paged list had to move its offset to the row's page first.
  useEffect(() => {
    if (!jumpTo || w.seq !== jumpTo.seq) return
    if (w.error) { toast([w.error]); onJumpHandled?.(); return }
    if (w.located !== jumpTo.id) return
    const row = w.rows?.find(r => r.id === jumpTo.id && !r.evicted)
    if (!row) return
    setShowRetired(on => on || !isHired(row))
    setSelId(row.id)
    onJumpHandled?.()
  }, [w.rows, w.seq, w.error, w.located, jumpTo, onJumpHandled, toast])
  // THE ROW'S CONTEXT MENU (contextmenu.tsx, 2026-09-07): open/close is the
  // row's own select; dismiss is the pane's dismiss (same `dismissDoc`, same
  // toast, same deselect); copy/download come from the shared builder
  const menu = useContextMenu()
  const rowMenu = (e: ReactMouseEvent<HTMLElement>, r: DocRow) =>
    presentationMenu(e.currentTarget, slug, r, {
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
    <PinFrame kind="gallery" title="Presented documents"
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
                <CollapsibleMailer collapsible listLabel="document list"
                  list={
                  <LazyDocList w={w} label="Presented documents">
                    {menu.node}
                    {rows!.map((r) => (
                      <GalleryEntry key={r.id} slug={slug} row={r}
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
                        title={[
                          r.evicted
                            ? 'content evicted — later presentations pushed '
                              + 'this card off the list'
                            : `read “${r.title}”`,
                          STATE_WHY[r.node_state],
                        ].filter(Boolean).join(' · ')}
                        onClick={() => openDocument(r.id)}
                        onContextMenu={(e) => menu.open(e, () => rowMenu(e, r))}>
                        <div className="l1">
                          <span className="mfrom">{r.title || '(untitled)'}</span>
                          <span className="mtime">{ago(r.at)}</span>
                        </div>
                        <div className="l2" data-copy-agent-name={r.node || undefined}>
                          <TierChip tier={r.tier} />
                          {r.node || '?'}
                          {r.format === 'html' && <MockupBadge />}
                          {r.evicted && <span className="badge evicted">content evicted</span>}
                        </div>
                      </GalleryEntry>
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
  return <div {...props}>{children}</div>
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
  refs, preloaded }: {
  preloaded?: LoadedDoc
  slug: string
  row: DocRow
  toast: ToastFn
  onDismissed: () => void
  close: () => void
  onFocusAgent?: (agentId: string) => void
  onReply?: (node: string, text: string, target: ReplyTarget, attachments?: string[], notice?: boolean) => Promise<unknown> | void
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
}) {
  // an evicted row has no body to fetch — say so instead of spending a
  // request to render the 404 the endpoint would answer with
  const { doc, err } = useDoc(slug, row.evicted ? '' : row.id, preloaded)
  const replyable = !row.evicted && isHired(row) && Boolean(row.node && !row.node.startsWith('@'))
  return (
    <>
      <div className="mailer-head doc-pane-head">
        {/* METADATA FIRST, title second (user, 2026-09-04: "swap that row with
            the title row, it should be first, the title second"). */}
        <div className="doc-pane-meta-row">
          {row.node ? (
            <AgentName id={row.node} tier={row.tier}
              onFocus={onFocusAgent
                ? (id) => { close(); onFocusAgent(id) }
                : undefined} />
          ) : (
            // no node recorded at all: there is no identity to draw, and
            // inventing one is the thing this panel must not do
            <span className="dim">?</span>
          )}
          {PANE_STATE_WHY[row.node_state] &&
            <span className="dim">{PANE_STATE_WHY[row.node_state]}</span>}
          <span className="dim">{fmtFull(row.at)}</span>
        </div>
        <div className="doc-pane-title-row">
          <b>{row.title || '(untitled)'}</b>
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
            {doc && doc.format !== 'html' && <RefMdBody className="mailer-body md"
              html={md(doc.body, fileBase(slug, doc.node))}
              world={refs?.world} onOpen={refs?.onOpen} />}
            {!doc && !err && <div className="dim pad">loading…</div>}
            {replyable && (
              <MailReplyBox target={row.node} slug={slug} toast={toast}
                onSend={(text, attachments, notice) => {
                  const target: ReplyTarget = { kind: 'document', org: slug, id: row.id }
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
  onReply?: (node: string, text: string, target: ReplyTarget, attachments?: string[], notice?: boolean) => Promise<unknown> | void
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
  onChanged?: () => void
  initialDocument?: string
  initialLoaded?: LoadedDoc
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
}

/** Agent-scoped presentation gallery opened from a card action.  The list and
 * reader remain AgentGalleryView's single implementation; this wrapper only
 * gives that view the same movable/pinnable shell as inbox and docket. */
export function AgentGalleryModal({ slug, nid, node, toast, close, onFocusAgent,
  onReply, refs, onChanged, initialDocument, initialLoaded, selectedRow, pinKind = 'agent-gallery' }: AgentGalleryViewProps & { close: () => void }) {
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
  const [shown, setShown] = useState<string | null>(initialDocument ?? null)
  return (
    <PinFrame kind={pinKind} title={`Presented documents for ${nid}`}
      restore={{ agent: nid, generation: node?.generation, ...(shown ? {document:shown} : {}) }}
      panel="settings wide gallery-modal" close={close}
      onPanelClick={openLightboxIfEligibleImage}>
      <AgentGalleryView slug={slug} nid={nid} node={node} toast={toast}
        onFocusAgent={onFocusAgent} onReply={onReply} refs={refs} onShown={setShown}
        onChanged={onChanged} initialDocument={initialDocument} initialLoaded={initialLoaded} selectedRow={selectedRow}
        collapsible />
    </PinFrame>
  )
}

/** The agent-scoped presentations view rendered on the agent desk.
 *  Shares the org presentation layout (.mailer with left-hand list and
 *  right-hand reading pane) and behaviors (inline markdown reading, HTML
 *  mockup new-tab link, viewer dismiss, reply box, selection by ID),
 *  limited strictly to presentations made by the selected agent. */
export function AgentGalleryView({ slug, nid, node, toast, onFocusAgent, onReply,
  refs, onChanged, initialDocument, initialLoaded, selectedRow, onShown,
  collapsible }: AgentGalleryViewProps) {
  const w = useDocWindow(slug, nid)
  const [dismissed, setDismissed] = useState<string[]>([])
  const fallbackRows: DocRow[] = useMemo(() => {
    return (node?.documents ?? []).map((d) => ({
      id: d.id,
      node: nid,
      title: d.title,
      at: d.at,
      format: d.format,
      bytes: d.bytes,
      evicted: false,
      node_state: (node?.state as DocRow['node_state']) ?? 'live',
      tier: node?.tier ?? null,
    }))
  }, [node, nid])

  const rows = useMemo(() => {
    const polled = w.rows?.filter((r) => r.node === nid && !r.evicted)
    // A response is authoritative even when its filtered result is empty:
    // falling back then resurrects dismissed, evicted, or stale node rows.
    // Node payloads are only a bootstrap fallback while the list is absent.
    const source = w.rows ? (polled ?? []) : fallbackRows
    const includeSelected = selectedRow?.node === nid && !source.some(r => r.id === selectedRow.id)
      ? [selectedRow, ...source] : source
    return includeSelected.filter((r) => !dismissed.includes(r.id))
  }, [w.rows, nid, fallbackRows, dismissed, selectedRow])

  const [selId, setSelId] = useState<string | null>(initialDocument ?? null)
  useEffect(() => {setSelId(initialDocument ?? null); setDismissed([])}, [slug, nid, initialDocument])
  // Tell an owning window WHAT IS ON SCREEN, every time it changes — a row
  // picked from the list, a document opened by reference from the pane, a
  // dismissal that clears the selection. Whoever holds the window publishes
  // this as the surface's identity; see AgentGalleryModal.
  useEffect(() => { onShown?.(selId) }, [selId, onShown])
  const cur = rows.find((r) => r.id === selId)
  // the row's context menu — the same entries as the org gallery's rows, with
  // this view's own dismiss bookkeeping (the optimistic `dismissed` list)
  const menu = useContextMenu()
  const rowMenu = (e: ReactMouseEvent<HTMLElement>, r: DocRow) =>
    presentationMenu(e.currentTarget, slug, r, {
      open: () => setSelId(r.id === selId ? null : r.id),
      openLabel: r.id === selId ? 'Close' : 'Open',
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
        setSelId(r.ref.id)
        return
      }
      refs.onOpen?.(r)
    },
  }) || undefined, [refs, rows])

  return (
    <section className="msgs gallery-modal gallery-agent desk-presented"
      aria-label={`presented documents for ${nid}`}
      onClick={openLightboxIfEligibleImage}>
      <div className="gallery-head desk-presented-head">
        <b>Presented</b>
        <span className="dim" data-copy-agent-name={nid}>documents and HTML previews from {nid}</span>
      </div>
      {rows.length === 0 ? (
        <DocListEmpty w={w} className="desk-presented-empty">
          {w.busy ? 'Loading…' : 'No presented documents.'}</DocListEmpty>
      ) : (
        <CollapsibleMailer collapsible={collapsible} listLabel="document list"
          list={
          <LazyDocList w={w} label={`Presented documents from ${nid}`}>
            {menu.node}
            {rows.map((r) => (
              <GalleryEntry key={r.id} slug={slug} row={r}
                className={'mailrow doc-gallery-row desk-presented-card'
                  + (isHired(r) ? ' active' : ' past')
                  + (r.id === selId ? ' on' : '')
                  + (r.evicted ? ' evicted' : '')
                  + (r.format === 'html' ? ' doc-mockup' : '')}
                title={[
                  r.evicted
                    ? 'content evicted — later presentations pushed this card off the list'
                    : `read “${r.title}”`,
                  STATE_WHY[r.node_state],
                ].filter(Boolean).join(' · ')}
                onClick={() => setSelId(r.id === selId ? null : r.id)}
                onContextMenu={(e) => menu.open(e, () => rowMenu(e, r))}>
                <div className="l1">
                  <span className="mfrom">{r.title || '(untitled)'}</span>
                  <span className="mtime">{ago(r.at)}</span>
                </div>
                <div className="l2" data-copy-agent-name={r.node || undefined}>
                  <TierChip tier={r.tier} />
                  {r.node || '?'}
                  {r.format === 'html' && <MockupBadge />}
                  {r.evicted && <span className="badge evicted">content evicted</span>}
                </div>
              </GalleryEntry>
            ))}
          </LazyDocList>
          }>
          <div className="mailer-read">
            {cur ? (
              <DocPane key={cur.id} slug={slug} row={cur} toast={toast}
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
