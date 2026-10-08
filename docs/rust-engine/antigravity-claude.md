# Claude 5.5 through Antigravity

The optional `agy-sonnet` and `agy-opus` tiers run on the Google/Antigravity
provider and native `agy` sign-in. They are independent of Claude Code tiers.
The user approved seats of 2 and 4 respectively on 2026-10-07. Their names are
`sonnet (antigravity)` and `opus (antigravity)` (user, 2026-10-08); they run
Claude Sonnet 5.5 and Claude Opus 5.5. Only the existing model colours are shared.
Provider styling, hire grouping, account selection and runtime stay Antigravity.

App settings > Runtime > Antigravity models enables both tiers. The setting
`antigravity_claude_enabled` defaults to false. Off hides new hire/switch offers
and rejects new turns; an already running turn finishes. Re-enabling publishes
new tier offers and wakes waiting mail. Existing seats keep their identity.

These tiers have no model-version choice. The catalog has no version entries;
launches ignore inherited version settings and the settings API rejects an
explicit version. Switching into one clears the old context size/version.
Context capacity and token pricing are unknown. Token-bearing turns retain
usage counts and mark dollar cost unknown; Gemini pricing is never reused.

## Measured CLI contract

On 2026-10-07, installed agy 1.3.1 returned these IDs from `agy models`:

- `claude-sonnet-5-5-low`, `claude-sonnet-5-5-medium`, `claude-sonnet-5-5-high`
- `claude-opus-5-5-low`, `claude-opus-5-5-medium`, `claude-opus-5-5-high`

Launch uses the exact effort-specific ID and `--effort`. Low, medium and high
are offered for staffing; inherited xhigh/max clamp to high as for other agy
models. The default is high. There is no Claude Code control channel.

The structured `/usage` command returned SUCCESS, an empty conversation ID,
zero turns and zero tokens. Its Claude and GPT models group explicitly names
Claude Opus and Sonnet, with buckets `3p-5h` and `3p-weekly`. Gemini has separate
`gemini-5h` and `gemini-weekly` buckets.

Hiring and turn admission refuse a fresh, full, unexpired window only in the
model's group. Missing/stale usage remains unknown, not an invented reading.
New limit marks use `agy:3p` or `agy:gemini`; account candidates and clearing
respect that scope. Unknown older/default marks remain conservative. Recovery
requires both scoped windows to have room, or a successful turn in that same
pool. The existing usage refresh wakes waiting native Google mail when a known
full bucket reports room again. The turn usage board names the exact two
windows; its change key includes the tier so switching groups updates the text.

## Verification and limits

Measured: renderer typecheck; actual renderer module smoke for provider,
label, seats, letters, opt-in hire/switch visibility, no versions and CSS
colour aliases. Catalog source smoke (logging attributes removed) checks exact
effort IDs, fixed 5.5, provider separation, seats and unknown pricing/context.
Quota smoke executes extracted production function bodies with fixture data:
independent full Gemini/third-party groups, weekly/five-hour exhaustion, expired
windows, missing evidence, two-window recovery and scoped account marks.

These are focused source/fixture smokes, not an installed-app or database
integration test. No inference turn, provider cache receipt, screenshot or
real exhaustion/recovery event has been measured. No live settings or data
were changed. See the hand-in for the final cargo-check result and commit IDs.
