---
name: orgtree-tool-watchdog
description: Create and manage persistent file, command, process, stream, activity and engine-event watchers.
---

Up: [orgtree-watchdogs](../SKILL.md)

# orgtree_watchdog

Use a watchdog to be told when an observable condition happens, instead of spending turns polling it. The watcher persists across engine restarts and costs no hiring credits. By default a fire mails and wakes its owner; `notice: true` makes that mail passive. A watchdog does not grant new filesystem or shell authority.

## Actions and parameters

The effective tool permission is `tools.orgtree.watchdogs`. The owner is the caller; there is no create-on-behalf-of parameter. Top-level callers follow the same owner and visibility rules as other agents.

| Parameter | Applies to | Default / meaning |
|---|---|---|
| `action` | All calls; required | `create`, `list`, `pause`, `resume`, or `remove`. |
| `kind` | Create; required | `file`, `command`, `process`, `stream`, `activity`, or `event`. |
| `target` | Create; required | Path, command, `pid:N`/`port:N`, activity agent name, or event name/prefix. |
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
| `agent.changed`, `agent.settings.changed`, `org.settings.changed` | Change notifications; settings payloads expose identities/field names rather than saved values or a full audit diff. |
| `turn.started`, `turn.finished`, `turn.failed`, `turn.stalled`, `turn.limited` | Runtime transitions/outcomes, not model text or raw error bodies. |
| `mail.waiting`, `mail.delivered`, `mail.changed` | Mail insertion, delivery settlement or mailbox change, without message bodies. |
| `docket.created`, `docket.status.changed`, `docket.attention`, `docket.question.answered` | Item or answered-question notifications, without question/answer text. |
| `account.signed_in`, `account.signed_out`, `account.limit.reached`, `account.limit.reset` | Published account authentication/limit changes, without credentials. |
| `hub.up`, `hub.down`, `hub.changed` | Org hub connection or network change. |
| `credits.changed` | Visible agent grant/free-credit changes. |
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

On Windows `shell: "native"` means `cmd.exe`; use `findstr`, `dir /b`, `%VAR%`, and `%TEMP%`. Bash syntax such as `$(...)`, `$VAR`, `/tmp`, `grep` or `sed` is not portable to it, and `find` is Windows FIND.EXE. `shell: "bash"` explicitly selects `bash -lc`, refused if Bash is unavailable; do not rely on interactive aliases or your current shell's environment. Native Unix commands use `sh -c`.

Creation returns `smoke`: **read it**. Command/stream smoke runs the target for up to 8 seconds and reports shell, output, exit status, matching and broken-target hints. A stream exiting immediately is suspicious; a command never exiting is suspicious. File smoke reports existence/current length, process smoke its current state, activity smoke its event-line format, and event smoke its current condition where available.

An armed result can still contain `smoke.broken: true`; arming is not proof of a working monitor. Fix and recreate a bad target before relying on it. Do not use repeated `list` calls as a substitute for a correctly working wake.

## Management, recovery and health

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
