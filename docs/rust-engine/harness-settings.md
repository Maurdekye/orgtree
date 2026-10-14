# Compact Harnesses settings

User 2026-10-14 10:59Z requested name, installed state, version and an install
link only for missing harnesses. Their follow-up adds compact OpenRouter and
Language server tags, with at most one short explanatory line.

`GET /api/harnesses` remains the registry for this page and selectors. It now
projects `version` from each existing `providers::State` CLI discovery record.
All five discovery lanes already record versions; no new discovery commands,
processes, sign-in checks or Antigravity invocations are added. Missing or blank
versions display **version unknown** for installed harnesses. Missing harnesses
display one **How to install** link when the registry supplies a URL, with no
version. Muse's official install URL matches the existing tray/README link.

Compatibility tags require `selectable` and the corresponding provider ID
(`openrouter` or `langserver`). They are independent of installation status.
Future registry entries automatically appear; unknown versions and missing URLs
remain usable with older engines. Description, provider paragraphs, install
instructions and protocol caveats remain registry/documentation data but are
not rendered in this tab. No picker, tray or provider settings behavior changes.

Verification packet for the shared batch:

- Renderer `harnesscompact` (4 cases) and `openrouterharness` (updated existing
  settings assertions). Red control: run the new test against base `2e3d287`'s
  `canvas/harnesses.tsx` and CSS in an isolated control checkout; no production
  edits or live app. Expected behavioral failures: old paragraphs, no versions,
  links on installed rows, absent tags. Restore the candidate for green.
- Rust `harnesses::tests::harness_versions_reuse_discovery` checks all five
  cached mappings plus unknown/missing/blank versions. `cargo check` and root
  typecheck in the same batch.
- Render the real `HarnessesSection` with the test registry fixture at normal
  and narrow settings widths; inspect compact wrapping, tags, unknown versions
  and missing-only links. No installed app or live provider interaction.

These commands are handed to the batch owner; this source commit does not
claim their execution or device acceptance.
