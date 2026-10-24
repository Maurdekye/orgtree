## Orgtree 2.0.8

This patch release removes repeated work from engine startup, adds the Hire Defaults settings that were missing, lets a transcript message be copied from its own right-click menu, and fixes resuming an agent after its provider account changes.

- Starting the engine no longer repeats the same import scan for every imported agent. That walk now happens once per startup pass, so the cost stops multiplying with the size of the organization.
- The engine reports itself ready without waiting for its recovery work to finish. The desktop shell is served straight away, while anything that writes waits for the repair to land so a new message cannot overtake a turn that was interrupted.
- A startup that hangs is now detected properly. The readiness deadline measures silence against real progress checkpoints, so ordinary log output can no longer keep a stalled start looking alive.
- Hire Defaults shows the MCP servers that are currently registered, instead of leaving you to guess what a new agent will get.
- Hire Defaults gained a provider account selector, and new hires inherit that account automatically.
- A transcript message can be copied from its own right-click menu, at the same granularity as Reply — right-clicking a thought copies the thought, right-clicking the message copies the message.
- What is copied is the stored text, not a tidied version of it. Indentation, trailing blank lines and fenced blocks survive the trip to the clipboard, so pasting a patch or a YAML fragment somewhere indentation-sensitive still works. Row metadata — ids, times, sender chips, delivery badges — is never copied.
- Switching an agent to a different provider account no longer tries to resume the other account's session. The session lineage resets and resumes are bound to the account they belong to.
- The session that was in progress before such a switch is archived rather than dropped, so what it knew is kept.
