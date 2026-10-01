// shell/advancedorg.tsx — the ONE advanced-organization modal.
//
// Moved out of App.tsx unchanged so the v3 Create page (shell/createorg.tsx)
// can open the same surface the inline creation form always did. Importing it
// from App.tsx would be a cycle: App.tsx renders the shell.
//
// App.tsx re-exports it, so every existing importer is unaffected.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { PinFrame } from '../canvas/modalpin'
import { SettingsIcon } from '../icons'

/** F-07 (user ruling 2026-08-04: "both, one modal"): the ONE advanced-org
 *  modal shell. The create form's advanced disclosure and the ⚙ settings
 *  panel both open this same surface; each pours in its own sections, and
 *  creation-only facts (kiosk, sandbox, disk type) render as LOCKED chips
 *  outside creation — visible, never editable, so the modal can't offer to
 *  change what cannot change after birth. No save button of its own: the
 *  create form submits, and the settings panel keeps its ONE bottom save
 *  (three save surfaces was a user-reported failure once already). */
export function AdvancedOrgModal({ title, close, children, tabs }: {
  title: string
  close: () => void
  children?: ReactNode
  /** tabbed form (user amendment 2026-08-05): categories as a tab strip —
   *  presentation only; both callers keep their own save flow */
  tabs?: { label: string; content: ReactNode }[]
}) {
  const [tab, setTab] = useState(0)
  return (
    <PinFrame kind="advanced-org" title={`${title} advanced`} panel="settings" close={close} pinnable={false}>
      <h3><SettingsIcon fontSize="inherit" /> {title} — advanced</h3>
        {tabs && (
          <div className="adv-tabs">
            {tabs.map((t, i) => (
              <button key={t.label} type="button"
                className={'adv-tab' + (i === tab ? ' on' : '')}
                onClick={() => setTab(i)}>{t.label}</button>
            ))}
          </div>
        )}
        {tabs ? tabs[Math.min(tab, tabs.length - 1)]?.content : children}
        <div className="row">
          <button className="primary" type="button" onClick={close}>done</button>
        </div>
    </PinFrame>
  )
}
