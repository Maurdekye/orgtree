# Rust docket policy parity (P41–P50)

Reference: Python `engine/backend/orgtree/ledger.py` at `4ddbfb1`.
The restored rules below are retained under PLAN §10 F1. Acceptance checks,
W08 receipts/artifacts/findings, review machinery, addenda and scope archive
remain removed under the signed F2–F5 differences. No renderer, schema,
Python engine or deployment changes are included.

## Restored rules

| Finding | Disposition | Rust behavior / Python reference |
| --- | --- | --- |
| P41 | Fixed | Supersede requires management rights on both items, an open replacement, a source not already superseded, and an acyclic replacement chain. A closed dropped/done source can still be replaced. `work_supersede`, lines 19769–19810. |
| P42 | Fixed | Creation and move share `checked_parent`: the parent must be readable, not necessarily manageable. The full ancestor chain is checked without a fixed hop cutoff. Dependencies still require existence only. `_work_parent_check`, lines 19740–19767. |
| P43 | Fixed | Keep/append require an integer `expected_rev`, checked against the locked item before mutation. A whole list cannot also specify keep/append. Internal staffing and completion-alias keeps derive the revision from the item locked in that transaction; explicit caller patches are validated first and caller revisions are never overwritten. The complete stored list and combined entry limit remain authoritative. As in Python, append supplies the result when keep and append are both present. `_work_patch_list`, lines 15291–15331. |
| P44 | Fixed | Agent get/list filter link headers using the same owner/creator/superior/participant/reviewer read rights as items. Unreadable dependencies return only `{visible:false}`; parent/replacement names become null with visibility false. Supersede/move history pointers receive the same filter. User views retain every readable link. `_work_view`, `_work_history_view`, `_work_pointer_visible`. |
| P45 | Fixed | Create and participant edits share actor-authorized passive notices. Only newly added members still in the final list are told, excluding the actor. Membership commits even if policy refuses mail; `notice_refused` identifies each refusal and `noticed_deferred` reports deferred delivery, including through staffing's outer response. Allowed notices are inserted with the mutation; database errors still abort it. Ordinary sends default to granting reply audiences; automatic participant notices explicitly disable that grant. `_work_participation_notices`, lines 17566–17615. |
| P46 | Fixed | Explicit archive refuses unfinished items and any manual attention or linked open question. Already archived closed work remains an idempotent success. `work_archive_now`, lines 19554–19578. |
| P47 | Fixed | Delete clears dependency occurrences and replacement pointers on active and archived items, with a `pointer_cleared` history row on each affected item and revision/date advances. Names stay retired, and children/open questions still refuse deletion. Cleanup reads at most 128 affected rows per query. `work_delete`, lines 19646–19663. |
| P48 | Fixed | Only the current owner of open work may request a handoff, addressed to its immediate superior (user for a top-level owner). Omitted/blank reason uses the original default. Ownership is unchanged. `work_handoff`, lines 17515–17526. |
| P49 | Fixed | Raise and amend compare only the latest dismissal after Unicode lowercase and whitespace normalization, before mutation. Older reasons do not permanently bar a materially changed sequence of flags. `_work_attention_repeat_guard`, lines 15374–15390. |
| P50 | Fixed | Amend keeps the original raise/set revision and stores amended author/time plus a durable before/after event. Retraction, dismissal, successful reply and supersede archive final reason and authors/times. Reply history also retains the full answer, does not clear a newer flag, and leaves flags with pending linked questions standing. `_work_attention_archive`, `work_update`, `work_dismiss_attention`, `work_clear_attention_on_user_reply`. |

## Implementation notes

Creation, link rearrangement and deletion use short serializable database
transactions. Concurrent conflicting graph/link writes may be refused by
PostgreSQL instead of committing a cycle or leaving a dangling pointer.
Participant notices use the caller's transaction with the shared mail-rights
check and actor identity; only mailbox publication runs after commit. Assignment,
review-request and kickoff messages retain their existing transactional path.
No global lock, external I/O inside a transaction, or live-data change is added.
Link headers are read in pages of 256; ancestor queries are scalar.

## Verification

The policy dispositions above are verified from source against the frozen
Python reference; they are not a claim of measured PostgreSQL behavior.
Measured: `cargo check --offline --manifest-path engine/rs/Cargo.toml
-p orgtree-engine -j 2` passed with `CARGO_TARGET_DIR=E:/cargo-target/jobs-sol`
and at least 6 GiB free RAM. The first check took 3m 23s in the fresh target;
the replay onto integration `807210f` passed in 18.23s; the anonymous-link
projection correction passed in 6.04s. The final engine tip `9f267ba`, including
atomic-staffing and completion adapters on integration `0482b2a`, passed in
19.03s with 12.05 GiB free RAM at start. All engine patches compared equal across
that last rebase; only the guide's insertion context changed, retaining upstream
entries. The staffing adapters were agreed with outage-astra, the completion
tool adapter with mcp-astra, and the default mail option with the coordinator.
No unit-test suite, independent review round, engine build, push, install or
restart is part of this prototype hand-in.
