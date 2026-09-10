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

import { useEffect, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { DocRow } from '../api'
import { BASE, fileBase, getDocuments, mockupUrl } from '../api'
import { sendLinkedReply } from '../events/reply'
import type { ReplyTarget } from '../generated/events'
import type { ToastFn, TreeNode } from '../types'
import { CloseIcon, DocIcon } from '../icons'
import type { LoadedDoc } from './docs'
import { dismissDoc, MockupBadge, MockupOpen, presentationMenu, useDoc } from './docs'
import { useContextMenu } from './contextmenu'
import { PinFrame } from './modalpin'
import { RefMdBody } from './refmd'
import type { RefWorld, ResolvedRef } from './reflinks'
import { resolveRef } from './reflinks'
import { openLightboxIfEligibleImage } from './lightbox'
import { fmtFull } from '../timefmt'
import { MailReplyBox } from './mail'
import { ago, md, TIER_LETTER, tierLabel, usePolled } from './shared'

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

export function DocGalleryModal({ slug, toast, close, onFocusAgent, onReply,
  refs, onOpenDocument }: {
  slug: string
  onOpenDocument?: (id: string) => void
  toast: ToastFn
  close: () => void
  onFocusAgent?: (agentId: string) => void
  onReply?: (node: string, text: string, target: ReplyTarget, attachments?: string[]) => Promise<unknown> | void
  /** canonical references written inside a document, and where they go. A
   *  presented plan names items, agents and the mail it answers; this panel
   *  can open none of those itself, so the shell supplies the routes and
   *  what it does not supply reads as "not opened from here". */
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
}) {
  const [pageOffset, setPageOffset] = useState(0)
  useEffect(() => setPageOffset(0), [slug])
  const data = usePolled(() => getDocuments(slug, pageOffset), [slug, pageOffset])
  const all = useMemo(() => data?.documents?.filter(r => !r.evicted), [data])
  const [showRetired, setShowRetired] = useState(false)
  // ONE list, grouped — not two views (user, 2026-09-03: "one tab with a
  // checkbox to show retired agents, which appear in the same list, sorted
  // below the active agents"). The server already returns newest-first, and
  // a stable partition keeps that order WITHIN each group while lifting the
  // hired ones above the retired: two filters, not a comparator, because a
  // sort would have to re-establish the recency order the server just set.
  //
  // Dismissed cards never arrive here at all — the server drops them from
  // `documents`, and the DELETE bumps the livebus so `usePolled` above
  // refetches without this panel wiring a refresh of its own.
  const hired = (all ?? []).filter(isHired)
  const retired = (all ?? []).filter((r) => !isHired(r))
  const rows = all && (showRetired ? [...hired, ...retired] : hired)
  const retiredCt = retired.length
  // selection is BY ID, not index — the list repolls, and the filter above
  // narrows it, so an index would silently address a different document
  const [selId, setSelId] = useState<string | null>(null)
  // THE ROW'S CONTEXT MENU (contextmenu.tsx, 2026-09-07): open/close is the
  // row's own select; dismiss is the pane's dismiss (same `dismissDoc`, same
  // toast, same deselect); copy/download come from the shared builder
  const menu = useContextMenu()
  const rowMenu = (e: ReactMouseEvent<HTMLElement>, r: DocRow) =>
    presentationMenu(e.currentTarget, slug, r, {
      open: () => openDocument(r.id),
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
    <PinFrame kind="gallery" title="presented documents"
      panel="settings wide gallery-modal" close={close}
      onPanelClick={openLightboxIfEligibleImage}>
        <div className="gallery-head">
          <h3><DocIcon fontSize="inherit" /> presented documents</h3>
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
            show retired agents
            {retiredCt > 0 && <span className="dim"> · {retiredCt}</span>}
          </label>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button disabled={pageOffset === 0} onClick={() => setPageOffset(v => Math.max(0, v - 100))}>Newer</button>
          <span>{data?.total ?? 0} documents</span>
          <button disabled={data?.next_offset == null} onClick={() => setPageOffset(data!.next_offset!)}>Older</button>
        </div>
        <div className="mailpane">
          {all == null
            ? <div className="dim pad">loading…</div>
            : rows!.length === 0
              ? <div className="dim pad">
                  {!showRetired && retiredCt > 0
                    ? `no cards from currently-hired agents — ${retiredCt} from `
                      + 'retired ones, behind the checkbox above'
                    : 'no cards have been presented yet'}
                </div>
              : (
                <div className="mailer">
                  <div className="mailer-list">
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
                        <div className="l2">
                          <TierChip tier={r.tier} />
                          {r.node || '?'}
                          {r.format === 'html' && <MockupBadge />}
                          {r.evicted && <span className="badge evicted">content evicted</span>}
                        </div>
                      </GalleryEntry>
                    ))}
                  </div>
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
                </div>
              )}
        </div>
    </PinFrame>
  )
}

/** The gallery's HTML card is itself a native new-tab link; selection
 *  still reveals its metadata and dismiss control when the user returns. */
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
  onReply?: (node: string, text: string, target: ReplyTarget, attachments?: string[]) => Promise<unknown> | void
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
                onSend={(text, attachments) => {
                  const target: ReplyTarget = { kind: 'document', org: slug, id: row.id }
                  if (onReply) return onReply(row.node, text, target, attachments)
                  return sendLinkedReply(slug, row.node, text, target, attachments)
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
  onReply?: (node: string, text: string, target: ReplyTarget, attachments?: string[]) => Promise<unknown> | void
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
  onChanged?: () => void
  initialDocument?: string
  initialLoaded?: LoadedDoc
  selectedRow?: DocRow
  pinKind?: string
}

/** Agent-scoped presentation gallery opened from a card action.  The list and
 * reader remain AgentGalleryView's single implementation; this wrapper only
 * gives that view the same movable/pinnable shell as inbox and docket. */
export function AgentGalleryModal({ slug, nid, node, toast, close, onFocusAgent,
  onReply, refs, onChanged, initialDocument, initialLoaded, selectedRow, pinKind = 'agent-gallery' }: AgentGalleryViewProps & { close: () => void }) {
  return (
    <PinFrame kind={pinKind} title={`presented documents for ${nid}`}
      restore={{ agent: nid, generation: node?.generation, ...(initialDocument ? {document:initialDocument} : {}) }}
      panel="settings wide gallery-modal" close={close}
      onPanelClick={openLightboxIfEligibleImage}>
      <AgentGalleryView slug={slug} nid={nid} node={node} toast={toast}
        onFocusAgent={onFocusAgent} onReply={onReply} refs={refs}
        onChanged={onChanged} initialDocument={initialDocument} initialLoaded={initialLoaded} selectedRow={selectedRow} />
    </PinFrame>
  )
}

/** The agent-scoped presentations view rendered on the agent desk.
 *  Shares the org presentation layout (.mailer with left-hand list and
 *  right-hand reading pane) and behaviors (inline markdown reading, HTML
 *  mockup new-tab link, viewer dismiss, reply box, selection by ID),
 *  limited strictly to presentations made by the selected agent. */
export function AgentGalleryView({ slug, nid, node, toast, onFocusAgent, onReply,
  refs, onChanged, initialDocument, initialLoaded, selectedRow }: AgentGalleryViewProps) {
  const [pageOffset, setPageOffset] = useState(0)
  useEffect(() => setPageOffset(0), [slug, nid])
  const data = usePolled(() => getDocuments(slug, pageOffset, nid), [slug, pageOffset, nid])
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
    const polled = data?.documents?.filter((r) => r.node === nid && !r.evicted)
    // A response is authoritative even when its filtered result is empty:
    // falling back then resurrects dismissed, evicted, or stale node rows.
    // Node payloads are only a bootstrap fallback while the list is absent.
    const source = data ? (polled ?? []) : fallbackRows
    const includeSelected = selectedRow?.node === nid && !source.some(r => r.id === selectedRow.id)
      ? [selectedRow, ...source] : source
    return includeSelected.filter((r) => !dismissed.includes(r.id))
  }, [data, nid, fallbackRows, dismissed, selectedRow])

  const [selId, setSelId] = useState<string | null>(initialDocument ?? null)
  useEffect(() => {setSelId(initialDocument ?? null); setDismissed([])}, [slug, nid, initialDocument])
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
        <span className="dim">documents and HTML previews from {nid}</span>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button disabled={pageOffset === 0} onClick={() => setPageOffset(v => Math.max(0, v - 100))}>Newer</button>
        <span>{data?.total ?? 0} documents</span>
        <button disabled={data?.next_offset == null} onClick={() => setPageOffset(data!.next_offset!)}>Older</button>
      </div>
      {rows.length === 0 ? (
        <div className="dim pad desk-presented-empty">No presented documents.</div>
      ) : (
        <div className="mailer">
          <div className="mailer-list">
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
                <div className="l2">
                  <TierChip tier={r.tier} />
                  {r.node || '?'}
                  {r.format === 'html' && <MockupBadge />}
                  {r.evicted && <span className="badge evicted">content evicted</span>}
                </div>
              </GalleryEntry>
            ))}
          </div>
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
        </div>
      )}
    </section>
  )
}
