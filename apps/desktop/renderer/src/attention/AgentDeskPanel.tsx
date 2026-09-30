// attention/AgentDeskPanel.tsx — THE DYNAMIC AGENT AREA.
//
// An agents list and EXACTLY ONE agent Desk, in place of the canvas's many. The
// Desk is the canonical one — `DeskSlot` from canvas/deskhosts.tsx, registered
// in the organization's ONE desk registry, so this panel and the canvas can
// never both own a writer for the same agent: whichever holds it draws the
// desk and the other draws the existing "open elsewhere / Show desk / Return
// here" placeholder. Nothing about the Desk, its permissions or its actions is
// reimplemented here; this file decides WHICH agent's desk is showing and
// nothing else.
//
// ⚠ THE LIST'S ORDER COMES FROM THE HOST'S LAYOUT, NOT FROM THE TREE ARRAY
// (coordinator ruling 2026-09-21). "The leftmost top-level agent" has to be the
// agent the user can see is leftmost, so the order is read from the same
// positions the canvas draws with (`posOf`), with the tree's own child order as
// the fallback for a host that has no layout yet. Sorting by array index would
// agree with the canvas only until somebody rearranged it.
//
// THE LIST IS A DRAWER, OPENED ONLY BY A CLICK (user 2026-09-29, image-28).
// It used to roll out on hover and retract when the pointer left it — and the
// desk's own "↑ you: …" jump chip, drawn ABOVE it, counted as leaving, so
// reaching for a row made the list vanish. Now the list button opens it, and
// only the button again, the dark scrim over the desk, or Escape close it —
// or the pointer moving well away from it (user 2026-09-30; see `inCloseZone`).
// Choosing an agent leaves it open, as a click-opened list always did. Its
// contents are the canvas's own Agents List (canvas/agenttray.tsx). The
// desk is its own stacking context (attention.css), so nothing inside the desk
// can draw over the drawer or the scrim. It is NEVER remembered (coordinator
// ruling 2026-09-29): it starts shut on every load and whenever the panel comes
// back on screen, so the desk is never found darkened by a drawer nobody opened.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronLeftIcon, ViewListIcon } from '../icons'
import type { ToastFn, TreePayload } from '../types'
import { DRAFT, providerOf, USER, useEsc } from '../canvas/shared'
import { setButtonAgent } from '../buttoncolours'
import type { CanvasNode, OpFn, Pt } from '../canvas/shared'
import { DeskSlot } from '../canvas/deskhosts'
import type { DeskChatProps } from '../canvas/desk'
import { agentNavProps } from '../canvas/agentnav'
import { AgentTray } from '../canvas/agenttray'
import type { TrayRow } from '../canvas/agenttray'
import { useRefRoutes } from '../canvas/reflinks'
import { focusByAttr } from './dom'
import { setAttentionLayout, useAttentionLayout } from './mode'

export interface AgentDeskPanelProps {
  slug: string
  tree: TreePayload
  op: OpFn
  toast: ToastFn
  /** the organization's flattened canvas map — the host's own, never a second
   *  projection of the same tree */
  map: Map<string, CanvasNode>
  /** the host's layout position for an agent. Used ONLY for ordering: the list
   *  reads left-to-right the way the canvas does, and "the leftmost top-level
   *  agent" means the same agent in both views. A host with no layout yet
   *  returns undefined and the tree's own child order stands in. */
  posOf?: (id: string) => Pt | undefined
  /** the routes the canonical Desk already takes from its host (jump, mail
   *  links, docket links, documents). Passed through untouched — this panel
   *  invents none of them and supplies no stubs. */
  deskExtras?: Partial<DeskChatProps>
  /** IS THIS PANEL'S DESTINATION ON SCREEN? Forwarded to the desk registry as
   *  `eligible`: may this slot own the one live desk right now, because the
   *  place it would draw in is visible and reachable?
   *
   *  The view decides it (see `deskEligible` in AttentionView) — this panel
   *  cannot, because the answer depends on the mode and on the panel's own
   *  surface, and a panel does not know whether the stage it sits in is the
   *  presented one. Defaults to true, which is the registry's own default and
   *  the right answer for any host that renders this panel on its own. */
  eligible?: boolean
  /** IS THIS REGISTRATION THE USER ASKING FOR THE DESK HERE, OR A VIEW MOUNTING?
   *
   *  `'automatic'` says the second: this panel is the presented Attention
   *  stage, and its desk slot appeared because the view rendered rather than
   *  because anyone asked for that agent's desk in this place. The registry's
   *  picker uses it to DEFER — an automatic claim never takes the desk from a
   *  different slot that still has a visible destination, so a Canvas pin the
   *  user placed keeps it and this panel draws the canonical open-elsewhere
   *  controls (v3-effort-opus host-slot interface rev 4).
   *
   *  ⚠ OMITTED, NOT `false`, when this panel is pinned or popped out. Those are
   *  windows the user placed, so their registrations are exactly as much a
   *  human request as a Canvas pin is, and they must not defer to anything.
   *  The view decides this for the same reason it decides `eligible`. */
  claim?: 'automatic'
}

type ListRow = TrayRow

export function agentRows(
  map: Map<string, CanvasNode>, posOf?: (id: string) => Pt | undefined,
  opts: { archived?: boolean; query?: string } = {},
): ListRow[] {
  const all = [...map.values()].filter((n) =>
    n.id !== USER && n.id !== DRAFT && !n.isBearerOf)
  const q = (opts.query ?? '').trim().toLowerCase()
  const match = (n: CanvasNode) =>
    (opts.archived || n.state === 'live') && (!q || n.id.toLowerCase().includes(q))
  const kids = new Map<string, CanvasNode[]>()
  // the tree's own order is the tie-break AND the whole answer when the host
  // has no layout, so it is captured before any sort touches the arrays
  const order = new Map<string, number>()
  all.forEach((n, i) => order.set(n.id, i))
  for (const n of all) {
    const parent = n.parent && map.has(n.parent) && n.parent !== USER ? n.parent : USER
    kids.set(parent, [...(kids.get(parent) ?? []), n])
  }
  const byPos = (a: CanvasNode, b: CanvasNode) => {
    const pa = posOf?.(a.id)
    const pb = posOf?.(b.id)
    if (!pa || !pb) return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    return pa.x - pb.x || pa.y - pb.y || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
  }
  // a filtered-out ANCESTOR of a match still has to render, or the descendant
  // is indented under a gap — the Agents List's own resolution
  const anyMatch = (n: CanvasNode): boolean =>
    match(n) || (kids.get(n.id) ?? []).some(anyMatch)
  const rows: ListRow[] = []
  const walk = (id: string, depth: number) => {
    for (const c of [...(kids.get(id) ?? [])].sort(byPos)) {
      if (!anyMatch(c)) continue
      rows.push({ node: c, depth, ghost: !match(c) })
      walk(c.id, depth + 1)
    }
  }
  walk(USER, 0)
  return rows
}

/** The default selection: the agent at the top of the list, which is the
 *  LEFTMOST TOP-LEVEL agent — a direct report of the eye, ordered by the
 *  host's layout. Falls back to the first listed agent at any depth when the
 *  organization has no live top-level agent at all (every root retired, its
 *  subtree still live), because an empty desk area would be worse than the
 *  first agent the list actually shows. */
export function defaultAgent(
  map: Map<string, CanvasNode>, posOf?: (id: string) => Pt | undefined,
): string | null {
  const rows = agentRows(map, posOf)
  return rows.find((r) => r.depth === 0)?.node.id ?? rows[0]?.node.id ?? null
}

/** How far past the drawer the pointer may go before it closes: this much of
 *  the drawer's own width beyond its left and right edges, and of its height
 *  above and below. */
export const CLOSE_ZONE = 0.5

/** Is the point inside the drawer's close zone? */
export function inCloseZone(
  r: { left: number; right: number; top: number; bottom: number },
  x: number, y: number,
): boolean {
  const dx = (r.right - r.left) * CLOSE_ZONE
  const dy = (r.bottom - r.top) * CLOSE_ZONE
  return x >= r.left - dx && x <= r.right + dx && y >= r.top - dy && y <= r.bottom + dy
}

export function AgentDeskPanel({
  slug, tree, op, toast, map, posOf, deskExtras, eligible = true, claim,
}: AgentDeskPanelProps) {
  const layout = useAttentionLayout(slug)
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [open, setOpen] = useState(false)
  // the stage stays mounted while the organization shows the canvas, so going
  // off screen is what "reopening the view" looks like from in here
  useEffect(() => { if (!eligible) setOpen(false) }, [eligible])

  const rows = useMemo(() => agentRows(map, posOf, { archived, query }),
    [map, posOf, archived, query])
  const fallback = useMemo(() => defaultAgent(map, posOf), [map, posOf])

  // ⚠ THE SELECTION IS THE STORED ONE WHILE IT STILL NAMES A LIVE AGENT, and
  // the default otherwise. Resolved during RENDER rather than written back by
  // an effect: an effect would leave one frame showing a desk for an agent
  // that is gone, and — worse — would write the default into storage for an
  // organization whose real selection simply had not loaded yet.
  const stored = layout.agent
  const selectedId = stored && map.has(stored) ? stored : fallback
  const selected = selectedId ? map.get(selectedId) : undefined
  useEffect(() => {
    if (eligible) setButtonAgent(slug, selected?.tier ? selected.id : null)
  }, [slug, eligible, selected?.id, selected?.tier])

  const select = useCallback((id: string) => {
    setAttentionLayout(slug, { agent: id })
  }, [slug])
  // a name in a row's status summary opens that agent's desk here, like a
  // press on its row
  const refs = useRefRoutes(slug, map, {
    onFocusAgent: select,
    tierOf: (id: string) => map.get(id)?.tier,
    view: tree.foreground,
  })

  const listRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  // where a real pointer press opened the drawer (see the close zone below);
  // null for a keyboard open, whose synthetic click has `detail` 0
  const openedAt = useRef<{ x: number; y: number } | null>(null)
  // closing from inside the drawer hands focus back to the button that opened
  // it, or it would be left on a row that is no longer visible
  const close = () => {
    const inside = listRef.current?.contains(document.activeElement)
    setOpen(false)
    if (inside) toggleRef.current?.focus()
  }
  // shut, the drawer is out of the tab order and the accessibility tree
  // (`inert`), so the keyboard reaches it through the button like a mouse.
  // Set on the element directly: React 18's DOM types do not know `inert`.
  useLayoutEffect(() => {
    listRef.current?.toggleAttribute('inert', !open)
  }, [open])
  // Escape closes it from anywhere in the view — the pointer is usually over
  // the desk, with focus still on the button or a row. Through the app's
  // Escape stack, so the open drawer is the one thing this Escape closes (the
  // panel around it is also on that stack, and used to take the key first).
  useEsc(close, open)
  // AND IT CLOSES BY ITSELF WHEN THE POINTER GOES WELL AWAY (user 2026-09-30:
  // "only after it goes some distance out, say 50% further"). Not on leaving
  // its surface — the desk's "↑ you" chip and the scrim sit right beside it —
  // but on leaving a zone half the drawer's size again past each edge
  // (`inCloseZone`). The zone ARMS once the pointer is known to be inside it:
  // at once when a press inside the zone opened the drawer (the button sits
  // in the zone, so a mouse open is armed from the start — review-sol), and
  // otherwise on the first move inside it. So a drawer opened from the
  // keyboard, with the mouse resting somewhere far away, is not shut by the
  // first nudge of that mouse. Touch is left
  // out: a finger only moves while it drags, and a tap outside is the
  // scrim's. Listened for on the drawer's own document, which is a different
  // one when this panel is popped out.
  useEffect(() => {
    if (!open) return
    const doc = listRef.current?.ownerDocument ?? document
    const at = openedAt.current
    openedAt.current = null
    const box = listRef.current?.getBoundingClientRect()
    let armed = !!at && !!box && !!box.width && !!box.height && inCloseZone(box, at.x, at.y)
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const r = listRef.current?.getBoundingClientRect()
      if (!r || !r.width || !r.height) return
      if (inCloseZone(r, e.clientX, e.clientY)) armed = true
      else if (armed) close()
    }
    doc.addEventListener('pointermove', onMove)
    return () => doc.removeEventListener('pointermove', onMove)
    // `close` touches only refs and a state setter, so the first one is as
    // good as the last
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return
    const i = rows.findIndex((r) => r.node.id === selectedId)
    const go = (to: number) => {
      e.preventDefault()
      const row = rows[Math.min(rows.length - 1, Math.max(0, to))]
      if (!row) return
      select(row.node.id)
      focusByAttr(listRef.current, 'data-attn-agent', row.node.id)
    }
    if (e.key === 'ArrowDown') go(i < 0 ? 0 : i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? rows.length - 1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(rows.length - 1)
  }

  return (
    <div className={'attn-agents-wrap' + (open ? ' list-open' : '')
      + (selected?.tier ? ' prov-' + providerOf(selected.tier) : '')}>
      <div className="attn-agents-bar">
        <button type="button" className="iconbtn attn-agents-toggle" ref={toggleRef}
          aria-expanded={open} aria-controls={`attn-agents-${slug}`}
          title={open ? 'close the agents list' : 'open the agents list'}
          aria-label={open ? 'Close the agents list' : 'Open the agents list'}
          onClick={(e) => {
            if (open) { close(); return }
            openedAt.current = e.detail > 0 ? { x: e.clientX, y: e.clientY } : null
            setOpen(true)
          }}>
          {open ? <ChevronLeftIcon fontSize="inherit" /> : <ViewListIcon fontSize="inherit" />}
        </button>
        {!open && <span className="dim attn-agents-rail-label" aria-hidden="true">agents</span>}
      </div>
      {/* the scrim: darkens the desk while the drawer is out, and a click on it
          closes the drawer. Always rendered so the dimming can fade. */}
      <div className="attn-agents-scrim" aria-hidden="true"
        onClick={() => { if (open) close() }} />
      <div className="attn-agents" role="listbox" aria-label="Agents" ref={listRef}
        id={`attn-agents-${slug}`}
        onKeyDown={onListKey}>
        {/* THE CANVAS'S OWN AGENTS LIST (user 2026-09-30: "identical to the
            canvas agents list") — same component, same rows, same filter box.
            What is this drawer's: a press SELECTS the agent for the desk
            beside it, the selected row is marked, and the row's main line is
            the listbox option the keyboard moves between. The right-click
            menu is the canonical agent menu, reached through the registry
            (`data-agent-nav`), because this host builds no menu of its own. */}
        <AgentTray map={map} rows={rows} query={query} onQuery={setQuery}
          archived={archived} onArchived={setArchived} onPick={select}
          compactAt={tree.compact_at} refs={refs} selected={selectedId}
          filterLabel="Filter agents"
          rowProps={(n) => agentNavProps(n.id)}
          mainProps={(n) => ({
            'data-attn-agent': n.id, role: 'option',
            'aria-selected': n.id === selectedId,
            tabIndex: n.id === selectedId ? 0 : -1,
          })} />
      </div>
      {/* `data-attn-desk-eligible` is this panel's own answer to the registry's
          question, written where it can be read — in a test, and in the real
          renderer's inspector while chasing a desk that went to the wrong
          slot. It is the same value handed to `DeskSlot` below. */}
      <div className="attn-desk" data-attn-desk-eligible={eligible ? 'yes' : 'no'}
        data-attn-desk-claim={claim ?? 'none'}>
        {selected
          ? <DeskSlot bare node={selected} map={map} op={op} slug={slug} toast={toast}
              pub={!!tree.public}
              maxTop={tree.max_top_grant ?? 1000}
              eligible={eligible} claim={claim} hidePopout
              {...deskExtras} />
          : <div className="dim pad attn-desk-empty">
              This organization has no agent to open a desk for yet.
            </div>}
      </div>
    </div>
  )
}

/** Keep the stored selection honest when the organization changes underneath
 *  it: an agent that is retired and hidden, or renamed away, must not leave a
 *  dangling id in storage forever. Called by the view, not by the panel, so a
 *  panel that is merely inactive never rewrites the user's choice. */
export function pruneSelection(slug: string, map: Map<string, CanvasNode>,
  stored: string | null): void {
  if (stored && !map.has(stored) && map.size > 1) setAttentionLayout(slug, { agent: null })
}
