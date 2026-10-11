# Provider configuration dialogs

The Providers tab previously expanded OpenRouter key entry and language-server
forms inline. The user's 2026-10-11 request moves both add and configure flows
into separate dialogs. Account/server summaries and model chips stay in Providers.

`canvas/providerdialog.tsx` exports `ProviderDialog({title, busy, close, children})`.
It uses the common non-pinnable `PinFrame` and `ModalOverPins`, focuses the first
field and restores the opener. Escape closes the top dialog; a nested model
browser closes before its draft. Backdrop clicks do not discard a draft. Save
requests retain the existing handlers; dismissal is blocked while busy.

Language-server presets, harness availability, custom API fields, model selection,
context windows, prices, concurrency and key replacement/removal are unchanged.
Cancel or Escape discards the draft. Successful Save closes it; failed Save keeps
the fields available for correction and reports the existing toast. The model
browser opened from a draft edits that draft; the standalone browser still saves
changes immediately. Both browser entry points escape the settings stacking context.

OpenRouter's existing single-key API remains unchanged. Add and Replace open a
password field with Save/Cancel. As before, submitting clears the secret draft
immediately; asynchronous failures use the existing error toast. Cancel/Escape
clears an unsent secret without writing. Favorites and the Runtime harness choice
are untouched. The concurrent multi-key ticket owns additive account APIs and can
reuse this shell; this change does not implement that separate feature.

## Individual availability (2026-10-11)

Each saved language server also has a direct **Use [server]** switch in Providers.
It calls the existing server PATCH with only `enabled`; disabling and re-enabling
preserve its URL, secret, models and other configuration. This is app-wide. The
existing provider-wide switch remains authoritative, and the configure dialog
retains the same server setting. Existing engine placement/turn rules are unchanged.

Org Settings > Accounts controls each `langserver:<id>` lane's org-local `allowed`
preference through the existing disabled-accounts setting. The account-list response
adds optional `enabled` and `disabled_reason` fields for effective app-wide
availability (engine changes owned by the multiple-OpenRouter-keys ticket).
An app-disabled lane cannot be newly allowed here. A previously allowed lane stays
checked as the saved org preference, displays the global-disable reason, and can
still be revoked. Restoring global availability does not undo an org's revocation.
Older responses without those fields retain the prior controls. Provider feed
changes refresh the lane list; a rejected save retains the previous checkbox value.

These generic org controls cover OpenRouter keys as well. Their individual Providers
controls and backend lane metadata belong to the separate multi-key implementation.

Measured renderer follow-up: 15 language-server/org-account tests pass, including
independent off/on, secret/model preservation, org-only writes, globally-off guards,
legacy payloads and rejected saves. Typecheck passes. The synthetic visual fixture
is `provider-toggle` (optional third argument to the visual command below): it checks
five toggle states at two viewport sizes in dark/light (20/20 pass; desktop Providers
and narrow light Org Settings screenshots inspected). It checks switch bounds and
scroll reachability, not the pre-existing PinFrame header's negative-margin overflow.
No installed-app or engine integration claim is made for the new lane metadata.

## Verification

Measured on the renderer source with synthetic responses only:

- 35 focused tests pass: OpenRouter key entry/favorites/harness/usage, language-server
  edit and model browsers, plus add payload, Cancel, nested Escape, pending/rejected
  saves, portal placement and restored focus. Typecheck passes.
- Offscreen Electron renders the actual components and CSS at 1366×768 and 390×844,
  dark and light. All 16 add/edit cases fit inside the viewport, have no horizontal
  overflow, sit above Providers and have reachable actions after scrolling.
- Screenshots inspected, including narrow language-server actions and desktop
  OpenRouter/add-server forms. This is renderer fixture coverage, not an installed
  app or live provider acceptance run. No real key, model server or provider call.

Focused command: `node apps/desktop/renderer/tests/run.mjs openrouter langserver providerdialog`.
Set TEMP/TMP to the authorized build-output root. Visual fixture command:
`node apps/desktop/renderer/tests/provider-dialog-visual.mjs <build-output> <evidence-dir>`.
The fixture bundles only these components and uses the supported rig's offscreen
Electron driver; it starts no engine and closes the local fixture server on exit.

Local evidence: `D:\orgtree-work\provider-dialog-tests-final.log`,
`D:\orgtree-work\provider-dialog-typecheck.log`, and
`D:\orgtree-work\rig\agy-astra\provider-dialog-visual-final\result.json` with screenshots
under its `desktop` directory. No installer, live settings, or public release changed.
