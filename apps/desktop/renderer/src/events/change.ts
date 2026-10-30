import { eventSummary } from './project'
import type { KnownEvent } from './project'

/** The one line the inbox list row and jump labels show for an event. */
export function noticeSummary(event: KnownEvent): string {
  return eventSummary(event)
}
