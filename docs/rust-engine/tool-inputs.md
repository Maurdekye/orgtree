# Full inputs on expanded tool calls

The 3.x renderer at `4ddbfb1` and alpha.6 both expanded only tool results and
diffs. The Rust actor kept a one-line argument summary and discarded full inputs.
This change implements the user's 2026-10-07 request to show full tool arguments.

## Storage and delivery

Migration `0008_tool_inputs` adds two JSONB columns to `ot.convo`. Ordinary
conversation reads still select only `body`; the full inputs are never included
in transcript pages or streams. `ConvoWriter` extracts inputs and writes them
atomically with the corresponding body/version. Result updates preserve inputs.
Agent id, conversation sequence and tool id identify a call, including repeated
Antigravity step ids across turns and negative imported-history sequences.

Claude tool/server-tool input and Antigravity parameters are retained whole.
New imports of 3.x history retain their full tool input too. Codex dynamic/MCP
arguments are retained, command events keep full commands and options available
in those events, and file-change events keep all changes rather than only paths.
Completed events refresh inputs when a provider supplies more detail later.

Codex's normalized events omit some original fields, notably the original patch
string and optional shell arguments. Its thread start/resume response supplies
the native rollout path (confirmed in the installed CLI's generated JSON schema).
Expansion reads only the matching `call_id` function/custom-tool/local-shell input
from that file, in a blocking worker, and caches the exact input in the second
column. If the path is absent, the existing per-home rollout locator is used.
No other native records are returned, no inference is run and no CLI is launched.
The native cache is separate so an actor's later result update cannot overwrite it.

`GET /api/orgs/{slug}/nodes/{nid}/toolinput/{seq}/{tool}` uses the same desktop
authentication and org/agent resolution as chat. It reads one indexed row. Tool
input responses are excluded from HTTP body logging like other file content.

## Display and limits

The expanded line mounts an input view, triggering the request only on expansion.
Shell commands are shown as their full multiline text with other supplied options
(including description and timeout). String inputs such as patches remain raw;
other inputs use indented JSON. The existing scrollable preformatted style bounds
the panel's height, not its content. Results, errors, images and diffs remain.

Previously flattened rows have no recoverable input in their stored summary;
the UI explicitly says the full input was not retained. This does not reimport
every old transcript or invent missing data. If a Codex rollout is not available,
the retained provider details are shown with an explicit note and Retry control.
Calls already cached from their native record remain available without that file.

## Verification

- `npm run typecheck` passed.
- A brief JSDOM smoke against the actual new component preserved a 120,021-character
  multiline command and its options, raw patch text and Edit JSON. It checked the
  encoded on-demand route, negative history sequence and unavailable old-row state.
  HTTP was stubbed; this is not a live engine or database rehearsal.
- `cargo check -j 2` checks the engine; the final hand-in records its result.
- No engine build, live data/settings changes, install or restart was performed.
