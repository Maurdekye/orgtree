// shell/orgrows.tsx — the organization list rows.
//
// Moved out of App.tsx so the Homepage view and the compact menu can render
// them without importing App.tsx, which renders both. App.tsx re-exports the
// component, so every existing importer is unaffected.
import { AutorenewIcon, DeleteIcon, PublicIcon } from '../icons'
import type { OrgFreshness } from '../orgstatus'
import type { OrgListEntry } from '../types'

/** The org list rows — the same columns the tray's primary-click list shows
 * (user spec 2026-09-10): an activity cell (spinner ONLY while that org has a
 * turn executing), the name, and an always-visible n/m count where n = agents
 * active now (`working`, supervisor.working_count()) and m = currently hired
 * agents (`live`). Every row renders every cell so the columns line up when
 * idle; a public listing row (no `working` — deliberately omitted server-side)
 * shows its hired count alone rather than inventing a zero. */
export function OrgRows({ orgs, slug, onPick, onDelete, freshness = 'current',
  ageMs = 0, openLabel }: {
  orgs: OrgListEntry[]; slug: string | null
  onPick: (slug: string) => void; onDelete: (org: OrgListEntry) => void
  /** how old these rows' STATUS values are (`orgstatus.ts`). Defaults to
   *  'current' so every caller that has no freshness to report — and every
   *  test that mounts fixed rows — reads exactly as it always did. */
  freshness?: OrgFreshness
  ageMs?: number
  /** slugs already open in another window, labelled instead of counted. Empty
   *  in the browser, where there is only ever one window. */
  openLabel?: (slug: string) => string | null
}) {
  // ⚠ THE SPINNER AND THE COUNTS ARE THE STATUS, and status is the one thing
  // an unfresh snapshot may not assert. The spinner is the loudest claim in
  // the row — an animation that says "a turn is executing now" — so it is
  // suppressed whenever the numbers behind it predate the open or have stopped
  // refreshing, rather than spinning on somebody's memory of three minutes
  // ago. Names, ordering, kiosk badges and every navigation affordance are
  // untouched: those are not status and they do not go stale on this timescale.
  const current = freshness === 'current'
  const staleTitle = freshness === 'loading'
    ? 'checking current status…'
    : `active / hired agents — from ${Math.round(ageMs / 1000)}s ago, not refreshing`
  return <>
    {orgs.map((o) => {
      const already = openLabel?.(o.slug) ?? null
      return (
      <div key={o.slug} role="button" tabIndex={0}
        className={'org' + (o.slug === slug ? ' current' : '')
          + (o.kiosk_cfg || o.kiosk ? ' kiosk-org' : '')}
        onClick={() => onPick(o.slug)}
        onKeyDown={(e) => { if (e.key === 'Enter') onPick(o.slug) }}>
        <span className="org-activity">
          {current && (o.working ?? 0) > 0 &&
            <span className="working-ct"
              title={`${o.working} agent${o.working === 1 ? '' : 's'} active — a turn executing now`}>
              <AutorenewIcon fontSize="inherit" className="cc-spin" /></span>}
        </span>
        <span className="org-name">
          <span className="org-name-text">{o.name}</span>
          {(o.kiosk_cfg || o.kiosk) &&
            <span className="kiosk-badge" title="kiosk org"><PublicIcon fontSize="inherit" /></span>}
          {already && <span className="org-open-badge">{already}</span>}
        </span>
        <span className={'org-counts dim'
          + (freshness === 'loading' ? ' org-counts-loading' : '')
          + (freshness === 'stale' ? ' org-counts-stale' : '')}
          title={current ? 'active / hired agents' : staleTitle}>
          {freshness === 'loading' ? '…'
            : typeof o.working === 'number' ? `${o.working}/${o.live}` : `${o.live}`}
        </span>
        {/* kiosk orgs delete like any other (user report 2026-07-31: the
            old !o.kiosk gate left NO UI path at all — the server already
            refuses public deletes, so hiding the trash from the admin
            protected nothing) */}
        <button className="org-del"
          onClick={(e) => { e.stopPropagation(); onDelete(o) }}><DeleteIcon fontSize="inherit" /></button>
      </div>
      )
    })}
    {!orgs.length && <div className="dim pad">no organizations yet</div>}
  </>
}
