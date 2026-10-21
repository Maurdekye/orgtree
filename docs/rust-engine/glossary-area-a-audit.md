# 4.4.0 glossary audit: workflows, team/projects and watchdogs

Source baseline: `2ec8c0e7d15b8810a7d957add335ac69472541c8`, checked
2026-10-21. The audit screened the feature history from published 4.3.2
(`d6e8540`) through that baseline, checked the current handlers and schemas,
and reconciled the pages below. This records a source/documentation audit;
it is not a fresh runtime, network or desktop test round.

Area A owns `docs/skills/orgtree-workflows/**`,
`docs/skills/orgtree-working/team/**` and
`docs/skills/orgtree-working/watchdogs/**`. Screen navigation, mail/docket/user
tool pages and settings/provider pages are checked by their separate owners.
The final branch rebases onto `5174fe397d035b58006ae13550210426c85fbfc1`,
including the other areas' glossary updates and MQTT publishing. Its author's
publish instructions are retained. The final reconciliation removes the old
"no publishing" claim and updates the generic send-refusal wording, checked
against `runtime/watchdogs/mqtt.rs:19`, `:42` and
`runtime/watchdogs.rs:2769` at `5174fe3`. The queue, slot, listener and peer-mail
source files cited below are unchanged between the two baselines.

Source paths in the tables are under `engine/rs/orgtree-engine/src/` unless
written out. Line numbers identify this source baseline, not future edits.

## Corrections

| Drift or ambiguity | Correction and pages | Source |
| --- | --- | --- |
| Fixed three checkups, one job per listener, incomplete attempts/reminder gates, dead-letter recipient/access/history and purge descriptions | Queue, concurrency, projects and project-tool pages now distinguish configurable reminder and attempt budgets, per-job ACK batches, turn-end nudges, reclaim gates, user jobs and exact dead-letter behavior. Current repository notes supersede preserved historical wording. | [Detailed queue audit](../skills/orgtree-workflows/collaboration-patterns/work-queues/source-audit.md), with per-correction source lines |
| Watchdog capacity still described as eight per agent / 32 per org in the barrier recipe; waiting guide called retained IDs capacity | Watchdogs have no number quota. The eight-row preview and 100-row list-page maximum are read bounds; project-kind uniqueness still applies. `concurrency-primitives`, `waiting-for-events`, `tool-watchdog`. | `domain/watchdog_inventory.rs:7`, `:14`, `:28`, `:95`; `runtime/watchdogs.rs:2515` |
| Event-listener prose said no agent could switch the project setting off; restore behavior was too broad | An ancestor agent or user can configure OFF; a below-project member cannot. Registration can turn ON. Only registrations marked as disabled by that switch are restored; manually paused registrations stay paused. `projects`, `tool-watchdog`. | `domain/ops.rs:369`, `:2411`; `domain/listeners.rs:129`, `:165` |
| User registrations were described as ending only manually, with incomplete update limits | One-shot listeners/watches spend on fire. User listener mode, watch count 1–1024 and queue batch 1–20 update in place. Queue batch reduction/leave retains held jobs; agents cannot act as the user. `projects`, `concurrency-primitives`, `tool-watchdog`. | `domain/ops/user_regs.rs:201`, `:232`, `:274`, `:309`, `:347`; `domain/listeners.rs:58`, `:489` |
| Common reporting superior implied ordinary cross-project mail; project audience text omitted switch conditions | Different actual parents require a directional audience. Both projects must have peer mail ON for a project-to-project bridge; explicit agent/agent or agent/project grants retain their override. Reverse direction needs its own grant. `peer-mail`, `projects`, `tool-project`, `work-queues`, `committee-mode`. | `domain/peer_mail.rs:27`, `:45`, `:65`; migration `engine/rs/orgtree-engine/migrations/0032_project_member_audiences.sql` |
| Self-retirement said archived descendants block it; project lifecycle/scope target distinctions were incomplete | Only live agent descendants block self-retirement. Retire/dissolve can archive descendant project containers; retool targets agents, with project policy handled by project configuration. `tool-retire`, `tool-dissolve`, `tool-retool`. | `domain/ops.rs:134`, `:1841`, `:1859`, `:1927`, `:3441` |
| Hire/retool group lists omitted Logo; scope table omitted compact/fast-defaults and implied self-interrupt needs runtime | All eight tool groups are named; always-available self inspection/control is separated from runtime authority over another agent. `tool-hire`, `tool-retool`, `scope-and-permissions`. | `domain/tool_groups.rs:5`, `:53`, `:60`, `:87` |
| Watchdog-only project status was described as own-only | Watchdog-only callers can read full slot coordination with others' lease IDs hidden, release their own lease and use event/dead-letter actions. Administration/force remains team-gated. `scope-and-permissions`. | `domain/tool_groups.rs:87`; `tools/defs.rs` restricted project schema; `domain/ops.rs:2504` |
| Dev-team workflow still prescribed one filesystem build lock | Current project Summary determines concurrency and resources; use slot permits and immediate lease release. Templates themselves install no machine build policy. `dev-team`. | User/coordinator build-slot ruling 2026-10-18, capacity revision 2026-10-19; [current build recipe](../skills/orgtree-workflows/collaboration-patterns/build-slots/SKILL.md) |

## Feature coverage, including already-correct pages

| 4.4.0 feature group | Glossary coverage checked | Current source anchors |
| --- | --- | --- |
| Project creation, hierarchy transparency, ancestor policy authority, restoration, placement and container-only operations | `projects`, `tool-project`, `credits`, `tool-rehire`, `tool-move`, `tool-self-subjugate`, `team-shape` | `domain/ops.rs:178`, `:369`, `:1453`, `:1552`, `:1597`, `:2031`; `domain/scope.rs` |
| Complete project settings/actions, atomic partial patches and stale startup schemas | `tool-project`, `projects`, `scope-and-permissions`, `build-slots` | `domain/ops.rs:2275`, `:2292`, `:2323`, `:2350`; `tools/defs.rs` project schema; `tools/mod.rs:178` |
| Multi-unit whole leases, several leases per holder, one pending agent claim, counted user pending claims and atomic remaining-room checks | `concurrency-primitives` mutex/semaphore and read/write-lock sections; `projects`, `tool-project`, `tool-watchdog` | `domain/slots.rs:43`, `:49`, `:95`, `:124`; `domain/ops.rs:2387`, `:2458`; `domain/ops/user_regs.rs` slot operations; migration `0049_slot_capacity_digits.sql` |
| Strict FIFO, whole release, idle reclaim, restart recovery and paged ended history | Same slot pages; `build-slots` | `domain/slots.rs:225`, `:257`, `:319`, `:386`, `:448`; `domain/ops.rs:2458` |
| Required read/write-lock use case | Own pattern-table row and exact reader/writer calls, full-capacity writer, no partial release or safe upgrade; FIFO and user-hold limits | `domain/slots.rs:49`, `:124`; `domain/ops.rs:2458`; source measurement described in `slot-capacity-measurement.md` |
| User-claimed slots, user queue membership and user event/listener-watch registration | Explicit sections in `projects`, `concurrency-primitives`, `tool-watchdog`, with identity, counted capacity/readiness, inbox delivery, protection, updates and persistence | `domain/ops/user_regs.rs:117`, `:201`, `:232`, `:309`; `domain/projects.rs:934`; `domain/listeners.rs:304`, `:489` |
| ACK/round-robin, exclude sender, batch fairness, one-shot batches, turn-end/checkup reminders, take-back and dead letters | `work-queues`, `concurrency-primitives`, `projects`, `tool-project`, `tool-watchdog` | [Detailed queue audit](../skills/orgtree-workflows/collaboration-patterns/work-queues/source-audit.md) |
| Events, listener watches, barriers and fire-message mentions/history | `projects`, `tool-project`, `tool-watchdog`, `concurrency-primitives` | `domain/listeners.rs:74`, `:129`, `:293`, `:304`, `:323`, `:444`, `:489`, `:665`, `:721` |
| Fire actions: current authority, four calls, 30 seconds each, depth four, safe-start exclusion and credential-file-only arguments | `tool-watchdog`, barrier recipe | `runtime/watchdogs.rs:43`, `:1429`, `:1520`, `:1567` |
| Uncapped watchdog inventory, bounded previews/pages, own-ID priority and restart admission/retry | `tool-watchdog`, `waiting-for-events`, `concurrency-primitives` | `domain/watchdog_inventory.rs:7`, `:14`, `:95`; `runtime/watchdogs.rs:283`, `:310`, `:2515` |
| Persistent polling/silence recurrence and one overdue catch-up | `tool-watchdog` restart/resume schedules | `runtime/watchdogs/schedule.rs:6`, `:13`, `:20`; `runtime/watchdogs.rs:527` |
| Cached usage edges, filters, initial baseline and partial/unknown recovery | `tool-watchdog` usage contract | `runtime/watchdogs/usage.rs:6`, `:9`, `:53`; `runtime/watchdogs/usage_eval.rs` |
| Engine events, safe visibility-filtered payloads, count crossings, bounded delivery and loop suppression | `tool-watchdog` event catalog/count/delivery sections | `runtime/watchdogs/events.rs:103`, `:110`, `:138`, `:235`, `:368`, `:415` |
| MQTT subscription, credentials/TLS, retained/payload filtering, retries and untrusted bounded payloads | `tool-watchdog` MQTT section, plus the inherited publish contract at final base `5174fe3`; obsolete no-publish wording removed | `runtime/watchdogs/mqtt.rs`; `mqtt/mod.rs:38`, `:68`, `:205`; `mqtt/creds.rs`, `mqtt/render.rs`, `mqtt/topic.rs`; final publish anchors above |
| WebSocket connections, credentials/hellos/protocol/heartbeat, send, retries and opt-in connect events | `tool-watchdog` WebSocket section/parameters | `runtime/watchdogs/websocket.rs:19`, `:39`, `:86`, `:653`; `ws/mod.rs:40`, `:42`, `:47`; `mqtt/backoff.rs` |
| Explicit hire scope, composite task/audience/kickoff admission and first-task behavior | `tool-hire`, `tool-rehire`, `hiring`, `delegating` | `domain/hire_requirements.rs:4`, `:9`, `:43`; `domain/ops.rs:719`, `:846`, `:1193`, `:1651` |
| Fast mode and per-tier hiring defaults, top-level write authority and saved-seat behavior | `tool-fast-defaults`, `tool-hire`, `tool-rehire`, `tool-retool`, model tool pages | `domain/ops/fast_defaults.rs:5`, `:11`; `providers/fast_mode.rs:12`, `:23`, `:31`, `:44` |
| Logo tool, separate default-on group, local image limits, atomic authority recheck and undo | `tool-org-logo`, `scope-and-permissions`, hire/retool group lists | `tools/logo.rs:22`, `:42`, `:64`; `domain/tool_groups.rs:5`, `:56`; `profile_pictures/image.rs`, `domain/undo.rs` |
| Independent committee hosting, manager alternative, development roles, phases and source template defaults | `committee-mode`, `dev-team`, `iterative-development`, collaboration index | `engine/docs/templates/devteam-*.json`, `engine/docs/charters/*.md`; recorded user workflow decisions cited in those pages |

## Validation and boundaries

Run `node docs/agents/check-coverage.mjs --self-test` and `git diff --check`.
Check local Markdown targets in the changed pages and source targets named by
this receipt. Preserved attributed records remain unchanged; current dated
guidance explicitly supersedes their stale descriptions.

The audit does not alter queue policy, tool authority, model catalogs or
runtime behavior. Cross-area corrections were handed to their owners rather
than committed over their files. The parent audit combines all four areas;
this receipt alone does not claim coverage of the other three areas.
