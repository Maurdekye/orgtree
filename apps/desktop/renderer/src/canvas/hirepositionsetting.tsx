import { setNewHirePosition, useNewHirePosition } from '../hireposition'
import { SetRow } from './settingskit'

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
