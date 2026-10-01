// shell/menu.tsx — the one compact application menu.
//
// The v3 header replaces the expandable organization sidebar, and this is
// where the navigation that sidebar carried went: opening a window, opening an
// organization, creating one, and the app-wide panels. Everything else on the header is a DIRECT button, because the
// settled design keeps the familiar action buttons rather than burying them in
// traditional menus — this menu is for navigation and app-wide state, and it
// is deliberately the only menu there is.
//
// ⚠ IT IS PRESENT IN ALL FOUR VIEWS. Homepage and Create have no organization
// and therefore no header action buttons, so for those two windows this menu
// is the ONLY way to reach Usage and App settings. Usage is app-wide, so this
// entry is the only way to open it in EVERY view, organization windows
// included: the org header's Usage button was removed (user 2026-09-28).
// Dropping it here would leave no way to reach the usage snapshots the shell
// is required to preserve.
//
// A DEDICATED DROPDOWN RATHER THAN `useContextMenu`. The canonical object menu
// takes plain string labels, and the organization list here is not a list of
// labels: each row carries a live activity spinner, an active/hired count, a
// kiosk badge, an "already open" mark and the freshness of the snapshot behind
// all of them. Rendering that through a label API would mean flattening it to
// text and losing the thing the list is for.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
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

/** Where the organization submenu sits, relative to `.shell-menu`: beside the
 *  panel on the right, or on the left when the right has no room. */
interface SubPos { left: number; top: number; flip: boolean }

export function OrgtreeMenu(props: OrgtreeMenuProps) {
  const { orgs, freshness, ageMs, error, currentOrg, isOpenElsewhere,
    onOpenOrg, onNewWindow, onCreateOrg, onUsage, onAppSettings } = props
  const [open, setOpen] = useState(false)
  // THE ORGANIZATION LIST IS A SUBMENU (user 2026-09-29, image-21: "this open
  // organization should open a submenu to the right side, not expand a new
  // list inside itself"). `subBy` says HOW it was opened, because that decides
  // how it closes: a submenu the pointer opened closes when the pointer
  // leaves it, like any desktop submenu; one opened by a click or the keyboard
  // stays until it is dismissed, so a click on a hover-opened row keeps it.
  const [subBy, setSubBy] = useState<'hover' | 'click' | 'key' | null>(null)
  const orgList = subBy !== null
  const [subPos, setSubPos] = useState<SubPos | null>(null)
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
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLButtonElement>(null)
  const sub = useRef<HTMLDivElement>(null)
  const id = useId()
  const subId = useId()
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  // closing RETURNS FOCUS to the button. Without that a keyboard user who
  // escapes the menu is left with focus on the document body, several tab
  // stops from where they were.
  const close = useCallback((restore = true) => {
    clearTimeout(hoverTimer.current)
    setOpen(false); setSubBy(null); setFilter('')
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
    // the submenu is outside the panel (see below), so "inside" is the whole
    // menu root: button, panel and submenu
    const onDown = (e: Event) => {
      if (root.current?.contains(e.target as Node)) return
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

  // ⚠ THE SUBMENU IS A SIBLING OF THE PANEL, NOT ITS CHILD. The panel scrolls
  // (`overflow-y: auto`), and a scroll container clips anything positioned
  // outside it, so a flyout nested inside would be cut off at the panel's
  // edge. It is placed from measured boxes instead: level with its row, to the
  // right of the panel, flipped to the left when the window has no room on the
  // right, and kept inside the window vertically. Hidden until placed, so it
  // never paints for a frame at the wrong spot.
  useLayoutEffect(() => {
    if (!orgList) { setSubPos(null); return }
    const place = () => {
      const r = row.current, p = panel.current, s = sub.current, m = root.current
      if (!r || !p || !s || !m) return
      const rr = r.getBoundingClientRect(), pr = p.getBoundingClientRect()
      const mr = m.getBoundingClientRect()
      const w = s.offsetWidth, h = s.offsetHeight
      const fitsRight = pr.right + 2 + w <= window.innerWidth - 4
      const x = fitsRight ? pr.right + 2 : Math.max(4, pr.left - 2 - w)
      const y = Math.max(4, Math.min(rr.top - 5, window.innerHeight - 4 - h))
      const next = { left: Math.round(x - mr.left), top: Math.round(y - mr.top), flip: !fitsRight }
      setSubPos((prev) => prev && prev.left === next.left && prev.top === next.top
        && prev.flip === next.flip ? prev : next)
    }
    place()
    const p = panel.current
    window.addEventListener('resize', place)
    p?.addEventListener('scroll', place)
    return () => { window.removeEventListener('resize', place); p?.removeEventListener('scroll', place) }
  }, [orgList, shown.length, note])

  // a submenu opened from the keyboard takes focus: the filter when there is
  // one, otherwise its first organization. Opened by the pointer it leaves
  // focus alone, as the main menu does.
  const wantSubFocus = useRef(false)
  useEffect(() => {
    if (!orgList || !wantSubFocus.current) return
    wantSubFocus.current = false
    const input = sub.current?.querySelector<HTMLElement>('.shell-menu-filter')
    if (input) input.focus()
    else focusItem(sub.current, null, 'first')
  }, [orgList])
  const openSub = (by: 'hover' | 'click' | 'key') => {
    clearTimeout(hoverTimer.current)
    if (by === 'key') wantSubFocus.current = true
    setSubBy(by)
  }
  const closeSub = (focusRow: boolean) => {
    clearTimeout(hoverTimer.current)
    setSubBy(null); setFilter('')
    if (focusRow) row.current?.focus()
  }
  const hoverIn = () => {
    clearTimeout(hoverTimer.current)
    if (!orgList) openSub('hover')
  }
  // a short grace period, so a diagonal move from the row into the submenu
  // does not cross another item and lose it
  const hoverOut = () => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => {
      setSubBy((v) => (v === 'hover' ? null : v))
    }, 250)
  }

  return (
    <div ref={root} className="shell-menu">
      {/* icon only, like every header button (user 2026-09-29); the name is
          the aria-label and the tooltip */}
      <button ref={button} type="button" className="shell-menu-button"
        aria-label="Orgtree menu" title="Orgtree menu"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : openWith(false))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); open ? focusItem(panel.current, null, 'first') : openWith(true)
          }
        }}>
        <MenuIcon fontSize="inherit" />
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
          <button ref={row} type="button" role="menuitem"
            className={'shell-menu-item shell-menu-subrow' + (orgList ? ' on' : '')}
            aria-haspopup="menu" aria-expanded={orgList}
            aria-controls={orgList ? subId : undefined}
            onPointerEnter={hoverIn} onPointerLeave={hoverOut}
            onClick={(e) => {
              // a click on a submenu the POINTER opened keeps it open (the
              // press landed on a row that was already showing its list); a
              // deliberate second activation closes it. A keyboard activation
              // (Enter/Space, `detail` 0) opens it with focus.
              if (orgList && subBy !== 'hover') closeSub(false)
              else openSub(e.detail === 0 ? 'key' : 'click')
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); openSub('key') }
            }}>
            <span className="shell-menu-label">Open organization…</span>
            <span className="shell-menu-value dim" aria-hidden="true">▸</span>
          </button>
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
          {/* NO "About Orgtree" ENTRY (user 2026-09-29): it only opened App
              settings, which the entry above already does. The running
              version is shown without any click instead — in an organization
              window's status strip, and beside the title on Home and New
              organization (shell/header.tsx `version`). */}
        </div>
      )}
      {open && orgList && (
        <div ref={sub} id={subId} role="menu" aria-label="Organizations"
          className={'shell-menu-sub' + (subPos?.flip ? ' flip' : '')}
          style={subPos ? { left: subPos.left, top: subPos.top }
            : { left: 0, top: 0, visibility: 'hidden' }}
          onPointerEnter={hoverIn} onPointerLeave={hoverOut}
          onKeyDown={(e) => {
            // the submenu's keys are its own: none of them reaches the main
            // panel's handler or the window's Escape (which closes the whole
            // menu) — Escape and ArrowLeft step back to the row instead
            e.stopPropagation()
            const inInput = (e.target as Element).tagName === 'INPUT'
            const from = (e.target as Element).closest('[role="menuitem"]')
            if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(sub.current, from, 'next') }
            else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(sub.current, from, 'prev') }
            else if (e.key === 'Home' && !inInput) { e.preventDefault(); focusItem(sub.current, null, 'first') }
            else if (e.key === 'End' && !inInput) { e.preventDefault(); focusItem(sub.current, null, 'last') }
            else if (e.key === 'Escape' || (e.key === 'ArrowLeft' && !inInput)) {
              e.preventDefault(); closeSub(true)
            }
            else if (e.key === 'Tab') close(false)
          }}>
          {orgs.length > 6 && (
            <input className="shell-menu-filter"
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
    </div>
  )
}
