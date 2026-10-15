---
name: orgtree-usage-windows
description: Interpret the account and model windows a turn spends and preserve uncertainty in usage readings.
---
Up: [orgtree-accounts](../SKILL.md)

# Usage windows

A provider has multiple allowances; “usage” is not one interchangeable number. Read the account, window/model scope, percentage or amount, reset and observation time together. The usage board is cache-only and may point to an earlier numbered snapshot when materially unchanged. Its starred lane is the current turn's account. Some unobserved lanes are omitted; absence is not room.

## Applicable windows

| Lane | What the turn spends |
| --- | --- |
| Claude | Session and standard weekly; a matching scoped weekly applies too. Fable needs its own scoped weekly as well as standard weekly. Lower Claude tiers do not spend Fable's scoped allowance. |
| OpenAI/Codex | The ordinary unnamed plan windows reported for that login, usually short/session and weekly; model-named windows are not automatically the standard pool. |
| Antigravity | Gemini tiers spend `gemini-5h` and `gemini-weekly`; its Claude-family tiers spend `3p-5h` and `3p-weekly`. |
| Muse | Its dated session/five-hour and weekly observations. A reading made under another model is not proof for this model; model-less account-wide readings can establish room. Never assume Wonder and Wonder Full share a pool. |
| OpenRouter | The key's credit row, including cap spending and shared account balance where reported. A zero balance can exhaust a key whose cap bar is under 100%. No rolling reset time is invented. |
| Other API keys | Local metered spending; provider quota is unsupported. |
| Language servers | No published provider quota; the configured agents-at-once cap governs local admission. |

Default placement guidance excludes an account-and-model pair when an applicable window is full. A full unrelated account/model pool does not constrain this pair. Current explicit account-specific user rulings remain authoritative; do not turn a team exception into a general product rule.

## Observation, freshness and capacity

A successful dated reading becomes stale at 900 seconds in the structured query. An unavailable reading, invalid observation, stale bar, missing window and unsupported quota are distinct. None is zero. A countdown reaching reset is not a fresh provider observation, and a stale restriction does not establish new capacity.

Automatic fallback needs positive room in all required windows, not just absence of a full-window refusal. Standard Claude room requires session and standard weekly, plus Fable's scoped weekly for Fable. Muse needs its required pair and applicable model evidence. OpenRouter's credit state must permit spending.

An account mark is another recorded restriction, independent of the displayed percent. Use [account-mark](../tool-account-mark/SKILL.md) for its provenance and exact pool; clearing it does not create quota.

## Refresh without making work

Use [usage](../tool-usage/SKILL.md) for the complete query schema, bounded pages, auth/scope gates and manual refresh statuses. Cached reads cause no provider probe. Its optional single-account refresh is rate-limited and does not run inference or switch accounts.

Automatic native-lane cadence increases with pressure: normally five minutes below 80%, two minutes from 80%, 45 seconds from 95%; existing provider idle caps and an open-window cap can shorten that. Reset catch-up may recheck every ten seconds up to four times. These schedules explain observation age, not a guarantee of fresh data or an instruction for agents to poll.

## See also

- [orgtree-tool-usage](../tool-usage/SKILL.md)
- [orgtree-turn-envelope](../../runtime/turn-envelope/SKILL.md)
- See `orgtree-usage-screens` (orgtree-app › providers).
