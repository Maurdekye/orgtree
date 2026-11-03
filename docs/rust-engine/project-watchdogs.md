# Project watchdogs

A watchdog **owned by a project**: when it fires, the fire becomes the project's event and
every armed `project_listener` on the project receives it (a broadcast, not a claim).
Docket `project-watchdogs-a-watchdog-owned-by-a-project-f`. USER 2026-11-03 10:33:10Z
mce2b36a98c88 ("watchdogs on projects. anytime the watchdog fires, it fires the project
event, and all listening agents receive it"), 10:33:19Z mafbe02361cad ("any agent above or
below the project can set up a watchdog on it instead of on themselves"), 10:33:56Z
m58f9d1d695c2 ("spec on opus, implement on sonnet"). Spec: @stream-plan-opus rev 1 + A1-A6
(scratch `project-watchdogs-spec.md`). Migration `0083_project_watchdogs.sql`.

## The decisions (numbers are the spec's)

- **D1/D2 owner.** `owner_kind = 'project'`, `owner_agent_id` = the project's `ot.agents` id.
  A DB trigger (`watchdog_owner_kind_agrees`) keeps the owner row's `kind` equal to
  `owner_kind`; the CHECK allows `agent`, `user`, `project`. Migration retires any
  pre-existing `agent` dog owned by a project row.
- **D3 creator.** `memo.created_by` = `{"kind":"agent","id","name","generation"}` or
  `{"kind":"user"}`. Informational: it names the *keeper*, grants nothing.
- **D4 authority.** The user and every agent that reaches the project (above or below, any
  depth: `projects::reaches`) may create, list, pause, resume, remove, `send` and
  `configure` its dogs. `resolve` says `only agents above or below project P manage its watchdogs`.
- **D5 hands.** A project dog runs with the project's effective scope (a project is
  transparent, so the nearest agent above it). At create the *caller* must also hold bash
  (command/stream), web (websocket/mqtt) or the folder (file); the project's line must hold it
  too (`project P's line does not hold bash/web/that folder, ...`). At run time only the
  project's hands are checked (`authority_lost`); the dog outlives its creator. Relative paths
  start in the project's folder. Prefer inline credentials: the folder is readable by members.
- **D6** `send`/`configure`: the D4 set; `send` needs the *caller's* web tool.
- **D7 kinds.** `file command process stream websocket mqtt` only
  (`a project watchdog can be ...; <kind> stays on an agent`).
- **D8 options.** `notice:true` and `fire_actions` are refused; `notice:false`/omitted is
  stored false (A2). Pattern, shell, interval, silence, once, hello, heartbeat, credentials,
  `connection_messages` as for agents.
- **D9/D10 fire.** `fire_with`/`fire_exited` call `listeners::fire_from_dog` instead of mailing:
  `fired_by` is the handle `P/uid`, `project_fires.source` records the dog, the body is capped at
  20,000 characters (cut at a newline, with a truncation line; a manual `fire_event` keeps its
  8,000). With no armed listener nothing is recorded or dispatched and the dog's ring gist ends
  `(no listeners armed)`. With the setting off the dog disables itself. `deliver()` refuses a
  project owner (error log, no mail).
- **D11** a listener's mail starts `watchdog @P/uid ("name", kind · target) fired the event on project @P`.
- **D12 keeper.** Administrative mail (went-quiet alerts, authority-lost pauses, connection
  mail, switch notices) goes passively to the creator if still a live agent reaching the
  project, else the project's nearest live superior; with neither, nothing is sent (A4).
- **D13 lifecycle.** Creator retire/move: no effect. Project retire pauses (`ARCHIVE_PAUSE`);
  restore re-arms (`restore_project` calls `resume_owned`); delete removes. Engine start arms
  armed dogs of live agents *or live projects* (never under SAFE_START).
- **D14 setting.** `switch_off` pauses the project's own armed dogs with `listeners_off`;
  `switch_on` re-arms them. Creating a dog does not switch the setting on; a create while off
  stores the dog paused with the explanation; resuming while off is refused.
- **D15 immediate.** A ready once-dog (setting on) fires inline to the listeners and reports
  `delivered` (0 with a note if nobody listens, A3); with the setting off it is registered paused.
- **D16 duplicates.** One armed/paused dog per (kind, target, pattern, shell, websocket hello,
  mqtt payload filter) per project, checked under the project row lock: one socket per project.
- **D17 listener `pattern`.** A `project_listener` may carry a regex matched against the
  event text (D11 line + message); a non-matching fire is invisible to that listener (no mail,
  no count, no one-shot spend). `listener_watch` counts it regardless.
- **D18** the `project.event` engine event gains `source` (`manual`/`watchdog`), `dog`,
  `dog_kind`; never the message text.
- **D19** templates skip project dogs with a warning. **D20** no new caps.

## Surfaces

`orgtree_watchdog` gains `project` (create/list). `orgtree_project action=listeners` adds
`sources` (the project's own dogs, 50 max) and listener `pattern`. Desktop: canvas satellites
(the existing layout already places them), project desk dog cards, **Event sources** section
on the Listeners tab, Recently Fired shows the source dog (`message_truncated` past 2,000
characters), the detail card reads `project @P` / `created by`.

## Gotchas

- A fire never mails a project; keep every new sink branching on `owner_kind`.
- Every `JOIN ot.agents a ON a.id = w.owner_agent_id` now sees project rows: filter
  `a.kind = 'agent'` where an agent is meant (listener/watch counts already do).
- The monitor `ev` JSON rides mail only; a project dog mails nobody, so listeners' fire mail
  carries its own (A5).

## Tests

`runtime/watchdogs/project_tests.rs` (T1-T13, T15-T20; synthetic PG `projdogs_fixture`, env
`ORGTREE_PROJDOGS_TEST_URL`/`ORGTREE_PROJDOGS_TEST_ROOT`, `--ignored --test-threads=1`), renderer
`tests/projectwatchdogs.test.tsx` (R1-R5). Not covered: T14 (send on a project websocket dog, needs
the websocket server fixture) and T21 (template export warning).
