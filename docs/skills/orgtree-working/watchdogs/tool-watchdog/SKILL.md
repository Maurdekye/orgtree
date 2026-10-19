---
name: orgtree-tool-watchdog
description: Create and manage persistent file, command, process, stream, activity and engine-event watchers.
---

Up: [orgtree-watchdogs](../SKILL.md)

# orgtree_watchdog

## Call contract

Create/list/pause/resume/remove persistent watchers; max 8/agent. Create requires kind/target (usage defaults target=usage); command requires regex. command/stream use YOUR authority and smoke-run at create: Windows defaults cmd.exe, or shell=bash. Read smoke output. once removes after a fire; always use it for deadlines. file matches new appends; process fires on observed UP->DOWN. fair_queue delivers project mail to one watcher; slot (one-shot) claims a project concurrency slot, firing when granted. project_listener receives a project's fired events; listener_watch fires at a count of armed listeners. fire_actions run orgtree tool calls as you at fire time. usage watches cached account/window edges with accounts/windows/usage_events filters and threshold_percent; unknown is never zero, and staying above never repeats. Event/count/silence semantics and catalog are in the guide. No added authority.

Use a watchdog to be told when an observable condition happens, instead of spending turns polling it. The watcher persists across engine restarts and costs no hiring credits. By default a fire mails and wakes its owner; `notice: true` makes that mail passive. A watchdog does not grant new filesystem or shell authority.

## Actions and parameters

`kind: "usage"` watches cached allowance edges without provider requests.
For example: `{"action":"create","kind":"usage","accounts":["claude-5"],"windows":["weekly"],"usage_events":["above"],"threshold_percent":98,"once":true}`.
Its target defaults to `usage`; account/window/event filters omitted mean any.
Explicit lists contain 1–32 exact strings. Windows match kind, group or display
label; account IDs are exact and subject to the org's current usage visibility.
Events are `above`, `below`, `reset`, `limit`, `stale`, `unreadable`, `recovered`,
`account_added`, `account_removed`, `refused`, `frozen`. Above means <N to >=N;
below reverses it. Above/below need `threshold_percent` (0–100). Staying above
does not repeat; falling below or a reset re-arms. Initial cache seeds without
firing. Unknown/stale is never zero or a crossing. Reset clocks report unknown
new usage. Current reset/freshness/account changes are detected within 15s.
OpenRouter spend caps use reported percent; uncapped balance has no percent.
Mail names account/window, old/new percent, threshold, reset and observation
times. Once/notice/pause/resume/remove work normally; resume seeds current
cache. `interval_s` is the minimum gap (floor 5s), not provider polling.
Usage dogs have no regex or silence mode. Desktop list/detail shows the dog;
creation stays tool-only. Event dogs may instead match safe `usage.reading`,
`usage.refused` or `usage.frozen` source events, without per-dog threshold logic.

The effective tool permission is `tools.orgtree.watchdogs`. The owner is the caller; there is no create-on-behalf-of parameter. Top-level callers follow the same owner and visibility rules as other agents.

| Parameter | Applies to | Default / meaning |
|---|---|---|
| `action` | All calls; required | `create`, `list`, `pause`, `resume`, or `remove`. |
| `kind` | Create; required | `file`, `command`, `process`, `stream`, `activity`, `event`, `usage`, `fair_queue`, `slot`, `project_listener` or `listener_watch`. |
| `count` | Create, `listener_watch` (required there) | Armed project listeners that fire it, 1–1024. Refused for every other kind. |
| `fire_actions` | Create, any kind except `fair_queue` | Up to 4 `{tool, args}` orgtree_* tool calls run as you when the dog fires; results ride the fire mail. See Fire-time tool calls. |
| `target` | Create; required | Path, command, `pid:N`/`port:N`, activity agent name, event name/prefix, or a project's name for `fair_queue`, `slot`, `project_listener` and `listener_watch`. |
| `name` | Create | Optional short name; its normalized slug becomes the owner-local ID. |
| `pattern` | Create | Regex. Required for `command`; optional otherwise. Process down edges do not use it. |
| `interval_s` | Create | Default 60 seconds; poll cadence for file/command/process, minimum fire gap for stream/activity/event. Floor 15 seconds for pollers, 5 seconds for pushed/streamed kinds; capped at 2,147,483,647 seconds. |
| `fire_mode` | Create | `event` by default; `silence` to fire after no matching event for a quiet period. |
| `quiet_period_s` | Create, silence only | Required positive integer seconds, capped at 2,147,483,647; refused with event mode. |
| `once` | Create | Default `false`; an ordinary match/silence fire spends the dog and removes it from `list`. See stream-exit exception below. |
| `notice` | Create | Default `false`; `true` sends mail without starting a turn. |
| `shell` | Create, command/stream only | `native` by default, or `bash`; other kinds do not execute a shell. |
| `threshold` | Create, event counts only | `below N` or `at least N`, nonnegative integer N; crossing behavior below. |
| `event_scope` | Create, event counts only | `subtree` by default, or `org` with full visibility. |
| `id` | Pause/resume/remove; required | Returned ID, or `owner/id` for a descendant's dog. |
| `reason` | Remove | Optional explanation recorded with removal. |

Supply parameters for the chosen action; this tool has no edit action. To change a target, regex, mode or delivery choice, remove and recreate the watcher. There are no custom owner, recipient, cwd or environment arguments.

Names become lowercase letters/digits/hyphens, with a 24-character base. Without a name, the base comes from kind and target. A clash gets the first free `-2`, `-3`, … suffix. Use the returned ID rather than guessing it. There can be at most **8 kept dogs per agent and 32 per org**; armed, paused and exited dogs count, spent/removed dogs do not. They consume no agent seat.

## Restart and resume schedules

Polling and silence deadlines survive engine restarts. A future slot stays put;
an overdue slot runs/fires at most once immediately, then the first original
recurrence slot in the future is used. For a six-hour dog last run at h0,
shutdown at h5 and restart at h7 produce one catch-up at h7 and next at h12.
Creation still performs smoke and an immediate initial poll. Explicit resume
begins a new recurrence and resets the quiet reference; ordinary restart does
neither. There is no interval edit: remove/recreate to use a new interval.

An overdue polling-silence watcher checks the target first. A match now resets
the quiet clock and suppresses the overdue alarm; otherwise one quiet fire
advances its original recurrence. A process watcher still needs an observed
UP-to-DOWN edge. Pushed stream/activity/event behavior is otherwise unchanged.
`list` includes actual `last_check`/`last_fired` evidence and fixed
`next_check_at`/`next_silence_at` where applicable. The UI countdown uses those
persisted deadlines and stays checking when overdue until the engine updates it.

## Choose a kind

### file

`target` is a file path; relative paths start at the owner's scratch folder. The resolved path must lie inside the owner's scratch, org workspace, org shared/team workspaces, or a folder it effectively holds. Existing symlinks are resolved for containment.

Creation records the current file end. Only subsequently appended nonempty matching lines fire; old content is not replayed at create. An absent file is allowed and watched when it appears, so check the path for typos. Saved offsets can recover appended content during engine downtime. Truncation to a smaller file restarts at the beginning; do not rely on same-size file replacement being detected as new content.

Reads use windows up to 1 MiB and normally wait for a complete CR/LF-terminated line; a full-window line is processed without waiting indefinitely. Output is decoded leniently as UTF-8; this is not a UTF-16 log decoder.

### command

Runs `target` once per poll and matches its stdout/stderr lines. `pattern` is required: merely printing something is not an event. A condition that remains printed can fire repeatedly, so use `once: true` for a deadline or completion condition.

The recurring command must exit. After 60 seconds it is stopped, and that timeout itself contributes an event even without a regex match. Creation also executes it once for smoke, so choose a read-only probe or another command explicitly safe to repeat. An ordinary nonzero exit alone is not a match; inspect the output and pattern.

### process

`target` is `pid:N` or `port:N`; ports are probed on `127.0.0.1`. Fires only on an **observed UP → definitively DOWN** edge. A target already down at creation does not fire until it has been seen up and then down. An access-denied/indeterminate PID probe or a connection timeout is unknown, not evidence of death, and does not overwrite the baseline. The process branch does not apply `pattern` to the down edge.

Use `once: true` for a particular PID finishing. A repeating port watch can observe later up/down cycles.

### stream

Runs one long-lived command and listens to stdout/stderr. Nonempty matching lines are collected with the configured minimum fire gap. Use a file watcher when recoverable appended log content is the actual target: a stream loses output that happened while its listener was offline.

An event-mode stream that exits records its code/time, moves to `exited`, and sends a terminal-exit diagnostic. It is not restarted automatically; resume starts it again. **That terminal diagnostic does not spend `once`** and can leave a one-shot dog in `exited`; remove it when finished. An ordinary matching-line fire does spend a one-shot.

In silence mode, an exited stream remains armed and its silence clock can keep firing. Inspect `exit` and resume to restart the listener; silence mail is not proof that the command still runs.

### activity

`target` is your own name or a live descendant, optionally prefixed `@`. Events are `turn_started`, `turn_done`, and `tool_call NAME`, with no arguments or result text. An optional regex selects those lines. This watches pushed activity, not a command.

The self/descendant relationship is rechecked before a fire. If the subject is no longer permitted/live, the dog can pause with a diagnostic. To watch a visible peer's permitted engine transitions, consider the event kind instead; activity authority remains self/downward only.

### fair_queue

`target` is a project node above or below you. Its mail waits in the project's mailbox until at least one agent watches it this way. Each waiting mail then goes to exactly one watcher: the least recently woken (one never woken first; ties go to the oldest watcher). It arrives as ordinary mail from its original sender, marked as coming via the project, and the project's copy is marked read. Busy, halted and frozen watchers keep their turn, so the mail waits in their mailbox. The first watcher to arm gets any backlog. A `pattern`, silence mode and `shell` are refused. A `once` dog takes one mail and is then spent. In a project set to **ack mode** you hold one handed mail at a time: ack it with `orgtree_message to=<project> reply_to=<that mail's id>` and a short completion record, and the next waiting mail comes at once; pausing or removing the dog gives an un-acked mail back to the queue. You may have only ONE fair_queue dog per project: a second `create` on a project you already watch is refused, naming your existing dog (a duplicate would not give you more of its mail, and in ack mode you hold one un-acked job per agent anyway). If your turn ends still holding an un-acked job, the project reminds you once at once (project setting "Remind an agent that ends its turn with an un-acked job", on by default). The handed mail's wrapper says whether it needs an ack. See [orgtree-projects](../../team/projects/SKILL.md).

### slot

`target` is a project above or below you with a slot count (Project settings). The dog is your **claim** on one of its concurrency slots and is always one-shot. A grant is an agreement with the other claimants, not a permission the engine enforces: nothing else stops or limits your work (see orgtree-projects › Concurrency slots). If a concurrency slot is free it is granted at once: the create result says `claimed a concurrency slot of project P (lease L)` and the dog fires immediately with the grant. Otherwise the armed dog is your place in a strictly first-come line (`2nd in line behind sc`) and fires when you are granted a concurrency slot, waking you with `You now hold a concurrency slot of project P (lease L)`. Removing it leaves the line; pausing it leaves the line too, and resuming rejoins at the **back**. One claim or held concurrency slot per agent per project; a project with no concurrency slots, or one you do not reach, is refused. A `pattern`, silence mode and `shell` are refused.

Release the concurrency slot as soon as the work that needs it ends: `orgtree_project action=release_slot lease=L` ([orgtree-tool-project](../../team/tool-project/SKILL.md)). A holder that is retired or halted loses the concurrency slot at once. An idle holder gets the 20-minute working checkup, naming the concurrency slot and how to release it, up to 3 times; at the next one the concurrency slot is taken back (only while that checkup and the project's ack timeout are on). Either way the holder is told why, and the next in line is granted the concurrency slot.

### project_listener

`target` is a live project above or below you. The dog listens for the project's manual event: each time someone above or below the project (or the user) fires it with `orgtree_project action=fire_event name=P` (optional `body`), every armed listener that still reaches the project receives the event and its message as ordinary watchdog mail, in the same instant; a one-shot is spent by it. This is the project's **sync wake**: participants arm one-shot listeners and end their turns; the fire releases them together. `list` shows fire count and last fire. A `pattern`, silence mode and `shell` are refused. One event listener per agent per project (a second is refused, naming the first). **Removed 4.4.0:** there is no separate "round" or barrier primitive; the listener plus the watch below is the mechanism.

### listener_watch

`target` is a live project above or below you; `count` (required, 1–1024) is how many armed `project_listener` dogs fire it. Paused listeners do not count; your own listener does. The watch evaluates whenever it is armed and whenever a listener on its project arms, resumes, pauses, is removed or is spent: reaching the count fires it — including at create, when the count is already reached (like a slot granted at once, so arming the watch after everyone has arrived works). Staying at or above the count does not fire again; a continuous watch fires again only after the count drops below and crosses again. Resuming re-evaluates from a cleared edge. One listener watch per agent per project. `list` shows its `count` and the project's current armed `listeners`. Paired with a `fire_actions` entry that fires the project's event, a superior is both told the group is ready and releases it in the same instant:

```json
{"action":"create","name":"all-in","kind":"listener_watch","target":"sync","count":3,"once":true,
 "fire_actions":[{"tool":"orgtree_project","args":{"action":"fire_event","name":"sync","body":"go"}}]}
```

## Fire-time tool calls

Any watchdog except `fair_queue` (whose fire is the mail it hands you) may carry `fire_actions`: up to 4 `{tool, args}` calls naming served `orgtree_*` tools, with `args` a JSON object (bounded at create; unknown tools are refused). When the dog fires, after the fire is recorded, the calls run **as the dog's owner, with the authority the owner holds at fire time** — tool-group switches and every handler check are re-read then, never captured at create. They run in order, 30 seconds each, and their results (truncated) are appended to the one fire mail; a failed or refused call reports FAILED there and does not stop the rest. Chains are bounded: a fired call that fires another dog whose calls fire another stops at depth 4, and the skipped calls are named in that mail. Fire actions never run in the engine's safe-start rehearsal. A stream's terminal-exit diagnostic is not a fire and runs none. `list` and the desktop detail show the calls a dog carries.

### event

`target` is an exact dotted event name or a dotted prefix ending `.*`, such as `turn.*`. The optional regex sees the safe JSON payload after access filtering; it does not match transcript text. Names are checked for syntax, not for membership in the catalog, so a well-formed typo can sit armed without firing.

Events are pushed. Creation smoke reports current exact conditions where available, but an already true condition does not fire just because the dog was created. There is no historical replay of events while the engine was offline. Recovered subscriptions are in place before `engine.started` is emitted.

## Engine-event catalog

| Targets | What they observe |
|---|---|
| `credentials.bridge.available`, `credentials.bridge.unavailable` | Credential broker readiness, distinct from general credential availability. |
| `credentials.isolated`, `credentials.ready` | General boot credential warning raised/cleared. |
| `engine.started` | Engine startup after persisted event dogs subscribe. |
| `agent.hired`, `agent.rehired`, `agent.retired`, `agent.halted`, `agent.unhalted`, `agent.frozen`, `agent.unfrozen`, `agent.moved`, `agent.renamed` | Agent lifecycle transitions. |
| `session.signed_in`, `session.signed_out` | The user signed in or out of Windows (a sign-in helper connected, or the last one stopped); machine-wide. Keep a one-shot dog on `session.signed_in` to wake when the desktop becomes available. |
| `agent.changed`, `agent.settings.changed`, `org.settings.changed` | Change notifications; settings payloads expose identities/field names rather than saved values or a full audit diff. |
| `turn.started`, `turn.finished`, `turn.failed`, `turn.stalled`, `turn.limited` | Runtime transitions/outcomes, not model text or raw error bodies. |
| `mail.waiting`, `mail.delivered`, `mail.changed` | Mail insertion, delivery settlement or mailbox change, without message bodies. |
| `docket.created`, `docket.status.changed`, `docket.attention`, `docket.question.answered` | Item or answered-question notifications, without question/answer text. |
| `account.signed_in`, `account.signed_out`, `account.limit.reached`, `account.limit.reset` | Published account authentication/limit changes, without credentials. |
| `hub.up`, `hub.down`, `hub.changed` | Org hub connection or network change. |
| `credits.changed` | Visible agent grant/free-credit changes. |
| `project.dead_letter` | An ack-queue job ran out of attempts and became a dead letter (see [orgtree-tool-project](../../team/tool-project/SKILL.md)); only agents above or below the project see it. Payload: project, mail id, sender, attempts, last holder, reason. `pattern=<project>` narrows it to one project. |
| `project.event` | A project's event was fired to its listeners (`orgtree_project action=fire_event`); only agents above or below the project see it. Payload: project, project_id, by, delivered count, has_message — never the message text. `pattern=<project>` narrows it to one project. |
| `documents.created`, `documents.updated`, `documents.changed` | Presentation create/update/feed change, without document body. |
| `audience.requested`, `audience.granted`, `audience.denied`, `audience.revoked` | Committed audience changes. |
| `cli.started`, `cli.ready`, `cli.cold`, `cli.evicted` | Another visible agent's process/warmth transitions. |
| `agents.active`, `agents.live` | Visible active-turn/live-agent membership count changes. |

Machine startup/credential events are available to watchers across orgs. Agent-subject events respect same-org effective visibility; org-wide settings/hub events are hidden from self-only watchers. Item-scoped docket events require docket read access. The answered-question notification is agent-scoped and follows agent visibility. Restricted account events remain in their origin org. Authorization is rechecked before delayed delivery; hidden events are not exposed in payloads or summary counts.

Watchdog-generated alert mail is excluded from the event adapters. A turn carrying watchdog mail suppresses its own owner's event dogs through settlement; other owners still observe it. Your own `cli.*` events are always excluded to prevent a cold/eviction → wake loop. Two agents watching one another can still cause mutual wakes; use one-shot or passive notices when that fits the task.

### Count thresholds

Only exact `agents.active` and `agents.live` targets accept `threshold` and `event_scope`. `active` counts agents in turns; `live` counts live agent records. The watcher itself is excluded.

- `event_scope: "subtree"` counts visible strict descendants and is the default.
- `event_scope: "org"` counts the visible org membership and requires full org visibility; it never counts another org.
- `threshold: "below 1"` fires when a previous count of at least one becomes zero.
- `threshold: "at least 10"` fires when a previous count below ten reaches ten or more.

Staying across the threshold does not refire. Leaving and crossing again can, unless `once` already spent the dog. Without a threshold, a count change is a match. Silence mode cannot be combined with a count threshold. Resume/recovery refresh the current count baseline; they do not invent crossings from paused/offline changes.

Event `interval_s` is a minimum fire gap, not a polling interval. Bursts coalesce into bounded summaries: a 256-event queue with a latest overflow sample and at most 40 distinct event-name/subject summaries per pending delivery. This is monitoring, not a lossless event archive. Storage failures retry with visible health rather than pretending a condition is false.

## Event mode, silence mode and delivery

`fire_mode: "event"` fires on matching events. `fire_mode: "silence"` requires `quiet_period_s` and fires after that many seconds without a matching event. Every match and every silence fire resets the silence clock; without `once`, another full quiet period can fire again. No pattern means eligible lines/events match, except that command requires one and process uses its down-edge logic.

Silence means absence of **matching events**, not general liveness. An active command or file producing only nonmatching text does not reset that timer. `notice: true` changes only delivery: the mail waits until the next turn and does not itself wake you. `once: true` should be used whenever the condition is a one-time deadline rather than a recurring edge. Ordinary spent one-shots disappear from `list` and cannot be resumed.

Regex compilation errors are refused. The engine supports lookarounds/backreferences; a runtime regex failure matches nothing, not everything. A regex-compatible spelling does not establish that your chosen target actually emits the expected line.

## Shell and create smoke

Command/stream dogs require your effective **Bash tool grant**, including ancestor restrictions, even when the native command shell is Windows cmd.exe. They run with the engine's environment/PATH and the owner's existing scratch directory as cwd, not inside your current tool session.

On Windows `shell: "native"` means `cmd.exe`; use `findstr`, `dir /b`, `%VAR%`, and `%TEMP%`. Bash syntax such as `$(...)`, `$VAR`, `/tmp`, `grep` or `sed` is not portable to it, and `find` is Windows FIND.EXE. `shell: "bash"` explicitly selects `bash -lc`, refused if Bash is unavailable; the current Windows resolver prefers Git Bash and excludes System32 (see [machine traps](../../workspace/machine-traps/SKILL.md)). Do not rely on interactive aliases or your current shell's environment. Native Unix commands use `sh -c`.

Creation returns `smoke`: **read it**. Command/stream smoke runs the target for up to 8 seconds and reports shell, output, exit status, matching and broken-target hints. A stream exiting immediately is suspicious; a command never exiting is suspicious. File smoke reports existence/current length, process smoke its current state, activity smoke its event-line format, and event smoke its current condition where available.

An armed result can still contain `smoke.broken: true`; arming is not proof of a working monitor. Fix and recreate a bad target before relying on it. Do not use repeated `list` calls as a substitute for a correctly working wake.

## Management, recovery and health

Slot, fair-queue, event, project-listener and listener-watch dogs are push-driven: zero polling checks does not trigger a "never run a check" warning. Queued slot claims show `line_position` and a readable `line` such as `in line: 2nd`, resolved from the project's current first-come queue. A granted claim identifies its lease. Real runner and storage errors still appear in health diagnostics.

`list` returns your kept dogs and your descendants' dogs. Owner-local IDs can collide; use `owner/id` for a team member's dog. Owners and their superiors can pause/resume/remove; a peer cannot manage a dog merely because the peer is visible. Ambiguous bare IDs are refused with the qualified choices.

Pause stops its runner. Resume requires a live owner, clears its exit record, resets a silence clock and rearms the runner. Remove stops it and releases its kept slot/ID. There is no resuming a spent one-shot: create a new one. An archive pauses owned armed dogs; rehire rearms those paused specifically by that archive, not manually paused ones. Armed dogs with live owners recover at engine startup. Lost file/shell/activity authority can pause a runner.

Inspect `state`, `checks_run`, `last_check`, `last_output`, `last_exit`, `fired`, `last_fired`, `exit`, `paused_why`, and `health` to distinguish quiet from broken. Stream/activity counts are observed output/activity lines, not shell poll counts. Output tails are bounded, typically 400 bytes.

Health alerts are distinct from matching fires: three consecutive broken command checks pause it; a PID already fired/down for 20 checks can pause as spent work; a file with no growth for at least 60 checks over at least an hour warns but remains armed. Staleness is not proof the writer died. Runner/storage errors retry with backoff and health diagnostics. If a create/management call times out, inspect the existing ID/state before duplicating it.

Common refusals include invalid/missing action/kind/target, `a command watchdog needs a pattern`, `fire_mode silence requires quiet_period_s`, `quiet_period_s applies only to fire_mode silence`, unavailable Bash, paths outside held folders, an activity target outside self/descendants, invalid threshold/scope combinations, the kept-dog caps, missing/ambiguous ID, and management outside the owner's superior chain.

## Examples

One completion line appended to a log:

```json
{"action":"create","name":"build-finished","kind":"file","target":"build.log","pattern":"^BUILD COMPLETE$","once":true}
```

Wake when visible descendants transition to having no active turns:

```json
{"action":"create","name":"team-idle","kind":"event","target":"agents.active","threshold":"below 1","event_scope":"subtree","once":true}
```

One quiet-period alert from a descendant's activity:

```json
{"action":"create","name":"worker-quiet","kind":"activity","target":"worker","fire_mode":"silence","quiet_period_s":600,"once":true}
```

Read and remove a kept dog:

```json
{"action":"list"}
```

```json
{"action":"remove","id":"worker/review-log","reason":"The review result is recorded."}
```

## See also

- [orgtree-machine-traps](../../workspace/machine-traps/SKILL.md)

- [orgtree-waiting-for-events](../waiting-for-events/SKILL.md)

For suggested team patterns, see `orgtree-committee-mode` and `orgtree-dev-team` (orgtree-workflows › collaboration-patterns).
