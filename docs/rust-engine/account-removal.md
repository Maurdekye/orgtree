# Secondary account removal (2026-10-07)

P37 found that the Rust route refused live bindings, then removed the account
without migrating archived bindings, queued changes or hiring defaults. The
reference is the preserved 3.x `account_removal.py`, including its busy-turn
boundary and all-or-nothing migration.

`domain::account_removal::remove` now moves stored references to the provider's
primary before deleting the account, credentials and limit marks. It protects
ambient/native primary accounts and OpenRouter's fixed account. Live seats must
belong to the removed account's provider. Idle Codex and Antigravity seats use
4.0's existing same-agent fresh-session and handoff model; ended sessions stay
in session history. The approved removal of lineage nodes is unchanged.

A live seat needing a session boundary blocks the entire removal while either
its runtime is busy, its durable inflight marker is present, or an unfinished
turn exists. Busy Claude seats keep their current session and turn; only their
next binding changes. Archived, unrecoverable and deleted seats lose the removed
binding without running or resetting their archived session.

Both pending-account and pending-model intents retain their other fields and
acceptance order. An account intent gets the removed provider's qualified
primary selector. A model intent gets its target tier's primary selector, or
loses the account key for an OpenRouter target. Organization and app hiring
defaults are migrated too, including stored references in trashed organizations.
Auth/account/balance freezes are cleared on a live rebound seat; usage-limit
freezes remain held, as in 3.x's removal path.

The queued-change integration at `2eb8321` supplies the only intent consumer:
`ops::apply_pending`, reached through `Actor::apply_pending_config`. Removal
only retargets the existing account keys; `seq`, `by`, `actor_id`, `at` and other
intent fields remain intact for its ordering and fresh-authority checks. It does
not generate replacement intents or apply queued changes during removal.

All changes and audit rows commit in one transaction across organizations. Any
validation or write error rolls everything back. Affected agents and defaults
are read in pages of 128, with indexes on reference fields. The transaction
locks the removed account row exclusively. Reference-writing triggers acquire
a shared lock on that account, so an earlier binder commits before the removal
scan and a later stale choice waits for the deletion, then is refused. Deadlocks
or serialization conflicts retry the whole operation at most four times.

Removed account IDs are retained as non-secret metadata and skipped by the ID
allocator. This prevents a cached identity from selecting a new credential
with a reused ID. The guard rejects removed identities while preserving legacy
missing-account placeholders and import ordering; it adds no new policy to
unknown pre-existing import references. Normal turn admission locks the agent
through the shared queued-configuration guard before claiming mail. That guard
also compares session_id, so an idle session reset cannot admit stale context;
it keeps the existing pending-intent checks and reconfiguration/re-wake path.

Snapshot refresh, runtime reconfiguration, wakes and feed notifications happen
after commit without row locks. A notification failure is logged, not reported
as a rolled-back removal. No profile directory or credential file is deleted;
database API-key credentials disappear through the existing foreign-key cascade.

Measured validation: cargo check passes. A brief standalone Rust smoke compiles
the actual transaction and pure helpers, with the runtime registry mocked idle,
and executes them against a fresh disposable PostgreSQL cluster using the actual
schema and reference migration. It verifies bindings, queued target selection,
defaults, fresh-session handoff, retained limit freeze, auth thaw, mark/credential
deletion, rollback after visiting an earlier seat, busy Claude behavior, reference
guards, legacy missing imports and concurrent earlier/later binders. All data
was synthetic; the cluster was stopped and deleted. HTTP handling, actual CLI
reconfiguration and live provider behavior were not exercised.
