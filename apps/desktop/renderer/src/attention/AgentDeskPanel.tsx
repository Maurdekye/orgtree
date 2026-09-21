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
// THE LIST IS COLLAPSED BY DEFAULT and rolls out OVER the desk on hover, so it
// never permanently costs the desk width. It retracts when the pointer leaves
// or a selection is made — and never when the keyboard is inside it, because a
// list that vanished from under a focused row would be unusable without a
// mouse. A deliberate toggle holds it open across all of that, and that choice
// is remembered per organization.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, ViewListIcon } from '../icons'
import type { ToastFn, TreePayload } from '../types'
import { DRAFT, USER } from '../canvas/shared'
import type { CanvasNode, OpFn, Pt } from '../canvas/shared'
import { DeskSlot } from '../canvas/deskhosts'
import type { DeskChatProps } from '../canvas/desk'
import { agentNavProps } from '../canvas/agentnav'
import { AgentName } from '../canvas/identity'
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

interface ListRow { node: CanvasNode; depth: number }

/**
 * The two desk-registry props, handed to `DeskSlot`.
 *
 * ⚠ THIS CAST IS TEMPORARY AND IT IS LOAD-BEARING WHEN IT GOES AWAY. The
 * registry's ownership picker gains `eligible` and `claim` in v3-effort-opus's
 * host-slot change (interface rev 4, 2026-09-21); `DeskChatProps` does not
 * carry them yet, and this file may not edit that shared type. So the values
 * are assembled here, in ONE named place, instead of being cast at the call
 * site where they would read as noise and be forgotten.
 *
 * Until deskhosts lands, React passes unknown props straight through to the
 * desk, which ignores them — so this is inert rather than wrong. The moment the
 * shared type carries both fields, DELETE THIS FUNCTION and spread them
 * directly: the compiler will then be checking BOTH names for us, which is the
 * whole reason not to leave a cast lying about.
 *
 * What is NOT deferred: the panel already computes and publishes the answer
 * (`data-attn-desk-eligible`), and attentionview.test.tsx asserts it, so the
 * decision this flag carries is under test today and only its delivery is
 * waiting.
 */
const deskRegistryProps = (eligible: boolean, claim?: 'automatic'): Partial<DeskChatProps> =>
  ({ eligible, ...(claim ? { claim } : {}) } as unknown as Partial<DeskChatProps>)

/** Every agent, in the host's own visual order, each superior immediately
 *  followed by its subtree — the Agents List's hierarchy rule. */
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
      rows.push({ node: c, depth })
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

export function AgentDeskPanel({
  slug, tree, op, toast, map, posOf, deskExtras, eligible = true, claim,
}: AgentDeskPanelProps) {
  const layout = useAttentionLayout(slug)
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  // rolled out by a hover or by the keyboard being inside it, as opposed to
  // held open by the toggle (`layout.listOpen`, which persists)
  const [transient, setTransient] = useState(false)
  const open = layout.listOpen || transient

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

  const select = useCallback((id: string) => {
    setAttentionLayout(slug, { agent: id })
    // a selection is a decision: the rolled-out list retracts behind it,
    // unless the user has deliberately held it open
    setTransient(false)
  }, [slug])

  const listRef = useRef<HTMLDivElement>(null)
  // hover and focus both roll the list out; only losing BOTH retracts it
  const hovering = useRef(false)
  const focused = useRef(false)
  const settle = () => setTransient(hovering.current || focused.current)

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
    else if (e.key === 'Escape' && transient) { setTransient(false); focused.current = false }
  }

  return (
    <div className={'attn-agents-wrap' + (open ? ' list-open' : '')}>
      <div className="attn-agents-bar">
        <button type="button" className="iconbtn attn-agents-toggle"
          aria-expanded={layout.listOpen}
          title={layout.listOpen ? 'collapse the agents list' : 'keep the agents list open'}
          aria-label={layout.listOpen ? 'Collapse the agents list' : 'Keep the agents list open'}
          onClick={() => setAttentionLayout(slug, { listOpen: !layout.listOpen })}>
          {layout.listOpen ? <ChevronLeftIcon fontSize="inherit" /> : <ViewListIcon fontSize="inherit" />}
        </button>
        {!open && <span className="dim attn-agents-rail-label" aria-hidden="true">agents</span>}
      </div>
      <div className="attn-agents" role="listbox" aria-label="Agents" ref={listRef}
        onPointerEnter={() => { hovering.current = true; settle() }}
        onPointerLeave={() => { hovering.current = false; settle() }}
        onFocusCapture={() => { focused.current = true; settle() }}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            focused.current = false
            settle()
          }
        }}
        onKeyDown={onListKey}>
        <input className="mail-filter tray-filter" placeholder="filter agents…"
          aria-label="Filter agents" value={query}
          onChange={(e) => setQuery(e.target.value)} />
        {(() => {
          const n = [...map.values()].filter((x) =>
            x.id !== USER && x.id !== DRAFT && !x.isBearerOf && x.state !== 'live').length
          return n > 0 && <button type="button" className="tray-arch"
            onClick={() => setArchived((v) => !v)}>
            {archived ? '▾ hide' : '▸ show'} {n} archived
          </button>
        })()}
        {rows.map(({ node, depth }) => (
          <button type="button" key={node.id} data-attn-agent={node.id}
            {...agentNavProps(node.id)}
            role="option" aria-selected={node.id === selectedId}
            tabIndex={node.id === selectedId ? 0 : -1}
            className={'attn-agent-row'
              + (node.id === selectedId ? ' sel' : '')
              + (node.state !== 'live' ? ' dim' : '')}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => select(node.id)}>
            <AgentName id={node.id} tier={node.tier} />
            {node.busy && <span className="attn-agent-busy" title="working" aria-label="working" />}
            {(node.mail_pending ?? 0) > 0 &&
              <b className="eye-count">{node.mail_pending}</b>}
          </button>
        ))}
        {!rows.length && <div className="dim pad">no agents match</div>}
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
              {...deskRegistryProps(eligible, claim)}
              {...deskExtras} />
          : <div className="dim pad attn-desk-empty">
              This organization has no agent to open a desk for yet.
            </div>}
      </div>
      {!open && <button type="button" className="attn-agents-peek"
        aria-label="Show the agents list"
        onPointerEnter={() => { hovering.current = true; settle() }}
        onFocus={() => { focused.current = true; settle() }}
        onClick={() => setAttentionLayout(slug, { listOpen: true })}>
        <ChevronRightIcon fontSize="inherit" />
      </button>}
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
