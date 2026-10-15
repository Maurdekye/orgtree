/* Settings › Developer › the row below all the others: EPIC Mode's switch.

   The user's own design (2026-10-14 23:42Z, follow-ups 23:43Z): the switch is
   ALWAYS rendered, but while it is off and not hovered the checkbox and its
   label are drawn in nothing but the background, so the row cannot be told
   apart from the empty panel under it. Hovering gives a subtle highlight that
   says only "something here is clickable". Clicking checks the box, which
   becomes an ordinary visible checkbox, and the label "EPIC Mode" turns the
   theme accent. Unticking makes it invisible again. There is deliberately no
   hint text, no on/off word, no volume control and no warning.

   The look lives in epic.css; this row keeps the settings grid's classes so
   that, once revealed, its checkbox sits in the same column as the toggles
   above it. */
import { setEpicMode, useEpicMode } from './pref'
import './epic.css'

export function EpicModeSwitch() {
  const on = useEpicMode()
  return (
    <label className={'set-row epic-switch' + (on ? ' on' : '')}>
      <span className="set-lead">
        <input type="checkbox" role="switch" aria-label="EPIC Mode" checked={on}
          onChange={e => { void setEpicMode(e.target.checked) }} />
      </span>
      <span className="set-label epic-switch-label">EPIC Mode</span>
    </label>
  )
}
