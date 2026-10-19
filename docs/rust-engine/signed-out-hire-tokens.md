# Signed-out hire tokens

User requirement, 2026-10-19 17:04:35Z: an enabled, set-up provider that is
signed out keeps dashed disabled hire tokens, with a hover explaining that
it must be signed in before hiring.

The engine's provider payload classifies `hire_reason` separately from its
human-readable remedy. Native installed CLIs report `signed_out` only after
discovery completes. OpenRouter does so only when every enabled key with an
installed harness has explicit cached authentication rejection evidence;
unknown readings, network failures and spend limits do not establish sign-out.
No authentication request is added by rendering the provider list.

Language servers use their configured endpoint and optional key. Their host
Claude/Codex CLI need not have a native subscription login. No models, an
offline endpoint or missing harness is not labeled signed out. The common
renderer supports an explicit signed-out payload for this family too, without
inventing such a state for today's server configuration protocol.

`hireOf` carries the classification into the shared token renderer. Signed-out
previews survive missing Muse/Antigravity account catalogs and the eligible-tier
filters used by Quick chat and desk pickers. Live selections still require the
ordinary staffing decision, and these disabled tokens never call a hire/switch
operation. OpenRouter and language-server tokens remain their configured
favorites/models; there is no invented fallback model when that registry is empty.

Legacy hiding, provider/org switches and installation absence retain their
existing rules. Antigravity's `preview_tiers` also preserves the Runtime switch
for Claude-backed models. The mobile hire sheet uses the same sign-in wording
and dashed style as the other strips.

This change adds display only, with no new UI action or agent tool.

## Author verification

Prepared frozen tests-only red checkpoint `c61a7eb`. Focused renderer and engine
verification plus a synthetic capture are pending the build permit; this is not
yet a measured success claim.
