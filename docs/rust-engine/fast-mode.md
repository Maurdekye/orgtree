# Per-agent fast mode (4.4.0)

User 2026-10-17 17:49Z requests a lightning toggle beside Send, a Model-tab
checkbox and a hover label for providers that offer faster inference at higher
usage. Unsupported controls are hidden, replacing the original disabled-control
proposal. Coordinator approved the researched design at 17:52:48Z.

`scope.fast_mode` is a node-local boolean, default false, preserved through scope
normalization/clamping without inheritance. A speed-only user save persists just
that field and publishes the agent; it never sends Reconfigured or cascades scope.
Model/account/session identity and startup fingerprint parts do not include speed.
Mixed model/settings edits retain their existing admission and boundary behavior.

Codex's existing offline capability discovery preserves the exact model row's
`serviceTiers`, accepting only advertised `fast` or `priority` IDs. The deprecated
`additionalSpeedTiers` is used only if the newer field is absent. Unknown models
and tier IDs never authorize a flag. Provider payloads expose default-model and
version-specific support; rediscovery replaces the registry, including removals.

The Codex next-turn request adds `serviceTierForTurn` only for a supported
first-party model: the advertised ID when on, `default` when off. It does not set
the persistent `serviceTier` or steer an active turn. Offline source:
Codex CLI 0.160.0 `app-server generate-ts --experimental`, v2/Model.ts,
v2/ModelServiceTier.ts and v2/TurnStartParams.ts. Explicit off prevents an
ambient fast configuration from sticking.

Claude Code's verified first-party Opus 4.8/5 model families receive a `fastMode`
boolean in launch flag settings and an acknowledged `apply_flag_settings`
control before the next user turn. Never send `/fast`: it can switch the model.
An error response prevents that prompt from being sent and follows the ordinary
refused-turn/mail-return path. Offline source: Claude Code 2.1.292 embedded
settings/control schemas and `fast_mode` model eligibility lookup, with the
Opus-family fallback. Actual account entitlement and provider policy remain
native checks. No paid inference was used for research.

Antigravity CLI help, OpenCode 2.0.28 help/current ACP transport, Muse 1.4.10's
generated MSP schema and local-server contracts expose no verified portable
equivalent. Their routes receive no new flags, even when a stale stored value
is true. No price or token multiplier is estimated; provider usage reporting is
unchanged. The saved UI state expresses a request, not a guarantee of entitlement
or actual acceleration.

Focused verification: renderer `fastmode` plus tooltip/settings neighbors;
Rust `fast_mode` tests exercise exact model gating, strict boolean validation,
non-inheritance, both native wire formats, explicit standard speed, same-session
behavior and Claude control refusal. All checks use synthetic inputs, no auth or
provider inference.


## Queued change badge (2026-10-18)

A running accepted turn publishes `fast_mode_current` from the native speed
setting actually sent, separately from `scope.fast_mode`. Speed-only saves do
not mutate that snapshot. Codex records it only when an advertised per-turn tier
was sent; Claude records it only after the flag acknowledgement and prompt send
succeed. Command/compaction turns and unknown routes leave it null. Idle actor
snapshots and the no-actor defaults clear it; the runtime overlay preserves the
field with its usual epoch/sequence ordering.

Beside the lightning button, the shared next-turn badge says `next turn → fast
on` or `next turn → fast off` only when this serving evidence differs from the
saved choice during a running turn. Matching, absent/unknown, idle or unsupported
states show no pending badge. The tooltip names the agent and current/next
values. A successful save alone never supplies serving evidence. New admission,
turn completion or reverting the saved choice removes the badge. Native provider
entitlement and acceleration remain outside this evidence: it records the sent
speed request, not a claim about observed latency or billing.

## Near-zoom active indicator (2026-10-18)

The ordinary near-zoom card's status badge row includes a passive lightning
icon with title/accessible label "fast". The current provider and pinned model
must advertise support. While busy, only fast_mode_current=true shows it; an
unknown/null serving value stays hidden. While idle, scope.fast_mode=true shows
it. A queued-on request does not label the standard-speed running turn, and
queued-off does not remove the bolt from a still-fast turn. Completion adopts
the saved setting. The existing far/map locator and open-desk exclusions remain.

The rich agent model hover's final segment reads "fast" instead of "fast mode";
its existing support and saved-preference gating remains. The desk speed
button's help/accessible name and the Model-tab setting retain their wording.

## Aligned composer and near queued card (2026-10-18)

The agent composer keeps the lightning toggle on the top row, with the queued
badge directly to its left. Effort and Send/Stop stay together on the lower row,
right aligned below the toggle. All four are 30px tall. The text field retains
its 10ch minimum and the attachment/notice column keeps its existing layout.
User 16:47Z and coordinator 16:48Z (m1b406c3ef7c8) restore this original vertical
placement, superseding the earlier single-row layout approved at 14:52Z.

Near-zoom cards reuse QueuedFastBadge and its exact NextTurnBadge text and
explanatory tooltip. They require a supported live agent, busy=true and a known
boolean serving value opposite the saved preference. Idle, unknown, matching,
unsupported and archived states hide it. Reversion, next admission, completion
or loss of support clears it. Far/map views omit near badges. The active-speed
bolt is independent: queued-on/current-off shows just the queued card;
queued-off/current-on shows the active bolt plus the queued-off card.

Confirmed layout: user 14:51Z and coordinator 14:52Z m60c9799b5dfe.
