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
agent rows with `FOR NO KEY UPDATE`. This is an org-local transaction lock,
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
Fresh changed-path preservation receipt `approved-folder-grants-20261012T213109`
passes all original 24 controls against that corrected binary, including
ordinary-agent denial, skipped/denied items, unrelated latent scope,
revocation, separate-org isolation, fake-CLI refresh and answer-mail rollback.
The older 8/8 scope-request result remains a prior R1 checkpoint.
No full suite, real provider turn or UI acceptance is implied.

## Foreign-key compatibility correction

Independent R2 found the original FOR UPDATE admission overlooked implicit
org KEY SHARE acquired by agent/event INSERT foreign-key checks. No/empty
audience hire and ordinary tree operations could hold a node, then wait on
that org FK while a folder route held the org and waited on the node.

Folder scope, batch approval, settings, user retool/rehire and audience grant
now use FOR NO KEY UPDATE for their org lock. They do not change the referenced
org id/uuid. The corresponding UPDATE statements change only settings,
row_version or net. No later upgrade to FOR UPDATE remains in these compositions.
That mode conflicts with another settings writer, with normal non-key UPDATE,
and with retained explicit FOR UPDATE isolation guards; it is compatible with
implicit org KEY SHARE. Thus the settings union/read-modify-write remains
serialized while an ordinary tree writer can finish its FK check. Ordinary
ops do not gain an early org lock or a broader permission.

The lock mode and FK behavior are documented by [PostgreSQL18 row locks](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)
and the [PostgreSQL18 referential-integrity implementation](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/adt/ri_triggers.c).
The schema audit covers every org reference in 0001_init and 0019_net_transfers:
the relevant agent/event/mail/audience/request/docket/watchdog and transfer rows
reference the stable org id. No migration drops these immediate constraints.
No source path changes the referenced id/uuid; deleted-org lifecycle is separate.

Explicit org-lock audit: the affected direct/batch/settings/ops/audience paths
all take the above mode consistently. Org-inbox admission/holder selection,
net failure notices, external-unroutable notices and profile revision serialization
retain their original FOR UPDATE locks. These still conflict with the new mode,
so inbox disable/admission and profile edit serialization are not relaxed.
Network state and org lifecycle updates retain their existing behavior. Account
removal's late org FOR UPDATE after agent mutations is unchanged; this correction
does not certify its pre-existing cross-subsystem lock ordering. An attempted
universal early KEY SHARE admission was abandoned because it would add a conflict
with that separate account/agent ordering. Its intermediate commit is superseded;
the final engine diff adds no lock to ordinary tree operations.

The new proof pauses BEFORE INSERT on agents/events before the FK check, starts
a competing real approval/direct route, records its lock wait, and probes actual
org FK insertion under the held route lock (KEY SHARE NOWAIT makes the old failure
bounded). Release then requires both routes to settle with folder/operation intact.
The restored-seat schedule targets the live parent's real pending ask: rehire
already holds that ancestor through its scope chain at the event barrier.
Two ordinary rename writers must reach a barrier concurrently, demonstrating
that separate-node work did not gain an org mutex. Shared-ancestor retool operations
retain their existing node serialization and are not suitable for that control.

Measured final correction 2026-10-12: exact R2 predecessor SHA256
`ff9e8717043f8131d5979c8ebaa46d45cc893a17b9110606dfe66f6385cbdd0d`
passed 5/11 in `approved-folder-grants-round3-20261012T214830`, with six
named failures: FK compatibility and HTTP settlement in user no-audience hire,
agent empty-audience hire and ordinary agent retool. The three competing folder
routes returned PostgreSQL deadlock/HTTP500. Restored-seat and concurrent
ordinary-node controls pass. Corrected `approved-folder-grants-round3-20261012T214855`
passes 11/11 against SHA256
`116148657b9990ade5d354c665c871d5cbf57d0dce69acce28bada27f2a10eaa`.

Fresh corrected preservation receipts: audience/intent 18/18 at
`approved-folder-grants-round2-20261012T214908`, original approval/rollback
24/24 at `approved-folder-grants-20261012T214932`, and settings/isolation
32/32 at `org-inbox-isolation-20261012T214952`. All eight sampled isolation
race directions observed disable winning; no accept-first race is established.
All these are disposable engine-local fixtures, each under1536MB/300s Job.
Their result JSON/logs remain under the previously named author D evidence root.

The engine-package all-targets single-job build completed in44.16s within
6144MB/600s Job, with two focused intent units passing (110 filtered).
Distinct D log: `scratch-open-sol-folder-grants-round3-build.log`.
Partial proof-development logs remain distinct: one two-retool concurrency
fixture timed out on an existing shared ancestor; an earlier green restored-seat
fixture returned404 before the archived seat's restore became visible. These
were fixture failures, not completed green acceptance, and the completed paired
receipts use the same final proof. Prior scope-request8/8 remains prior evidence.
No global deadlock-free engine, real-provider or UI acceptance is claimed.
