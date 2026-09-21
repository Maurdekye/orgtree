# P01 isolated preview contracts

A preview can execute normal ledger mutators on a detached document and still
perform expensive reads or provider preflights before that simulation. This
package records those distinctions for `orgtree_preview` before native
conversion. It changes contract data, documentation and tests only.

The frozen v6 design remains authoritative. The new contract closes the bounded
legacy authority and receipt facets. Reads, writes, predicates, conflicts,
wire, effects and instrumentation remain explicitly unresolved where their
transitive or native obligations are incomplete. The registry now has 16
contracts, seven mapped registration sites and 31 mapped selector witnesses.
Its 598 pending obligations are 302 registrations, 194 selectors, 15 storage
candidates and 87 unresolved dimension occurrences. These are source and
contract obligations, not operation counts or a completion percentage.
`runtime_census` and `conversion_authorized` remain false.

## Surfaces and authority

The real agent HTTP door authenticates the caller and runs its admission checks.
The preview branch loads the org separately and requires that caller live. A
nested `actor` argument does not replace the authenticated caller. Visibility
of another agent does not confer management authority over it.

| Surface | Accepted operations |
|---|---|
| Agent preview | reallocate, move, swap/swap_seats, self_subjugate/subjugate, retool/set_scope, retire, dissolve, revoke_dir, switch_model, audience |
| Operator preview | retire, rescind, delete, dissolve, reallocate, switch_model, promote, demote, move, reseed, revoke_dir |

The agent removes one leading `orgtree_` prefix without trimming spaces or
folding case. Container-valued operation names fail the shared text validator
first. Its move batches use `operation=move` with `moves`; direct `move_batch`
is refused even though the helper supports it. Hire, rehire and rename are
also refused. Audience preview supports only grant and revoke. Selected HTTP
tests assert the operator credential, public-org refusal and surface allowlist.
The general operator route remains pending because ordinary operations on the
same route are not qualified by these preview-only tests.

Each admitted agent spelling executes its real ledger branch on the shadow.
Selected refusals cover an unrelated target, self restrictions, capability
ceilings, insufficient credits, an invalid move batch and self-retirement with
live reports. Fractional credit rounding is pinned without reserving any real
credit. Shadow audience grants can create mail and a returned drive hint, but
the stored org retains neither that mail nor the new grant.

## Preflights are part of the contact problem

Retool/set_scope with an account rejects self and unrelated targets, then calls
registry selection validation against the target's **current** model. Directory
translation also runs before the detached clone. Switch previews call provider
admission, account compatibility and supervisor busy-state lookup first.

The fixture stubs provider admission rather than executing provider discovery,
authentication or network work. It verifies refusal ordering and selected
registry/current-model behavior. Source inspection shows that provider
preflights can read settings/installation state or refresh evidence; non-primary
accounts consult the registry. All those transitive contacts remain open.
No universal no-network or no-filesystem-effect claim follows from these tests.

Two concrete legacy parity limits are pinned:

- A retool account can pass prevalidation yet be excluded from the helper's
  allowed fields, so the shadow does not change its binding. The gate also uses
  the current model when a queued switch has a different destination.
- A switch preview executes the ledger transition, including busy or durable
  inflight queuing and cancellation, but does not run supervisor account/session
  finalization. It is not a full rehearsal of the real transition.

These are recorded gaps, not newly approved native behavior. Complete
account/session and underlying transition parity remain prerequisites.

## Response and retry behavior

Successful responses have exactly `operation`, `applied`, `result`, `before`,
`after` and `changes`; `applied` is false. `before` and `after` use the structural
inspection projection. The recursive diff uses positional paths and null for
absence; a missing-to-null change is not distinguishable from null-to-missing
solely by its values. There is no durable acceptance or reservation token.

Selected legacy edge behavior is preserved explicitly:

- Agent preview defaults `include_archived` to true and evaluates it with plain
  `bool`. Null is false; a nonempty string such as `"false"` is true. This differs
  from the string-aware inspection flag and the pure helper's false default.
- Falsy nested args become an empty object before the dictionary check. Truthy
  non-dictionaries refuse. Text fields use shared normalization. Unknown retool
  fields are ignored after the earlier account/directory handling.
- Result filtering removes a fixed case-insensitive set of private **keys**
  recursively. It does not inspect arbitrary values or remove unlisted keys.
  Lists and tuples in `result` are capped at 200; strings, before/after node
  lists and the diff have no corresponding total size bound. The 240-row
  projection fixture tests this distinction through a declared projection seam;
  it is not a 240-agent database benchmark.
- Hidden charter changes can produce an empty structural diff. Directory
  translation warnings are currently discarded by the preview door. Ledger
  warnings, when returned, are inside `result`, not a top-level warning field.
- Selected malformed numeric arguments currently produce HTTP 500. Complete
  malformed-input and native result parity remain open; tests characterize the
  legacy response without authorizing its retention in the rewrite.

Legacy receipt coverage is unknown (the empty string), not explicit `NONE`.
The branch returns before receipt admission. A syntactically valid keyed wrapper
recomputes a fresh preview after the real state changes; lookup returns
`unknown/unsupported_operation` and writes no absent-key fence. The fixture
obtains a real custody epoch and uses real minted keys. No operation receipt is
created by the preview or that unsupported lookup.

## Storage witness and atomicity limit

`isolated()` JSON-serializes the full org before constructing the shadow. Lazy
document traversal materializes unrelated retained sections. A real pooled
SQLite trace on the already-migrated synthetic fixture observes SELECT,
BEGIN and COMMIT, with the `meta`, `doc`, `nodes`, `log_d` and `log_l` tables.
The clone materializes retained events, mail history and notice history; the
unrelated private mail text does not appear in its structural response.

The measured reallocation call directly blocks `save_org`, `subprocess.Popen`
and `supervisor.read_chat`; no measured domain DML occurs, and whole stored
document equality holds. Those guards apply to that call window. They do not
qualify cold migration/recovery, all middleware effects or all provider paths.
SQL tracing retains only controlled verbs/table labels, never statement values
or payload text. This is a contact witness, not a complete runtime census.

The agent branch holds no DOC_LOCK over the complete load/preflight/simulation.
The eager SQLite snapshot, later lazy reads, runtime state and provider evidence
are not one atomic read. The operator preview currently holds DOC_LOCK instead;
its serialization is an existing cost, not a proposed native lock. Native
consistent bounded reads, indexed predicates, generation/current-disclosure
fences and disjoint progress are still required. A before/after preview is not
an atomic transaction over the actual affected agents.

## Executable controls and limits

The source-bound fixture refuses missing operation or field coverage, stale
registry bindings, omitted native obligations and forged census/conversion
flags. Source hashes and existing validator drift controls remain mandatory.
The tests use real HTTP authentication and real ledger/store paths against
temporary orgs, credentials and home/data roots. ASGI lifespan is not started.

Two deliberate unsafe substitutions run only inside the test process:

1. Return the original org instead of a detached clone. The same input-object
   immutability assertion that passes for the real implementation must fail.
2. Save an org mutation from the preview wrapper. The same whole persisted-doc
   equality assertion must fail. This writes only the disposable synthetic org.

Both controls include execution markers, so skipping the unsafe branch cannot
count as detecting it. The controls are invariants of preview isolation, not
tests that merely repeat source formatting. They do not prove production crash
recovery, native concurrency, external-effect exactly-once behavior or complete
wire parity. No backend entry point, provider dependency or live state is changed.
