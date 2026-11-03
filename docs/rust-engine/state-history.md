# Agent state history in the desk transcript

USER 2026-10-31 11:00:50Z (`m36bf8730cba7`): "backlog: show a history of
active / idle / blocked / halted / frozen state times in the history".
Implementation authorized 2026-11-01 (`m81708aedacc4`, `m622bddf14606`);
the liaison spec on docket `agent-state-history-active-idle-blocked-halted-f`
fixed the shape, and the gap-fills below were decided in that spec or in
[DECISIONS.md](DECISIONS.md) (state history entry, 2026-11-02).

## What the user sees

Every change of an agent's effective state leaves one compact system row
in its desk Chat transcript, inline where it happened, in the existing
transcript system-row style:

```
Idle · was active 12m
Frozen · was active 3m
Active · was frozen 2h
```

The row's stored `text` still names the state just entered and the one it
ended, but the DESK draws the row from its structured fields
(`prev_state`, `prev_secs`; USER 2026-11-03 17:37:22Z `m1bfdb3fba01b`):
"`<Ended state> for <duration>`" (`Active for 32s`, `Idle for 19s`), in the
desk's own age words (`45s`, `12m`, `2h`, `3d`), never the new state. An
ended state under one second (`prev_secs` 0) draws no row at all in the
transcript, the popouts or any preview (no empty line, no gap); the row
stays in the data and on the States tab. An ended state of unknown start
shows its name alone, a first row with no ended state shows nothing, and a
row of an older engine without the fields keeps its own text
(`canvas/statemarker.ts`). The row's timestamp is the new state's start; hovering it
names that instant in full ("Idle since …"), like every other age on the
desk. When the ended state's start is not known (it began before
recording did), the duration is left out rather than invented
("Idle · was frozen"), and the very first row an agent ever gets may
name only its state. The rows are ordinary conversation rows: they load
lazily with the rest of the transcript in the usual bounded pages, and
there is no org-wide view and no totals summary.

## The five states and their precedence

One effective state per agent, derived with the same precedence as the
desk's state badges (`deriveAgentVisualState` in `canvas/desk.tsx`), so
the history and the badges never disagree:

1. **Halted** — the durable `halt` record is set.
2. **Frozen** — a freeze record stands (or the agent is limit-locked),
   except the short automatic retries below.
3. **Active** — a turn is running or admitted (`inflight_at` set, or
   the actor holds a turn, command turns included).
4. **Blocked** — the agent's last self-reported status
   (`orgtree_status`) is `blocked`.
5. **Idle** — none of the above.

Active, idle, halted and frozen are engine-measured; blocked is the one
self-reported state. A report of `working`/`done`/`idle` is not one of
the five states: out of a turn it simply leaves the agent idle (or ends
a blocked span). A blocked report made mid-turn takes effect when the
turn ends, because a running turn outranks it — exactly as the badges
read it.

A pure connection-retry freeze and a pure request-rate 429 freeze are
**not** frozen spans: freeze release already treats them as neither a
limit reset nor an unstick, and they retry within minutes. Every other
freeze record — usage limit, auth, balance, no allowed account — is
Frozen. The org killswitch and retiring an agent are not states here:
the killswitch is org-wide, and a retired agent's history simply ends.

## Recording: the actor is the only writer

Conversation rows have exactly one writer, the agent's actor
(`ConvoWriter` owns the sequence), so state rows are written there and
nowhere else. The pure logic — precedence, the freeze predicate,
duration words, the transition tracker and the row shape — lives in
`runtime/state_history.rs`; the actor owns a `Tracker` (last recorded
state + when it began) and one `note_state(at)` path that re-derives the
effective state from the durable facts and appends a row only on a
change, which makes every notification idempotent.

Transitions are noted:

- by the actor itself: turn admission (`start_turn`, at the admission
  instant, before the turn's mail row), command turns, turn end
  (`end_turn`, after the turn's freeze/inflight writes), halt and
  unhalt;
- from outside writes, through `runtime::state_note` →
  `AgentMsg::StateNote(at)`: status reports (`tools/mailtools.rs`),
  freeze release (`freeze::thaw_matching`), continue-on
  (`freeze::continue_on` when it released a freeze), and the
  no-allowed-account freeze (`org_accounts::leave`).

A write that changes `halt`, `frozen`, `limit_locked` or `last_status`
anywhere else must send the same note after commit, or its transition
is only picked up later (below). The known places that rely on the
later pickup today, because their writes sit inside larger
transactions with deferred effects, are the account rebind's
auth/balance unfreeze (`domain/ops.rs`), account removal
(`domain/account_removal.rs`), and rehire clearing a halt. In those
the row's previous state is still right; its instant — and so the ended
span — is measured when the actor next notes, not when the write
committed.

## Restarting: seeding and reconcile

Actors exit when idle and the engine restarts, so the tracker is
rebuilt at actor start (`Actor::state_seed`): from the newest
`kind = "state"` conversation row when the history has one (the rows
are the durable record), otherwise from the durable facts themselves
with the stamp each fact carries (`halt.at`, a freeze record's `at`
when it has one, `last_status.at`, `inflight_at`, the last turn's
`ended_at` for idle). Right after starting, the actor reconciles once:
a transition that happened while no actor ran is recorded then, at the
winning fact's stamp when it has one, else at the reconcile instant. A
freeze released while the engine was down therefore measures to the
recovery, not to the release nobody ran.

Row shape: `{role: "system", kind: "state", state, prev_state,
prev_secs, text, ts, tokens: not counted (not sent to the agent)}`.
Rows never fold into the system-notice pile (that fold is for
`@system` mail), carry no token count, and are part of the transcript
agents read back with `orgtree_read_transcript`.

## The States tab in node settings (2026-11-03, 4.5.5)

USER 2026-11-03 09:25:37Z (`md2ffcbe7266e`): "also was hoping to see
idle/active/state times in the node seytinfs history tab, or a new
adjacent tab". An agent's settings window has a **States** tab directly
after History (agents only; a project has no states). It reads the same
`kind = "state"` conversation rows, so nothing new is recorded.

**Placement: a new tab, not rows in History.** The History tab is the
retained *event* feed (`ot.events`, one capped record-subscription window,
only shown when events exist). State spans come from the conversation
table, need their own paging and totals, and would have grown that
window; a separate tab keeps History's reads and meaning unchanged.

What it shows, newest first: a totals line (time per state over the last
24 hours and the last 7 days; a state with no time is left out), then one
entry per span — state, start, end (or **now** for the current span) and
duration in the desk's age words. Times show in the user's display zone
like every other time. The inline transcript rows are unchanged.

Read: `GET /api/orgs/{slug}/nodes/{nid}/states?limit=1..100&before=<cursor>`
→ `{node, states:[{state, start, end|null, secs}], next_cursor, totals?}`.
Spans are the rows between neighbours: a span ends where the next newer
row begins; the newest row's span is open. `totals` ride on the first page
only (rows back to the 7 day cut plus the one before it, read in bounded
pages). Time before the first recorded row is unknown and counts for no
state, so totals can sum to less than the window. The newest row is
what the actor last recorded: a transition no actor has noted yet shows at
the next actor start (the reconcile above). Migration `0082` adds a partial
index on the state rows so every read touches only them, never the
agent's whole transcript. Pure span/totals logic: `state_history::spans`
and `state_history::totals`.
