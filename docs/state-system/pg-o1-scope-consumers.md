# Scope consumer inventory

Stored agent scope is configured. Native capability decisions fold the current
parent chain, and hold its path locks through an engine action. A captured display
snapshot can fold or memoize its own chain, but cannot authorize a later action.
Configured model, effort, account and compaction preferences remain preferences.

The two exact inventories are `tools/scope-consumers-python.json` and
`tools/scope-consumers-renderer.json`. Each expression occurrence has a category
and a reason. They pin expressions, owners and occurrence counts; line numbers
are diagnostic only. A new expression, an extra occurrence, a removed binding or
an empty explanation fails the inventory tests. Classifying an entire function
does not implicitly authorize its future reads.

The Python AST inventory records direct `scope`/`configured_scope` fields,
attributes, scope calls, current-view calls and named method bindings. It retains
the origin when a consumer assigns the value to a local alias. The TypeScript AST
inventory records direct and optional field access and string-index access. Both
exclude comments and prose strings. These are syntax inventories, not a substitute
for the actual permission, dispatch and database controls.

Categories:
- `effective`: current capability input, captured effective display or the explicit
  current-view binding. Explanations identify the transaction/display boundary.
- `configured`: authored writers/codecs, explicit seat copies, legacy-only clamps
  or preferences. These must not be used as native action permission.
- `unrelated`: a different meaning of scope, such as docket history, question
  decisions, OAuth or transcript cursor identity.

The configuration editor uses `configured_scope`, falling back to `scope` for
legacy payloads. Its parent ceilings, staged hire defaults, read-only markers and
MCP availability use effective displayed scope. The server remains authoritative.
An inserted superior first hires within the current anchor limits, then preserves
the anchor's configured seat values; its effective permissions still follow the
resulting ancestor chain. Native folder-revocation planning selects the edited row
and current authority path without enumerating descendants.

Run the inventory tests through the normal Python verification runner and Node
test runner under P03. The command-line inventory tools can retain the complete
match/classification list as JSON in the implementation review packet. Update an
entry only after inspecting its source and the relevant actual consumer control.
