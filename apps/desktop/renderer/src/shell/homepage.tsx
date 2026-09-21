// shell/homepage.tsx — the Homepage view: every organization, and the two
// ways out of it.
//
// A Homepage window is bound to nothing. Choosing an organization that is not
// open turns THIS window into that organization's Canvas — same window, same
// document, same window id, only the binding changes. Choosing one that is
// already open focuses its existing window and leaves this Homepage exactly
// where it was, because the settled rule is one main window per organization
// and this window is not it.
//
// ⚠ CREATING ALWAYS OPENS A SEPARATE WINDOW, even from here. The Homepage is
// not consumed by starting a creation: if the creation is abandoned the
// organization list is still there behind it. It is the CREATION window that
// becomes the new organization's Canvas on success.
import { useState } from 'react'
import { OrgRows } from './orgrows'
import { orgFreshnessNote } from '../orgstatus'
import type { OrgFreshness } from '../orgstatus'
import type { OrgListEntry } from '../types'
import type { ReactNode } from 'react'

export interface HomepageViewProps {
  orgs: OrgListEntry[]
  freshness: OrgFreshness
  ageMs: number
  error: string | null
  /** already open in another window — the row says so and focuses it */
  isOpenElsewhere?: (slug: string) => boolean
  onOpenOrg: (slug: string) => void
  onCreateOrg: () => void
  onDelete: (org: OrgListEntry) => void
  /** the first-run setup card, when this installation has no organizations
   *  yet. `null` at every other time. */
  onboarding?: ReactNode
}

export function HomepageView(props: HomepageViewProps) {
  const { orgs, freshness, ageMs, error, isOpenElsewhere,
    onOpenOrg, onCreateOrg, onDelete, onboarding } = props
  const [filter, setFilter] = useState('')
  if (onboarding) return <div className="shell-page shell-homepage">{onboarding}</div>
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? orgs.filter((o) => o.name.toLowerCase().includes(needle)
      || o.slug.toLowerCase().includes(needle))
    : orgs
  const note = orgFreshnessNote(freshness, ageMs, error)
  return (
    <div className="shell-page shell-homepage">
      <div className="shell-page-inner">
        <div className="shell-page-eyebrow">Homepage</div>
        <div className="shell-page-head">
          <h1 className="shell-page-title">Your organizations</h1>
          <button type="button" className="primary shell-create-btn"
            onClick={onCreateOrg}>Create new organization</button>
        </div>
        {/* the filter appears only when the list is long enough to need it —
            a search box over four rows is furniture, not a feature */}
        {orgs.length > 6 && (
          <input className="shell-homepage-filter"
            aria-label="find an organization" placeholder="Find an organization"
            value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
        {note && <div className="dim org-freshness" role="status">{note}</div>}
        <nav className="shell-homepage-list" aria-label="organizations">
          <OrgRows orgs={shown} slug={null} onPick={onOpenOrg} onDelete={onDelete}
            freshness={freshness} ageMs={ageMs}
            openLabel={(slug) => (isOpenElsewhere?.(slug) ? 'Already open' : null)} />
        </nav>
        {!shown.length && orgs.length > 0 &&
          <div className="dim pad">no organization matches “{filter}”</div>}
      </div>
    </div>
  )
}
