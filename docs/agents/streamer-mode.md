# Streamer mode (4.5.5)

User scope: on-screen only (2026-11-02 m2656d00014b4), all listed sensitive
categories and surfaces (mc8e118c58de9), implementation authorized m0103b81de013.
The App menu placement and visible indicator follow the coordinator's provisional
default and remain flagged for user confirmation. Native-picker exclusion is the
coordinator's explicit 2026-11-02 me7e21312f674 decision. Per-surface opaque-cover
dismissal is the user's m84e04d547421 ruling.

## Boundaries

- `packages/contracts/streamer.ts` owns detection, known structured values and
  the conservative native text policy. It never rewrites domain payloads.
- `streamer-boundary.ts` walks displayed DOM text and installs CSS Highlight
  ranges. The original text nodes stay intact, including native selection/copy.
  Blocks delimit labelled secrets; inline fragments are scanned together.
  DOM updates are processed by a MutationObserver before the next paint.
  Form-value paint is hidden without changing `.value`; tooltip/accessible labels
  are temporarily generic and restored on disable. Background images and generated
  content are hidden while enabled. Unsupported Highlight API or incomplete known
  identities leaves the document covered with an accessible Turn off control.
- `streamer.ts` owns synchronized native preference/browser-storage state and
  all registered documents, including portal popouts. It ignores superseded
  preference loads/saves. `api.ts` and `appfeed.ts` collect known structured
  identities before consumer rendering. Known values remain renderer-local,
  unpersisted, and are not collected from engine credential stores.
- HTML/media DOM covers retain the original element/runtime. Native artifact
  viewers (which do not load React) receive a separate opaque WebContentsView
  before their content loads. It is an inert page with only a cancelled-navigation
  dismiss action and no app bridge. Dismissal affects that surface only and is
  reset on reopen or mode cycle. Native holding/recovery pages use the same cover.
- `streamer-native.ts` owns native title, menu, dialog and notice policy. Generic
  notification/title text never contains the original content; enabling closes
  retained notices. Native menus/dialogs keep callbacks and stable safe actions;
  uncertain labels are generic. Tray rows retain original navigation IDs while
  their names become generic; a mode change closes an already-open tray list.
  Conversion progress uses safe display text without changing conversion work.

## Explicit limits

Native OS file/open/save dialogs, including browser file inputs, are excluded and
are not blocked. Clipboard, links, submissions, stored data and agent context
retain originals. Opaque surfaces explicitly revealed by the user can show any
content. Recognition uses known structured identifiers plus conservative patterns;
an arbitrary unlabelled short string cannot be classified as a secret by syntax.
This is screen sharing assistance, not a data-access or credential security boundary.

## Evidence contract

The first test commit contains inert no-op feature interfaces, so the new tests
can execute against the pre-feature behavior rather than fail to import a missing
module. It does not activate a feature in the base application. `streamer.test.tsx`
checks each category across six DOM surface classes, split text/live changes,
original copy/editor/link data, fallback and cover lifetime. `streamernative.test.tsx`
checks native sinks/actions, picker exclusion, existing notices and native-view
covers. `streamerstate.test.tsx` covers preference races and popup synchronization.
`menumodes.test.tsx` is the shared menu contract from the attract-mode author.

These DOM tests prove ranges and state, not actual Chromium paint. Integration
must attempt one isolated, muted capture of real Highlight rendering, selected
text, editor masking, opaque/native covers and their dismiss/reset behavior. If
startup fails, record NOT_EXECUTED and seek coordinator disposition; do not claim
visual privacy was verified.
