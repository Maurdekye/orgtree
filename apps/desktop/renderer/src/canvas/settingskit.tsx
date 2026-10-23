// canvas/settingskit.tsx — D-222: the pieces every settings surface is built
// from. App settings (canvas/accounts.tsx) and org settings (App.tsx) both
// import from here, which is the only reason they can be relied on to look
// and behave like one product.
//
// Two things live here: the tab strip, and the row.
//
// ── THE TAB STRIP ────────────────────────────────────────────────────────
//
// There were two. App settings had a full ARIA tablist — roving tabindex,
// arrow keys, Home/End, `aria-controls` pointing at real `role="tabpanel"`
// regions. The org settings' advanced modal had `.adv-tabs`: bare buttons,
// no roles, no arrow keys, reachable only by tabbing through every one of
// them. Two strips one modal apart that looked similar and behaved
// differently is precisely the incoherence this change is about, and the
// weaker of the two was also the inaccessible one.
//
// So: one component, the stronger behaviour, used by both.
//
// ⚠ THE PANELS STAY MOUNTED ONCE VISITED (`useVisitedTabs` below). The old
// advanced modal rendered only the active tab, which is why its callers had
// to hoist half-typed API keys and mailserver addresses into the parent to
// keep a tab switch from destroying them (D-204). Mounting on first visit and
// hiding thereafter keeps the lazy first load — a tab you never open never
// fetches — while making a tab switch lossless by construction rather than by
// remembering to hoist the next draft field someone adds.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'

export interface SettingsTab<T extends string> {
  id: T
  label: string
  /** a short scope badge on the tab itself, e.g. "this browser" */
  note?: string
}

export function SettingsTabs<T extends string>({
  tabs, tab, setTab, idBase, label, stripRef,
}: {
  tabs: SettingsTab<T>[]
  tab: T
  setTab: (id: T) => void
  /** prefix for the `app-settings-tab-*` / `app-settings-panel-*` id pair */
  idBase: string
  /** the tablist's own accessible name */
  label: string
  /** the strip's element, for `useSettingsTarget`: it finds the panels (the
   *  strip's siblings) from here, inside this window and this panel only */
  stripRef?: RefObject<HTMLDivElement | null>
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const move = (from: number, delta: number) => {
    const next = (from + delta + tabs.length) % tabs.length
    setTab(tabs[next]!.id)
    refs.current[next]?.focus()
  }
  return (
    <div className="app-settings-tabs" role="tablist" aria-label={label} ref={stripRef}>
      {tabs.map((item, index) => (
        <button type="button" role="tab" key={item.id}
          ref={(el) => { refs.current[index] = el }}
          id={`${idBase}-tab-${item.id}`}
          aria-selected={tab === item.id}
          aria-controls={`${idBase}-panel-${item.id}`}
          // roving tabindex: one stop for the whole strip, arrows within it
          tabIndex={tab === item.id ? 0 : -1}
          className={'app-settings-tab' + (tab === item.id ? ' on' : '')}
          onClick={() => setTab(item.id)}
          onKeyDown={(e) => {
            if (e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault(); move(index, 1)
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault(); move(index, -1)
            } else if (e.key === 'Home' || e.key === 'End') {
              e.preventDefault()
              const next = e.key === 'Home' ? 0 : tabs.length - 1
              setTab(tabs[next]!.id); refs.current[next]?.focus()
            }
          }}>
          {item.label}
          {item.note && <span className="app-settings-scope">{item.note}</span>}
        </button>
      ))}
    </div>
  )
}

/* ── OPENING A PANEL AT A CONTROL ─────────────────────────────────────────
 *
 * A link into settings (the desk's cheap-compact warning: "Turn off in
 * settings", USER 2026-10-20) has to land on the control, not on the panel:
 * the right tab, the row scrolled into view, its control focused, and the row
 * marked for a moment so the eye finds it. A request is `{ tab, field, seq }`:
 *   tab    the tab that holds the control
 *   field  the row, as `field` on its SetRow/SetToggle (`data-settings-field`)
 *   seq    a counter. The panel may already be open (on another tab, pinned,
 *          or popped out into a window of its own), so "the same control" has
 *          to be a NEW request the next time; a rerender that carries the same
 *          seq is the same request and moves nobody.
 * The owner of a panel holds the target in state, bumps `seq` on each request,
 * switches its tab and calls `useSettingsTarget`; the row is looked up from the
 * tab strip's own element, so it finds ITS panel's row (two panels can carry a
 * `cheap-compact` row at once) in ITS window (a popped-out panel is another
 * document). */
export interface SettingsTarget { tab: string; field: string; seq: number }

/** how long the mark stays (a fade, `set-target-fade` in the sheet) */
export const SETTINGS_TARGET_MS = 1800
const TARGET_MARK = 'set-target-hl'
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])'

/** Lands `target` once `ready` (its tab is shown and its body mounted). The
 *  row may appear a frame or two after the tab does (a lazily mounted body),
 *  so it is looked for a little while (about four seconds: a row that waits for
 *  a fetch, like App settings' turn limit, is there once the answer is). The mark is a class added to the row
 *  outside React, which leaves a row's own className alone (no row sets one). */
export function useSettingsTarget(strip: RefObject<HTMLElement | null>,
  target: SettingsTarget | null | undefined, ready: boolean): void {
  const handled = useRef<number | null>(null)
  const fade = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(fade.current) }, [])
  useEffect(() => {
    if (!target || !ready || handled.current === target.seq) return
    let retry: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    const land = () => {
      const scope = strip.current?.parentElement
      const row = [...scope?.querySelectorAll<HTMLElement>('[role="tabpanel"]:not([hidden]) [data-settings-field]') ?? []]
        .find((el) => el.getAttribute('data-settings-field') === target.field)
      if (!row) { if (tries++ < 100) retry = setTimeout(land, 40); return }
      handled.current = target.seq
      scope?.querySelectorAll('.' + TARGET_MARK).forEach((el) => el.classList.remove(TARGET_MARK))
      row.scrollIntoView?.({ block: 'center' })
      row.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true })
      row.classList.add(TARGET_MARK)
      clearTimeout(fade.current)
      fade.current = setTimeout(() => row.classList.remove(TARGET_MARK), SETTINGS_TARGET_MS)
    }
    land()
    return () => { clearTimeout(retry) }
  }, [target?.seq, ready])  // eslint-disable-line react-hooks/exhaustive-deps
}

/** one tab's region. `hidden` rather than unmounted, so a half-typed field
 *  and a scroll position survive a look at another tab. */
export function SettingsTabPanel({ id, idBase, active, children, className = 'app-settings-panel' }: {
  id: string
  idBase: string
  active: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div id={`${idBase}-panel-${id}`} role="tabpanel"
      aria-labelledby={`${idBase}-tab-${id}`}
      hidden={!active} className={className}>
      {children}
    </div>
  )
}

/** tracks which tabs have ever been shown. Render a tab's body only once it
 *  is in this set: a mailserver tab that is never opened never issues its
 *  fetch, and one that HAS been opened keeps its state while you look
 *  elsewhere. */
export function useVisitedTabs<T extends string>(first: T):
[T, (id: T) => void, (id: T) => boolean] {
  const [tab, setTabState] = useState<T>(first)
  const [seen, setSeen] = useState<T[]>([first])
  const setTab = useCallback((id: T) => {
    setTabState(id)
    setSeen((s) => (s.includes(id) ? s : [...s, id]))
  }, [])
  const visited = useCallback((id: T) => seen.includes(id), [seen])
  return [tab, setTab, visited]
}

/* ── THE ROW ──────────────────────────────────────────────────────────────
 *
 * Every adjustable thing in every settings tab is a `SetToggle` or a
 * `SetRow`, and both render the SAME three-column grid (`.set-row` in the
 * sheet): a lead slot for the control, a label rail, and a trailing control
 * column. Callers pass CONTENT — a label, a hint, a control — and never
 * layout: there is no per-row className, no per-row margin, and no
 * `margin-left: auto`.
 *
 * That is the whole point. The rows these replace were hand-laid flex boxes
 * and each independently chose where to put its label and its control, so
 * the three Runtime state words landed at three different x positions in one
 * panel (measured 2026-09-01 at x=1253, x=682 and x=510 in a 1320px panel)
 * and the two Display rows read as two unrelated widgets. A grid column
 * exists whether or not a given row fills it, so rows line up because they
 * are in a column rather than because each one happened to agree.
 * ------------------------------------------------------------------------ */

/** a titled band of rows. The note is for scope ("saved in this browser"),
 *  not for prose — a sentence belongs in a row's `hint`. */
/** Ask the shell to open Application settings at one section — from any
 *  surface (a desk banner, a popout) without importing the settings panel.
 *  App.tsx opens the panel; the panel switches to the section. */
export const OPEN_APP_SETTINGS_EVENT = 'orgtree:open-app-settings'
export function openAppSettings(tab: string, focus?: string): void {
  window.dispatchEvent(new window.CustomEvent(OPEN_APP_SETTINGS_EVENT,
    { detail: { tab, focus } }))
}

/** A link that wants a settings panel opened AT a control, from anywhere: a
 *  desk (docked, or popped out into a window of its own, whose code still runs
 *  in this renderer), a banner. The same window event the turn-slot banner uses
 *  for app settings; the shell that owns the panel answers (App.tsx for the
 *  org's settings, OrgCanvas for an agent's gear), switches the panel to
 *  `target.tab` and lands `useSettingsTarget` on `target.field`. `org` keeps
 *  one organization's window from answering another's link. */
export const OPEN_SETTINGS_AT_EVENT = 'orgtree:open-settings-at'
export interface SettingsAsk {
  scope: 'org' | 'agent'
  org: string
  /** the agent whose gear, when `scope` is 'agent' */
  agentId?: string
  target: { tab: string; field: string }
}
export function openSettingsAt(ask: SettingsAsk): void {
  window.dispatchEvent(new window.CustomEvent(OPEN_SETTINGS_AT_EVENT, { detail: ask }))
}
/** hears the asks of one `scope` for one organization (none while `org` is null) */
export function useSettingsAsk(scope: SettingsAsk['scope'], org: string | null, on: (ask: SettingsAsk) => void): void {
  const latest = useRef(on)
  latest.current = on
  useEffect(() => {
    const hear = (e: Event) => {
      const ask = (e as CustomEvent<SettingsAsk | undefined>).detail
      if (ask && ask.scope === scope && ask.org === org) latest.current(ask)
    }
    window.addEventListener(OPEN_SETTINGS_AT_EVENT, hear)
    return () => window.removeEventListener(OPEN_SETTINGS_AT_EVENT, hear)
  }, [scope, org])
}

export function SetGroup({ title, note, subtitle, children }: {
  title: string
  note?: ReactNode
  subtitle?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="set-group">
      <div className="set-group-head">
        {title}{note && <span className="dim">{note}</span>}
      </div>
      {subtitle && <div className="set-group-subtitle">{subtitle}</div>}
      {children}
    </div>
  )
}

/** a non-boolean setting: label on the rail, control in the right column.
 *  The lead slot is left empty — the grid column is still there, so this
 *  row's label starts exactly where a toggle row's label does. */
export function SetRow({ label, hint, children, field }: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
  /** names the row for `useSettingsTarget` (a link that opens settings here) */
  field?: string
}) {
  return (
    <div className="set-row" data-settings-field={field}>
      <span className="set-label">{label}</span>
      {children && <span className="set-control">{children}</span>}
      {hint && <span className="set-hint">{hint}</span>}
    </div>
  )
}

/** a setting whose control needs the panel's full width — a textarea, a
 *  folder list, a list of addresses. Keeps the label and hint typography of
 *  a row, drops the control column. */
export function SetBlock({ label, hint, children }: {
  label?: ReactNode
  hint?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="set-block">
      {label && <span className="set-label">{label}</span>}
      {hint && <span className="set-hint">{hint}</span>}
      {children}
    </div>
  )
}

/** a boolean setting. Without an independent action the whole row is the
 *  `<label>`. With one, the title, hint and state each label the same input;
 *  the action stays outside those labels and cannot toggle the checkbox.
 *  ⚠ the input keeps an explicit `aria-label`: the row's text content
 *  includes the hint prose and the state word, and letting that become the
 *  control's accessible name is how a two-word switch ends up announced as a
 *  paragraph. The visible on/off word is redundant for a screen reader (the
 *  switch role already carries the state) but is what makes the column
 *  readable at a glance for everyone else. */
export function SetToggle({ label, labelContent, hint, checked, disabled, title, onChange, action, field }: {
  label: string
  labelContent?: ReactNode
  /** Independent right-hand control, outside the checkbox's label. */
  action?: ReactNode
  hint?: ReactNode
  checked: boolean
  disabled?: boolean
  title?: string
  onChange: (next: boolean) => void
  /** names the row for `useSettingsTarget` (a link that opens settings here) */
  field?: string
}) {
  const id = useId()
  const Row = action ? 'div' : 'label'
  const Text = action ? 'label' : 'span'
  return (
    <Row className="set-row" title={title} data-settings-field={field}>
      <span className="set-lead">
        <input id={id} type="checkbox" role="switch" aria-label={label}
          checked={checked} disabled={disabled}
          onChange={(e) => onChange(e.target.checked)} />
      </span>
      <Text className="set-label" {...(action ? { htmlFor: id } : {})}>{labelContent ?? label}</Text>
      <span className="set-control">
        <Text {...(action ? { htmlFor: id } : {})} className={'set-state' + (checked ? ' on' : '')}>
          {checked ? 'on' : 'off'}</Text>
        {action}
      </span>
      {hint && <Text className="set-hint" {...(action ? { htmlFor: id } : {})}>{hint}</Text>}
    </Row>
  )
}
