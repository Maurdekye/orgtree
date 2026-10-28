# Request-rate 429 retries (Codex)

A Codex turn that ends with `exceeded retry limit, last status: 429 Too Many Requests` hit the
provider's request-rate limit. It is not a usage limit, and the agent retries after minutes, not
after a usage reset. [decided: user 2026-10-28 10:07:18Z mb1ca1568502c, "pretty sure 429 errors
should only wait another few minutes before retrying, noit several hours"]

## What was measured (2026-10-28 10:04Z)

About 34 Terra and Sol seats ran on `openai/primary`. In the engine log (local time UTC+2),
`rr450-check-sol-1` and `-3` each reached `end_turn(error="exceeded retry limit, last status: 429
Too Many Requests", res={"codex":true})` and then `usage limit reset ... parsed=false`, with
`until` one hour later. The weekly window read 8-10 %. The cause:

- `recovery::worded_limit` reads a text with "limit" beside "exceeded" as a usage wall, and
  `usage_reset::reported` found no reset time in it and used its fallback hour.
- The engine only read `error.message` of the app-server's `error` / `turn/completed`, so nothing
  else could tell the two apart. The message carries no body and no headers: the Codex app-server
  relays neither, so there is no `Retry-After` in the 10:04Z error.

The app-server's schema (`codex app-server generate-json-schema`, 0.160.0) types the failure in
`TurnError.codexErrorInfo`: `usageLimitExceeded` and `rateLimitExceeded` as plain tags, and
`responseTooManyFailedAttempts`, `httpConnectionFailed`, `responseStreamConnectionFailed` and
`responseStreamDisconnected` as objects holding `httpStatusCode`. The engine now keeps that tag and
`additionalDetails` beside the message (`Turn::codex_error_extra`, handed to `end_turn` as
`res["codex_error"] = {"info", "details"}`).

## The rule (`runtime/rate_limit.rs`, Codex lane only)

`rate_limited(error, codex_error, window_full)` says rate limit when the failure is the
`rateLimitExceeded` tag, a retry limit or connection failure whose `httpStatusCode` is 429, or a
text that states a 429 (`too many requests`, or 429 beside `status`/`HTTP`/`code`/`error`/
`response`: a bare 429 is not one), and none of these holds:

- the `usageLimitExceeded` tag;
- a usage wall's words in the text or details (`usage limit`, `usage_limit`, `hit your limit`,
  `quota`, `weekly`, `resets`, `reset at`, `try again at`, `billing`, `credits`, `upgrade`,
  `subscription`);
- an exhausted window: the turn's own rate-limit snapshots said so (`limit_signal`), or a fresh
  usage reading shows a window the tier spends at 100 % with a future reset (`cached_reset`).

Then `end_turn` skips `usage_reset::reported` and classifies the turn `Class::Rate`. Everything
else, a real usage limit included, takes the old path unchanged.

## The retry

A retry freeze, built like the connection retry of 3.x parity batch 4a: `connection: true`,
`limit: false`, `cause: "rate_limit"`, `attempt`, `retry_in_s`, and `wake_text` naming the 429 as the
request rate "not your usage limit". The engine's freeze timer wakes it at `until` with no clock-skew
grace and whatever the org's auto-resume setting is. The wait for attempt n:

| Source | Wait |
|---|---|
| a `Retry-After` / `retry after ...` / `try again in ...` in the text or details | that, between 15 s and 10 min |
| none (the measured case) | 60 s, 120 s, 240 s, then 300 s (`RATE_RETRY_FIRST_S`, `RATE_RETRY_CAP_S`) |

plus 0 to 20 % by agent id, so a herd that was refused together does not come back together and is
never earlier than the base. At most `RATE_RETRY_MAX` = 5 attempts (about 15 to 20 minutes of waiting
in all), counted in `ot.agents.extra.rate_limit_run` and cleared by a completed turn
(`recovery::clear_runs`). When they are spent, `recovery::retry_exhausted` tells the agent and its
superior once ("your turn failed 5 times in a row (provider rate limit (HTTP 429))...") and later
failures surface as ordinary failed turns. The request the refused turn was given is kept in
`resume_texts` and given again at the wake when the turn had done nothing (`!turn.activity`); a
turn that had worked is told to check its real state instead.

## What shows

- Desk header, card and agents-list status: `rate-limited` (short form `rate`) with the retry time,
  from `freezeKind` = `rate`; not `usage limit`.
- The org chart other agents read: `frozen (rate-limited, retrying)`; a usage freeze still reads
  `frozen (usage limit)`.
- A dead turn's project leases and un-acked jobs go back with the reason "stopped by the provider's
  request-rate limit (HTTP 429) and it was frozen for a short retry" (`holdings::died`).

## Other lanes (unchanged, on purpose)

- Claude: its 429 prose ("would exceed your account's rate limit") was observed on 2026-09-04 as the
  usage wall (3.x `failclass`, `supervisor`), and `worded_limit` keeps it so; a typed
  `api_error_status` is read only for 401. Splitting Claude's per-minute 429 from its usage wall needs
  a measured sample of each and a decision.
- OpenRouter and language model servers: a typed 429 is not classified (only 401, 402, 5xx are).
- Muse: its host judges retryability (`Class::Net`) and types its quota reset.
- Project-line sweeps (`domain/projects.rs`) still name any frozen holder "frozen by a usage
  limit", also for a connection retry; they run only for a holder that is frozen when the sweep
  looks, after the turn-end release above.

## Tests

`runtime::rate_limit::tests` (the measured error, the typed tags, the usage-wall controls, the
exhausted window, Retry-After, the schedule and the spread, the freeze record),
`domain::holdings::tests::a_rate_limit_retry_freeze_is_not_called_a_usage_limit`,
`runtime::envelope::frozen_tag_tests`, renderer `freezelabel.test.ts`, and the rig proof
`tools/rig/proofs/turn-failures.mjs` (agents `nia` and `una`).
