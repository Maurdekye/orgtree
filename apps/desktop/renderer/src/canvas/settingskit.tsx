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

import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface SettingsTab<T extends string> {
  id: T
  label: string
  /** a short scope badge on the tab itself, e.g. "this browser" */
  note?: string
}

export function SettingsTabs<T extends string>({
  tabs, tab, setTab, idBase, label,
}: {
  tabs: SettingsTab<T>[]
  tab: T
  setTab: (id: T) => void
  /** prefix for the `app-settings-tab-*` / `app-settings-panel-*` id pair */
  idBase: string
  /** the tablist's own accessible name */
  label: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const move = (from: number, delta: number) => {
    const next = (from + delta + tabs.length) % tabs.length
    setTab(tabs[next]!.id)
    refs.current[next]?.focus()
  }
  return (
    <div className="app-settings-tabs" role="tablist" aria-label={label}>
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

/** one tab's region. `hidden` rather than unmounted, so a half-typed field
 *  and a scroll position survive a look at another tab. */
export function SettingsTabPanel({ id, idBase, active, children }: {
  id: string
  idBase: string
  active: boolean
  children: ReactNode
}) {
  return (
    <div id={`${idBase}-panel-${id}`} role="tabpanel"
      aria-labelledby={`${idBase}-tab-${id}`}
      hidden={!active} className="app-settings-panel">
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
export function SetGroup({ title, note, children }: {
  title: string
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="set-group">
      <div className="set-group-head">
        {title}{note && <span className="dim">{note}</span>}
      </div>
      {children}
    </div>
  )
}

/** a non-boolean setting: label on the rail, control in the right column.
 *  The lead slot is left empty — the grid column is still there, so this
 *  row's label starts exactly where a toggle row's label does. */
export function SetRow({ label, hint, children }: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="set-row">
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
  children: ReactNode
}) {
  return (
    <div className="set-block">
      {label && <span className="set-label">{label}</span>}
      {hint && <span className="set-hint">{hint}</span>}
      {children}
    </div>
  )
}

/** a boolean setting. The whole row is the `<label>`, so the hint and the
 *  state word are click targets too.
 *  ⚠ the input keeps an explicit `aria-label`: the row's text content
 *  includes the hint prose and the state word, and letting that become the
 *  control's accessible name is how a two-word switch ends up announced as a
 *  paragraph. The visible on/off word is redundant for a screen reader (the
 *  switch role already carries the state) but is what makes the column
 *  readable at a glance for everyone else. */
export function SetToggle({ label, hint, checked, disabled, title, onChange }: {
  label: string
  hint?: ReactNode
  checked: boolean
  disabled?: boolean
  title?: string
  onChange: (next: boolean) => void
}) {
  return (
    <label className="set-row" title={title}>
      <span className="set-lead">
        <input type="checkbox" role="switch" aria-label={label}
          checked={checked} disabled={disabled}
          onChange={(e) => onChange(e.target.checked)} />
      </span>
      <span className="set-label">{label}</span>
      <span className="set-control">
        <span className={'set-state' + (checked ? ' on' : '')}>
          {checked ? 'on' : 'off'}</span>
      </span>
      {hint && <span className="set-hint">{hint}</span>}
    </label>
  )
}
