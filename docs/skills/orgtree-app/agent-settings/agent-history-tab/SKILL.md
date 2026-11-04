---
name: orgtree-agent-history-tab
description: Explain the retained event history in an agent's settings and distinguish it from the conversation.
---
Up: [orgtree-agent-settings](../SKILL.md)

# Agent History tab

History displays retained agent **event records** from the history feed. Each row renders its timestamp, event kind/actor and detail/gist, or the corresponding typed event card. It is not a second full conversation transcript; the agent desk's [Chat](../../desk/desk-chat/SKILL.md) is the conversation surface.

The History tab appears in an agent's settings only when that agent has retained history records. Draft or uninitialized agents and project settings without history do not show it. The tab stays attached to its record feed while open, so later agent actions can appear without reopening it. Loading, empty and failed states differ; “Could not load history” offers Retry. A blank or unavailable read does not establish that the agent never acted.

The records are what the engine retained. This view does not reconstruct missing old provider turns, reconcile an interrupted tool, or prove a historical operation succeeded merely from its title. Follow exact references where supplied and inspect the current object when a state may have changed.

Reading History does not start a model turn, rehire a retired agent or edit retained records. Use it to explain chronology and actor identity; use the associated tool/workflow guide for the event's operational meaning.

## States tab

Agent settings has a **States** tab directly after History (agents only; projects have no states). It shows how long the agent was active, idle, blocked, halted or frozen: a line of time per state over the last 24 hours and the last 7 days (states with no time are left out), then each span newest first with its start time (HH:MM, hover for the whole span, "now" for the current one), a bar sized by its length that fills the row (log scale: 1 second is the shortest, 7 days or more fills the track; three thin pips on every row's track mark 1 minute, 1 hour and 1 day on that same scale, and hovering one names it), and its duration, under a date divider for each day. The first page loads on open and older spans load by themselves as you scroll toward the end (a failed page shows a Retry row). Times show in your display zone. It reads the same state changes the desk Chat shows inline ("Active for 32s": the state that ended and how long it lasted; under a second shows no line there) and records nothing new. Time before the agent's first recorded state change counts for no state, so a total can be less than its window. A state change not yet noted by the agent appears when the agent next starts. The engine side is documented in docs/rust-engine/state-history.md, section "The States tab in node settings".

## See also

- [orgtree-agent-config](../agent-config/SKILL.md)
- [orgtree-desk-chat](../../desk/desk-chat/SKILL.md)
