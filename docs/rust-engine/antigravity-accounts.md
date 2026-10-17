# Antigravity: registered accounts and the one-sign-in limit

Docket: `antigravity-multi-account-support-via-isolated-p` (4.4.0). Measured 2026-10-16.

## What was measured

Antigravity (AGY CLI 1.3.5, sha256 `4790560754…c4`) keeps its sign-in in the
Windows Credential Manager under one fixed target, `gemini:antigravity`. Two
user-approved probes, each run once from a non-Antigravity session
(`C:/orgtree-build/agy-accounts-opus/agy-keyring-probe.mjs`), ran the silent
check (`AGY_CLI_CDE_AUTH_ACTION=check`, zero args) with
`USERPROFILE=HOME=<fresh empty folder>`:

| probe | extra | verdict |
| --- | --- | --- |
| 1 | none | `Already authenticated as <default account>`; nothing written in the folder |
| 2 | fresh `<folder>\.gemini\antigravity-keyring-unavailable` | same: the marker did not stop the keyring read |

A static read of the binary shows a composite token store whose file branch is
home-relative and whose keyring bypass is that marker (one-hour window), but
probe 2 disproved it at runtime for the check path. **A folder does not isolate
an Antigravity sign-in.** Signing in again replaces the one default sign-in.

Agents that run on Antigravity must never start the real `agy` themselves for
such probes: they share that sign-in, and a token refresh can end their own
session. Hand probes to a non-Antigravity agent as a script.

## What Orgtree does

- `providers::agy_auth::Login`: `Primary` (the user's own sign-in, unchanged)
  or `Profile { id, home }` for a registered Antigravity subscription row that
  is not an API key and not the default sign-in (`login_of`).
- Every AGY process for a profile (agent launch in `runtime/agy.rs`, silent
  check, `/usage`, `GET /api/accounts/{id}/identity`) gets `USERPROFILE` and
  `HOME` set to the row's folder, after everything inherited.
- A profile has its own latch (`diagnostics/agy-auth-latch-<id>.json`) and
  stamp (its `.gemini` token files' metadata, never contents; none = signed
  out, no CLI runs).
- Fail closed: a profile runs only when its silent check names an account AND
  the default sign-in, asked right then (side-effect free), does not name the
  same one. Otherwise it is latched `not_isolated` and refused with a plain
  reason: the agent's mail waits, the identity read answers 409, usage reads
  `not_isolated`. A profile never silently runs on the default sign-in (before
  this change, a bound google row did, with its usage attributed to the row).
- On AGY 1.3.5 this refuses every profile. If a future AGY keeps sign-ins per
  home, the same check passes with no code change; the profile watch
  (`agy-profile-watch`) flags candidate versions.
- Desktop: Add Antigravity account states the limit and offers only an API key;
  no profile creation and no second sign-in terminal. Subscription rows show
  the limit.
- Usage admission (`at_limit`), balancing and fallback capacity (`has_room`)
  read a registered profile's `agy:<id>` cache, as its own usage probe does.
  A missing, stale or unavailable profile reading stays unknown instead of
  borrowing the default account's usage. Ambient aliases and rows without a
  nonblank profile folder keep the native `agy` cache; API keys have no
  subscription reading. Model-pool filtering is unchanged.
- Account placement validates the selected profile's quota and marks without
  consulting the native account's quota. Staffing offers the tier when an
  eligible profile can serve it, with the exhausted native choice unavailable.
  Org restrictions, account switches and the profile-isolation guard still apply.

## Options for real multi-account (not built)

- A separate Windows user per Antigravity account (the Credential Manager is
  per Windows user): needs stored Windows credentials and cross-user process
  launch.
- Token injection (`JETSKI_OAUTH_TOKEN`): Orgtree would have to run Google
  OAuth and refresh tokens itself.
- Upstream profile support (issue #381, linked in the dialog).

## Proofs

- Rig: `tools/rig/proofs/agy-profile-accounts.mjs` (the fake agy records each
  call's `USERPROFILE`; like 1.3.5 it names the same account in every home
  unless the proof writes `<home>\.gemini\rig-agy-identity`).
- Units: `providers::agy_auth` tests `agy_profile_*`.
- Usage units: `usage::agy_reading_tests` exercises admission, balancing and
  fallback with conflicting native/profile readings, missing/stale/failed
  profile evidence, native aliases, API keys and separate model pools.
- Placement units: `domain::ops::agy_placement_tests` and the staffing-options
  test in `usage::agy_reading_tests` use conflicting native/profile quotas and
  verify that native aliases retain native refusals.
- Renderer: `tests/accountsregistry-create.test.tsx`.
