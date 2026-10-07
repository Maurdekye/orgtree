# Staffing and queued configuration parity

2026-10-07. Source reference: Python `origin/dev` at `4ddbfb1`; findings
`artifacts/parity/batch1.md` (P01-P10), batch3 (P30), batch4 (P40).

## Restored behavior

| Finding | Implementation |
|---|---|
| P01 | Staff schema includes retained seat, placement, harness, kickoff and docket update arguments. Removed review-stage machinery stays removed under PLAN section 10. |
| P02 | Hire/rehire, scope, audiences, work assignment/update and kickoff share one caller transaction. Refusal rolls back the composite. Feed publication, scratch creation, warming and waking occur only after commit. |
| P03 | Staffing or hire/rehire with `work_item` opens a backlogged item; ordinary assignment retains its status. |
| P04 | Staff infers update from a slug and forwards title/objective, attention, blocked reason, reopen and progress. |
| P05 | Rehire applies name, scope, charters, effort, validated account and fallback overrides. Account override does not use the live frozen-seat rebind door or implicitly thaw a freeze. |
| P06 | Superior rehire inherits the target scope and inserts the restored seat above the target. Explicit inherited scope fields are refused. |
| P07 | Explicit OpenRouter hire harness is validated and retained. |
| P08 | Retire/rescind/dissolve/delete withdraw open requests in the same transaction and publish asks/docket changes. |
| P09 | Every 20 seconds, a bounded policy query finds up to eight unfinished items with an abandoned owner and at least 30 minutes of inactivity. Full records are loaded only for those candidates; assignment and mail commit together. A compacted live identity is retained. |
| P10 | Retool account selectors are checked for existence and provider compatibility before mutation. |
| P30 | Busy model/account changes persist pending intents, replacing or cancelling earlier ones. Settlement or the next wake applies them under normal validation. Monotonic row versions order combined choices. Failed application leaves the old configuration and records a dropped-intent event. Admission serializes against configuration changes. |
| P40 | Hire, rehire and staff audience shortcuts use the same authority rules as standalone grants and commit with the rest of the composite before kickoff. |

## Shared transaction interface

`domain::ops::run_in_tx(engine, org, tx, actor, req, &mut Effects)` is for
callers which already own a transaction. `Effects::default()` collects only
post-commit work. Call `apply_effects(engine, org, effects)` after a successful
commit, and discard the effects on rollback. Docket create/update/assign and
audience grant have transaction-aware cores; their standalone entry points
retain transaction ownership. Do not publish or wake from those cores.

Queued actor ids are immutable. Imported name-only intents resolve a live
caller and never acquire user authority if that caller disappeared. The
existing account/provider switch session rules remain in the normal apply
operations; no lineage nodes are introduced.

## Verification limits

Measured: `cargo check -p orgtree-engine --offline --quiet -j 2` succeeds in
this worktree (build artifacts on E:). Functional behavior above is verified
from source, not a live mutation or provider run. No test suites, installation,
restart, release or push were performed during this prototype task. Coordinator
review and merge are still required. The existing 4.0 transaction isolation and
signed differences in PLAN section 10 remain in force.
