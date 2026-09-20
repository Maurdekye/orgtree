# P01: executable contract coverage

This bounded package builds on source-inventory commit
83b2fe414ff416418b4bd45bc7a27bfbb16350fd and frozen v6 design
b830a69bd71b0cee052e78acfe1ceff6b399532765db7ed55d05a253f0f84dfd.
It supplies a checked contract format and an initial populated reservation
family. **P01 remains incomplete.** It changes no backend entry point,
database, permission, receipt, dependency or product behavior.

## Two separate questions

The default command answers whether the registry is structurally valid and
still bound to the current source:

    python tools/state_operation_contracts.py

The completion command additionally requires every obligation and every
contract dimension to be resolved:

    python tools/state_operation_contracts.py --require-complete --details

Exit 0 means the requested check passed, 1 means invalid or stale contracts,
2 means malformed/unreadable input, and 3 means structurally valid **but
incomplete** coverage. The committed registry deliberately returns 3 for the
completion command. Both commands always report runtime_census=false and
conversion_authorized=false, even for a complete synthetic fixture. Neither
static source review nor a JSON edit can satisfy P02/P03 or authorize conversion.

There is no automatic write/refresh mode. Source edits require an intentional
inventory refresh AND contract reassessment. Regenerating the inventory alone
does not refresh the contract's pinned digest or line-span hashes.

## Data model

operation-contracts.json uses schema orgtree.state-operation-contracts/v1.

| Part | Checked requirement |
|---|---|
| source_inventory_sha256 | SHA256 of canonical UTF-8 JSON for the full current inventory; sorted keys, compact separators, unescaped Unicode. Whole-module hashes invalidate helper changes, including unrecognized registrations. |
| entries | Exactly one disposition for each of the 309 inventoried registration sites. Pending, mapped or source-backed exclusion. HTTP/WS/tool entries cannot be excluded as false positives. |
| dispatch | Exactly one disposition for each of the 225 selector witnesses. A branch is evidence, not another operation. |
| storage | Exactly one disposition for each of the 15 connection candidates. Unknown sockets/factories remain visible. |
| contracts | Source-entry bindings, optional tool/action selector, explicit argument normalization and conditional variant, domain mode and all nine dimensions. |
| facets | Source-span-bound assertions for authority, reads, writes, predicates, conflicts, wire, receipt, effects and instrumentation. An unresolved facet requires concrete open questions. |
| wire_cases | Executable selector cases for every contract/entry pair; zero, multiple or wrong matches refuse. These are selector fixtures, not complete API-result fixtures. |

Each source reference records path, inclusive start/end lines and SHA256 of
that exact span after universal newline decoding. Paths must be in the pinned
backend module set. Source witness IDs for dispatch/storage are SHA256 of
canonical JSON [group, inventory_row]; registration entries retain the
inventory's site_id. They identify source evidence, not runtime operation IDs.

The small condition language supports always, not, non_null_any and truthy_text.
It never evaluates code. Action normalization is explicit contract data:
identity, str_or_empty, or str_or_empty_strip_lower. A null action means no
action restriction. Other entry families may need additional reviewed selector
operators; they remain pending until their actual behavior is represented.

Facets intentionally contain human-readable source assertions. The validator
checks their source binding, dimensions, references and honest unresolved
status; **it does not prove that prose accurately describes effects**.
Independent review, canonical result/refusal fixtures, native conflict tests and
observed contact comparison remain necessary. Filling every field with plausible
text is not semantic verification.

## Initial reservation contracts

Both tool names bind the same eleven variants: ordinary list, scope-checking
list, landing query, overlap query, acquire, renew, recover, invalidate,
release, release-with-successor and land. All nine public action names are
covered; the alias retains the same behavior while its distinct tool name
remains part of the legacy receipt fingerprint.

The selector cases cover explicit nulls, empty/non-null candidate, base-only
input, action normalization and empty/false successor. Tests compare list's
read/write split with the current pure document helper on synthetic data.
Empty candidate selects the write-capable branch even when validation refuses.
The helper does not perform the actual public transaction.

Important source behavior is retained:

- Every action is TX_POST in the public receipt classifier, including a domain
  read. Domain mode must not be presented as the actual database contact set.
- Integration-key replay precedes the retained-row cap, which precedes ordinary
  same-owner acquire replay. The cap counts all 512 retained rows, including
  terminal rows. Its native admission mechanism remains unresolved.
- A named resource exposes bounded contention metadata, not private item paths,
  receipts or mutation permission.
- Scope changes do not steal a live claim; recovery requires quiet heartbeat
  and an expired lease or non-live owner, using the stored stale threshold.
- A successful release can stage mail/authority effects and a later wake.
  A RELEASED retry returns notified:null. LANDED is terminal and refuses release.
- land reports a Git action; it runs no Git command. A scope mismatch mutates
  the helper's temporary row before raising; public save/rollback must be pinned.

At this revision two registration sites and fourteen dispatch witnesses map to
these variants. The remaining 307 registrations, 211 dispatch witnesses and all
15 connection candidates are pending. The reservation family's transitive
authority, wrapper contacts, native conflicts, complete result formats,
receipt behavior and runtime probes are also explicitly unresolved. There are
611 unresolved witness/dimension obligations; this is not 611 runtime operations.

## Deliberate failing controls

Tests remove entries, actions, connections, dimensions, source bindings and alias
cases; duplicate or substitute witnesses; map a route to an unrelated contract;
forge qualification; erase unresolved status; overlap conditional branches; and
label scope-checking list read-only. Each must be rejected. A helper write and
an unknown registration invalidate prior source evidence. Source scanning never
imports the backend. The only product calls in the conformance tests are the
existing pure reservation/receipt helpers on synthetic data.

Continue P01 by resolving entries/facets and full wire/receipt fixtures under
review. The preserved http-cover census implementation is input to P02, not
silently imported or enabled by this package. Use the PostgreSQL qualification
record for the separate package-adoption gate.
