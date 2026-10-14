# Panel widths and provider headings — 2026-10-14

User requests: document-sidebar collapse at a60%larger reading-box width,
model-family headers with dim harness names, and an App settings panel about10%
wider. The latter expressly asks to report remaining tab overflow without
changing labels or tab styling.

Documents use896CSSpx (formerly560); mail retains560 and inline galleries keep
their persistent list. Both org and agent gallery modals pass the new threshold.
Settings now use783px (formerly660, then726), scoped to `.settings.acct-panel`,
with the94vw cap and pinned-window sizing retained. This follows the user's
20:15UTC ruling to widen until the whole desktop tab row fits.

Provider headings: Claude · Claude Code, ChatGPT · Codex, Gemini · Antigravity,
Muse · Muse Code. Known providers use the same bold/dim slots; unknown-provider
fallback, status, IDs and controls retain their existing behavior. OpenRouter's
subtitle is REST API; per-key actual harness labels remain.

## Measured evidence and limits

Rig439 tested the composed batch `bc737c0`. The appsettings fixup `14e763e`
was picked patch-identically as `3e473ee`. Focused appsettings12/12, within its
34/34union. Panel suites59/59; red54/59, exactly five intended failures:
org/agent document collapse, family headers, OpenRouter header and the updated
Codex header in the usage-filtering case. No skipped/cancelled cases.

The original whole-base OpenRouter red source could not link against another
owner's changed key exports. The accepted composed control reverses only this
item's own header hunk from the composed OpenRouter file, retaining that owner's
new key API. Other red surfaces still use0f8638f. This is a composition adapter,
not a product change. The visual capture fixture also needed a fixed flex basis
to achieve its requested700/1000px mailer width; width plus flex-shrink alone
allowed the real flex row to grow it to1196px. Both original runner failures are
recorded separately from the accepted successful diagnostic phase.

Sixteen before/after actual-surface captures, light/dark, were produced with
synthetic HTTP only. The author inspected all16. Four receipts pass; no console
errors except Electron's filtered CSP warning. Measurements:

| Surface | Before | After | Outcome |
| --- | --- | --- | --- |
| Settings at1366×768 | 660px panel;596px tabs viewport | 726px panel;662px tabs viewport | exactly1.10×panel width;719px tab content still exceeds viewport by57px |
| Settings at390×844 | 366.59375px panel;303px tabs viewport | same | 94vw cap retained; tabs still scroll |
| Document reading box700px | list expanded | rail/toggle collapsed | requested new collapse behavior |
| Document reading box1000px | expanded | expanded | enough room above896px |

At the measured726px candidate **desktop tabs still did not fit**: About
remained beyond the visible row. Overflow improved from123px to57px. User
20:15UTC then authorized widening until they fit, keeping all tab labels,
padding and font unchanged. The new783px width is derived from measured719px
tab content plus64px panel chrome. The added proof checks its actual client /
scroll widths at1366×768 and1920×1080, with a one-pixel-smaller overflow control,
and rechecks390×844 for the unchanged94vw cap. Those new captures are pending;
the earlier16captures prove the726px candidate only.

The four after headings are checked in DOM receipts and focused tests. The
settings captures show the visible top sections. The OpenRouter fixture has no
keyed harness, so its REST API subtitle is identical before/after; removal of
the always-Claude-Code claim is established by the red test, not these images.

Evidence: `D:/orgtree-work/tmp/rig-opus/batch-439/logs/{cd-fix,d-panels-composed,d-panels-visual-diag}.log`
and `evidence/d-panels-diag/result.json` beneath the same batch directory.
Root/renderer/tests typechecks are pending the rig's final composed tip. No
installed/native-user acceptance, push, packaging or integration is claimed.
