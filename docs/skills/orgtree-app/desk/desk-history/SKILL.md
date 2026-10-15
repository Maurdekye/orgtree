---
name: orgtree-desk-history
description: Explain the agent event log shown in History and distinguish it from the conversation.
---
Up: [orgtree-desk](../SKILL.md)

# Desk History tab

History displays retained agent **event records** from the history feed. Each row renders its timestamp, event kind/actor and detail/gist, or the corresponding typed event card. It is not a second full conversation transcript; [Chat](../desk-chat/SKILL.md) is the conversation surface.

The view remains attached to its record feed while open, so later agent actions can appear without reopening it. Loading, empty and failed states differ; “Could not load history” offers Retry. A blank/unavailable read does not establish that the agent never acted.

The records are what the engine retained. This view does not reconstruct missing old provider turns, reconcile an interrupted tool, or prove a historical operation succeeded merely from its title. Follow exact references where supplied and inspect the current object when a state may have changed.

Reading History does not start a model turn, rehire a retired agent or edit retained records. Use it to explain chronology and actor identity; use the associated tool/workflow guide for the event's operational meaning.

## See also

- [orgtree-desk-chat](../desk-chat/SKILL.md)
