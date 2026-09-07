import type { Event, PublicEvent, Family } from '../generated/events'
import { FAMILY_OF } from '../generated/events'
import { record } from './decode'
import { fieldType, humanValue } from './value'
import type { HumanValue } from './value'

export type KnownEvent = Event | PublicEvent
export type Placement = 'header' | 'body' | 'context'
export interface EventField { key: string; label: string; placement: Placement; value: unknown; type: string }
export interface EventView { event: KnownEvent; family: Family; title: string; fields: EventField[] }
type Keys<T> = T extends unknown ? keyof T : never
type Spec<T> = readonly [Keys<T> & string, string, Placement]

function layout<T extends KnownEvent>(event: T, title: string, specs: readonly Spec<T>[]): EventView {
  const fields: EventField[] = []
  // Private-only fields are absent by construction in PublicEvent. No casts
  // or text recognition fill those gaps, and no raw payload is rendered.
  if (record(event)) for (const [key, label, placement] of specs) {
    if (Object.prototype.hasOwnProperty.call(event, key)) fields.push({ key, label, placement, value: event[key], type: fieldType(event.variant, key) })
  }
  return { event, family: FAMILY_OF[event.variant], title, fields }
}

export function assertNever(event: never): never {
  throw new Error('Unhandled canonical event')
}

/** Every canonical leaf names its title and the placement of each human field.
 *  Legacy/unsupported rows never enter this switch. */
export function projectEvent(event: KnownEvent): EventView {
  switch (event.variant) {
    case "ordinary.message": return layout(event, "Message", [["body", "Message", "body"]])
    case "ordinary.question": return layout(event, "Question", [["body", "Message", "body"]])
    case "ordinary.request": return layout(event, "Request", [["body", "Message", "body"]])
    case "ordinary.decision": return layout(event, "Decision", [["body", "Message", "body"]])
    case "ordinary.status": return layout(event, "Status message", [["body", "Message", "body"]])
    case "ordinary.notice": return layout(event, "Notice", [["body", "Message", "body"]])
    case "reply.docket": return layout(event, "Docket reply", [["body", "Message", "body"], ["role", "Role", "header"], ["owner", "Assigned to", "header"]])
    case "reply.document": return layout(event, "Presentation reply", [["body", "Message", "body"]])
    case "reply.mail": return layout(event, "Mail reply", [["body", "Message", "body"], ["quote", "Quoted message", "context"]])
    case "docket.assigned": return layout(event, "Assignment", [["owner", "Assigned to", "header"], ["previous_owner", "Previously assigned to", "header"], ["assigner", "Assigned by", "header"], ["status", "Status", "header"], ["objective", "Objective", "body"], ["done_so_far", "Completed", "context"], ["working_on_next", "Next steps", "context"]])
    case "docket.review_requested": return layout(event, "Review requested", [["reviewer", "Reviewer", "header"], ["requested_by", "Requested by", "header"], ["owner", "Assigned to", "header"], ["objective", "Objective", "body"], ["done_so_far", "Completed", "context"]])
    case "docket.review_changes": return layout(event, "Changes requested", [["reviewer", "Reviewer", "header"], ["owner", "Assigned to", "header"], ["note", "Review note", "body"], ["relayed", "Relayed to owner", "context"]])
    case "docket.review_approved": return layout(event, "Review approved", [["note", "Review note", "body"], ["reviewer", "Reviewer", "header"], ["owner", "Assigned to", "header"], ["relayed", "Relayed to owner", "context"]])
    case "status.report": return layout(event, "Status update", [["state", "State", "header"], ["summary", "Summary", "body"]])
    case "answer.ask": return layout(event, "Question answered", [["questions", "Questions and answers", "body"], ["text", "Response", "body"], ["dismissed", "Dismissed", "header"], ["single", "Single question", "context"]])
    case "answer.batch": return layout(event, "Request resolved", [["sections", "Answers and decisions", "body"]])
    case "decision.credit": return layout(event, "Credit decision", [["outcome", "Outcome", "header"], ["old", "Before", "context"], ["asked", "Asked", "context"], ["granted", "Granted", "context"], ["now", "Current total", "context"]])
    case "decision.audience": return layout(event, "Audience decision", [["granted", "Granted", "header"], ["target", "Target", "header"], ["decided_by", "Decided by", "context"]])
    case "decision.attention_dismissed": return layout(event, "Attention dismissed", [["reason", "Reason", "context"], ["pending_questions", "Pending questions", "context"], ["dismissed_by", "Dismissed by", "context"]])
    case "ask.routed": return layout(event, "Question forwarded", [["from_node", "From", "context"], ["questions", "Questions and answers", "body"]])
    case "access.scope_requested": return layout(event, "Scope requested", [["items", "Items", "context"], ["reason", "Reason", "body"], ["wanted", "Requested access", "context"]])
    case "access.audience_requested": return layout(event, "Audience requested", [["stage", "Stage", "header"], ["from_node", "From", "header"], ["target", "Target", "header"], ["reason", "Reason", "body"]])
    case "access.audience_changed": return layout(event, "Audience changed", [["outcome", "Outcome", "header"], ["by", "By", "header"], ["target", "Target", "header"], ["other", "Other", "context"]])
    case "access.grant_changed": return layout(event, "Credits changed", [["relation", "Relation", "context"], ["node", "Node", "header"], ["delta", "Change", "header"], ["now", "Current total", "header"], ["free", "Available credits", "context"], ["by", "By", "header"]])
    case "access.scope_changed": return layout(event, "Permissions changed", [["by", "By", "context"], ["changed", "Changed", "context"]])
    case "access.kiosk_clamped": return layout(event, "Visitor permissions limited", [["lost", "Lost", "context"]])
    case "access.kiosk_ceiling": return layout(event, "Visitor limits changed", [])
    case "lifecycle.kickoff": return layout(event, "Handoff", [["body", "Message", "body"], ["hired_by", "Hired by", "context"], ["reason", "Reason", "context"], ["tier", "Tier", "context"], ["grant", "Grant", "context"]])
    case "lifecycle.hired": return layout(event, "Agent hired", [["node", "Node", "context"], ["by", "By", "context"], ["relation", "Relation", "context"], ["tier", "Tier", "context"], ["grant", "Grant", "context"], ["parent", "Parent", "context"], ["why", "Why", "body"]])
    case "lifecycle.retired": return layout(event, "Agent retired", [["node", "Node", "context"], ["by", "By", "context"], ["relation", "Relation", "context"], ["freed", "Freed", "context"]])
    case "lifecycle.rescinded": return layout(event, "Hire rescinded", [["node", "Node", "context"], ["clawed", "Clawed", "context"]])
    case "lifecycle.rehired": return layout(event, "Agent rehired", [["node", "Node", "context"], ["by", "By", "context"], ["relation", "Relation", "context"], ["grant", "Grant", "context"]])
    case "lifecycle.dissolved": return layout(event, "Team dissolved", [["node", "Node", "context"], ["by", "By", "context"], ["relation", "Relation", "context"], ["nodes", "Nodes", "context"], ["freed", "Freed", "context"]])
    case "lifecycle.deleted": return layout(event, "Agent deleted", [["node", "Node", "context"], ["relation", "Relation", "context"], ["extra", "Extra", "context"]])
    case "lifecycle.compacted": return layout(event, "Session compacted", [["node", "Node", "context"], ["relation", "Relation", "context"], ["generation", "Generation", "context"], ["predecessor", "Predecessor", "context"], ["auto", "Auto", "context"], ["lost", "Lost", "context"], ["size_note", "Size note", "context"]])
    case "lifecycle.cheap_compacted": return layout(event, "Session reset", [["node", "Node", "context"], ["relation", "Relation", "context"], ["by", "By", "context"], ["predecessor", "Predecessor", "context"], ["team_note", "Team note", "context"]])
    case "lifecycle.reseeded": return layout(event, "Session reseeded", [["node", "Node", "context"], ["relation", "Relation", "context"], ["by", "By", "context"], ["predecessor", "Predecessor", "context"]])
    case "lifecycle.recovered": return layout(event, "Session recovered", [["predecessor", "Predecessor", "context"], ["successor", "Successor", "context"]])
    case "lifecycle.phantom_removed": return layout(event, "Missing session removed", [["predecessor", "Predecessor", "context"], ["holder", "Holder", "context"]])
    case "lifecycle.unrecoverable": return layout(event, "Session unrecoverable", [["node", "Node", "context"], ["reason", "Reason", "body"]])
    case "lifecycle.bearer_lost": return layout(event, "History lost", [["bearer", "Bearer", "context"]])
    case "lifecycle.bearer_exhausted": return layout(event, "History exhausted", [["bearer", "Bearer", "context"]])
    case "lifecycle.handoff_record": return layout(event, "Handoff recorded", [["generation", "Generation", "context"]])
    case "lifecycle.model_switched": return layout(event, "Model changed", [["node", "Node", "context"], ["relation", "Relation", "context"], ["old", "Before", "header"], ["new", "After", "header"], ["seat_old", "Seat old", "context"], ["seat_new", "Seat new", "context"], ["by", "By", "header"], ["queued", "Queued", "context"], ["crossed", "Crossed", "context"], ["old_provider", "Old provider", "context"], ["new_provider", "New provider", "context"], ["predecessor", "Predecessor", "context"]])
    case "lifecycle.switch_queued": return layout(event, "Model change queued", [["node", "Node", "context"], ["old", "Before", "context"], ["new", "After", "context"], ["by", "By", "context"]])
    case "lifecycle.switch_cancelled": return layout(event, "Model change cancelled", [["node", "Node", "context"], ["target", "Target", "context"], ["by", "By", "context"]])
    case "lifecycle.switch_dropped": return layout(event, "Queued model change dropped", [["node", "Agent", "header"], ["target", "Requested model", "header"], ["kept", "Retained model", "header"], ["reason", "Reason", "body"]])
    case "lifecycle.seat_swapped": return layout(event, "Seats exchanged", [["a", "First agent", "context"], ["b", "Second agent", "context"], ["role", "Role", "context"], ["nested", "Nested", "context"], ["by", "By", "context"], ["reports_to_after", "Reports to after", "context"], ["grant_after", "Grant after", "context"], ["audience_note", "Audience note", "context"]])
    case "lifecycle.moved": return layout(event, "Agent moved", [["node", "Node", "context"], ["from_parent", "From parent", "context"], ["to_parent", "To parent", "context"], ["role", "Role", "context"], ["by", "By", "context"], ["tail", "Tail", "context"]])
    case "lifecycle.inserted": return layout(event, "Superior inserted", [["node", "Node", "context"], ["above", "Above", "context"], ["parent", "Parent", "context"], ["role", "Role", "context"], ["by", "By", "context"], ["grant_target", "Grant target", "context"], ["grant_new", "Grant new", "context"], ["committed", "Committed", "context"]])
    case "lifecycle.renamed": return layout(event, "Agent renamed", [["old", "Before", "header"], ["new", "After", "header"], ["by", "By", "header"]])
    case "lifecycle.disk_migrated": return layout(event, "Disk migrated", [["floored_from", "Floored from", "context"]])
    case "policy.fable_flagged": return layout(event, "Provider policy event", [["audience", "Audience", "context"], ["node", "Node", "context"], ["outcome", "Outcome", "context"], ["autopsy", "Autopsy", "context"], ["autopsy_model", "Autopsy model", "context"], ["replacement", "Replacement", "context"], ["reason", "Reason", "body"], ["detail", "Detail", "body"]])
    case "policy.weekly_limit": return layout(event, "Weekly capacity limit", [["relation", "Relation", "context"], ["node", "Node", "context"], ["outcome", "Outcome", "context"], ["nodes", "Nodes", "context"], ["freed", "Freed", "context"], ["policy", "Policy", "context"], ["detected_at", "Detected at", "context"], ["halted", "Halted", "context"], ["dissolved", "Dissolved", "context"], ["converted", "Converted", "context"]])
    case "policy.unstuck": return layout(event, "Agent released", [])
    case "policy.unlocked": return layout(event, "Agent unlocked", [["node", "Node", "context"], ["relation", "Relation", "context"]])
    case "policy.limit_reset": return layout(event, "Capacity reset", [["relation", "Relation", "context"], ["node", "Node", "context"], ["released", "Released", "context"]])
    case "monitor.watchdog_fired": return layout(event, "Monitor event", [["once", "One-shot", "header"], ["prefix", "Prefix", "context"], ["lines", "Observations", "body"], ["count", "Count", "context"]])
    case "monitor.watchdog_quiet": return layout(event, "Monitor quiet", [["headline", "Headline", "header"], ["facts", "Observations", "body"], ["advice", "Advice", "body"]])
    case "runtime.turn_failed_terminal": return layout(event, "Turn failed", [["door", "Door", "context"], ["err", "Error", "body"]])
    case "runtime.turn_failed_repeated": return layout(event, "Repeated turn failure", [["attempts", "Attempts", "context"], ["classified", "Classified", "context"], ["err", "Error", "body"]])
    case "runtime.report_stalled": return layout(event, "Report stalled", [["report", "Report", "context"], ["report_name", "Agent", "context"], ["cause", "Cause", "context"], ["audience", "Audience", "context"], ["attempts", "Attempts", "context"], ["classified", "Classified", "context"], ["door", "Door", "context"], ["err", "Error", "body"]])
    case "runtime.report_parked": return layout(event, "Report parked", [["report", "Report", "context"], ["report_name", "Agent", "context"], ["audience", "Audience", "context"], ["headline", "Headline", "context"], ["detail", "Detail", "body"], ["lane", "Lane", "context"], ["err", "Error", "body"]])
    case "runtime.report_limited": return layout(event, "Report limited", [["report", "Report", "context"], ["report_name", "Agent", "header"], ["audience", "Audience", "context"], ["lane", "Lane", "header"], ["reset_at", "Reset at", "header"], ["err", "Error", "body"]])
    case "runtime.subagent_died": return layout(event, "Subagent stopped", [["orphans", "Orphans", "context"], ["count", "Count", "context"], ["reason", "Reason", "body"]])
    case "runtime.background_task_stopped": return layout(event, "Background task stopped", [["summary", "Summary", "body"], ["output_file", "Output file", "context"]])
    case "runtime.restart_notice": return layout(event, "Backend restarted", [["prev_pid", "Prev pid", "context"], ["started_at", "Started at", "context"], ["branch", "Branch", "context"]])
    case "runtime.storage": return layout(event, "Storage update", [["level", "Level", "header"], ["used_mb", "Used mb", "context"], ["cap_mb", "Cap mb", "context"], ["scope", "Scope", "header"]])
    case "runtime.token_expiry": return layout(event, "Credential expiry", [["days", "Days", "context"]])
    case "runtime.delivery_unread": return layout(event, "Delivery unread", [["to", "To", "context"], ["waited", "Waited", "context"], ["boundary_for", "Boundary for", "context"]])
    case "runtime.ui_crash_report": return layout(event, "UI crash report", [["summary", "Summary", "body"], ["report", "Report", "context"]])
    case "runtime.external_unroutable": return layout(event, "External mail unroutable", [["peer", "Peer", "context"], ["excerpt", "Excerpt", "body"]])
    case "reminder.working_checkup": return layout(event, "Progress checkup", [])
    case "reminder.idle_docket": return layout(event, "Docket reminder", [["items", "Items", "body"], ["more", "More", "context"]])
    case "docket.participant_added": return layout(event, "Participation added", [["added_by", "Added by", "context"], ["owner", "Assigned to", "context"], ["objective", "Objective", "body"]])
    case "context.deep_reach": return layout(event, "Message routing notice", [["node", "Node", "context"], ["gist", "Gist", "body"], ["kind", "Kind", "context"]])
    case "context.notice_digest": return layout(event, "Change notices", [["groups", "Groups", "context"], ["untyped", "Untyped", "context"]])
    case "context.org_state": return layout(event, "Organization state", [])
    case "context.provider_usage": return layout(event, "Provider usage", [])
    case "context.cache_continuity": return layout(event, "Cache continuity", [])
    case "context.org_charter": return layout(event, "Organization instructions", [])
    case "context.command": return layout(event, "Command", [["text", "Response", "body"]])
    case "context.drive_mail_pointer": return layout(event, "Delivery context", [])
    case "context.drive_restart_interrupted": return layout(event, "Interrupted restart", [])
    case "context.drive_restart_wake": return layout(event, "Restart wake", [])
  }
  return assertNever(event)
}


function summaryValue(value: HumanValue): string {
  switch(value.kind) {
    case 'text': return value.text
    case 'scalar': return value.value === null ? '' : String(value.value)
    case 'list': return value.items.map(summaryValue).filter(Boolean).join(' / ')
    case 'record': return value.fields.map(f=>summaryValue(f.value)).filter(Boolean).join(' / ')
    case 'event': return eventSummary(value.event)
    case 'unavailable': return ''
  }
  const unhandled: never = value
  return unhandled
}
/** List previews and user-jump labels use the same declared human fields as
 * the card, including nested answers; empty bodies still have a useful label. */
export function eventSummary(event: KnownEvent): string {
  const view=projectEvent(event), profile='projection' in event?'public':'operator'
  const body=view.fields.filter(f=>f.placement==='body')
  const fields=body.length?body:view.fields.filter(f=>f.placement==='header')
  const text=fields.map(f=>summaryValue(humanValue(f.value,f.type,profile))).filter(Boolean).join(' / ')
  return text || view.title
}
