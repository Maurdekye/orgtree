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
