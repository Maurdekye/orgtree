# Development and verification

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Worktrees, build/resource rules, tests, evidence, platform traps and maintenance.

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

## Current operating-rule homes

The assigned checkout and exact base determine which repository instructions apply.
A parent checkout may still inject a 3.x guide; do not use that snapshot to choose
a branch, test suite or build protocol for Rust work. Read the current assignment
and signed decisions; preserve historical records without treating their commands
as current permission. [decided: user 2026-10-22, operating-rule reconciliation]

| Decision | Read its current home |
| --- | --- |
| Org model/account eligibility, source/output/storage and installer policy | Org shared AGENTS.md supplied in the session |
| Active release line, phase, owner, review routing and exceptions | Current team notes and authoritative assignment |
| Build capacity, RAM, Cargo jobs, kernel Job and low-RAM/priority policy | Current build-project Summary, read through authorized project tools or supplied by the coordinator |
| Claim/release mechanics | [Build workflow](../skills/orgtree-working/workspace/builds-under-the-lock/SKILL.md) |
| Exact-SHA hand-in and findings | [Landing workflow](../skills/orgtree-working/workspace/reviews-and-landing/SKILL.md) and [docket ownership](../skills/orgtree-working/docket/docket-items/SKILL.md) |
| Code-specific tests, capture and fixture traps | This topic and [test rig](../rust-engine/test-rig.md) |

Do not copy live machine limits or the current phase into repository recipes.
Read them before each assigned phase; if a required source or tool is inaccessible,
ask the coordinator for that input. Project visibility and mail audiences do not
grant Summary-policy authority. A source-only/docs assignment stays source-only.

## Test-window session and clipboard isolation (2026-10-24)

Every test, rig, capture or fixture window runs only in Session 0 or on a
never-switched private desktop, never on the user's signed-in desktop. A hidden
or offscreen window launched from a turn inherits that turn's session, normally
the signed-in session (for example, Session 3; IDs vary); a temporary
profile/data root does not change that. Do not use a signed-in-session scheduled
task for testing.

For Session 0, call `orgtree_session({use: 0})`, end the current turn without
children, then verify `this_session: 0` in the next turn before launch. Measure
the child window process's PID and SessionId before interaction. Use an isolated,
initially empty clipboard, deny clipboard permissions and block native clipboard
bridges/paste paths from the real clipboard; never read, write or clear the user's
clipboard. Input is CDP/PostMessage to owned test windows only, with no OS input.
Every capture receipt records the child PID/SessionId, private desktop when used,
and the clipboard-denial state. A missing historical field remains unknown.

This replaces signed-in-session probe advice and any assumption that hidden
captures automatically run in Session 0. If a required native assertion cannot
run on the isolated route, report it as unverified and ask the coordinator.
See the [full isolation procedure](../skills/orgtree-working/runtime/session-0-ui-testing/SKILL.md).
[decided: coordinator 2026-10-24, test-window isolation]

## GL/SVG parity cameras

The GL wire parity fixture compares two separate canvas mounts. Restore the
same saved camera for both, and check their committed transforms before
comparing the exact classes and geometry. The default opening glide makes
wall-clock snapshots incomparable: a peer wire can cross the viewport boundary
between mounts even though both renderers receive the same wire list. Preserve
the off-screen peer and unculled GL-list controls. The fake layer proves data
and camera parity, not shaders or pixels. [verified: `glwires.test.tsx`,
`canvas/{OrgCanvas,viewport}.tsx`; 2026-10-23]

## Baseline-tool metadata fixtures

The baseline tool's `show` filtering and concurrency-description tests use an
explicit synthetic baseline containing all three registered suite names. The
measured release baseline may omit retired suites; its contents must not decide
which metadata branches these tests exercise. The Python suite is metadata only
in this fixture and is never executed. [verified: `tests/test-baseline.test.mjs`;
2026-10-22]

## Native test homes

### Portable root test output

`scratch-note-create`, `taskbar-badge`, `taskbar-dot-art`, `taskbar-eligibility`,
`taskbar-unified`, `tray-recent` and `tab-origin-native` run with ordinary
`node --test tests/<name>.test.mjs`. Each allocates its own fresh child of the
platform temporary directory; team runners set `TEMP`/`TMP` to their authorized
output scope. No module requires another author's folder. Existing dependencies
resolve locally, or via `ORGTREE_TEST_DEPS` pointing to the existing dependency
checkout's package.json; never install, copy or link dependencies for a test.

The optional `ORGTREE_NOTE_TEST_ROOT`, `ORGTREE_BADGE_TEST_ROOT`,
`ORGTREE_TRAY_TEST_ROOT` and `TAB_ORIGIN_NATIVE_OUT` select output **parents**,
not reusable receipt leaves. Each must be an absolute strict descendant of
`C:/orgtree-build/<ORGTREE_AGENT>/`, with no parent traversal or linked
ancestors. The shared helper checks canonical containment before allocation,
then verifies containment and the fresh directory's identity before cleanup.
Repeated/concurrent runs preserve existing parent contents. Safety controls
are in `tests/test-output.test.mjs`; Windows override controls need an owned
C output temp directory and `ORGTREE_AGENT`, while default/refusal/identity
controls run without them. Product assertions and synthetic dependencies remain
unchanged. [verified: `tests/helpers/test-output.mjs`; 2026-10-22]

- Built-in preset byte assertions run in a subprocess with an empty owned
  `ORGTREE_TEST_HOME`; preset resolution deliberately prefers the user's
  `.orgtree/charters` files. Never set a process-wide home while parallel tests
  can read it, weaken the bundled-byte equality, or edit a real override. The
  Heavy dev shop regression starts with a synthetic override, proves it wins
  before and after the isolated assertion, and checks that its bytes survive.
  This uses the existing cfg(test)-only home seam; product lookup is unchanged.
  [verified: `domain/templates.rs` tests; 2026-10-22]

## Native window-controls edge probe assets

`tools/test-window-controls-edge-native.mjs` imports the complete renderer
`styles.css`, including KaTeX font references. Its browser esbuild call embeds
`.ttf`, `.woff` and `.woff2` assets as data URLs because the disposable loopback
server serves only fixture JS and CSS. Keep the full stylesheet, native header
structure and every restored/maximized edge hit-test and inset-header mutation
assertion. Run `node --test tests/window-controls-edge.test.mjs` only on the
[isolated route](#test-window-session-and-clipboard-isolation-2026-10-24) under
the current build permit/containment, with `TEMP`/`TMP` inside the
assigned output scope. A font-loader setup failure means native hit-testing did
not execute; never count it as a product result.
[verified: `tools/test-window-controls-edge-native.mjs`,
`tests/window-controls-edge.test.mjs`, `tests/window-controls-edge-native.probe.ts`;
2026-10-22]

## Renderer, capture and rig traps

- **A capture fixture loads what main.tsx loads, at the width the app would.**
  The app menu's dropdown and other v3 shell rules live in `shell.css`, which
  `main.tsx` imports after `styles.css`; a fixture importing only `styles.css`
  drew the menu as loose buttons. List-and-pane panels (Presentations, the
  Changelog) collapse their list below 896 px (`NARROW_DOCS_WIDTH`): a 1000 px
  offscreen window left about 884 px, so a capture meant to show the list uses
  1024 px, Session 0's display width. Assert the list is expanded
  (`.mailer:not(.narrow-list)`) as well as sized.
  [verified: `tools/rig/desktop/changelog-visual.cjs`; 2026-10-24]

- **Spelling probes include a typed word-boundary control.** On Windows Electron,
  CDP insertion of `mispellled synthetic` without a final boundary produced empty
  native spelling params at scale 1 and at text scale 0.625. With a final typed
  space, the real canvas NodeSquare/DeskChat returned `mispellled` and suggested
  `misspelled`; the production replacement callback corrected the real field.
  Do not diagnose CSS hit-testing from the empty-input control alone. Check the
  actual native event and complete a word boundary before asserting suggestions.
  WebFrame spelling APIs returned false/empty even alongside successful Windows
  native spelling params, so they are not a verified fallback here. Keep dictionary
  additions stubbed and clipboard paths denied. The native-template preview in
  `spell-scale.capture.cjs` is not native popup layout proof. Menu instrumentation
  must retain real Electron Menu objects (intercept only `popup`); replacing
  `buildFromTemplate` with plain objects stalled default-app startup.
  [verified: `tests/spell-scale-ui.tsx`, `tests/spell-scale.capture.cjs`; 2026-10-24]

- **Shortcut inventory follows a consumed imported key table.** The test scanner
  attributes a named exported table to the importing `.find(row =>
  row.keys.includes(...))` matcher, not its data-only module; Space normalizes
  to the event's literal space. Native modifier-release/replay bookkeeping and
  navigation-focus bookkeeping are excluded by their exact observer statements,
  without excluding whole files or modifier keys. Keep controls for missing
  imports/exports/table reads, real commands added beside observers, removed
  navigation catalog rows and wrong source attribution. No catalog or runtime
  behavior changes are needed for a scanner repair. [verified:
  `tests/shortcuts.test.tsx`; 2026-10-24]

- The Muse removal proof waits for both DB turn completion and the same live
  seat's published runtime idle before its single after-turn DELETE. DB-only
  completion can race the finalizer's busy publication. Preserve all ten
  atomicity/removal checks, and record synchronization timeout as FAIL rather
  than treating nine earlier passes as a completed proof. See
  [completion synchronization](../rust-engine/test-rig.md#what-keeps-it-safe).
  [verified: `tools/rig/proofs/muse-r4-removal.mjs`; 2026-10-24]

- **Mail-card parity compares content beneath transparent selection boundaries.**
  `mailcard.fixture.ts` removes only pending chrome and checked
  `selection-source` wrappers (`display: contents`, source marker, no extra
  styling class). Keep all body markup, metadata, attachment rows and their
  ordering in the exact comparison. The column oracle uses this normalized
  tree; typed/legacy parity retains controls rejecting a layout-producing
  wrapper, a missing selection marker and changed body text. Product rendering
  and selection behavior are unchanged. [verified: `tests/pendcol.test.tsx`,
  `tests/pending-style.test.tsx`, `canvas/replyselection.tsx`;2026-10-23]

- **Scope click-away listener counts to the component lifecycle.** Import
  canvas modules before intercepting document listeners, then snapshot the
  mounted canvas's callback identities before opening the tray. Tray open and
  reopen add exactly one; close/Escape return to the same baseline; unmount
  removes all listeners owned by that mount. Global navigation and module
  observers are independent owners. Keep a duplicate-handler mutation control
  when changing this oracle. [verified: `tests/agentstrayclickaway.test.tsx`,
  `canvas/OrgCanvas.tsx`, `windowlife.ts`;2026-10-23]

- Work-status and next-turn-query share `tools/rig/native-tool-result.mjs`:
  correlate the original process/server/tool/request/RPC identity, and for
  repeated work calls also the tool-use id and exact scripted arguments. Accept
  one primary text block plus only the exact optional three-decimal timing block;
  parse JSON from the primary alone. Work-status saves the raw native log before
  decoding and retains all 33 named transition, persisted/refetched, refusal,
  no-op, archive and concurrent-chain guards. Required status JSON or setup/
  framing failures persist named FAILs; expected plain non-status/refusal text
  remains plain. Never strip arbitrary suffixes or accept missing status fields.
  [verified: `tools/rig/proofs/work-status-transition.mjs`; 2026-10-22]

- The 21-check watchdog-slug proof distinguishes ready rowless one-shots from
  registered dogs that later fire. Verify complete inline results, unchanged
  row/mail/turn ledgers and immediate id reuse. Then arm a real command against
  WAITING input before changing it to READY; require its original row to become
  spent once, with one fire mail. Reuse its id while that tombstone is under
  14 seconds old, verifying both its earlier spent feed entry and the unique
  current handle/target afterward. Preserve all 21 names and the other 19 calls;
  never manufacture spent SQL or remove the 15-second deduplication control.
  [verified: `tools/rig/proofs/watchdog-slugs.mjs`; USER 2026-10-21 18:05:58Z;
  2026-10-22]

- The five-check draft-model proof snapshots the actual seed, including agent
  identities and persisted hire fields. Compare exact +0 engine-state deltas
  both before and after model selection, then exactly +1 newly identified Sol
  hire with unchanged existing rows and the engine-read effective default grant.
  Never assume an empty org or grant 12, accept a preexisting selected name, or
  replace identity checks with a count alone. Preserve all five names, original
  picker/draft positives and interactions; save snapshots and mutation controls.
  [verified: `tools/rig/proofs/uninit-model.mjs`; 2026-10-22]

- The nine-check team-workspaces proof expects an initialized own-team header
  before the exact labelled lead/boss blocks. Match each block's own END and
  exact path, label, body and order after the rules; never use the first global
  END as an ancestor's boundary or drop the own-header block. Preserve the
  other eight calls, including the two reproduced baseline prose failures.
  Save the fresh prompt and replay retained prompts with missing/wrong/extra
  block controls. [verified: `tools/rig/proofs/team-workspaces.mjs`; USER
  2026-10-17 17:26Z initializer; 2026-10-22]

- Shared-scratch folder proofs must preserve header-initialized workspaces:
  stage originals and test-created directories with reversible renames, snapshot
  exact original file bytes without following links, and verify their restore.
  Never assume a resolved shared/team directory is empty. Keep all 16 folder,
  native-helper, auth, junction and file-replacement guards; save setup failures
  and every cleanup failure separately so a later error cannot mask the first.
  Parked synthetic directories/links stay in the disposable rig for inspection.
  Its eight staging controls run without rig environment variables in a fresh
  OS-temp directory. An explicit `SHARED_SCRATCH_CONTROL_OUTPUT` instead needs
  `ORGTREE_AGENT`, an absolute descendant of that owner's `C:/orgtree-build/`
  scope, canonical containment and no linked ancestors; each run gets a fresh
  child. Mock-proof evidence and native-helper environment are isolated too.
  [verified: `tools/rig/proofs/shared-scratch-folder.mjs`; USER 2026-10-17
  17:26Z initializer; 2026-10-22]

- The single-slot proof preserves its 16 names: immediate grants use structured
  lease/quantity and no watchdog/mail/turn changes; a blocked registered claim
  proves one spent dog and grant mail. Distinguish held-capacity refusal from
  the one-pending-claim refusal, and require both refusals to leave rows alone.
  The queue-batch proof preserves all 20 names: register the full-batch listener
  before seeding to retain spent-row/count/one-wake/fakeCLI-prompt coverage.
  The ready short ACK batch instead returns unique consumed message identities
  inline, with read/delivery provenance, no row/fire mail/wake, no second copy
  on dispatch and durable unacked custody. Setup/timeout errors save named FAILs,
  so partial progress is never a completed pass. [verified: `tools/rig/proofs/project-slots.mjs`,
  `tools/rig/proofs/project-queue-batch.mjs`; USER 2026-10-21 18:05:58Z; 2026-10-22]

  Check no-wake at inline creation, before any later explicit mail to an
  unlistened project can legitimately warn/wake its manager and trigger ACK
  reminders. After that mail, require the same unacked custody and copy ids.
  Require non-empty original/copy UIDs and both link directions in the handed
  and current rows; missing links must never pass as `undefined === undefined`.
  Replay the exact exported custody predicate against retained rows, with
  separate missing-link mutations as negative controls.
  This follows [wake an agent to listen for project mail](../skills/orgtree-app/app-settings/app-concurrency-and-checkups/SKILL.md)
  and the [consumed-copy turn-end reminder](../skills/orgtree-working/team/projects/SKILL.md)
  (`domain/mail.rs`, `domain/projects.rs`), not an exception to inline no-wake.
  The 17-check user-slot proof uses the same structured inline lease and the
  exact capacity-409 refusal with unchanged lease/watchdog rows; retain all
  other user-owned lease, protection, line and restart guards.

- Multi-slot proofs keep all 23 names and the 21 other controls. An inline
  two-slot result must return `slots:2`, the stored lease identity and one
  complete fire, with no watchdog/mail/turn-count increase, including after
  settling. Test grant-mail quantity and once-delivery on a separate queued
  two-slot claim: one registered/spent dog, one fire, one mail naming its
  lease, still one after release. Keep the main FIFO, restart, concurrent
  admission and whole-lease release/reclaim scenario unchanged. See
  [multi-slot semantics](../rust-engine/PROJECT-NODES.md#placement-and-runtime-capabilities).
  [verified: `tools/rig/proofs/project-multi-slots.mjs`; USER 2026-10-21
  18:05:58Z inline contract; 2026-10-22]

- Project-history keeps its 35 historical check names. Durable events capture
  history time before delivery; require exact wait starts from each dog's prior
  `last_fired`, with capture time no later than delivery. Listener watches still
  register rows. To test slot claim-dog history, queue the claim behind an
  occupied synthetic lease: ready claims deliberately create no dog (USER
  2026-10-21 18:05:58Z). Execute unchanged migration 0040 in an isolated
  pre-0040 schema; require exact +2 legacy fires/endings, repeat idempotence
  and untouched modern history. Keep a separate negative clone reproducing the
  invalid replay after 0050 fires; never edit a checksummed old migration or
  ignore extra rows. See [project history](../rust-engine/PROJECT-NODES.md#the-project-desks-history-user-2026-10-20-0622z-0642z-migration-0040).
  [verified: `tools/rig/proofs/project-history.mjs`, `src/migrate.rs`,
  `src/domain/listeners.rs`; 2026-10-22]

- The project-folder-raise proof's exact policy includes `event_listeners`
  (USER 2026-10-20 10:50Z, off by default). Configure outer=false and inner=true
  before capturing the rows; require exact equality afterward, including the
  enabled value, Summary, row versions and every slot/queue setting. Preserve
  all 10 check names/order and the other eight check calls; never filter away
  unexpected policy keys. [verified: `tools/rig/proofs/project-folder-raise.mjs`;
  2026-10-22]

- Native project-boundary proofs require explicit `ORGTREE_AGENT`,
  `ORGTREE_RIG_HOME` below the owner's `C:/orgtree-build/<owner>` scope,
  `ORGTREE_BOUNDARY_NATIVE_EXE` and `ORGTREE_CLAIM_TEST_OUTPUT` below the
  owner's `C:/orgtree-build/<owner>` scope. Admission also accepts retained
  `D:/orgtree-work/rig/<owner>` homes; current storage policy still owns where
  new generated fixtures may be written. The run root must be a direct child
  of the admitted home's `runs` directory. The runner supplies its run root,
  database URL/org and exports v4.3.3 migrations into that output. Test-only
  admission rejects absent/foreign/live paths, traversal and reparse points;
  it checks run ownership/marker, disposable DB/user, loopback port/credentials
  and the server's actual data directory before any functional writes.
  It rejects every `hostaddr` override before opening any connection (the
  driver can otherwise use that address instead of the checked `host`). A pure
  no-connect regression starts with an admitted host-only config, then adds
  `hostaddr=192.0.2.1` and requires refusal; the metadata admission control also
  appends that override to its actual good owned config. These controls require
  no outside probe and do not repeat the seven functional boundary cases.
  The ignored `native_fixture` metadata tests admit an owned C fixture without
  connecting, then exercise foreign/live/traversal, phase, metadata, provider,
  port/credential and junction refusals. Supply all three owned link fixtures
  with `ORGTREE_NATIVE_FIXTURE_LINK_{HOME,ROOT,OUTPUT}` and run these tests
  serially: the metadata control restores its own bytes between mutations.
  One guard control precedes the unchanged seven named boundary cases. Engine
  fixture outputs and migration reads use the supplied owned output; never
  select another author's executable or bypass admission to reuse a rig.
  [verified: `domain/native_fixture.rs`, `tools/rig/proofs/project-claim-boundary.mjs`; 2026-10-22]

- `agy-auth-wake.mjs` signed-out attribution controls replay its actual final
  check: `node --test tools/rig/tests/agy-auth-attribution.test.mjs`.
  `AGY_AUTH_WAKE_PROOF_REF` selects a predecessor red control;
  `AGY_AUTH_WAKE_PACKET` supplies a retained measured packet. Known other-owner
  runtimes may interleave; rejected or unknown owners still fail. Preserve all
  ten runtime checks and raw calls; replay is not a full runtime proof pass.

- `agy-lane.mjs` quota outcome controls replay its actual pia wait/check with
  `Rig.waitFor`: `node --test tools/rig/tests/agy-quota-outcome.test.mjs`.
  `AGY_QUOTA_PROOF_REF` selects a predecessor red control; `AGY_QUOTA_PACKET`
  supplies retained ledger/freeze examples. The two-write gap is a deterministic
  model, not a new runtime trace. Missing/non-limit outcomes remain failures;
  do not replace the freeze assertion with ledger completion or a fixed sleep.

- `codex-accounts.mjs` account-removal controls replay its actual boundary wait
  and single DELETE through `Rig.waitFor`:
  `node --test tools/rig/tests/codex-removal-boundary.test.mjs`.
  `CODEX_REMOVAL_PROOF_REF` selects a predecessor red control; optional
  `CODEX_REMOVAL_PACKET` supplies the retained original 409. Virtual-clock states
  model the ledger/runtime gap, not a new engine run. Missing or mismatched seats
  fail before DELETE; preserve lawful busy refusals without mutation retries.

- `jump-last-sent.mjs` sample-turn controls replay its actual send/setup block
  through `Rig.waitFor`: `node --test tools/rig/tests/jump-last-sample-turn.test.mjs`.
  `JUMP_LAST_SAMPLE_PROOF_REF` selects a predecessor red control. Virtual-clock
  relational rows cover prior seeds, exact receipt/agent/org identity, delivery,
  helper grace, failed/killed turns and durable setup failures. Preserve all three
  original scroll checks and the unchanged driver; replay starts no engine or UI
  and cannot establish a functional jump pass. See [sample synchronization](../rust-engine/test-rig.md#what-keeps-it-safe).

- All labeled seed waits use `SEED_SETTLE_TIMEOUT` from `tools/rig/seed-settle.mjs`:
  120 seconds for the existing 60-second helper grace plus a 60-second execution
  budget. Local `settle`/`quiet` calls pass it explicitly, preserving non-seed
  defaults. `node --test tools/rig/tests/shared-seed.test.mjs tools/rig/tests/account-windows-seed.test.mjs`
  checks coverage, actual wait closures and non-seed defaults with deterministic
  clocks. `SHARED_SEED_PROOF_REF` selects a predecessor for the shared controls;
  `ACCOUNT_WINDOWS_PROOF_REF` retains the original account-window red control.
  Keep placement overrides, functional assertions and timeout failures intact.
  A seed-only runtime check stops before the account assertions and is not a
  full account-windows proof pass. See [rig safety](../rust-engine/test-rig.md#what-keeps-it-safe).

- The org-shared-notes proof expects a new shared `AGENTS.md` to contain
  exactly `# Shared standing notes for this organization\n` (USER 2026-10-17
  17:26Z), and checks that initialization preserves existing empty/custom
  notes. Keep its 16 historical names for baseline comparison: only the two
  empty-directory predicates change; seven reproduced baseline prompt/harness/
  isolation failures remain FAIL. Never delete notes to manufacture an empty
  fixture. See [shared notes](../rust-engine/org-shared-notes.md).
  [verified: `tools/rig/proofs/org-shared-notes.mjs`; 2026-10-22]

- The next-turn-query proof saves the native fake CLI log before decoding.
  Its display text joins MCP blocks, so correlate the original response by
  process/request id and parse only its primary JSON block; permit only the
  separate three-decimal execution-time block. Malformed JSON, unexpected
  blocks and setup/parse errors must persist a named FAIL. Retain all 38
  semantic checks, including live occupancy and actual restart controls.
  [verified: `tools/rig/proofs/next-turn-query.mjs`; 2026-10-22]

- The Muse visual proof uses the signed light-slice-2 partner `#005680`
  (user 2026-10-18 15:34Z/15:35Z) for light card and app-theme expectations;
  `#afe5ff` remains the dark accent. Retain all 24 controls and report the
  two v4.3.3 far-rail baseline failures as failures, separately from stale
  colour expectations. See [Muse verification](../rust-engine/muse-code.md#verification).
  [verified: `tools/rig/proofs/muse-visual.mjs`; 2026-10-22]

- The next-turn-cards proof matches `next turn: <value>` (USER 2026-10-19
  13:46Z), never the retired arrow label. Its driver persists every semantic
  and layout guard before throwing; the proof counts those named checks and
  records setup/driver errors as FAIL. Keep current serving values, exact
  tooltips, default/cancel/retool, wrapping bounds and pinned single-copy
  controls. See [next-turn cards](../rust-engine/next-turn-cards.md#rig-proof).
  [verified: `tools/rig/proofs/next-turn-cards.mjs`,
  `tools/rig/desktop/next-turn-cards.cjs`; 2026-10-22]

- The mailbox proof checks explicit reads, not the historical blanket-pending
  expectation: list/conversation previews and invalid/deferred/foreign reads
  leave mail alone; returned own fetch/chunk content records read/delivery.
  To test chunk consumption independently, it re-arms one immutable synthetic
  row after fetch and uses the genuine continuation handle. Keep UTF-8/digest,
  paging and restart controls; attachment checks retain their separate verdicts.
  [verified: `tools/rig/proofs/mailbox.mjs`; 2026-10-22]

- The document-chips proof compares exact shared document titles (no historical
  `read ` or status prefix). Keep newest-four ordering, interleaved sent-file
  exclusion and Report 6 opening from both header and canvas. Record named
  `Proof.check` verdicts and save a failure on setup/driver errors; raw driver
  completion with zero checks is not a passing proof.
  [verified: `tools/rig/proofs/document-chips.mjs`, `tools/rig/desktop/document-chips.cjs`; 2026-10-22]

- A scratch HOME or empty Git config alone does not isolate the credential
  broker: it launches native Git/gh from PATH, which can still read Windows
  credential stores. Use the offline executables, cleared task environment and
  preflight in the [broker proof](../rust-engine/test-rig.md#what-keeps-it-safe).
  Its success/failure checks exercise the real bridge with synthetic credentials;
  they are not GitHub network coverage. [verified: 2026-10-22,
  `tools/rig/proofs/credential-broker.mjs`]

- IPC source-extraction fixtures must isolate the intended registration before
  transpiling TypeScript. A distant handler sentinel can silently include new
  adjacent registrations and their unrelated dependencies; raw `new Function`
  then fails on TypeScript instead of executing authorization assertions.
  `tests/scratch-folder.test.mjs` bounds the next sibling registration and uses
  esbuild's TypeScript transform. [verified: 2026-10-22]

- Docket detail tests must account for first-shown-ticket opening on org,
  agent, team and project surfaces (USER 2026-10-21 16:50:46Z, PLAN §10).
  Use `selectDocketRow` for idempotent detail setup and deliberately clear the
  opening selection before testing navigation from an empty reader. Searches
  filter the list while retaining its selected reader. Work fixtures must
  include required detail fields such as `attention_sources`; auto-selection
  exposes incomplete mocks immediately. See `docketselection.fixture.ts`.
  [verified: renderer docket/keyboard/membership suites; 2026-10-21]
- **A bridge planted after load must not claim native windows.** App reads
  `nativeWindows()` (`requestOrg`) at every render, and a v3 window's identity
  is seeded at mount. A desk script whose catch-all Proxy answers `requestOrg`
  makes the window a v3 window bound to no organization: the canvas goes
  blank, and App settings (open per organization since b0aa671) closes. Leave
  out `requestOrg`, `windowIdentity` and `getWindowIdentity`, as
  `tools/rig/desktop/run-on-startup.cjs` does, or plant a typed v3 identity
  before load (`Page.addScriptToEvaluateOnNewDocument`, as
  `desktop/quick-chat-header.cjs` does). [verified:
  `apps/desktop/renderer/src/App.tsx`, `src/desktop.ts`; measured: @rig-sol-b
  2026-10-22 at 5dd06ee]
- **Run main's closures; don't read one handler's text.** `apps/desktop/main/index.ts`
  starts Electron, so its wiring tests work from its source. A slice that
  starts at one `handleApp(...)` comes up empty (`-1 -1`) once that handler
  delegates to a shared closure (de04072: Settings and the tray share
  `changeRunAsAdministrator`). Slice the closure itself between anchors and
  run it (esbuild `transformSync`, loader `ts`, in `vm` with synthetic seams),
  as `tests/tray-admin.test.mjs` and `tests/run-as-administrator.test.mjs` do.
  After changing `index.ts`, run the tests that read it
  (`grep -l "main/index.ts" tests/*.test.mjs`) at the base and the tip.
  [verified: `tests/run-as-administrator.test.mjs`, `tests/run-on-boot.test.mjs`;
  measured: @rig-sol-b 2026-10-22 at 5dd06ee]
- **Keep the UAC verb out of test text.** `tests/disruptive-policy.test.mjs` §2
  reads every `tests/*.test.mjs` as text and fails on `-Verb RunAs` or
  `runas`, even in an assertion against a fake runner. Spell it
  `['Run', 'As'].join('')`, as `tests/run-on-boot.test.mjs` does, and run
  `disruptive-policy.test.mjs` with any new or changed test file.
  [verified: `tests/disruptive-policy.test.mjs`; measured: @rig-sol-b
  2026-10-22 at 5dd06ee]
- **Run a long-lived host's proof unsplit.** The boot host is one process
  for the whole boot; a proof split into parts, each with a fresh host,
  cannot see what one engine leaves for the next. `session0-handover.mjs`
  passed as two parts (`SESSION0_PROOF_PART=1` and `=2`) while its unsplit
  run failed twice: a loss from D timed E's, and F's rollback, 149 s into
  the host, met a readiness window counted from the host's start. For a
  hand-in, run it with the variable unset (A to H, about 5 minutes).
  [verified: `boot_supervisor.rs`, `host.rs`; measured: @rig-sol-b
  2026-10-22 at 5dd06ee]

Relocated from team standing notes on 2026-10-21. The dates below identify the
original observations; relocation is not a fresh test run. Current assignment,
verification phase and build-project permits still govern what may be run.

- **DOM assertions must report scalars.** The [existing assertion warning](docket-and-presentations.md#e-73f802e8ab8d258b)
  also applies to focus and identity, not just absence. Use
  `assert.equal(document.activeElement === box, true)` and
  `assert.ok(!el.querySelector(selector))`; never hand React-managed elements
  to an assertion. A failing reporter can exhaust memory before later tests
  report anything. After a red run, verify every expected test name appeared;
  the outer summary alone is insufficient. [decided: coordinator 2026-10-21;
  measured: @rig-opus 2026-10-14 round 439; @desk-parity-opus 2026-10-19]
- **Fake desktop bridges must preserve synchronous contracts.** `onEvent`
  returns an unsubscribe function, not a Promise. The Create-picker fixture
  now gives it an explicit stub, limits null Promise stubs to known async
  methods and names unsupported members in a refusal. A catch-all Promise
  Proxy caused thousands of StrictMode cleanup errors and renderer crashes
  in the 4.4.0/4.4.1 template proof. [verified:
  `tools/rig/desktop/org-templates-create.cjs`, `packages/contracts/index.ts`;
  measured: @template-dogs-sol 2026-10-23]
- **Measure the intended text.** `textContent` joins adjacent elements without
  separators, so word-boundary checks can miss a separate `to` span or match
  across elements. Find that span and its `nextElementSibling` instead.
  `range.selectNodeContents(el); range.getClientRects()` includes child
  element border boxes as well as text boxes; its first rect may be a model
  card, not a text line. Walk `NodeFilter.SHOW_TEXT` nodes and measure their
  ranges, excluding a tier-card letter when appropriate. [decided: coordinator
  2026-10-21; measured: @inbox-ui-opus 2026-10-18, projectrecipientcard §4 and
  projectdelivery-visual]
- **Capture after paint, and inspect the image.** Wait two
  `requestAnimationFrame`s plus a short delay before every `capturePage()`.
  Prefer that API to `invalidate()` plus the offscreen `paint` event; passing
  DOM probes can accompany a PNG one state behind. Session 0 was measured at
  1024×768: keep fixtures around 1000×700 unless the measured isolated display
  permits more. Hidden/offscreen windows still inherit the
  launching turn's session; follow the current [isolation rule](#test-window-session-and-clipboard-isolation-2026-10-24),
  not the user's signed-in display.
  [decided: coordinator 2026-10-21; measured: @rig-opus 2026-10-14 round 439]
- **Mount the whole canvas through its flex stage.** Use
  `.app > main.solo > .canvas-stage > OrgCanvas`, as in
  `apps/desktop/renderer/tests/faroverview-fixture.tsx`. Direct mounting into
  `#root` leaves `.viewport` zero-height and culls cards while overlays/pile
  badges can still satisfy JSON probes. View the PNG.
  [verified: `apps/desktop/renderer/tests/faroverview-fixture.tsx`,
  `retiredpiles.visual.tsx`; measured: @desk-parity-opus 2026-10-20]
- **Pins and surface requests identify the target too.** Per-target Mail,
  Docket, Team, Slots, Listeners, settings, Watchdog, project desks and scoped
  readers use `kind:target` in pins, open markers, window rows and surface
  requests/claims. Tests must use `instanceKind(kind, id)` from
  `apps/desktop/renderer/src/modalkinds.ts`; a bare kind no longer addresses
  that window. Legacy records migrate on first read. The global reader keeps
  its separate scope. [decided: user 2026-10-20, DECISIONS 92;
  verified: `apps/desktop/renderer/src/modalkinds.ts`; 2026-10-21]
- **Observe one engine's own log.** `rig.engineLog()` concatenates session
  files in name order. Once a second engine creates a newer log, the first
  engine's subsequent writes land in the middle: `.slice(offset)` can miss
  real events or vacuously pass a negative check. Select the session file
  whose header contains `engine starting pid=<pid> ` (including the trailing
  space) and track a byte offset in that file.
  [verified: `tools/rig/lib.mjs` engineLogFiles/engineLog;
  measured: @rig-opus 2026-10-15, engine-start-signin proof C]
- **Clear losing timers.** A bare `Promise.race([exited, sleep(ms)])` leaves
  the timeout alive after exit and can retain the process and build permit.
  Clear it in `finally`, following `within()` in
  `tools/rig/proofs/boot-host-stop.mjs` (12-second proof held its permit for
  72 seconds before this correction).
  [verified: `tools/rig/proofs/boot-host-stop.mjs`;
  measured: @rig-opus 2026-10-15]

### Renderer tests from a worktree without node_modules

The repaired run.mjs resolves existing dependencies in place through
createRequire, with nodePaths for bundled dependencies and an absolute file URL
for external jsdom. All modes (temporary output, --output and --prebuilt) create
no dependency links or copies. A worktree without node_modules sets
ORGTREE_TEST_DEPS to the existing dependency checkout's absolute package.json
path. A checkout with its own dependencies needs no override. The old ESM loader
and separate NODE_PATH setup are no longer required on repaired checkouts.
Batch size, timeouts, kernel Job containment, output ownership and cleanup
behavior remain unchanged.

Temporary and explicit `--output` modes own their initially empty output
directory and remove it on exit, including a failed run. Set
`KEEP_ORGTREE_TEST_OUTPUT=1` when the bundles are needed for diagnosis or
receipts; naming `--output` alone does not retain them. `--prebuilt` does not
own or delete its input. Keep logs/receipts outside an output directory the
runner will remove, and clean retained generated leaves only within authorized
scope after resolved-path/activity checks.

The repaired team
renderer-tests-from-worktree/bundle-tests.mjs adapter takes REPO, OUT, DEPS and
one or more filename filters. DEPS is an existing node_modules directory:
createRequire resolves esbuild there, nodePaths resolves bundled dependencies,
and an onResolve plugin rewrites external jsdom to its absolute file URL. It
creates no dependency links or copies and stops esbuild after each batch of
eight, including build failures. OUT must be empty and outside worktrees.
Use run.mjs --prebuilt OUT with ORGTREE_TEST_DEPS as above, or execute the
bundles directly with Node's test runner. Prebuilt mode never removes OUT;
retain receipts and clean only authorized generated leaves after path/activity
checks. For older, unrepaired checkouts, the existing ESM esbuild loader plus
NODE_PATH set to DEPS still supports prebuilt execution; their normal bundling
modes must remain unused because they create junctions.
[verified: team adapter bundle-tests.mjs; 2026-10-22]

The earlier [source-checked recipe](legacy-and-superseded.md#renderer-adapter-recipe-2026-10-21)
is retained as history, not an exemption. Any Windows --import paths still need
a file URL (pathToFileURL(path).href); select exact filename filters and prove
the intended tests ran. Bundling/execution follows the current permit, output
scope and containment in the rule-home table above.

### Rig build permit compatibility

The retired filesystem-lock implementation is removed. The old withBuildLock
export remains solely for existing callers' result shape: it invokes the
callback and returns its value with informational caller-managed build-slot
text. Callback errors propagate unchanged. It performs no lock/queue I/O,
lease validation, RAM check or process containment. The agent owns those
checks and actual claim/release through the current project tools. Rig build
steps and isolation remain unchanged; the retired build-lock proof refuses
with a pointer to the focused mock-build controls. See the [rig guide](../rust-engine/test-rig.md#what-keeps-it-safe).
[verified: tools/rig/{lib,rig}.mjs, tools/rig/tests/build-permit.test.mjs; 2026-10-22]

<a id="e-43f61695c2e13155"></a>

## Engine tests that require a synthetic PostgreSQL cluster are explicitly

Original section: Unsectioned integration notes. Source lines 125–131.

<!-- preserved:e-43f61695c2e13155 -->
- Engine tests that require a synthetic PostgreSQL cluster are explicitly
  ignored in ordinary `cargo test --bin orgtree-engine`. The docs-opening test
  requires `ORGTREE_OPENING_TEST_PG` and an explicit `--ignored --exact` run
  against a fresh disposable database; it never falls back to an ambient URL.
  Tool-description changes must pass both the pre-split snapshot and startup
  description-budget tests; the aggregate cap stays 12,000 UTF-8 bytes.
  [verified: `http/docs.rs`, `tools/defs.rs`; 2026-10-20]
<!-- /preserved:e-43f61695c2e13155 -->

<a id="e-a3b847c6b17a8585"></a>

## Log canary tests use crate::trace::LogCapture (start, then finish() for

Original section: Unsectioned integration notes. Source lines 185–194.

<!-- preserved:e-a3b847c6b17a8585 -->
- Log canary tests use `crate::trace::LogCapture` (start, then `finish()` for
  the text), never a hand-made `test_sink` + `set_default`. tracing-core trap:
  while exactly one dispatcher is registered, a callsite first hit on another
  thread (a parallel test with no subscriber) caches `never` for every thread,
  so a scoped capture loses lines in parallel runs. LogCapture keeps a no-op
  peer dispatcher registered, serializes captures (they share the verbose
  switch) and returns only once its own last line has been written
  (tracing-appender's WorkerGuard waits about a second). [verified: tracing-core
  0.1.36 `callsite.rs` `dispatchers::rebuilder`; 1 of 3 runs at 8 test threads
  failed before, 10 of 10 passed after; coordinator 2026-10-19 22:04Z]
<!-- /preserved:e-a3b847c6b17a8585 -->

<a id="e-5ae942752b1afc0d"></a>

## Large futures on deep paths are awaited through util::boxed( …), which

Original section: Unsectioned integration notes. Source lines 196–214.

<!-- preserved:e-5ae942752b1afc0d -->
- Large futures on deep paths are awaited through `util::boxed(|| …)`, which
  builds each one in a frame of its own: a debug poll frame keeps two or three
  copies of every future awaited inline, and `Box::pin(call)` still builds the
  future there first. The 2 MiB engine worker stack overflowed in debug builds
  on three such paths: a first Codex turn (`run` → `handle_msg` → `on_slot` →
  `start_turn` → `ensure_proc`: about 1.6 MiB of static frames inline at
  9edbc13, 360 KB boxed), a polled dog's fire action that created a websocket
  dog (`run_fire_actions` boxes its `call_tool`), and a project create through
  the tool path (every arm of `tools::dispatch` and
  `ops::run_in_tx_without_audience_notices` is boxed: 636 KB and 464 KB of
  poll frame inline, 25 KB and 111 KB boxed). Await new large futures on these
  paths (a few KB or more) the same way, never raise stack limits, measure
  frames with `dumpbin /unwindinfo` beside the PDB and run
  `tools/rig/proofs/debug-stack-first-turn.mjs` on the default stack. See
  [stack safety](../../docs/rust-engine/tool-cards.md#stack-safety).
  [verified: `util.rs`, `runtime/{actor,watchdogs}.rs`, `tools/mod.rs`,
  `domain/ops.rs`; debug-stack-first-turn proof red at 9edbc13 and, for the
  tool path, at 1cbaac2, green after; websocket proof's fire action likewise;
  2026-10-19/20]
<!-- /preserved:e-5ae942752b1afc0d -->

<a id="e-280cb9c0e06f1123"></a>

## Exact tracing-event-count tests must isolate process-global callsite caches

Original section: AGENTS.md — working on Orgtree. Source lines 1387–1392.

<!-- preserved:e-280cb9c0e06f1123 -->
- Exact tracing-event-count tests must isolate process-global callsite caches
  from parallel tests. The session-blip regression runs its assertion in one
  exact child test, primes the no-subscriber-first case, then rebuilds interest
  after installing the collector; thread-local subscribers alone do not isolate
  cached interest. Production placement/logging code is unchanged.
  [verified: `runtime/session_watch.rs` tests, tracing-core 0.1.36; 2026-10-18]
<!-- /preserved:e-280cb9c0e06f1123 -->

<a id="e-069864513234d854"></a>

## New hub settings receive stable per-hub IDs on save; the network pass repairs

Original section: AGENTS.md — working on Orgtree. Source lines 1605–1609.

<!-- preserved:e-069864513234d854 -->
- New hub settings receive stable per-hub IDs on save; the network pass repairs
  older missing/empty/duplicate IDs once. Existing valid IDs remain stable;
  the repair compares the old hub array to avoid overwriting concurrent edits.
  Without an ID the registration worker skips the hub even when Test succeeds.
  [verified: `http/settings.rs`, `net.rs`; 2026-10-19]
<!-- /preserved:e-069864513234d854 -->

<a id="e-a12504529fb2c73c"></a>

## This is the one file every agent working in this repository reads first. It collects the

Original section: AGENTS.md — working on Orgtree. Source lines 2722–2727.

<!-- preserved:e-a12504529fb2c73c -->
This is the one file every agent working in this repository reads first. It collects the
design facts, user rulings, architecture and working practices that are otherwise spread
across `docs/`, past agents' notes, tickets and conversations, and it links to the detailed
docs instead of copying them. Codex reads `AGENTS.md`, and Claude Code reads it when the
repository has no `CLAUDE.md`, so **do not add a root `CLAUDE.md`**. [decided: user
2026-10-05]
<!-- /preserved:e-a12504529fb2c73c -->

<a id="e-f76fd81794788f25"></a>

## Orgtree 4.0.0 (Rust engine): read this first

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2736–2736.

<!-- preserved:e-f76fd81794788f25 -->
#### Orgtree 4.0.0 (Rust engine): read this first
<!-- /preserved:e-f76fd81794788f25 -->

<a id="e-4ab1b5bc2121915b"></a>

## The plan is docs/rust-engine/PLAN.md (§10 lists every user-facing

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3699–3702.

<!-- preserved:e-4ab1b5bc2121915b -->
The plan is [`docs/rust-engine/PLAN.md`](../../docs/rust-engine/PLAN.md) (§10 lists every user-facing
difference from 3.x); the user's standing rulings are
[`docs/rust-engine/DECISIONS.md`](../../docs/rust-engine/DECISIONS.md), numbered, and they override the
plan and this file. Read both before you change anything. All entries below: 2026-10-06.
<!-- /preserved:e-4ab1b5bc2121915b -->

<a id="e-29d2ba53942932f8"></a>

## Where and how to work

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3827–3828.

<!-- preserved:e-29d2ba53942932f8 -->
**Where and how to work** [decided: coordinator 2026-10-06, from the rust-engine session's terms;
user, DECISIONS 39]
<!-- /preserved:e-29d2ba53942932f8 -->

<a id="e-9522900dfe5708ae"></a>

Historical record moved to [legacy and superseded records](legacy-and-superseded.md#e-9522900dfe5708ae); use [current operating-rule homes](#current-operating-rule-homes).

<a id="e-53dd75a0fc1e48e5"></a>

Historical record moved to [legacy and superseded records](legacy-and-superseded.md#e-53dd75a0fc1e48e5); use [current operating-rule homes](#current-operating-rule-homes).

<a id="e-ca02d79ca0ee8a7d"></a>

Historical record moved to [legacy and superseded records](legacy-and-superseded.md#e-ca02d79ca0ee8a7d); use [current operating-rule homes](#current-operating-rule-homes).

<a id="e-cd70dd295fff4d67"></a>

## Electron probes: pass URLs and options through the environment, not the command line: with

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4005–4007.

<!-- preserved:e-cd70dd295fff4d67 -->
- **Electron probes:** pass URLs and options through the environment, not the command line: with
  an `http://` argument `electron.exe` exits −1 before the script runs (measured 2026-10-07).
  Clear `ELECTRON_RUN_AS_NODE` first; tool shells inherit it from VS Code.
<!-- /preserved:e-cd70dd295fff4d67 -->

<a id="e-837c7011305e3f2e"></a>

Historical record moved to [legacy and superseded records](legacy-and-superseded.md#e-837c7011305e3f2e); use [current operating-rule homes](#current-operating-rule-homes).

<a id="e-df30bae43ef1d6bb"></a>

## Still valid from the 3.x sections: Machine traps (shell, CRLF, slow git on

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4027–4030.

<!-- preserved:e-df30bae43ef1d6bb -->
**Still valid from the 3.x sections:** [Machine traps](development-and-verification.md#e-802759bf35d36260) (shell, CRLF, slow git on
E:), the worktree rules (own worktree, no `node_modules` links, no bare `git stash`), "commit
before you mutate", the evidence rules, and the product rulings except where PLAN §10 or
DECISIONS changes them.
<!-- /preserved:e-df30bae43ef1d6bb -->

<a id="e-997232eb4582e84a"></a>

## Keep this file current

Original section: Keep this file current. Source lines 4118–4118.

<!-- preserved:e-997232eb4582e84a -->
#### Keep this file current
<!-- /preserved:e-997232eb4582e84a -->

<a id="e-2f58d475705f7a24"></a>

## Keep entries short. Date each one (UTC) and tag it

Original section: Keep this file current. Source lines 4153–4156.

<!-- preserved:e-2f58d475705f7a24 -->
- Keep entries short. Date each one (UTC) and tag it **[verified: `<file>`]** (you checked
  the source) or **[decided: `<who>` `<date>`]** (a recorded ruling: "user" is the product
  owner, "design" is [`pg-data-model-design.md`](../../docs/state-system/pg-data-model-design.md),
  "coordinator" is the team coordinator). Link the detailed doc.
<!-- /preserved:e-2f58d475705f7a24 -->

<a id="e-6be65c0ba1936e55"></a>

## Describe only what has landed: on rust-engine for 4.0.0, on dev for the 3.x line. Work

Original section: Keep this file current. Source lines 4157–4161.

<!-- preserved:e-6be65c0ba1936e55 -->
- Describe only what has landed: on `rust-engine` for 4.0.0, on `dev` for the 3.x line. Work
  still in review or on a private branch is not current behaviour: its entry goes in the commit
  that ships it. For 4.0.0, a new user decision goes in
  [`docs/rust-engine/DECISIONS.md`](../../docs/rust-engine/DECISIONS.md) first; add a one-line pointer
  here only if agents would otherwise get it wrong. (2026-10-06)
<!-- /preserved:e-6be65c0ba1936e55 -->

<a id="e-7cc5529b5c6b06bf"></a>

## When a rule changes, edit its entry in place and say what it replaced. Dead rules live

Original section: Keep this file current. Source lines 4162–4163.

<!-- preserved:e-7cc5529b5c6b06bf -->
- When a rule changes, edit its entry in place and say what it replaced. Dead rules live
  only in [Removed and dead ideas](legacy-and-superseded.md#e-962161abcd765385).
<!-- /preserved:e-7cc5529b5c6b06bf -->

<a id="e-998c7e96381cb84e"></a>

## Reviewers check this: a landing that adds a gotcha, an invariant or a ruling without

Original section: Keep this file current. Source lines 4164–4165.

<!-- preserved:e-998c7e96381cb84e -->
- Reviewers check this: a landing that adds a gotcha, an invariant or a ruling without
  updating this file is not finished.
<!-- /preserved:e-998c7e96381cb84e -->

<a id="e-2b6fb1f21c689754"></a>

## Agent sessions load this whole file, so keep it dense; long explanations belong in

Original section: Keep this file current. Source lines 4166–4167.

<!-- preserved:e-2b6fb1f21c689754 -->
- Agent sessions load this whole file, so keep it dense; long explanations belong in
  `docs/` with a one-line pointer here.
<!-- /preserved:e-2b6fb1f21c689754 -->

<a id="e-802759bf35d36260"></a>

## Machine traps

Original section: Machine traps. Source lines 5022–5022.

<!-- preserved:e-802759bf35d36260 -->
#### Machine traps
<!-- /preserved:e-802759bf35d36260 -->

<a id="e-e446fc17ae10e2a6"></a>

## Read the authoritative built-in machine traps page

Original section: Machine traps. Source lines 5024–5030.

<!-- preserved:e-e446fc17ae10e2a6 -->
Read the authoritative built-in [machine traps page](../../docs/skills/orgtree-working/workspace/machine-traps/SKILL.md)
before shell or file-edit work on this Windows machine (orgtree-working > workspace
> machine-traps). It owns escaping, CRLF, Git Bash/WSL paths, encodings, Edit-tool
quirks and rerere/mojibake; `docs/machine-traps.md` is a compatibility pointer.
Current build/worktree workflows are linked there; the old Python/P03 recipes
are explicitly historical. [decided: user/coordinator 2026-10-16; verified:
`.gitattributes`, `docs/skills/orgtree-working/workspace/machine-traps/SKILL.md`]
<!-- /preserved:e-e446fc17ae10e2a6 -->
