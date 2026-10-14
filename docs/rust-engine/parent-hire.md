# Hiring a parent without a new allocation

An agent may call `orgtree_hire` with `hire_type: "superior"` and omit
`target` to put a new parent in its old position, including at the top level.
An explicit self target has the same effect. `parent` remains a target alias
on hire; on `orgtree_staff` it remains the parent **work item**, as before.
Subordinate hiring remains the default.

For this self-insertion, `grant` means free capacity reserved for the new
parent, in addition to the caller's remaining subtree. The new seat and this
free capacity must fit the caller's existing free credits. No ancestor grant
is raised, no top-level default is applied, and existing reports keep their
allocations and parent. Agent hires require an explicit zero-based `index`,
chosen among the caller's former live siblings with the caller excluded,
as for other superior insertions. Choosing the caller's former index retains
its position; another valid index places the new parent there instead.
The result's parent, index, order and live sibling count describe the final
position, rather than the temporary report used for atomic funding.

With caller seat C, grant G, reports' held allocation H, new seat P, and
requested free allocation R, require G-H >= P+R. The result is:

- New parent grant: C+G-P, with R free.
- Caller grant: G-P-R, still holding H for its reports.
- External seat-plus-grant allocation: C+G, unchanged.

At the top level, C+G-P can exceed the organization's user-hire grant cap
when the caller's seat costs more than the new parent's. This is a transfer
of existing stake, with no new external allocation, so the cap is not applied
to this promotion (coordinator ruling, 2026-10-14). Ordinary user root hires
retain their cap.

## Authority and transaction

`tools/treetools.rs` and `domain/staffing.rs` stamp the admitted generation,
never accepting that stamp from tool arguments. An omitted target resolves
from the authenticated agent ID inside the transaction, so renaming/reusing
a name cannot redirect default self-insertion.

`domain/ops.rs` admits a self-hired parent temporarily as the caller's report
inside a SERIALIZABLE transaction. It checks that the caller is live, the
admitted generation still matches, and the effective tool group still permits
hire (or both team and docket for staff). The ordinary reservation cannot
cascade above the caller. Composite audiences, work assignment and kickoff
are checked while the new seat is still a report. Then `self_subjugate`
promotes it within that same transaction; failure rolls everything back.
No CLI warming, mail delivery or topology publication runs before commit.
Serialization/deadlock conflicts use the existing bounded four-attempt retry.
The kickoff is authorized while the hire is a report; its event's `grant`
is updated to the final parent grant C+G-P before the same transaction commits,
for both hire and staff. The hire event followed by the promotion event
continues to describe the operation's history.

The final parent receives the caller's captured **effective** folders, tools
(including Orgtree groups), visibility and permission mode, rather than a
broader configured scope or org defaults. Explicit overrides of these fields
are refused, as for existing superior insertion. Omitted account fallback
preserves the caller's effective preference (the org default when unset).
An explicit `account_fallback: true` is clamped to that same preference;
an explicit false remains allowed. This also applies to the staff alias.
Account selection uses ordinary hire rules, including org account exclusions
and provider checks.

Creating a superior accepts its ordinary powers over the caller: it may
rebind the caller to an org-allowed account, change its model or effort,
rename, halt or retire it. The new parent's account is not pinned to the
caller's. This indirect self-reconfiguration is inherent to the feature,
as ruled by the coordinator on 2026-10-14; it does not remove the existing
org/provider admission checks or inherited scope ceilings. The fallback
admission clamp above prevents a caller with fallback off from enabling it
through an explicit parent-hire override.

Other-target superior hires retain their existing funding rules. Rehire does
not gain a new root/self-insertion permission in this change. An ordinary
rehire after a hire/promote/retire cycle still reserves its seat and grant.

## Verification

`tools/rig/proofs/parent-hire.mjs` runs the real agent tool/domain path against
an isolated engine and PostgreSQL cluster. It checks root and non-root
insertion, repeated insertion, free/held accounting, sibling position, scope
ceilings and enforced group denial, account exclusions, composite staff and
audiences, rollback after late validation errors, concurrent spending,
generation/scope changes while a request waits on a row lock, and a
hire/promote/retire/rehire cycle. The single review fix round adds explicit
fallback on/off checks through hire and staff, and final kickoff-grant checks
for both aliases (35 checks in total). The focused Rust test
`domain::ops::parent_hire_tests::self_parent_fallback_respects_caller_and_explicit_opt_out`
covers omitted/true/false requests against explicit caller preferences and
org defaults. These added checks await rig-opus execution; the prior batch's
29-check proof passed. Existing `tree-credits` and `hire-scope`
proofs cover the neighboring operations. Test identities and simulated CLI
turns only; no live organization hierarchy or credits are changed.
