# Signed-out hire tokens

User requirement, 2026-10-19 17:04:35Z: an enabled, set-up provider that is
signed out keeps dashed disabled hire tokens, with a hover explaining that
it must be signed in before hiring.

The engine's provider payload classifies `hire_reason` separately from its
human-readable remedy. Native installed CLIs report `signed_out` only after
discovery completes. Muse requires its explicit logged-out metadata; Antigravity
retains its silent check's explicit sign-out result. A missing metadata read or
transient check failure remains unknown, with no sign-in assertion. OpenRouter
does so only when every enabled key with an
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

Measured on 2026-10-19 under one build-slot grant, released after verification:

- Frozen tests-only `c61a7eb`: 12 intended failures and one passing control,
  including independent signed-out cases for all six provider families.
- Final source/test tip `5914b95`: 15 new renderer tests pass, covering all
  four edges, Quick chat, desk and mobile hire sheet, switches and unknowns.
  Existing hireavail 17, musehire 7, orghire 20, desk-model 6,
  quickchat-availability 4 and agymodelsrefresh 6 also pass (75 total).
- Focused engine tests: 3/3 pass, zero ignored. Cargo check exits zero with
  one unused-import warning in unchanged `domain/tree.rs`. Cargo uses `-j1`
  under a 6144 MB kernel Job; renderer work uses a 3072 MB Job. Fresh RAM
  exceeded the assigned floor before each phase.
- Synthetic capture passed and was personally viewed: six disabled provider
  rows, dashed computed borders and readable sign-in explanation. This checks
  DOM title text and its displayed fixture copy, not native tooltip timing.
- Six changed TypeScript files have zero strict diagnostics. The raw compiler
  exits 1 with 32 diagnostic lines in transitive unchanged files; this is not
  a full renderer typecheck pass.

Evidence is retained under `C:/orgtree-build/ordering-sol/` in `signedout-red`,
`signedout-green`, `signedout-final`, `signedout-visual` and
`signedout-verification`. The first desk-selector test failure and test-fixture
typecheck error are retained separately; both were corrected before final checks.
Engine results are unit/compile evidence; actual provider sign-in transitions,
PostgreSQL/runtime delivery and live/native UI operation were not exercised.
