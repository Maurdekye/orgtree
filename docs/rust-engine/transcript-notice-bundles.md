# Transcript notice bundles

User 2026-10-13 22:56Z requested inbox-like bundles in transcripts. The
23:01–23:02Z clarification limits this to **system-originated passive notices**.
The coordinator's intervening broader machine-message interpretation is superseded.
Waking messages, requests, review requests, user/agent notices, assistant output
and tool activity remain separate. Inbox eligibility and behavior are unchanged.

`events/systemruns.tsx` adapts wire rows to the existing `isSystemNotice` rule.
Mail preserves its explicit sender and passive flag. Notice-segment rows omit
sender/delivery: their notice container supplies passive delivery and a validated
engine-authored event supplies system provenance. Unknown rows without proven
system authorship stay visible; no body-text recognition is used. Ask/wait,
question and approval controls remain outside disclosures.

Presentation flattens delivered turn segments only after the desk's existing
deduplication. This permits adjacent notices to join across envelope boundaries,
without treating the envelope's `user` role as user authorship. Individual rows,
their timestamps, inner cards/actions and reply identity survive. Envelope reply
annotations and turn-jump anchors occur once; truncation/steering receipts stay
at the end. Hidden machine context remains hidden as before. Archives and shared
live segment rendering use the same component. Pending mail keeps its separately
approved six-row folding and never joins a settled bundle.

Two notices show a native keyboard-accessible details/summary, collapsed by
default. The first member keys the run. Single-to-multiple transitions and tail
appends keep children mounted; expanded state survives appends. The header uses
inbox classes/count styling and ellipsized kinds, with full accessible name.
Existing restart card styles stay on the children; a bundle containing a restart
also retains a red left edge. Reply/turn navigation reveals a containing bundle
before measuring or scrolling. Desk toggles reuse the current bottom-follow
policy, so deliberate upward reading remains respected.

## Verification handoff

Source-only author checkpoint, **not yet executed**: user centralized verification
with rig-opus. Run in the combined batch under its kernel Job/queue/output rules:

- Renderer typecheck (existing batch command), exit 0.
- `node apps/desktop/renderer/tests/run.mjs systemruns pendingrun eventtranscript transcriptviewport transcriptprepend sysnotice noticeborder restorenotice --output <fresh-C-output>`
  or the batch's equivalent explicit esbuild bundle/prebuilt runner using its
  provisioned dependencies. All selected tests must pass; `systemruns` has five
  focused cases, including actual DeskChat routing and modeled scroll intent.
- `node apps/desktop/renderer/tests/systemruns-visual.mjs <fresh-C-bundle-output> <D-evidence> <provisioned-node_modules>`
  inside the batch Job. Expect result.ok, dark/light collapsed and expanded PNGs,
  native Enter open/close, unchanged following-row position on collapsed append,
  and all full cards retained. The fixture uses real Msg/SystemRuns with synthetic
  rows, not a live agent or native installed app.

Source composition must preserve scratch-open-sol's pending ToolChip/tool_writing
and shell-error changes. This branch does not alter their dispatch or timing.
No native app, live traffic, engine changes, installation or publication is part
of this feature. Screenshot results and typecheck/test results remain pending
until the batch supplies actual receipts.
