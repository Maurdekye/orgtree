# Per-agent fast mode (4.4.0)

User 2026-10-17 17:49Z requests a lightning toggle above Send, a Model-tab
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
