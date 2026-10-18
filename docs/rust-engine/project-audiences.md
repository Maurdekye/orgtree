# Project audiences

Projects retain explicit grants in `ot.audiences`. Migration 0030 adds the read-only
`ot.effective_audiences` view: an active explicit grant, plus each live direct member
of its live project holder. The inherited branch reads the base grant table, never
the view, so a nested project cannot relay a parent's inherited authority. Moving or
retiring nodes changes the computed result without copying or deleting member grants.
Paused and revoked grants contribute no authority. Org-inbox grants remain agent-only.

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

The project menu offers Acquire/Drop audience immediately after Settings. Menus and
desk badges revoke only explicit grants: inherited access displays its source and has
no misleading personal revoke button. An independent explicit grant can be removed
while inherited access stays effective.

Phase 1 validation is limited to the focused menu regressions, projection/tool-contract
units and a compile check. `tools/rig/proofs/project-audiences.mjs` retains the prepared
real-tool matrix for hardening; it is deliberately unrun under the user's 09:25Z ruling.
