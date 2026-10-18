import { QueuedModelBadge } from './nextturn'
// canvas/agenttray.tsx — THE AGENTS LIST, one component for every place it shows.
//
// The canvas's Agents List (the tray) and the Attention view's agents drawer
// are the same list (user 2026-09-30: the drawer "should look identical to
// the canvas agents list"). This used to be written inline in OrgCanvas and
// the drawer had rows of its own; now both render this, so a row, the filter
// box and the archived toggle are the same markup and the same stylesheet
// rules (`.tray`, `.tray-row` in styles.css) wherever they appear.
//
// What stays with the HOST: which rows, in what order (the canvas sorts by
// its own layout; the Attention view left to right — see agentRows in
// attention/AgentDeskPanel.tsx), what a press on a row does, and what its
// context menu offers. What differs by host is passed in, never branched on.

import type { HTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode, Ref } from 'react'
import type { NodeStatus } from '../types'
import type { CanvasNode } from './shared'
import { ago, DRAFT, providerOf, tierLabel, USER } from './shared'
import { ContextWheel, TrayStatus } from './desk'
import type { RefRoutes } from './reflinks'
import { Written } from './reflinks'
import { charterLine } from '../archived'
import { agentTooltipProps } from './agentnav'
import { TierChip, nodeTierOf } from './identity'

export interface TrayRow {
  node: CanvasNode
  depth: number
  /** a filtered-out ancestor kept so a matching descendant's indent still has
   *  a parent above it (FR-16) */
  ghost?: boolean
}

/** The switchboard identity used by the top-level superior row and its selected value. */
export function SwitchboardMark() {
  return <span className="tier quickchat-user-mark" aria-hidden="true">
    <svg className="eye" viewBox="0 0 48 26">
      <path d="M 2 13 C 13 2, 35 2, 46 13 C 35 24, 13 24, 2 13 Z" />
      <circle className="iris" cx="24" cy="13" r="6.5" />
      <circle className="pupil" cx="24" cy="13" r="2.6" />
    </svg>
  </span>
}

/** THE LIST'S ROWS, by hierarchy (FR-16): every superior immediately
 *  followed by its subtree, indented per depth, siblings ordered by the HOST's
 *  `compare` (null = the tree's own order). A filtered-out ancestor of a match
 *  stays as a ghost so the descendant's indent still has a parent above it.
 *  Both hosts call this — the canvas tray and the Attention drawer
 *  (`agentRows`) — and so does Quick chat's superior menu, so the three
 *  cannot list agents in different orders. */
export function trayRows(map: Map<string, CanvasNode>, opts: {
  archived?: boolean; query?: string; activeOnly?: boolean
  compare?: ((a: CanvasNode, b: CanvasNode) => number) | null
} = {}): TrayRow[] {
  const all = [...map.values()].filter((n) =>
    n.id !== USER && n.id !== DRAFT && !n.isBearerOf)
  const q = (opts.query ?? '').trim().toLowerCase()
  const match = (n: CanvasNode) =>
    (opts.archived || n.state === 'live') && (!opts.activeOnly || n.busy === true)
      && (!q || n.id.toLowerCase().includes(q))
  const kids = new Map<string, CanvasNode[]>()
  for (const n of all) {
    const parent = n.parent && map.has(n.parent) && n.parent !== USER ? n.parent : USER
    kids.set(parent, [...(kids.get(parent) ?? []), n])
  }
  const anyMatch = (n: CanvasNode): boolean =>
    match(n) || (kids.get(n.id) ?? []).some(anyMatch)
  const rows: TrayRow[] = []
  const walk = (id: string, depth: number) => {
    const siblings = kids.get(id) ?? []
    for (const c of opts.compare ? [...siblings].sort(opts.compare) : siblings) {
      if (!anyMatch(c)) continue
      rows.push({ node: c, depth, ghost: !match(c) })
      walk(c.id, depth + 1)
    }
  }
  walk(USER, 0)
  return rows
}

/** how many rows the archived toggle folds in and out */
export const archivedCount = (map: Map<string, CanvasNode>): number =>
  [...map.values()].filter((n) =>
    n.id !== USER && n.id !== DRAFT && !n.isBearerOf && n.state !== 'live').length

export interface AgentTrayProps {
  map: Map<string, CanvasNode>
  rows: TrayRow[]
  query: string
  onQuery: (q: string) => void
  archived: boolean
  onArchived: (v: boolean) => void
  /** press on a row */
  onPick: (id: string) => void
  /** right-click on a row; `go` is the same action a press takes */
  onRowMenu?: (e: ReactMouseEvent, node: CanvasNode, go: () => void) => void
  compactAt?: number
  refs?: RefRoutes
  /** the row the host is showing — drawn as selected */
  selected?: string | null
  /** extra attributes on the tray itself (a listbox role, a key handler) */
  listProps?: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }
  /** extra attributes on a row's focusable main line */
  mainProps?: (node: CanvasNode) => HTMLAttributes<HTMLButtonElement> & Record<string, unknown>
  /** extra attributes on the row */
  rowProps?: (node: CanvasNode) => HTMLAttributes<HTMLDivElement> & Record<string, unknown>
  filterLabel?: string
  /** host-owned root/option rows after the filter, before the agent hierarchy */
  leadingRows?: ReactNode
  /** controls that belong beside this list's search filter */
  filterActions?: ReactNode
  /** shown when no row matches; nothing by default (the canvas's behaviour) */
  empty?: ReactNode
  /** whether to show a pending model switch badge in each row; defaults to
   *  true for shared trays outside the canvas Agents sidebar */
  showQueuedModelBadge?: boolean
}

/** Compact checkbox in the Agents panel's title bar. The host owns the
 *  persisted preference; this component only reports the user's choice. */
export function ActiveAgentsFilter({ checked, onChange }: {
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="modalpin-active-filter" title="Show only agents currently running a turn">
      <input type="checkbox" aria-label="Only active agents" checked={checked}
        onChange={event => onChange(event.currentTarget.checked)} />
      <span>active</span>
    </label>
  )
}

export function AgentTray({
  map, rows, query, onQuery, archived, onArchived, onPick, onRowMenu, compactAt,
  refs, selected, listProps, mainProps, rowProps, filterLabel, leadingRows, filterActions, empty,
  showQueuedModelBadge = true,
}: AgentTrayProps) {
  const archN = archivedCount(map)
  return (
    <div className="tray" {...listProps}>
      {filterActions ? (
        <div className="tray-filter-row">
          <input className="mail-filter tray-filter" placeholder="filter agents…"
            aria-label={filterLabel} value={query} onChange={(e) => onQuery(e.target.value)} />
          {filterActions}
        </div>
      ) : (
        <input className="mail-filter tray-filter" placeholder="filter agents…"
          aria-label={filterLabel} value={query} onChange={(e) => onQuery(e.target.value)} />
      )}
      {/* archived rows are HIDDEN by default (user spec 2026-07-31) — the
          count row folds them in and out */}
      {archN > 0 && (
        <button type="button" className="tray-arch" onClick={() => onArchived(!archived)}>
          {archived ? '▾ hide' : '▸ show'} {archN} archived
        </button>
      )}
      {leadingRows}
      {rows.map(({ node: n, depth, ghost }) => {
        const go = () => onPick(n.id)
        // №13: the status summary is TEXT here, not a tooltip — and a
        // finished status survives the next turn as prev_status (dim)
        const stat: (NodeStatus & { _stale?: boolean }) | null = n.last_status
          ?? (n.prev_status ? { ...n.prev_status, _stale: true } : null)
        const lastTurn = n.turns?.[n.turns.length - 1]
        return (
          /* ⚠ THE ROW IS NOT ITSELF A BUTTON, which is what lets its summary
             carry reference controls: a button inside a `role="button"` is
             invalid nesting. The row navigates on click, the MAIN LINE is the
             focusable button (Enter/Space arrive as a click and bubble to the
             row's one handler, so activation cannot fire twice), and the
             summary is a sibling of that button. Nothing in the main line is
             interactive: ContextWheel is only a button when given
             `onCompact`, which the tray does not pass. */
          <div key={n.id} data-copy-agent-name={n.id} {...agentTooltipProps(n.id)}
            {...rowProps?.(n)}
            className={'tray-row' + (n.state !== 'live' ? ' off' : '')
              + (ghost ? ' ghost' : '')
              + (selected === n.id ? ' sel' : '')
              + ' prov-' + providerOf(n.tier ?? '')}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={ghost
              ? 'shown for context — this row does not match the '
                + 'current filter, but a report under it does'
              : undefined}
            onClick={go}
            /* A right-click never navigates: `contextmenu` is not `click`,
               and `go` is on the click. */
            onContextMenu={onRowMenu ? (e) => onRowMenu(e, n, go) : undefined}>
            <div className="tray-primary">
              <button type="button" className="tray-main" title={`go to ${n.id}`}
                {...agentTooltipProps(n.id)}
                {...mainProps?.(n)}>
                <TierChip tier={nodeTierOf(n)} agentName={n.id} />
                {showQueuedModelBadge && <QueuedModelBadge node={n} />}
                <span className="tray-name" {...agentTooltipProps(n.id)}
                  title={charterLine(n) || n.id}>{n.id}</span>
                <ContextWheel occ={n.occupancy} cw={n.context_window}
                  est={n.occupancy_est} compactAt={compactAt} />
                <TrayStatus node={n} turn={lastTurn} live={n.state === 'live'} />
              </button>
              {/* ⚠ NO PER-AGENT CONTROLS HERE ANY MORE (user ruling
                  2026-09-12): the row's ⌖ pin and ↗ popout buttons are gone,
                  and both actions live in the row's context menu with
                  everything else the agent can do. */}
            </div>
            {/* ⚠ THE WHOLE SUMMARY, MATCHED BEFORE ANY TRUNCATION: a slice
                here cuts tokens in half, and the clipping is the stylesheet's
                job (`.tray-sum-text` is ellipsis-clipped). The AGE is its own
                element so the ellipsis eats the summary's tail rather than the
                one fact beside it that the summary does not contain. */}
              <div className={'tray-sum' + (stat?._stale ? ' stale' : '')}
                title={stat?.summary || undefined}>
                {stat?.summary ? <>
                <span className="tray-sum-text">
                  {stat.status}: <Written text={stat.summary} refs={refs} />
                </span>
                {stat.at && <span className="tray-sum-at"> · {ago(stat.at)} ago</span>}
                </> : <span className="tray-sum-text" aria-hidden="true">&nbsp;</span>}
              </div>
          </div>
        )
      })}
      {!rows.length && empty}
    </div>
  )
}
