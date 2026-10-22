# Portable nested templates

Saved files remain version-1 nested `agents`/`reports` JSON. There is no node or
tree-depth limit. The actual read, parse and write paths enforce a 16 MiB UTF-8
file bound with a clear refusal. Save reads every live node with keyset paging,
then preserves `(sibling_order,id)` order. Note-specific safety limits remain.

`template_wire::Wire` reads the tree as `RawValue`; serde_json's raw-value scanner
uses an explicit scratch stack. A single-pass token index points past each JSON
subtree. Each node is deserialized without its `reports` member and stored with
an index to its preceding parent. Template topology never owns recursive Rust
values. Template/Slot Clone and Drop, error cleanup, walks, credit planning,
standing-note capture and nested output emission are flat or iterative. The
index avoids reparsing each descendant subtree and quadratic work on chains.
Other JSON parsing retains its default recursion checks.

Project `settings` carries the queue/event allowlist, validated and applied by
canonical `configure_project`; slots and peer mail remain layout fields. Saved
speed uses `scope.fast_mode`, including explicit false. A harness is exported
only for OpenRouter with `extra.harness_pin=true`; the ordinary inherited harness
stamp is omitted. Preview blocks unsupported speed or unavailable pins, permits
explicit overrides, and creation rechecks normal speed/harness eligibility.

Desktop names traversal is iterative. Preview rows are flat and paged in groups
of 100; actual depth/parent text survives capped visual indentation. The full
creation plan is retained. HTTP endpoints/file fields supply parity; there is
no template agent tool. See the org-template and create-organization glossary.

Measured pure engine checks on a 256 KiB thread passed 1,000 nodes/20 levels,
1,000 levels, 5,000 levels and 12,000 levels. The last file was 16,777,105 bytes
(111 below 16 MiB). Export/parse/preview took 0.3274/0.1025/0.2767 seconds for that
case, including safe Clone/Drop and validation in the test. The legacy parser
probe accepted 63 tree levels and refused 64; the 4.4.1 validator independently
enforces four levels. New nested files within those old limits retain the old
wire shape. Unsupported format versions produce a version refusal.

The explicit disposable-database fixture measures production save/list/resolve
handlers and actual desktop Save/Picker/Create components. Its create adapter
runs the same canonical node requests in one transaction; post-commit network,
warming and kickoff effects are disabled by design. It verifies the resulting
stored node/parent graph and scope. It is a timing receipt, not a full app/rig
proof; final measurements are attached to the exact-SHA hand-in.
