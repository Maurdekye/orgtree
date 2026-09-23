# P01 structural diagnostic contracts

Structural inspection and capability reporting look like small reads, but their
authorization, returned fields and underlying storage work have different
boundaries. This package records the current behavior of
`orgtree_state_inspect` and `orgtree_capabilities` before native conversion.
It changes only contract data, documentation and tests.

Two tool cards and their two individual dispatch selectors now map to explicit
contracts. The shared diagnostic/preview branch, general HTTP route and storage
connection sites remain pending. The registry now has 15 contracts, six mapped
entries and 18 mapped dispatch witnesses. Its 605 pending obligations comprise
303 registrations, 207 dispatch witnesses, 15 storage candidates and 80
unresolved dimension occurrences. This is 597 minus four mapped witnesses plus
12 newly detailed unresolved occurrences, not a runtime operation count or a
progress percentage. `runtime_census` and `conversion_authorized` remain false.

## What the public tests establish

The tests use the real authenticated `/api/agent` door with temporary
organizations, credentials and existing migrated SQLite stores. They do not
start the ASGI lifespan, a provider, PostgreSQL or a Rust service.

| Boundary | Executable contract |
|---|---|
| Visibility | Self, team, subtree and full scopes; team is self plus siblings, without parent/descendant rows. Item membership does not expand structural scope. |
| Selection | Request order and duplicate targets survive. `nodes` overrides `node`, even when empty. Empty selections mean the whole visible set. One hidden/unknown target refuses the entire batch before projecting any row. |
| Archives | The flag changes both the visible universe and explicit-target eligibility. An archived caller cannot use it to bypass authentication. Archived output rows have `free:null`. |
| Wire coercion | Node text normalization, list-only `nodes`, element stringification, and the shared string-aware archive flag are pinned. A leading/trailing space in a target name is not stripped. |
| Safe fields | Exact top-level and nested field allowlists omit account identifiers, charters, sessions, transcripts, mail, directory paths and status summaries. Account binding exposes presence/missing/provider only. |
| Funding display | The returned free balance depends on current tier prices and immediate non-archived child obligations, including children absent from the requested output. It is not permission to spend. |
| Capability catalogue | Current actor/scope plus install-wide tool names and agent/operator asymmetries. Standard/frozen and desktop alias combinations are exercised over HTTP; a reported tool still refuses an unauthorized target when actually called. |
| Middleware | Invalid credentials, identity mismatch, stale generation, archive, halt and killswitch reject before projection. Frozen policy refuses a non-loopback client. Invalid deployment policy does not yield a permissive catalogue. |
| Repeated requests | The diagnostic branches execute freshly with current scope; no committed operation result is replayed. Unsupported receipt lookup does not create a fence. |

The capability list is a catalogue of the install's dispatch surface. It is not
a per-target authority check, a provider-availability probe or a grant of the
listed operator-only operations. Catalogue fixtures use a loopback ASGI client;
the separate non-loopback refusal fixture prevents accidentally claiming that
the frozen policy works with an unrestricted remote client. No real listener is
started.

Projection allowlists constrain keys, not every value's origin or size. Allowed
operational values such as a title, MCP name or freeze cause are not recursively
scrubbed. Malformed restored field types, all middleware/bridge paths and
complete Rust/native wire parity remain open. A visible row can contain a
parent identifier whose own row is not visible; this existing structural
reference grants no access to that parent.

## Actual storage work behind the small response

The leaf branch calls `load_org`, separately from the cached organization reads
used by authentication and halt checks. `_load_lazy` captures eager fields and
all node rows in a short SQLite `BEGIN`/`COMMIT` read snapshot; the transaction
has ended before response production. Optional lazy sections, if reached, are
not automatically part of that same snapshot.

The new observer attaches to actual pooled connection acquisitions, including
already-open connections. It records only statement verbs, recognized table
labels and a boolean for the exact all-node SELECT. It never retains SQL
values or credentials. In the existing migrated fixture, both tools executed
23 observed statements, including one all-node SELECT, touching `meta`, `doc`,
`nodes`, `log_d` and `log_l`. Inspection returned only the requested single
node. Both observed paths used `BEGIN`, `SELECT` and `COMMIT`, without domain
DML, `save_org`, an org-sequence change, transcript reading or process launch
in that measured window.

Those numbers are reproducible fixture evidence, not a production census or a
performance result. They demonstrate that a small response is not a small
data access. Native conversion must replace the eager roster materialization,
visibility scans and child-balance scans with the specified bounded queries.
No new org-wide permission or revision lock is authorized.

The normal-path no-write observation is deliberately narrow. `load_org` can
reach `_ensure_migrated`, which may finish an interrupted migration or migrate
a legacy JSON source under the existing ownership gate. Connection/schema
initialization, request diagnostics, cached snapshots and in-memory legacy
normalization also need separate accounting. This package executes no such
migration. P02 must measure cold/warm, legacy, failure and recovery variants
before any full-contact claim.

## Legacy differences retained for the native gates

- A missing stored visibility is backfilled to `full` by `Org` construction.
  The helper's own fallback for an existing empty value is `team`, while the
  response preserves the empty value. The former is documented legacy behavior,
  including an existing user-ruling comment; it is not an implicit new default
  chosen by this package.
- An unrecognized nonempty stored visibility falls through to full inspection.
  The test deliberately corrupts the stored field; it does not use or endorse
  a valid scope-setting operation. Native validation must not silently accept
  this malformed permission as broad authority.
- Removing visibility during projection does not fence the already-authorized
  response. The next request observes the restriction. A controlled generation
  change between the initial identity check and the leaf load similarly allows
  that request, while the next one refuses the stale credential. These are
  legacy gap characterizations. They do not satisfy the approved Effective
  output fence or native generation/race gates.
- Neither tool appears in the legacy receipt coverage table. The returned
  coverage class is the empty unknown string, not the explicit `NONE` class.
  Both early branches still return before receipt admission. The contract
  records this distinction; it neither fixes the classifier nor treats its
  omission as native acceptance.

## Failure controls and evidence limits

Two deliberate unsafe substitutions are exercised in the isolated test
process. Caching the initial visible set fails the same next-request restriction
assertion that passes normally. Injecting an extra account field fails the
normal projection-allowlist assertion. Both controls record an execution marker;
neither edits product code. The fixture validator also refuses missing tools,
fields, scope/flag cases, native obligations, stale registry bindings and forged
qualification flags.

The prior reservation and material-read fixtures receive only the refreshed
registry digest; their response/authority expectations remain unchanged. The
existing count assertions and coverage documentation track the expanded
registry. The source inventory and backend bytes are unchanged.

No complete runtime contact closure, native conflict implementation, actual
parallel PostgreSQL execution, crash recovery, migration, deployment or release
qualification is claimed. The frozen v6 packet remains authoritative.
