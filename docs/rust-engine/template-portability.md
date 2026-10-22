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

## Measured desktop path and remaining integration check

The actual Save modal and creation picker passed over the isolated production
save/list/resolve HTTP handlers. Times include UI commit and HTTP work; preview
includes its normal debounce. Every case kept all nodes, validated the file and
rendered at most 100 preview rows without a crash or stack overflow.

| Nodes | Tree levels | File bytes | Desktop save (s) | Desktop preview (s) |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 20 | 269,951 | 0.0809 | 0.3226 |
| 1,000 | 1,000 | 281,813 | 0.0554 | 0.2998 |
| 5,000 | 5,000 | 1,413,813 | 0.1939 | 0.4676 |
| 12,000 | 12,000 | 16,776,295 | 0.9065 | 0.7996 |

The 12,000-level desktop file is 921 bytes below the 16 MiB cap. A separate
control loading the exact parent save-dialog traversal reproduced a stack
overflow at 5,000 levels; the iterative traversal retained all 12,000 nodes.

**Canonical creation/result is not an author pass.** The old shared path's
1,000-node/20-level transaction was still active at 131 seconds and was stopped;
that is a lower bound, not a completed-create duration. The layout contains 50
chains, each with two agents and 18 projects: 100 agents, 900 projects and 1,900
canonical create/configure requests. Shared `projects::settle_credits` runs after
each request and still has a 1,024-level frontier cutoff. The coordinator assigned
that shared fix and matched creation timing to the separate deep-project work,
and deferred full creation/result remeasurement to the integrated tip. This
template stack does not alter settlement or claim those deferred cases passed.

Other author checks: focused Rust 49/49, typecheck, glossary coverage 9/9 and
`cargo check` passed. The only check warning was the pre-existing unused HashMap
import in `domain/tree.rs`. One updated offline Save dialog capture was inspected.
