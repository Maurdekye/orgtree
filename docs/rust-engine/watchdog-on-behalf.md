# Watchdogs created on behalf of a descendant

Docket `create-a-watchdog-on-behalf-of-a-descendant-owne`; USER 2026-11-04 m2354c41b2887 ("yes, do the second one"), md3c4826e4a7d,
ma00be303ac44, m0340d4a190dd, m10c3e0bc4586, m643efc7b83b3 (reach), m2e772fbd1c5d ("Allow, limited to both", fire_actions).
The spec is @stream-plan-opus's rev 1.3 (W1-W12); decisions here are its numbers.

- **Create (W1-W5, W7-W8, W10):** `orgtree_watchdog create owner=X` -> `runtime::watchdogs::create_for` (live agent strictly below the
  setter, holds the watchdog tool group) -> `create_mode(..., Some(Delegate))`. The row is the owner's (`owner_agent_id`), `memo.created_by`
  is the setter, per-owner limits and ids use the owner. The setter must also hold bash/web/the folder (W3; an ancestor's scope clamps
  its descendants, so the owner check usually fires first). `app_listener` is refused; ready-once slot/fair_queue/usage dogs and dogs with
  fire_actions register instead of resolving inline. The owner gets one passive notice after commit.
- **Reach (W6):** `watch_reach` (tree, effective audience, then the setter's reach or audience) replaces `require_reach` at the fair_queue,
  slot and listener create sites. A reach that is not the owner's tree reach is stored as `memo.reach_grant = {project (id), via, from}`.
  `projects::dog_reaches` / `granted` / `granted_dog` are the one runtime predicate, used by: `projects::dispatch` eligibility, `watched`,
  `queue_state`, `release_stale`, `stale_claim_reason`; `listeners` fire delivery, listener_watch evaluation and the outbox; `slots` grant
  and lease holds; `holdings` lost-reach sweeps; `resume_slot` / `resume_listener`; and `mail::send_project` (a worker's ack of a job it
  holds through a granted dog). Every other `reaches()` caller is unchanged, so the grant lives inside its dog.
- **fire_actions (W5 rev 1.2):** `setter_of` finds `memo.created_by` at fire time; `setter_gate` (live, strict ancestor) and `setter_allows`
  (tool groups via `tool_groups::allows_call`, then an allow-list by target reach) run before each call in `run_fire_actions_inner`.
- **Management (W9):** unchanged; any ancestor of the owner manages (MG1-MG3 pin it).
- **Configure edits (rev 1.4/1.5 section 5):** `runtime/watchdogs/edit.rs` (`plan` validates everything and writes nothing, `apply` merges into
  `configure`'s one transaction). It reuses create's validators (`interval_floor`, `silence_pair`, `batch_value`, `slots_value`, `count_value`,
  `fire_actions_arg`/`fire_actions_listed`, `websocket::validate`/`mqtt::validate` with an optional stored-credentials argument, `smoke`,
  `watch_reach`). A smoke that reports the target broken refuses the edit. `memo.actions_by` (an editor's object, or "owner") picks whose
  authority `setter_of` intersects at fire time. Not editable yet: an app_listener's subscription (event_name, panel, all_panels). An mqtt/
  websocket tier A pattern edit applies at the dog's next connection (the live connection's compiled pattern is not swapped).
- **fire_actions and `recover`:** fire actions run only in a normal or recovering engine (a safe-start rehearsal skips them); an ordinary create
  need not return `registered:true`.
- **Tests:** `runtime/watchdogs/onbehalf_tests.rs` (WD, RB, RA, FA, MG; synthetic PG `projdogs_fixture`, like project_tests.rs), T1 in
  `tools/defs.rs`, renderer R7.
