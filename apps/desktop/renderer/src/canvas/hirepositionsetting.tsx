import { setNewHirePosition, useNewHirePosition } from '../hireposition'
import { setHireAutoFocusOn, useHireAutoFocus } from '../hirefocus'
import { SetRow, SetToggle } from './settingskit'

export function HireAutoFocusSetting() {
  const on = useHireAutoFocus()
  return <SetToggle label="Open desk after manual hire" checked={on} onChange={setHireAutoFocusOn}
    hint="Automatically open the new agent's desk after a canvas hire or Quick chat. Turn off to keep your current view." />
}

export function NewHirePositionSetting() {
  const position = useNewHirePosition()
  return <SetRow label="New hires go"
    hint="New agents and projects go at the end, start or centre of their superior's live reports. Centre goes just after the middle. Side and above placements keep their chosen spot.">
    <select aria-label="New hires go" value={position}
      onChange={e => {
        const value = e.target.value
        setNewHirePosition(value === 'start' || value === 'centre' ? value : 'end')
      }}>
      <option value="end">End (default)</option>
      <option value="start">Start</option>
      <option value="centre">Centre</option>
    </select>
  </SetRow>
}
