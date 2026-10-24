## Orgtree 2.0.5

This release improves provider access, update reliability, chat rendering, and desktop window behavior.

- Refreshes Claude subscription credentials through the same path the CLI uses, including recovery from client-specific 403 failures.
- Labels secondary Anthropic accounts as Claude Code and shows each account's own reported subscription tier.
- Repairs Antigravity permission hooks on Windows paths containing spaces while keeping tool restrictions enforced.
- Lets you check for a newer release while an update is already prepared. A genuinely newer package replaces the prepared one; the same or an older release leaves it intact.
- Makes update installation safer by confirming engine shutdown and preserving recovery state when installation cannot proceed.
- Gives live and historical chat rows one durable identity and prevents the same event from appearing twice while retaining the newest content.
- Prevents a replayed provider-switch turn envelope from appearing as raw message text.
- Improves the desktop interface: compact provider controls, clearer prepared-update status, restored eye shortcuts, stable context menus, persistent fitted views, reliable "Show on canvas," and simpler docket controls.
- Keeps presented-document chips visible but inactive on zoomed-out agents.
- Moves popped-out desk and modal window controls into their own content headers, removes the extra window strip and detached draft-copy action, and makes the integrated header draggable.
