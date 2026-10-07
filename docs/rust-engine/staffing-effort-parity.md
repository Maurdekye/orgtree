# Quick-staff effort parity

Source comparison: 2026-10-07, Python/renderer baseline `4ddbfb1`.

The Rust staffing offers used `Tier.live_effort`, which describes a mid-turn
control channel, as a launch-time capability check. This removed Codex and
Antigravity effort submenus; OpenRouter explicitly returned an empty list.
The existing renderer already creates effort rows and posts the selected value.

## Restored choices

| Provider/tier | Offered levels |
| --- | --- |
| Claude, including Haiku | low, medium, high, xhigh, max |
| OpenRouter favorites | low, medium, high, xhigh, max |
| Codex | The above five levels intersected with the selected model's advertised `supportedReasoningEfforts` |
| Antigravity Flash | low, medium, high |
| Antigravity Pro family | low, high |

References: `engine/backend/orgtree/staffcache.py::_supported_efforts`,
`providers.py::codex_model_inventory` and `antigravity_effort` at the baseline.
This patch does not change which tiers are available for hiring.

Codex discovery uses the ambient signed-in CLI's `app-server` `model/list`,
including hidden models and pagination, as 3.x did. It runs in the existing
background provider-discovery loop, with a 25-second exchange timeout and a
20-page bound. It creates no thread or inference request. Missing login or a
failed probe produces no Codex effort offers and exposes an availability error;
the new snapshot does not retain an earlier successful inventory on failure.
Quick-staff preview and staffing-options only read retained capabilities.

## Applying a selection

Quick-staff validates the chosen level against the current offer, passes it to
the existing hire scope, and request mode includes it in the staffing request.
The actor's effective effort reaches Claude's launch flag for every Claude
harness tier (including Haiku and OpenRouter), Codex's next `turn/start` without
rewriting max to xhigh, and Antigravity's tier-specific vocabulary. The existing
OpenRouter Codex guard still omits reasoning effort for non-reasoning models.
Mid-turn control support is unchanged.

## Verification and limits

- Measured: `cargo check -p orgtree-engine -j 2` and `npm run typecheck` pass.
- Measured: a brief smoke against the actual renderer quick-staff module with
  a stubbed request function exercised 90 effort selections across seven tier
  fixtures and three staffing modes, plus explicit account selection with max.
- Source inspected: preview/validation/hire scope and all three launch paths.
- No engine build, provider inference, live hire, or live settings/data change
  was performed. Provider discovery and end-to-end launches remain unmeasured
  in a running build; the renderer smoke's capability rows are fixtures.
