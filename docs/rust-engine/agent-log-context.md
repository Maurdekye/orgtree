# Agent names in engine log client IDs

User clarification, 2026-10-07: engine lines caused by an agent should identify it as
`agent:<id>/<name>`; watchdog lines should identify the owner as `dog:<uid>/<owner name>`.
The existing `RQ… client EX…` format stays unchanged (DECISIONS 34).

## Measured before the change

A read-only, streaming scan of `2026-10-07_00-41-19.log` after its size rollover
(`.f664570109f14470a89c84da3f341c2e.gz`) counted 541,032 physical lines:

| Client | Lines |
| --- | ---: |
| Named agent | 206,832 |
| engine | 101,702 |
| user | 94,640 |
| desktop | 17,988 |
| Watchdog without owner | 660 |
| No request prefix | 119,210 |

These are line counts, including method call/return lines, not request counts.
The scan retained only prefix/method counts and request paths, never bodies or credentials.
It did not copy the live log or modify live data.

Concrete gaps: actor construction (66 lines), actor run (52), process close and unpark
(38 each) had no request prefix. Freeze recovery scheduled agents under `engine` (10
schedule lines). All 660 watchdog lines lacked the owner's name, including checks,
delivery and wake calls. Most `user` lines were UI chat/docket reads; sampled `user`
wakes correlated with HTTP message/resume actions. They must keep the real caller label.
Engine-wide feed refreshes cannot honestly be assigned to one agent.

## Implementation and source audit

- Actor startup reuses its existing identity row before entering a named request for
  construction, the entire actor loop, error handling and teardown. Account-fallback tasks
  get named child requests with the triggering request recorded as their cause.
- Scheduler messages retain the sender's span; queued and held slots retain their owner's
  span through release. No per-message identity query or shared identity cache is added.
- Freeze timers carry the scheduled agent's name. Recovery, warming and reminder delivery
  use names from existing row reads. Their engine-wide scans keep their original contexts.
- Watchdog runners reuse the initial watchdog row for a named request. Each poll uses its
  freshly loaded owner name. Stream/activity runners use the owner name at runner start.
  Cleanup/rearming preserves the named context. Query counts and runner gates stay unchanged.
- HTTP accepts the desktop token, not agent tokens. Claude/Codex tool requests and the
  Antigravity per-agent named-pipe bridge already create named agent requests. No identity
  is inferred from an HTTP target agent, user-agent string or untrusted header.

Identity lookup failures retain the initiating context and include the numeric agent ID;
there is no trustworthy name to print in that case. Long-lived actor/CLI, freeze-timer and
stream/activity contexts use the name captured when they started; this change does not
introduce a global name registry or a new query for every log line.

## Verification limits

Rust parsing via `rustfmt --emit stdout` and `git diff --check` are the brief checks for this
hand-in. No engine was built, installed or restarted, and the changed runtime behavior
has not been exercised against a running engine. A later prototype smoke should check an
agent turn, queued slot release, watchdog fire and automatic wake for the expected client
prefixes, while confirming a UI chat read still says `user`.
