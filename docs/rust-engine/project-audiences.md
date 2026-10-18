# Project audiences

## Agent-visible sources and notices

Each agent's ORG STATE includes its own effective audiences, labelled explicit
or through a named project, independently of inspection/tool grants. The line
participates in semantic header deltas: unchanged routes are not repeated.
Existing mail/ask/present/tool-group gates retain their original behavior.

Revoke changes only the explicit row. Its passive notice names a remaining
project route or says that inherited access is gone. The typed event renderer
must preserve this information: for rescinded events, `other` carries the
remaining project name, an empty string means checked absence, and historical
null/missing values direct the agent to its current org state instead of
asserting access loss. No event schema change is needed.

Grant/revoke and membership/topology transactions compare active, org-scoped
effective grants before and after. Passive start/end mail is inserted in that
same transaction, deduplicated by agent/target/source. Mailbox notifications
publish only after commit; failed operations and serialization retries cannot
leave a false notice. Serializable snapshots plus bounded retries prevent
concurrent changes from being described as this operation's change.
Multi-step gestures and undo/redo compare only their transaction's initial and
final routes, so intermediate moves do not manufacture start/end mail. Direct
membership, project targets, explicit overlap and inactive/nested exclusions
continue to come from the existing effective view; no audience rows are copied.

Projects retain explicit grants in `ot.audiences`. Migration 0030 adds the read-only
`ot.effective_audiences` view: an active explicit grant, plus each live direct member
of its live project holder. The inherited branch reads the base grant table, never
the view, so a nested project cannot relay a parent's inherited authority. Moving or
retiring nodes changes the computed result without copying or deleting member grants.
Paused and revoked grants contribute no authority. Org-inbox grants remain agent-only.

User rulings of 2026-10-18 14:09–14:12 retain that inheritance. Migration 0032
extends the effective relation to the direct live agent members of a project
grantor. A grant from B to A lets A's direct members write to B's direct members;
the reverse requires a separate grant. Reciprocal project grants enable both
directions. Both expansions start from an explicit grant, never from this view,
so neither nested membership nor another project's grants relay authority.
No personal rows are copied. Target membership changes affect reach immediately.

Mail to the user, mail across agent branches, project mailbox writes, user questions,
personal presentations and runtime guidance use this effective relation. The separate
recursive own-project presentation exception remains intact. Tree/feed, chart and
state inspection expose effective grants, explicit grants, and inherited source projects.
Grant records remain explicit in the audience editor. The feed refreshes effective
facts after tree changes as well as grant changes.

Either named endpoint of `orgtree_audience` may be a live project. A project's nearest
real-agent superior handles requests and decisions, with the user as fallback. Direct
members cannot manage their project's grants. `request from=P target=T` requests for
a managed project while preserving the actual caller in audit events. Project notices
and answers route to the manager; they never create a project turn. Existing agent
delegation and top-level user-audience rules remain in force.

Both user project message endpoints call
`audiences::grant_user_audience_to_project(engine, org_id, project_id)` after a committed
delivery. It validates a live project in that org and uses the canonical short grant
transaction. Repeated grants create neither duplicate grants nor duplicate notices.
If delivery succeeds but the grant fails, the response explicitly reports that partial
outcome. Internal fair-queue system nudges do not invoke the contact hook.

Broadcast copies retain the real user sender and shared ancestor forwarding,
but set `grant_reply_audience=false`. Admission passes that flag into
`deep_reach_batch_tx`, disabling only personal contact grants, not forwarding.
This applies even before the project gets its post-delivery user audience and
to nested broadcast recipients that do not inherit it. Direct agent mail and
commands check the effective user audience before adding a personal grant:
existing inherited access must not become a permanent explicit grant. When the
project's audience is removed (or the agent moves out), a later direct contact
can grant normally. Existing personal grants are untouched.

The project menu offers Acquire/Drop audience immediately after Settings. Menus and
desk badges revoke only explicit grants: inherited access displays its source and has
no misleading personal revoke button. An independent explicit grant can be removed
while inherited access stays effective.

An inherited-only agent still offers **Acquire audience**, which invokes the
normal explicit-grant API. Its freshness query intentionally reads explicit
rows: a manual grant must work even when the agent inherits user access. This
is separate from the automatic contact guard above.

## Audience-check audit

The operational checks use `ot.effective_audiences`: user mail and cross-branch
agent mail and project mailbox writes (`domain/mail.rs`), audience
requests/delegation (`audiences::effective_holds`), ask (`asks.rs`), present and file delivery
(`docs.rs`), and runtime user-access guidance (`runtime/envelope.rs`). Tree/feed,
chart and state inspection share the effective projection. Renderer permission
indicators use `audiences_held`; `audiences_explicit` is reserved for Acquire/Drop
and explicit-grant badges. Tool groups and independent scope checks still apply.

Explicit-table reads remain intentional for grant creation/revocation, grant
editing/history/imports/renames, and the agent-only org-inbox audience. The
runtime actor's explicit audience query is for `@extern`, not user access.

Phase 1 validation is limited to the focused menu regressions, projection/tool-contract
units and a compile check. `tools/rig/proofs/project-audiences.mjs` retains the prepared
real-tool matrix for hardening; it is deliberately unrun under the user's 09:25Z ruling.
