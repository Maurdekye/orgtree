# Panel widths and provider headings — 2026-10-14

User requests: document-sidebar collapse at a60%larger reading-box width,
model-family headers with dim harness names, and an App settings panel about10%
wider. The latter expressly asks to report remaining tab overflow without
changing labels or tab styling.

Documents use896CSSpx (formerly560). User2026-10-14 23:07UTC subsequently asked
inbox to collapse at that same width: `NARROW_MAILER_WIDTH` now aliases
`NARROW_DOCS_WIDTH`, replacing mail's560px boundary. Both use the same overlay
list behavior, at or below896CSSpx of the `.mailer` reading box; wider boxes
keep two panes. The org and agent presentation modals retain896px. Inline desk
mail and galleries keep their persistent lists because they do not opt in.
Settings now use791px (formerly660/726/783), scoped to `.settings.acct-panel`,
with the94vw cap and pinned-window sizing retained. This follows the user's
20:15UTC ruling to widen until the whole desktop tab row fits and the coordinator's
20:21UTC refinement: add8px to the measured minimum for font/scaling variation.

Provider headings: Claude · Claude Code, ChatGPT · Codex, Gemini · Antigravity,
Muse · Muse Code. Known providers use the same bold/dim slots; unknown-provider
fallback, status, IDs and controls retain their existing behavior. OpenRouter's
subtitle is REST API; per-key actual harness labels remain.

## Measured evidence and limits

The inbox alignment is a later source hand-in; the Rig439 results below are
historical evidence for the earlier document-only change. The updated
`gallery.test.tsx` covers org and agent presentation modals, the default inbox
layout, and inline opt-outs at895/896/897px, plus700/1000px and the former
559/560/561px boundary. It checks the rail and retained list DOM through a
resize round trip. Widths are explicit jsdom/ResizeObserver inputs, not real
window geometry. Tests-only predecessor5b3184c retains the560px inbox and
should fail the mail case at896px; targeted batch execution is pending at
source hand-in. This adds no layout behavior beyond the threshold alignment.

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
and rechecks390×844 for the unchanged94vw cap. The earlier16captures prove
the726px candidate only; the new width has its own receipts below.

Rig439 at5677e87 (patch-identical802e3ff) ran the canonical width-only proof:
six passing light/dark captures, all inspected by the author. At1366×768 and
1920×1080 the783px panel has719px tab client and719px scroll width: all nine
tabs through About fit. The782px control has718px client versus719px content,
so783px is the measured smallest whole-pixel width for this harness. At390×844
the panel remains366.59375px (94vw), with303px tab client and719px content,
scrolling as before. Provider headings remain correct; at1920×1080 the four
sections' headings are visible in the inspected screenshots.

This fit has zero slack. The measurements use this harness's fonts and DPR1;
other font rasterisation or native Windows125%/150%scaling is unmeasured and
could differ by a pixel. Coordinator20:21UTC therefore directed an8px fixed
margin, raising the panel to791px without changing font/padding/labels. Rig439
at71aed01 (patch-identical7ce15be) passed the targeted1366×768 light/dark fit
proof:791px panel,727px tab client and727px scroll width, DPR1; both screenshots
inspected show allnine tabs with visible room after About. The old probe field
`tabSlack:0` cannot describe spare space: scrollWidth is at least clientWidth
even when the contents are shorter. The8px margin is inferred from727px client
minus719px content measured while overflowing, and is explicit in the CSS;
a direct last-tab edge-gap measurement has not run. Future probe metadata
uses `tabOverflow` and the last tab's right-edge gap instead. Existing fit
assertions and791px product are unchanged, so no repeat phase was requested.
Proof: `logs/d-panels-791.log` and `evidence/d-panels-791/result.json` under
the rig439 directory. The supported runner cannot set1.25/1.5device
scale: `tools/rig/desktop/main.cjs` fixes `force-device-scale-factor` to1 and
`page.resize` fixes CDP `deviceScaleFactor` to1; its page API exposes no scale
setter. No shared-runner change or substitute native-scaling claim is made.
The unchanged narrow94vw behavior and earlier wider-fit receipts remain.
Measured783px minimum proof:
`D:/orgtree-work/tmp/rig-opus/batch-439/logs/d-panels-783.log` and
`evidence/d-panels-783/result.json` under that same batch directory.

The four after headings are checked in DOM receipts and focused tests. The
settings captures show the visible top sections. The OpenRouter fixture has no
keyed harness, so its REST API subtitle is identical before/after; removal of
the always-Claude-Code claim is established by the red test, not these images.

Evidence: `D:/orgtree-work/tmp/rig-opus/batch-439/logs/{cd-fix,d-panels-composed,d-panels-visual-diag}.log`
and `evidence/d-panels-diag/result.json` beneath the same batch directory.
Root/renderer/tests typechecks are pending the rig's final composed tip. No
installed/native-user acceptance, push, packaging or integration is claimed.
