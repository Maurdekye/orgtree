// shell/menu.tsx — the one compact application menu.
//
// The v3 header replaces the expandable organization sidebar, and this is
// where the navigation that sidebar carried went: opening a window, opening an
// organization, creating one, the app-wide panels, and what version is
// running. Everything else on the header is a DIRECT button, because the
// settled design keeps the familiar action buttons rather than burying them in
// traditional menus — this menu is for navigation and app-wide state, and it
// is deliberately the only menu there is.
//
// ⚠ IT IS PRESENT IN ALL FOUR VIEWS. Homepage and Create have no organization
// and therefore no header action buttons, so for those two windows this menu
// is the ONLY way to reach Usage and App settings. That is why Usage is an
// entry here as well as a direct button in an organization window: dropping it
// from the non-org views would silently remove the usage snapshots the shell
// is required to preserve.
//
// A DEDICATED DROPDOWN RATHER THAN `useContextMenu`. The canonical object menu
// takes plain string labels, and the organization list here is not a list of
// labels: each row carries a live activity spinner, an active/hired count, a
// kiosk badge, an "already open" mark and the freshness of the snapshot behind
// all of them. Rendering that through a label API would mean flattening it to
// text and losing the thing the list is for.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { DataUsageIcon, HomeIcon, MenuIcon, SettingsIcon } from '../icons'
import { orgFreshnessNote } from '../orgstatus'
import type { OrgFreshness } from '../orgstatus'
import type { OrgListEntry } from '../types'

export interface OrgtreeMenuProps {
  /** every organization, in the list's existing order */
  orgs: OrgListEntry[]
  freshness: OrgFreshness
  ageMs: number
  error: string | null
  /** the organization this window is bound to, if any */
  currentOrg: string | null
  /** slugs already open in another window — selecting one focuses it */
  isOpenElsewhere?: (slug: string) => boolean
  onOpenOrg: (slug: string) => void
  onNewWindow: () => void
  onCreateOrg: () => void
  onUsage: () => void
  onAppSettings: () => void
  /** the real running version, shown inline on the About entry. `null` in a
   *  plain browser, which has no packaged version and is given no invented
   *  one — the entry then simply carries no value. */
  appVersion: string | null
  /** told whenever the organization list inside the menu opens or closes.
   *  ⚠ THIS IS NOT COSMETIC: the org-status poller runs while a list is on
   *  screen and stops when none is, and this menu is a list. Without it the
   *  menu in a bound organization window would be the one organizations list
   *  in the app that never refreshed, which is the exact defect
   *  `show-current-organization-statuses-immediately` exists to remove. */
  onOrgListOpen?: (open: boolean) => void
}

/** Move focus among the menu's items. Kept as a function of the CURRENT
 *  element rather than an index, because the organization list grows and
 *  shrinks under the menu as it refreshes and an index would point at a
 *  different row after every poll. */
function focusItem(panel: HTMLElement | null, from: Element | null,
  move: 'next' | 'prev' | 'first' | 'last'): void {
  if (!panel) return
  const items = [...panel.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not([aria-disabled="true"])')]
  if (!items.length) return
  if (move === 'first') { items[0]!.focus(); return }
  if (move === 'last') { items.at(-1)!.focus(); return }
  const at = from ? items.indexOf(from as HTMLElement) : -1
  const next = move === 'next'
    ? (at < 0 ? 0 : (at + 1) % items.length)
    : (at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length)
  items[next]!.focus()
}

export function OrgtreeMenu(props: OrgtreeMenuProps) {
  const { orgs, freshness, ageMs, error, currentOrg, isOpenElsewhere,
    onOpenOrg, onNewWindow, onCreateOrg, onUsage, onAppSettings, appVersion } = props
  const [open, setOpen] = useState(false)
  const [orgList, setOrgList] = useState(false)
  const [filter, setFilter] = useState('')
  // ⚠ REPORTED FROM AN EFFECT, NOT FROM THE SETTER. Calling the parent's
  // callback inside a state updater is a side effect in the render phase, and
  // React may run an updater twice; an effect on the settled value reports
  // once and reports the truth. The cleanup reports `false` so a menu that
  // unmounts with its list open does not leave the poller believing a list is
  // still on screen.
  const notifyOrgList = useRef(props.onOrgListOpen)
  notifyOrgList.current = props.onOrgListOpen
  useEffect(() => { notifyOrgList.current?.(orgList) }, [orgList])
  useEffect(() => () => { notifyOrgList.current?.(false) }, [])
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()

  // closing RETURNS FOCUS to the button. Without that a keyboard user who
  // escapes the menu is left with focus on the document body, several tab
  // stops from where they were.
  const close = useCallback((restore = true) => {
    setOpen(false); setOrgList(false); setFilter('')
    if (restore) button.current?.focus()
  }, [])

  const run = (fn: () => void) => { close(false); fn() }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
    }
    // ⚠ POINTERDOWN, NOT CLICK, for the outside press. A click listener fires
    // after the press has already moved focus, so a press on another header
    // button would close the menu and then be delivered to a button the menu
    // was covering a moment ago.
    const onDown = (e: Event) => {
      const t = e.target as Node | null
      if (panel.current?.contains(t as Node) || button.current?.contains(t as Node)) return
      close(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, close])

  // opening with the keyboard lands on the first item; opening with the
  // pointer leaves focus on the button, which is what a pointer user expects.
  //
  // ⚠ THE FOCUS HAPPENS IN AN EFFECT, not beside the `setOpen`. A microtask
  // scheduled there runs BEFORE React has rendered the panel, so `panel.current`
  // is still null and the focus silently goes nowhere — measured. The effect
  // runs after the panel exists, which is the only moment there is anything to
  // focus.
  const wantFirst = useRef(false)
  useEffect(() => {
    if (!open || !wantFirst.current) return
    wantFirst.current = false
    focusItem(panel.current, null, 'first')
  }, [open])
  const openWith = (fromKeyboard: boolean) => {
    wantFirst.current = fromKeyboard
    setOpen(true)
  }

  const note = orgFreshnessNote(freshness, ageMs, error)
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? orgs.filter((o) => o.name.toLowerCase().includes(needle)
      || o.slug.toLowerCase().includes(needle))
    : orgs

  return (
    <div className="shell-menu">
      <button ref={button} type="button" className="shell-menu-button"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : openWith(false))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); open ? focusItem(panel.current, null, 'first') : openWith(true)
          }
        }}>
        Orgtree <MenuIcon fontSize="inherit" />
      </button>
      {open && (
        <div ref={panel} id={id} className="shell-menu-panel" role="menu"
          aria-label="Orgtree menu"
          onKeyDown={(e) => {
            const from = (e.target as Element).closest('[role="menuitem"]')
            if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(panel.current, from, 'next') }
            else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(panel.current, from, 'prev') }
            else if (e.key === 'Home') { e.preventDefault(); focusItem(panel.current, null, 'first') }
            else if (e.key === 'End') { e.preventDefault(); focusItem(panel.current, null, 'last') }
            else if (e.key === 'Tab') close(false)
          }}>
          <div className="shell-menu-group">Organizations</div>
          <button type="button" role="menuitem" className="shell-menu-item"
            onClick={() => run(onNewWindow)}>
            <HomeIcon fontSize="inherit" />
            <span className="shell-menu-label">New window</span>
            <span className="shell-menu-value dim">Homepage</span>
          </button>
          <button type="button" role="menuitem" className="shell-menu-item"
            aria-haspopup="true" aria-expanded={orgList}
            onClick={() => setOrgList((v) => !v)}>
            <span className="shell-menu-label">Open organization…</span>
            <span className="shell-menu-value dim" aria-hidden="true">{orgList ? '▾' : '▸'}</span>
          </button>
          {orgList && (
            <div className="shell-menu-orgs">
              {orgs.length > 6 && (
                <input className="shell-menu-filter" autoFocus
                  aria-label="find an organization" placeholder="Find an organization"
                  value={filter} onChange={(e) => setFilter(e.target.value)} />
              )}
              {note && <div className="dim org-freshness" role="status">{note}</div>}
              {shown.map((o) => {
                const elsewhere = isOpenElsewhere?.(o.slug) === true
                return (
                  <button key={o.slug} type="button" role="menuitem"
                    className={'shell-menu-org' + (o.slug === currentOrg ? ' current' : '')}
                    onClick={() => run(() => onOpenOrg(o.slug))}>
                    <span className="shell-menu-label">{o.name}</span>
                    {elsewhere
                      ? <span className="shell-menu-value dim">Already open</span>
                      : <span className="shell-menu-value dim">
                        {/* the SAME freshness rule the list rows obey: an
                            unfresh snapshot shows no count rather than an
                            old one presented as current */}
                        {freshness !== 'current' ? '…'
                          : typeof o.working === 'number' ? `${o.working}/${o.live}` : `${o.live}`}
                      </span>}
                  </button>
                )
              })}
              {!shown.length && <div className="dim pad">
                {orgs.length ? 'no match' : 'no organizations yet'}</div>}
            </div>
          )}
          <button type="button" role="menuitem" className="shell-menu-item"
            onClick={() => run(onCreateOrg)}>
            <span className="shell-menu-label">Create new organization…</span>
          </button>
          <div className="shell-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="shell-menu-item"
            onClick={() => run(onUsage)}>
            <DataUsageIcon fontSize="inherit" />
            <span className="shell-menu-label">Usage…</span>
          </button>
          <button type="button" role="menuitem" className="shell-menu-item"
            onClick={() => run(onAppSettings)}>
            <SettingsIcon fontSize="inherit" />
            <span className="shell-menu-label">App settings…</span>
          </button>
          <div className="shell-menu-sep" role="separator" />
          {/* the REAL running version, inline. The mockup's 3.0.0 was
              illustrative; a browser has none and is shown none. */}
          <button type="button" role="menuitem" className="shell-menu-item"
            onClick={() => run(onAppSettings)}>
            <span className="shell-menu-label">About Orgtree</span>
            {appVersion && <span className="shell-menu-value dim">{appVersion}</span>}
          </button>
        </div>
      )}
    </div>
  )
}
