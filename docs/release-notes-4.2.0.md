# Orgtree 4.2.0

Orgtree 4.2.0 adds finer control over agents' tools, expands Language Server support, improves file transfers and conversation updates, and makes Windows startup and shutdown work together more consistently.

## Agents and settings

- **A dedicated Tools tab** follows Scope in agent settings. Native tools, Orgtree tools and MCP servers are grouped there; folder access stays under Scope. Hire Defaults uses matching tool labels and descriptions within its existing layout.
- **Seven Orgtree tool groups** can be enabled or disabled independently. Agents inherit these limits, and disabled groups remove their tool definitions and related instructions. Status reporting remains available.
- **Standing notes use AGENTS.md.** Existing CLAUDE.md notes still apply, and startup delivers the notes each harness needs without duplicating files it already reads itself.
- **Organization account controls** restrict which accounts agents may use and keep account pickers and usage displays aligned with that choice. Folder grants can also be removed explicitly.
- **Quick Chat and organization templates** retain more of your preferred placement, defaults and optional organization settings.

## Language servers and usage

- Expanded local and remote Language Server setup, model browsing and model options, with support through Claude Code and Codex.
- Better handling of strict model templates, cancelled model loads, context limits and session recovery, plus a context gauge.
- Usage history and clearer account labels make it easier to follow consumption. Expired usage-limit markers and frozen-agent displays are handled more consistently.

## Files and conversations

- Durable, resumable attachment transfers with progress, local staging and controls for pending work. Interrupted transfers can recover from saved progress.
- Bundled **mail hub 2.1.1**, including transfer recovery and cleanup fixes. This keeps the existing hub schema version.
- Streaming text, thoughts and tool activity keep their order more reliably. Jumping to an earlier message no longer pulls the view back to the bottom.
- Clearer answered and resolved cards, persistent document read marks, refreshed queued-mail counts, and better links from tool activity to agents, watchdogs and docket items.
- Messages can address multiple recipients. Attention badges and unread notices make pending work easier to find.

## Windows startup and credentials

- **Run on startup** governs the desktop, background engine and sign-in helper together. Updates preserve the setting. The tray shows pending feedback while Windows permission is being requested and reflects the completed setting without requiring another click.
- The sign-in helper can host sandboxed Codex processes in the interactive session while the desktop provides credentials. Native Git askpass supports credential access without depending on an MSYS shell. Existing network restrictions and escalation requirements remain in effect.
- During a signed-in session, loss of a required core process shuts down the remaining core components. Startup and intentional replacement have bounded grace periods; hiding the window is supported, and normal Windows sign-out retains the background engine.
- Graceful agent shutdown and forced-termination diagnostics have been improved.

## Notes

- Windows builds remain unsigned. macOS and Linux builds remain prototypes; their automated build and smoke checks do not replace testing on your own machine.
- Language Server compatibility depends on the model, its template and server. Not every combination has been tested. A reported intermittent freeze when pinning a desk also remains under investigation.
- The Linux startup and folder-permission fixes from 4.1.2 and 4.1.3 are retained.
- Release downloads include `SHA256SUMS.txt` for checking file integrity.
