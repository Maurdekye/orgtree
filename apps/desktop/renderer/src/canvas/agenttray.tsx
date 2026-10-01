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
import { ago, DRAFT, providerOf, queuedSwitchTitle, TIER_LETTER, USER } from './shared'
import { ContextWheel, TrayStatus } from './desk'
import type { RefRoutes } from './reflinks'
import { Written } from './reflinks'
import { charterLine } from '../archived'

export interface TrayRow {
  node: CanvasNode
  depth: number
  /** a filtered-out ancestor kept so a matching descendant's indent still has
   *  a parent above it (FR-16) */
  ghost?: boolean
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
  /** shown when no row matches; nothing by default (the canvas's behaviour) */
  empty?: ReactNode
}

export function AgentTray({
  map, rows, query, onQuery, archived, onArchived, onPick, onRowMenu, compactAt,
  refs, selected, listProps, mainProps, rowProps, filterLabel, empty,
}: AgentTrayProps) {
  const archN = archivedCount(map)
  return (
    <div className="tray" {...listProps}>
      <input className="mail-filter tray-filter" placeholder="filter agents…"
        aria-label={filterLabel} value={query} onChange={(e) => onQuery(e.target.value)} />
      {/* archived rows are HIDDEN by default (user spec 2026-07-31) — the
          count row folds them in and out */}
      {archN > 0 && (
        <button type="button" className="tray-arch" onClick={() => onArchived(!archived)}>
          {archived ? '▾ hide' : '▸ show'} {archN} archived
        </button>
      )}
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
          <div key={n.id} data-copy-agent-name={n.id}
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
                {...mainProps?.(n)}>
                <span className={'tier t-' + n.tier}>{TIER_LETTER[n.tier!] ?? '?'}</span>
                {n.pending_switch &&
                  <span className="queued-mark" title={queuedSwitchTitle(n)}>
                    →{TIER_LETTER[n.pending_switch.tier] ?? '?'}</span>}
                <span className="tray-name"
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
            {stat?.summary && (
              <div className={'tray-sum' + (stat._stale ? ' stale' : '')}
                title={stat.summary}>
                <span className="tray-sum-text">
                  {stat.status}: <Written text={stat.summary} refs={refs} />
                </span>
                {stat.at && <span className="tray-sum-at"> · {ago(stat.at)} ago</span>}
              </div>
            )}
          </div>
        )
      })}
      {!rows.length && empty}
    </div>
  )
}
