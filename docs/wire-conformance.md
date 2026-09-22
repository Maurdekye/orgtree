# Backend wire conformance, first slice

The Rust migration needs executable compatibility evidence at the doors used by
the desktop and agents. `tests/test_wire_contract.py` captures a representative
slice of the Python HTTP, WebSocket and MCP behavior. It changes no product code.
The reference source is `286396ebc6db13aed7bc0ebcfc873a703828296b` (2.x main).

Run from the checkout being tested, using the repository's isolated runner and
an existing runtime with the application dependencies:

```powershell
python tools/run-python-verification.py --python E:/Libraries/Desktop/orgtree/engine/runtime/python.exe --json-output wire-receipt.json tests/test_wire_contract.py tests/test_wire_contract_controls.py
```

The interpreter path is an example for this development machine; use an existing
supported interpreter on another machine. Nothing is downloaded or installed.
The runner records import provenance, tests actually run, failures and cleanup.
The baseline has eleven scenarios. The control module has one test with six
subtests, each running a scenario against a deliberately faulty child process.
Neither skip nor crash counts as detecting a control.

## What executes

| Boundary | Actual path | Expectations |
|---|---|---|
| HTTP authentication | `engine.launch.load_app` / `TokenGate` / `/api/agent` | Exact 401 messages; valid caller succeeds; credential bound to live same-generation peer, other existing org, stale generation; agent denied operator GET |
| Validation/refusal | Real FastAPI request parsing and agent dispatcher | Exact missing-field and malformed-JSON 422 envelopes; container rejected for text argument; unknown tool refusal |
| Unhandled error | Real document route and production exception handler | Injected storage `OSError` becomes exact JSON 500; subsequent valid request succeeds |
| Document pages | Real document metadata/detail HTTP routes | Newest-first pages without overlap/omission, next offset, terminal and beyond-end pages, filtered totals, locate page, missing locate 404, body only in detail |
| Operation receipts | Real `/api/agent` epoch/call/lookup dispatch and persisted document effects | One presentation on replay, receipt instead of original result, correlated lookup, conflict on changed arguments, absent lookup fences delayed call, stale epoch absence remains unknown |
| WebSocket | Real TCP upgrade, `org_ws`, production Hub, save notification | Unauthorized upgrade is HTTP 403; ordered per-org integer revisions; two clients agree; disconnect misses changes; reconnect obtains current HTTP snapshot and subsequent frame advances it |
| MCP | Real `orgtree.mcptool` stdio subprocess forwarding to the fixture HTTP listener | Initialize and tools/list envelopes, id 0 and string IDs, distinct tool names, success/error content shape, malformed arguments, unknown tool, missing/mismatched/stale credentials |
| Legacy MCP frames | Same persistent stdio process, ordered barrier request | Malformed/non-object lines and notifications yield no response; tool notification does not mutate state; unknown method/unsupported protocol behavior explicitly characterized below |

Assertions compare complete small envelopes and selected contract fields in
large/dynamic responses. They do **not** snapshot the entire tree/tool catalog,
normalize errors, sort returned pages, remove unknown fields, or import the
implementation's expected values. Generated IDs, receipt timestamps and epochs
are checked through cross-response identity/shape relations, not golden values.
Timeouts are bounded hang detection, not latency requirements. The 200 ms socket
silence check characterizes current reconnect behavior; it is not a performance
qualification gate.

## Isolation and adapter boundary

`tests/wire_contract/fixture.json` is hand-authored synthetic seed data. It has
no copied organization data, prompts, credentials or transcript material. Each
factory invocation owns a new temporary data root and HOME/profile/config/temp
directories. The child environment starts from a small OS-variable allowlist;
provider secrets, inherited Orgtree routing and proxy settings are not copied.
Operator/agent credentials are generated per process and exchanged only through
private pipes; they are never stored in fixtures or test receipts. A startup
diagnostic redacts the temporary operator credential. All temporary files and
owned child processes are cleaned up on success or failure.

The Python adapter calls the real app loader and runs uvicorn on an owned
loopback port. ASGI lifecycle startup is disabled: this suite does not start the
guardian, mailhub, recovery drivers, provider discovery, warm pools, watchdogs or
provider turns. It connects `store.on_save` to the real `api.hub_changed` on the
server loop, the narrow production notification wiring needed by this slice.
Child-process launches and non-loopback socket connections attempted by the
server after fixture construction raise errors. This is a test guard, not a
general-purpose OS sandbox. MCP uses a separate owned child and the exact
fixture port with no inherited proxy configuration.

For the 500 case only, the adapter injects a storage failure for the synthetic
`wire-fault` gallery; the HTTP route and exception handler remain production
code. Fixture provisioning is allowed to use implementation-specific storage
APIs. Scenario assertions are not.

Implementation selection is outside the assertions:

```powershell
$env:ORGTREE_WIRE_FACTORY = 'tests.wire_contract.python_target:create_target'
python tools/run-python-verification.py --python <existing-python> tests/test_wire_contract.py
```

A later Rust adapter provides a `module:create_target` context manager that
creates the same logical seed, owns the isolated server lifetime and yields:

| Method | Required result |
|---|---|
| `http(path, method='GET', payload=None, raw=None, auth='operator', org='wire-actions', headers=None)` | Raw response with `status`, lowercase header map, `body: bytes`, `json()`; no response normalization |
| `websocket(auth='operator', org='wire-actions')` | Context-managed real socket with `send(str)` and `recv(timeout=...)`; preaccept refusal exposed as `websockets.exceptions.InvalidStatus` |
| `mcp(auth='caller', org='wire-actions', node='caller')` | Context-managed persistent stdio peer with `send(dict)`, `send_raw(str)`, `receive(timeout=...)`; one response per receive |

Auth aliases are `operator`, `bad-operator`, `caller`, `peer`, `old`, `bad-agent`
and `none`. `old` carries generation 0 while its existing seed seat is generation
1. `caller` and `peer` are both live at generation 0. All four seed organizations
exist. Seed documents belong only to `wire-gallery`; mutations use `wire-actions`
and stream checks use `wire-stream` so earlier writes cannot leave pending frames
in that room. No CLI option accepts a running installation's endpoint. An adapter
is trusted test code and must provision disposable state; the suite does not
authorize attaching to live state. The Rust adapter itself is not built here.

## Deliberately retained legacy behavior

These are observations of the Python compatibility surface, **not** new v3
requirements or evidence of conformance to the MCP/JSON-RPC specifications.

| Label | Observed behavior | Status |
|---|---|---|
| LEGACY-L1 | Invalid JSON, JSON scalars/batches, and notifications are silently ignored; an unknown request method returns an empty result | Pinned in `test_legacy_mcp_ignored_frames_and_unknown_method`; no normative parse-error/method-not-found claim |
| LEGACY-L2 | MCP initialization echoes an unrecognized requested protocol version | Pinned separately from ordinary initialization; not real version negotiation |
| LEGACY-L3 | WebSocket has no initial snapshot, text-ping response or replay cursor; revisions are process-local, and reconnect requires HTTP resnapshot | Pinned for compatibility only; cannot qualify the approved v3 durable feed |
| LEGACY-L4 | A valid agent credential on an operator-only HTTP route yields the same 401 prose as an invalid/expired credential | Exact response pinned; wording does not mean the otherwise valid token expired |
| LEGACY-L5 | Document detail exposes `tier: null` for the seeded presenter despite its model tier | Current shape pinned; no new tier semantics inferred |

The approved architecture v6 `CHANGE-FEED-AND-UI.md` instead requires committed
groups, exact snapshot/follow coverage, durable cursor resumption, projection
incarnation fencing and explicit `ResnapshotRequired` after expiry/invalidation.
Those requirements need a separate future protocol profile when their endpoints
exist. Do not make the legacy tests silently accept a different answer, or use
this green suite to claim the v3 feed is complete. Existing original-key receipt
replay also covers only its declared document transaction; `post_effects.observed`
remains `unknown`, never proof of exactly-once provider/external effects.

## Discriminating controls

`create_unsafe_target` is an explicit test-only factory. The normal factory ignores
inherited control selectors. The controls replace a real decision in the owned
child process and rerun an unchanged public scenario:

| Defect | Required detecting assertion |
|---|---|
| Bypass `_agent_identity` | Existing peer/cross-org/stale identity must be refused |
| Bypass `_op_admit` | Replay must return a receipt, with only one presentation effect |
| Reverse gallery read order | Exact page concatenation must be d4,d3,d2,d1,d0 |
| Constant stream revision | Successive changed frames must advance by one |
| Stale snapshot revision | HTTP snapshot must cover changes observed while disconnected |
| Wrong MCP response ID | Initialize reply must preserve the request ID |

All six were detected by assertion failures against the reference checkout.
These controls establish sensitivity to those concrete defects only. They do
not prove detection of every possible authorization or recovery failure.

## Limits and next slices

This is the smallest cross-engine foundation, not an exhaustive API inventory.
It does not qualify provider execution, real startup/guardian ownership, artifact
transfer, every MCP verb/schema, notification delivery, public kiosk/bridge doors,
WebSocket transcript segment projection, ETag races, process restart/receipt
retention, loss of a response during transmission, disk crash recovery, concurrent
transactions, migration, PostgreSQL or Rust. Existing launcher auth coverage is
in `tests/test_engine_http.py`; focused internal event and gallery checks remain
in `tests/test_engine_events.py` and `tests/test_documents_window.py`.

The qualification stream should consume this suite as a compatibility gate and
keep its uncovered native-runtime/migration/feed gates separate. Work-name codec
vectors belong to the independent name-codec slice and are not duplicated here.
