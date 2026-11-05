import { setEventHeadlineOn, useEventHeadline } from '../events/cardheadline'
import { SetToggle } from './settingskit'

export function EventHeadlineSetting() {
  const on = useEventHeadline()
  return <SetToggle label="Show event message text as the card headline" checked={on} onChange={setEventHeadlineOn}
    hint="On WebSocket and MQTT monitor event cards, show a JSON message's text, message or body as the headline, with the rest folded under Details. Off by default; applies at once." />
}
