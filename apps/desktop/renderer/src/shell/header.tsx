// shell/header.tsx — the compact header, in all four views.
//
// One shape, four fillings. The settled design is: one compact app menu, a
// plain organization title with no top-level picker, a prominent labelled
// Canvas/Attention toggle, the familiar direct action buttons, and the native
// window controls. Homepage and Create have no organization, so they carry the
// menu, their own title and the controls, and nothing else — which is exactly
// why the menu has to hold Usage and App settings (see shell/menu.tsx).
//
// ⚠ THE STATUS CHIPS ARE NOT HERE. They were, in `.bar-detail`; the approved
// layout moves the whole run to a bottom strip (shell/statusbar.tsx) because a
// compact header has no room for nine of them. That is a move, not a cut.
//
// THE ACTION BUTTONS ARE ICONS ONLY, at every width (user 2026-09-29): the
// words were dropped, and each button's name lives in its `aria-label` and
// tooltip instead. All of them share one frame — border, background, size —
// and one corner count badge, so the row reads as a set.
//
// THE KILLSWITCH HAS ITS OWN SLOT, `guard`, to the LEFT of that row (user
// 2026-09-29). Arming it expands STOP ALL leftward into the empty gap, so the
// buttons to its right never move under the pointer.
import type { ReactNode } from 'react'
import { UpdateNotice } from '../update-notice'
import { WindowControls } from '../window-controls'
import { desktop } from '../desktop'

export interface ShellHeaderProps {
  /** the compact app menu — present in every view */
  menu: ReactNode
  /** the plain window title: the organization's name, or Home / New
   *  organization. A TITLE, not a picker: choosing an organization happens in
   *  the menu, and a bound window never changes the one it shows. */
  title: string
  /** the prominent Canvas/Attention toggle. Organization windows only. */
  modes?: ReactNode
  /** the familiar direct action buttons. Organization windows only. */
  actions?: ReactNode
  /** the killswitch, placed just LEFT of `actions` so its expansion grows
   *  into the gap and never shifts the action buttons. */
  guard?: ReactNode
  /** the running app version, for windows with no status strip (Home and New
   *  organization): shown dim beside the title so it is visible without a
   *  click. Organization windows show it in their status strip instead. */
  version?: string | null
}

export function ShellHeader({ menu, title, modes, actions, guard, version }: ShellHeaderProps) {
  return (
    <header className={'shell-header' + (desktop() ? ' native-header' : '')}>
      <div className="shell-header-main">
        {menu}
        <h2 className="shell-header-title" title={title}>{title}</h2>
        {version && <span className="shell-version dim"
          title={`running Orgtree ${version}`}>Orgtree {version}</span>}
        {modes && <div className="shell-header-modes">{modes}</div>}
        <span className="shell-header-gap" />
        {guard && <div className="shell-header-guard">{guard}</div>}
        {actions && <div className="shell-header-actions">{actions}</div>}
      </div>
      <UpdateNotice />
      {/* Native WindowControls owns refresh in the desktop shell; a browser
          keeps the renderer-only reload it has always had. */}
      {!desktop() && (
        <button type="button" className="iconbtn" title="refresh app view"
          aria-label="refresh app view" onClick={() => window.location.reload()}>
          <span aria-hidden="true">⟳</span>
        </button>
      )}
      <WindowControls />
    </header>
  )
}

/** One direct action button: an icon and, where a count applies, a badge.
 *  The name is never visible text — `aria-label` carries it for a screen
 *  reader and `title` shows it as a tooltip. */
export function ShellAction({ label, title, icon, badge, glow, onClick, className }: {
  label: string
  title?: string
  icon: ReactNode
  /** the existing badge element, rendered exactly as it was in the header */
  badge?: ReactNode
  glow?: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button type="button"
      className={'shell-action' + (glow ? ' glow' : '') + (className ? ' ' + className : '')}
      aria-label={label} title={title ?? label} onClick={onClick}>
      {icon}
      {badge}
    </button>
  )
}
