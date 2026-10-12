# User-approved folder grants enter organization defaults

The HTTP scope editor and request approval previously raised agent/ancestor
configured folders without raising the organization ceiling. A user could
approve an outside folder and still receive CLAMPED. This omitted the recorded
2026-08-08 3.x rule (Python `ledger.py:8082`, request resolver `set_scope(USER)`),
already implemented by Rust user retool and described in tree-scope parity P56.

The shared HTTP mutation now raises org folders in the same transaction as
child/ancestor scope and the request's answer. It reuses `scope::raise`'s union
and adequate RO/RW coverage semantics, preserving unrelated org settings.
Only actual user-authorized positive folder intent enters the org:

- A direct whole-list scope save contributes newly added paths and RO-to-RW
  upgrades only when a folder list is actually supplied. Canonically equivalent
  rows aggregate permission in either order: any existing RW row already covers
  RW intent. Unchanged dormant entries, removals and downgrades contribute nothing.
  Only inferred positive intent is aggregated; stored historical rows are retained.
- A request contributes exactly its approved folder items. Explicit reapproval
  of retained clamped intent counts even if its raw folder was already present.
- Deny/skip, other scope axes, inspection and ordinary agent actions contribute
  no folder authorization. Agent retool still cannot grant above itself.

Org-folder settings/revocation, user scope/approval, user retool/rehire and
user/agent hire/rehire with a nonempty audience list take the org row before
agent rows. This is an org-local transaction lock,
not a global runtime lock. A failed transaction publishes no effects. After
commit, org-folder expansion publishes the org change and refreshes live
agents across the org, since retained scope on other branches may become
effective. Without org expansion, a cascade refresh starts from the highest
raised ancestor. Effort validation and live effort delivery are unchanged.

No historical approvals are replayed and no directory or OS permission is
created. Previously clamped grants remain raw intent: manually adding the
matching org ceiling still revives them if the raw child/ancestor grants remain.
Genuinely revoked or replaced raw grants must be restored explicitly. An absent
directory remains a launch concern: create it before scope refresh/fresh CLI
launch; Claude omits nonexistent paths when launching. Existing running turns
retain their process until the safe replacement boundary.

## Focused proof

`tools/rig/proofs/approved-folder-grants.mjs` uses real HTTP/agent-tool routes
and synthetic disposable rig state. It covers top-level and deep approvals,
RO/RW, explicit retry of a stored clamped grant, unrelated latent exclusions,
mixed/all deny/skip, ordinary-agent refusal, user revocation, existing user
retool, concurrent approvals/settings/retool, separate-org isolation, next
fake-CLI launch and an injected answer-mail failure rolling all state back.
Latent-grant seeding and the failure trigger touch only the disposable rig.

The predecessor uses the already-built `687ab67` engine, SHA256
`f203efb26de7550d4b9e9890f3314e76e0591da514dfa0c77bdf98d128c50f4f`.
The audited approval/scope region is unchanged at current base `cf7668e`;
this is not a fresh base build. Its actual receipt has ten named failures.
Corrected verification and its measured limits are recorded below.

Measured 2026-10-12: predecessor 14/24 passes and ten named failures at
`D:\orgtree-work\rig\scratch-open-sol\evidence\approved-folder-grants-20261012T204441`;
corrected 24/24 at `approved-folder-grants-20261012T211352`; corrected legacy
scope-request proof 8/8 at `scope-requests-20261012T211434` under that evidence root.
Both corrected rig commands exit0; supported cleanup reports no runs or strays.
Corrected engine SHA256:
`e509dd2fdd63e932d392ad4d140791a0964f88d7c55c3bbf6449f4f65c4157de`.
The fake CLI SHA256 is
`343e44792f186b7543af176fa83af69952bb9e728eac534a1cabf4734e537586`.

The initial all-targets `-j2` build failed allocation inside its 6144 MB Job;
the log remains `D:\orgtree-work\scratch-open-sol-folder-grants-build.log`.
A single-job retry at the same 6144 MB / 600 s cap built all engine-package
targets in 2m34s and ran the exact permission-intent unit test: 1 passed,
110 filtered out. Retry log: `scratch-open-sol-folder-grants-build-retry.log`.
Both route proofs were bounded by a 1536 MB / 300 s kernel Job. Build outputs
remain under the author's granted C build root; evidence remains on D.

The concurrent route proof is one observed simultaneous run, not exhaustive
schedule coverage. Rollback is measured by injecting answer-mail insertion
failure in the rig. CLI evidence uses the fake harness; it does not establish
real-provider sandbox enforcement or busy-turn/idle warm-process replacement
timing. Those unchanged actor boundaries were inspected from source. No live
or historical external request was read, replayed or changed.

The older `scope-requests.mjs` expected outside-org clamping and partial RO
after user approval. Those expectations are corrected because they encoded
the omission, contrary to the recorded rule; its other request/routing controls
are preserved. No real provider, external organization's private data, live
settings, filesystem permission, installer or pixel acceptance is claimed.

## First-review correction

Independent R1 identified two concrete gaps in that checkpoint: first-match
folder comparison could reinterpret existing RO/RW aliases as new RW intent,
including an effort-only save; and staffing could lock a parent before its
audience grant acquired the org. The correction requires a supplied folder
list, compares adequate permission across all equivalent rows, and aggregates
only positive new intent. Explicit request approvals keep their separate exact
items, so genuine clamped reapproval remains effective.

The finite composite callsite audit found `audiences::grant_tx` called by
standalone `audiences::grant` and `ops::run_in_tx`. Standalone audience grant's
agent reads do not use FOR UPDATE. The staffing composite is the shared
user/agent hire/rehire dispatcher, so its org acquisition now precedes dispatch.
Ordinary agent checks are unchanged. `ops::run_once` begins its transaction
before dispatch; tool `treetools::run` releases its caller-read connection first.
User and agent `staffing.rs` paths call `ops::run` with a fresh transaction.
The only other `run_in_tx` callers are credit reallocation (no audience
composition) and templates in a newly inserted, uncommitted org (not visible
to competing scope requests). No late lock inside `grant_tx` is used as a fix.

`approved-folder-grants-round2.mjs` controls the staffing schedule using an
advisory barrier trigger after staffing node locks, entirely in disposable
rig state. The competing real approval/direct-edit route's PostgreSQL wait
query must be an org acquisition, then both routes must commit with the
folder and audience intact. User hire/approval, agent hire/direct, user
rehire/direct and agent rehire/approval are separate schedules, plus an
uncontended composite. This measures those schedules rather than every
possible interleaving. The predecessor binary is the exact R1 runtime,
preserved before rebuilding; partial fixture-development logs are retained
separately and are not completed red/green receipts.

Measured correction 2026-10-12: the completed exact R1 predecessor receipt
`approved-folder-grants-round2-20261012T212843` passed 9/18, with three
duplicate-intent failures and both wait-order/settlement failures in user
hire, agent hire and agent rehire. All three competing folder HTTP requests
returned 500 with PostgreSQL deadlock errors. User rehire's existing org-first
schedule and the other positive controls passed. Corrected receipt
`approved-folder-grants-round2-20261012T213036` passed 18/18; every observed
competing wait query acquired the org, then both routes settled correctly.
These receipts are under the same author evidence root described above.
Separate command logs are `scratch-open-sol-folder-grants-round2-red-18.log`
and `scratch-open-sol-folder-grants-round2-green.log` under D:\orgtree-work.

The focused all-targets single-job compile finished in 1m11s, within the same
6144 MB / 600 s Job. The two intent unit tests passed (110 filtered), under
the build lock with a 30-second unit process timeout. Build/unit log:
`scratch-open-sol-folder-grants-round2-build.log`. The corrected engine SHA256
is `ff9e8717043f8131d5979c8ebaa46d45cc893a17b9110606dfe66f6385cbdd0d`.
Both completed route receipts used the same 1536 MB / 300 s Job envelope.
No full suite, real provider turn or UI acceptance is implied.
