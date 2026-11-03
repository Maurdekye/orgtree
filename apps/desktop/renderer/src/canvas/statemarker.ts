import { fmtAge } from '../timefmt'
import type { ChatMessage } from '../types'

const LABEL: Record<string, string> = {
  active: 'Active', idle: 'Idle', blocked: 'Blocked', halted: 'Halted', frozen: 'Frozen',
}

/** What a state-history row says in the transcript (USER 2026-11-03 17:37:22Z m1bfdb3fba01b): the state that just
 *  ENDED and how long it lasted ("Active for 32s", "Idle for 19s"), in the same age words as the States tab. Not the
 *  new state, and no "was".
 *
 *  - an ended state that lasted under one second (the engine writes whole seconds, rounded down, so `prev_secs` 0)
 *    says nothing: `null`, the row is not drawn at all. The state row stays in the data and on the States tab.
 *  - an ended state whose start is unknown (it began before recording did) is named without a duration.
 *  - a row with no ended state (an agent's very first) has nothing to say: `null`.
 *  - a row of an older engine with no structured fields keeps its own text.
 *  Returns `undefined` for a row that is not a state row. */
export function stateMarkerText(m: Partial<Pick<ChatMessage, 'kind' | 'state' | 'prev_state' | 'prev_secs' | 'text'>>): string | null | undefined {
  if (m.kind !== 'state') return undefined
  if (typeof m.state !== 'string') return m.text ?? ''
  const ended = m.prev_state ? LABEL[m.prev_state] : undefined
  if (!ended) return null
  if (typeof m.prev_secs !== 'number') return ended
  if (m.prev_secs < 1) return null
  return `${ended} for ${fmtAge(0, m.prev_secs * 1000)}`
}
