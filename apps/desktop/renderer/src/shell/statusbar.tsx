// shell/statusbar.tsx — the organization status strip along the bottom of an
// organization window.
//
// WHY IT MOVED. Every chip here used to sit in the header's `.bar-detail` run,
// between the organization name and the action buttons. The settled v3 header
// is compact — one app menu, a plain title, a prominent Canvas/Attention
// toggle, the familiar action buttons and the native controls — and there is
// no room left in it for nine status chips. The approved mockup shows a status
// strip along the bottom of the window, so that is where the whole run went.
//
// ⚠ MOVED, NOT REDUCED. Every chip keeps its own visibility rule, its exact
// tooltip and its click-through: the mail-hub chip still opens Org settings at
// Connections, the kiosk spend chip still turns bad at 90% of its limit, the
// audit chip still speaks only when something is wrong. Nothing here is a
// summary of what used to be shown; it is what used to be shown, in a
// different place.
//
// THE CONNECTIVITY ERROR IS PINNED TO THE END AND NEVER SCROLLS AWAY. In the
// header it was absolutely positioned so its arrival could not change the
// bar's height and push the canvas down. That hazard is gone — a bottom strip
// growing by a line does not move what is under the pointer — but a second one
// took its place: a strip that scrolls its chips at narrow widths could carry
// an actionable error off the end of a row nobody scrolls. So the chips are
// the part that yields and the error keeps its seat.
import { BlockIcon, EyeIcon, LanIcon, AutorenewIcon, WarnIcon } from '../icons'
import { primedRestartChip } from '../canvas/shared'
import { ActiveAgentSummary, costLabel, costTitle, showCost } from './treeinfo'
import type { OrgListEntry, TreePayload } from '../types'

export interface OrgStatusBarProps {
  tree: TreePayload
  /** the cross-organization list, for the activity chip's tooltip */
  orgs: Pick<OrgListEntry, 'name' | 'working'>[]
  /** the connectivity/save error, or null */
  error: string | null
  /** open Org settings at Connections — the mail-hub chip's click-through */
  onOpenConnections: () => void
}

export function OrgStatusBar({ tree, orgs, error, onOpenConnections }: OrgStatusBarProps) {
  const hubs = (tree.net?.hubs ?? []).filter((h) => h.enabled && !h.hidden)
  const up = hubs.filter((h) => h.connected).length
  const queued = hubs.reduce((a, h) => a + h.queued, 0)
  const hubLabel = hubs.length === 1
    ? (hubs[0]?.name || (hubs[0]?.id === 'local' ? 'local hub' : 'hub'))
    : `${up}/${hubs.length} hubs`
  const primed = primedRestartChip(tree.primed_restart, true)
  return (
    <footer className="shell-statusbar" aria-label="organization status">
      <div className="shell-statusbar-chips">
        {/* the ledger self-audit only speaks when something is wrong; credit
            totals live on the eye's bar */}
        {!tree.audit.no_overdraft &&
          <span className="chip bad"><WarnIcon fontSize="inherit" /> {tree.audit.problems.join(', ')}</span>}
        <ActiveAgentSummary tree={tree} orgs={orgs} />
        {/* the bare cost chip is redundant when the kiosk spend chip already
            shows the same figure against its limit (user spec 2026-07-31) —
            limitless orgs keep it */}
        {showCost(tree) && !tree.kiosk?.spend_limit &&
          <span className="chip" title={costTitle(tree)}>{costLabel(tree)}</span>}
        {tree.fable_lock &&
          <span className="chip bad" title={tree.fable_lock.at as string | undefined}>
            <BlockIcon fontSize="inherit" /> fable limit</span>}
        {tree.kiosk?.spend_limit && (
          tree.spend_frozen
            ? <span className="chip bad"><BlockIcon fontSize="inherit" /> spend limit reached — agents frozen</span>
            : <span className={'chip' + (tree.cost_usd_total >= tree.kiosk.spend_limit * 0.9 ? ' bad' : '')}
              title={costTitle(tree, true)}>
              {costLabel(tree)} / ${tree.kiosk.spend_limit.toFixed(2)}
            </span>
        )}
        {tree.headless && (
          <span className="chip"
            title="headless: no user is present — user-bound requests auto-deny; the eye renders grey and empty">
            <EyeIcon fontSize="inherit" /> headless
          </span>
        )}
        {/* V2 maintenance records are machine-local and the native consumer
            performs an installed-app relaunch after idle. The words live in
            `primedRestartChip` so the desktop and standard renderer contracts
            can be tested separately. */}
        {primed && (
          <span className="chip primed" title={primed.title}>
            <AutorenewIcon fontSize="inherit" /> {primed.label}
          </span>
        )}
        {/* Every enabled, non-hidden hub gets a token — the LOCAL hub included
            once it has answered. Clicking the chip opens Connections: a
            failure's diagnostics are one click from the failure. */}
        {hubs.length > 0 && (
          <span role="button" tabIndex={0}
            className={'chip' + (up === 0 ? ' bad' : '')}
            style={{ cursor: 'pointer' }}
            onClick={onOpenConnections}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenConnections() }
            }}
            title={hubs.map((h) =>
              `${h.name || h.address}: ${h.connected ? 'connected' : h.error || 'connecting…'}`).join(' · ')
              + ' — click to open Connections'}>
            <LanIcon fontSize="inherit" /> {hubLabel}
            {up === 0 ? ': offline' : ''}
            {queued > 0 ? ` · ${queued} queued` : ''}
          </span>
        )}
      </div>
      {/* pinned, outside the scrolling run — see the header note */}
      {error && (
        <span className="chip bad shell-statusbar-error" role="alert" title={error}>
          <WarnIcon fontSize="inherit" />
          <span className="conn-chip-text">{error}</span>
        </span>
      )}
    </footer>
  )
}
