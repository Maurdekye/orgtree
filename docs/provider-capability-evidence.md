# Provider capability and admission evidence (W15)

Package W15 of the 2026-09-12 suggestion synthesis, implemented on top of the
account-balancing work that landed as `04e1b0a` and `121e00a`. Sources: `AU01`
(antigravity-usage), `PP08` (perf-pass), `stateaudit-04`, `statereview-10`.

## The two problems

**A capability conclusion was being stored as a fact.** Antigravity's `/usage`
was concluded unreadable once, against one CLI build, and the conclusion
outlived the build: the CLI grew a structured, zero-token `/usage` result while
`unsupported` stayed put. Nothing in the record said *when* or *against what*
the conclusion had been reached, so nobody could see it was old (`AU01`).

**A window at 100% was read as a contradiction.** The provider-usage board
showed a Fable weekly window at 100%, `limit-active`, for a whole session while
turns kept being admitted (`PP08`). The requested fix was a "soft vs hard"
marker on the number. That conflicts with the user's rule of 2026-09-12, which
makes a fully consumed window a *hard* ineligibility — so it was not built.

## What the board was actually saying

The board lists **every signed-in account**. An exhausted window belongs to one
account, and it is only a constraint on a turn that (a) runs on that account and
(b) runs a model that draws on that window. The Fable weekly pool is drawn on by
Fable turns and by nothing else; an Opus turn on the same account spends the
session and pooled weekly windows and none of Fable's. So most reports of
"100% yet admitted" are not the board contradicting itself — they are a row
being read as though it applied to the reader.

What was missing was the arithmetic, not a caveat. The board now closes with

    this turn spends: <model> on <account> → <windows>; other windows are not
    spent by it, and no lane publishes a turns-remaining figure.

`turnusage.spent_windows` is that rule, and it is deliberately **not**
`limits.lane_applies`: the two answer different questions. `lane_applies` asks
which window a limit *message* is about (a Fable wall is never explained by the
pooled weekly lane); `spent_windows` asks which windows a turn *draws down* (a
Fable turn draws down both, per the user's accounting). Keeping them separate is
why a Fable node is still never parked on the pooled weekly reset.

When the mapping has not been measured for a lane, the sentence says
`not published for this lane`. It never states a turns-remaining figure, because
no provider publishes one — that request (`PP08`, `stateaudit-04`) is answered
with the honest "not published" rather than an estimate.

## What a capability record now carries

`capability.observation` — one record, four facts: the `cli`, the `version` that
was **observed** when the conclusion was reached, the `basis` (why the lane
cannot answer), and `observed_at`. `capability.stale(record, version)` retires a
record whose version is no longer installed, in either direction; an upgrade, a
downgrade and a vanished CLI all count, and an `unobserved` version never
matches an observed one.

| basis | meaning | re-decidable by upgrading? |
| --- | --- | --- |
| `version` | the installed CLI predates the build whose read-only behaviour was verified | yes |
| `scope` | the credential can never carry the permission the usage endpoint needs (D-147) | no |
| `no-profile-selector` | the CLI answers only for its ambient account | no |
| `billing` | the lane bills per request and publishes no window | no |

Carriers: `antigravity_limits.fetch` (both directions — the negative and the
successful board), `accounts.account_usage` for a `claude setup-token` row, and
`accountusage.view` for a non-ambient Antigravity profile and an org API-key row.

`antigravity_limits`' usage cache is keyed by CLI version as well as by account,
so a board produced by one build is dropped rather than republished after the
build changes.

A read that *spans* a version change is filed under neither build, and it
carries **no capability record at all** — not one stamped with the version
observed afterwards, which would credit a successful read to a build that may
never have performed it. An absent record is the honest shape: no conclusion
was reached, and `capability.stale(None, …)` is true for every version, so the
next reader recomputes rather than inheriting an answer nobody measured.

## Rules this keeps

- `observed_at` is the instant the **evidence** was observed, `null` when the
  caller cannot say. It is never the formatting time: `accountusage.view` must
  answer the Usage modal and the turn envelope identically from the same state,
  and a pinned test compares them byte for byte.
- No probe, no spawn, no credential read on the envelope path.
  `capability.cli_version_cached` reports an already-observed version or
  nothing — it never probes to avoid saying "unobserved".
- `available: False` means *no reading*. It is neither zero nor room, and it is
  never an admission gate; usage telemetry still gates nothing.
- The zero-turn contract on `/usage` is unchanged: a result showing any
  conversation, turn or token is refused rather than normalized.

Regression suite: `tests/test_capability_and_admission_evidence.py`.
