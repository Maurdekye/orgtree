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
// NARROW WIDTHS drop the action labels and keep the icons, through a container
// query on the header itself rather than a viewport media query: an
// organization window and a Homepage window can be different widths at the
// same moment, so the question "is this bar narrow?" is about this bar and not
// about the screen.
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
}

export function ShellHeader({ menu, title, modes, actions }: ShellHeaderProps) {
  return (
    <header className={'shell-header' + (desktop() ? ' native-header' : '')}>
      <div className="shell-header-main">
        {menu}
        <h2 className="shell-header-title" title={title}>{title}</h2>
        {modes && <div className="shell-header-modes">{modes}</div>}
        <span className="shell-header-gap" />
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

/** One direct action button, with a label that survives at wide widths and
 *  steps aside at narrow ones.
 *
 *  ⚠ THE LABEL IS HIDDEN WITH CSS, NEVER REMOVED FROM THE DOM. `aria-label`
 *  carries the same words regardless, so a narrow window is narrower to look
 *  at and identical to a screen reader. Removing the text at a breakpoint
 *  would make the accessible name depend on the window's width. */
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
      <span className="shell-action-label">{label}</span>
      {badge}
    </button>
  )
}
