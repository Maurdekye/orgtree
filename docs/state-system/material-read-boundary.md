# P01 scratch and transcript read contracts

The source inventory identifies entry points, but an entry called a read can
still mutate state or expose content after its permission changes. This package
adds executable legacy contracts for `orgtree_read_scratch` and
`orgtree_read_transcript`, preserving the distinction between observed behavior
and the approved native design.

No runtime source changes. All HTTP fixtures use temporary organizations,
credentials, files and SQLite stores. The application lifecycle is never
started. No provider or database service is started, no live data is accessed,
and `runtime_census` and `conversion_authorized` remain false.

## What the registry closes

Two tool cards and two transcript-only dispatch witnesses now have explicit
contracts. The shared five-tool read branch and the general HTTP route remain
pending because their other operations are not covered. Source spans bind
legacy authority, item predicates and receipt behavior. Wire, physical reads
and writes, native conflicts, transitive effects and instrumentation retain
specific unresolved questions. The domain classification is `read` for scratch
and `conditional_write` for transcript; domain mode is never a complete
physical contact classification.

At this package's first landing there were four mapped registration sites,
sixteen mapped dispatch witnesses and zero closed storage candidates, with
597 pending obligations:
305 registrations, 209 dispatch witnesses, 15 connection candidates and 68
dimension occurrences. That is eight more than the preceding 589 because this
package replaces four pending source witnesses with two detailed contracts
that disclose twelve still-open dimension occurrences. These are coverage
obligations, not operation counts or a progress percentage.

`material-read-boundary.json` binds to the canonical registry digest and pins
both tools, response field sets, selected argument/coercion cases, explicit
native obligations and witnessed sidecars. Its validator rejects omitted
tools/shapes/cases, changed limits, dropped native obligations, stale registry
bindings and claims that these tests authorize census or conversion. The
existing reservation fixture changes only its registry digest; its response
expectations are unchanged.

Current expanded registry totals are maintained in operation-contracts.md.

## Authority and observable responses

The real authenticated `/api/agent` fixtures exercise self, descendant,
inherited-holder, participant and reviewer reads, plus unrelated peer/upward
refusals. Wrong identities, stale generations, archived callers, halt and
killswitch refuse before content production. Archived targets remain readable
through a valid route. Removing item membership is visible to the next request,
including a transcript request waiting behind all four read-admission slots.

Scratch fixtures pin root/directory/file/missing-path shapes, sorted first 200
entries, the first 20,000 decoded characters, UTF-8 replacement, text argument
normalization, separator-anchored path containment and filesystem failures.
A resolved-link escape is injected at the resolver seam; this does not test OS
junction replacement or a file-open race. Lineage scratch shares its successor
directory. A first read can create a missing directory and attempt ownership
repair; the test spies that repair to prevent a container command.

Transcript adapter fixtures pin the default 30, clamp to 1–80, numeric coercion,
malformed/nonfinite refusal, `hold_back=False`, outer slicing, 1,200-character
text limit and projected message fields. They deliberately supply extra rows
after the projector's nominal bound, as preserving-bearer rows can occur there.
The simple real-file fixture separately exercises actual ingestion and readback.
These tests do not claim all provider, import, oracle or middleware variants.
Return limits do not bound all underlying IO: scratch reads the entire file or
directory before slicing, and nested transcript tool data has no corresponding
byte limit at this adapter.

Both tools have legacy receipt class `NONE`. Wrapped reads execute freshly and
revalidate authority, even when the key is repeated; a lookup has no receipt
evidence and reports unsupported/unknown without fencing. Wrapper validation
still applies. A no-receipt classification says nothing about physical writes.

## Contacts that a read label would conceal

| Path | Observed or source-backed contact | Atomicity limit |
|---|---|---|
| Cold transcript identity | `reply_events.incarnation` and `transcript_records.incarnation` load/save organization state under `DOC_LOCK`. A shared snapshot can cause repeated reply-identity saves during one call. | Each save is its own cycle; it is not one authority-to-response transaction. |
| Transcript records | `transcript-records.sqlite3` ingestion, retained rows, ordering and assistant data | Separate SQLite transactions; these include authoritative retained data. |
| Transcript projection | `chat-window-index.sqlite3` derived cache rows | Separate connection and commits. |
| Reply snapshots | `reply-events.sqlite3` retained quote identities | Separate connection and commits; not all data is reconstructable projection. |
| Scratch | File/directory reads, conditional directory creation and sandbox ownership attempt | No database transaction covers the filesystem action or disclosure. |

The synthetic real transcript test observes connection destinations and SQL
statement verbs only, without collecting SQL values. It confirms INSERT and
COMMIT on all three sidecars, observes both organization identity minters,
then proves the subsequent pre-minted warm fixture does not save the org.
Existing pooled connections are not comprehensively observed by that hook;
the save spy supplies the organization-write witness. This is a lower-bound
contact witness, not production logging, a call-graph census or a performance
measurement. P02 must still measure all branch/cache/provider/disk variants,
physical transactions, wait/hold time and actual contact drift.

## Legacy behavior the native design must assess explicitly

The approved v6 output-fence and immutable-identity rules are not present in
these legacy helpers. Tests record the following without approving them:

- Revocation after authorization but during transcript production can still
  return the old content. The next call refuses. Native Effective restrictions
  must fence or drain that outstanding disclosure over the affected consumers.
- The roster matcher uses node names despite carrying `born` metadata. A
  deliberately mismatched stored `born` still grants; this is not a claimed
  full delete/rehire experiment. Native immutable identity must close it.
- A holder returning in `A -> B -> A` can match its earlier roster stretch
  while it is also current. Native current-holder exclusion must not copy this.
- A `done` item still in the active collection grants during the archive grace
  interval. Archive ends the grant. The exact closed-item transition must be
  reconciled with the approved policy before conversion; this package chooses
  no new user-facing definition.
- Once a target is authorized, content has no item-tag filter: the item is the
  authority witness for the target's namespace. This package does not invent a
  new finer-grained content policy.

The complete wire facet remains open. Known source deficiencies are not golden
native acceptance requirements: later native/Rust tests must assert the approved
behavior and explicitly document deliberate differences from the legacy cases.

## Negative controls and limits

Caching the first successful authority result makes the same sequential
revocation assertion fail; the unchanged helper passes it. Ignoring the outer
message slice likewise fails the normal response-limit assertion. Each unsafe
branch has an execution marker. Missing contract data and false gate elevations
are independently rejected. The tests alter only their own synthetic process.

No PostgreSQL, Rust, actual sandbox ownership, live profiling/census, complete
transitive contact closure, crash recovery, native concurrency, migration or
release qualification is claimed. The frozen v6 packet remains unchanged.
