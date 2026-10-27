# AGENTS.md — working on Orgtree

Named app events use a durable armed-listener snapshot and private delivery
outbox, never the coalescing metadata bus or project ancestry. Source mutations
lock owner scope before app rows; nested fire actions run after all app gates
and DB connections are released. See [Apps](docs/rust-engine/custom-apps.md).
[verified: `domain/apps/events.rs`; 2026-10-26]

Presentations and apps stay separate (user 2026-10-26: "its also good to spesrate
them from a ux perspective; predentstions are intended as a one-way communication,
whearas apps are meant as a two-way communication, where the user cimmunicates back to
the agent thru the app."). Inline HTML presentations are interactive but one-way: no SDK
or bridge, and the app never listens to their frame. Apps reach agents only through
declared events (user: "i want to keep agent notification purely through the event
system, no targeting agents directly (makes them more portable and easier to
manipulwte)"); mail.send is removed (old declarations import, never granted). See [inline presentations](docs/agents/docket-and-presentations.md#inline-html-presentations-2026-10-26).
Apps are custom UIs for the user to manipulate data in a structured way, not
persistent program environments (user 2026-10-27); panels run only while Orgtree
is open, tray included, as the tool texts say; the Apps menu shows no note.
[decided: user 2026-10-26, 2026-10-27; verified: `canvas/{docs,gallery}.tsx`, `canvas/apps/ui.tsx`, `domain/apps/{wire,policy,bridge}.rs`]

Read this file before working in this repository. It is the startup guide, not a landing log. Detailed rules, source references and the complete earlier notes live in the [topic index](docs/agents/README.md).

Installer shutdown fixtures need a trusted synthetic data parent, even when a
runner redirects `LOCALAPPDATA`; never relax product attach ACL checks. See
[native test homes](docs/agents/development-and-verification.md#portable-root-test-output).
[verified: `tests/installer-elevation.test.mjs`; 2026-10-26]

Hovering or focusing a mini node, agent or project, always shows its name on the
floating plate above every card, also while desks are open (pinned or popped out;
replaces 0a47651). Never hide or cover it. See [identity hover](docs/rust-engine/agent-identity-tooltip.md).
[decided: user 2026-10-26 "Never hide on hover"; 2026-10-27 names above nodes; verified: `canvas/farzoomname.tsx`; 2026-10-27]

Apps derive org-internal capability/file defaults from origin policy; user Deny
wins and survives agent code replacement. Agents create only closed copies and
never show windows. See [custom apps](docs/rust-engine/custom-apps.md).
[decided: user2026-10-26; verified: `domain/apps/{policy,storage,file_scopes}.rs`]

App/panel mention context menus share Apps-list settings and confirmed deletion.
An app's New panel creates a fresh closed/off copy through panel_open closed:true,
the same insertion path agents use, without showing or running it. See
[app mentions](docs/rust-engine/custom-apps.md#mentions-2026-10-27).
[decided: user 2026-10-27; verified: `canvas/apps/links.ts`, `domain/apps/storage.rs`]

The Apps list shows apps newest first and each app's panels in creation order
(`created_at`); never reorder by running, shown, hidden or used state. Renderer
CSS must use theme variables that `styles.css` defines (`--line`, `--dim`,
`--panel-2`, `--ink`, ...): an undefined `var()` silently drops its declaration,
as `--border/--muted/--hover/--text` did in `apps.css`. See [custom apps](docs/rust-engine/custom-apps.md).
[decided: user 2026-10-26 "the ordering of the apps in the list shouldnt change as panels are turned onca or off", "newest first", "Fixed order"; verified: `canvas/apps/{store.ts,ui.tsx,apps.css}`, `domain/apps/storage.rs`; 2026-10-26]

Custom app actions use parent-only, code/panel-bound sessions and native owning-document
permission prompts; sandbox HTML never receives a credential or permission method.
App definitions retain portable named event declarations; declarations grant no
execution or subscription. See [custom apps](docs/rust-engine/custom-apps.md).
[verified: `domain/apps/{wire,storage,templates}.rs`; 2026-10-26]

App file and portability IO enter a private scope on each blocking worker,
including nested path helpers; ordinary verbose diagnostics remain enabled.
See [custom apps](docs/rust-engine/custom-apps.md).
[verified: `trace::private_app_blocking`, `domain/apps/{file_access,file_scopes}.rs`, `tools/apps.rs`; 2026-10-26]
App content that a recipient's actor reads back from the database (an app's
docket assignment notice, named event delivery or older mail) is logged by
mail ID in every line; ordinary mail logs as before. See [custom apps](docs/rust-engine/custom-apps.md).
[verified: `trace::private_app_content`, `runtime/actor.rs::mail_of`; 2026-10-26]
App files use native read grants, opaque per-panel references and bounded reads.
Folder/computer scopes and separate write grants retain paths in native code;
outside-org file changes need one-shot native confirmation; org changes do not. Agent writes also require
live writable folder/edit scope. See the same file-access topic.
Only the exact media GET route substitutes an asset ticket of the running copy
for desktop authentication; no general engine credential enters HTML. Hide and
session renewal keep links; revocation cancels active bodies. Agents require both app grants and their current folders.
See the file-access section in [custom apps](docs/rust-engine/custom-apps.md).
[decided: user 2026-10-26; verified: `domain/apps/file_access.rs`, `http/app_files.rs`, `canvas/apps/files.ts`]
Apps New counts are org-persisted catalog metadata; only visible menu entries
are acknowledged, with orgtree_apps mark_seen parity. See
[custom apps](docs/rust-engine/custom-apps.md).
[verified: `domain/apps/storage.rs`, `canvas/apps/store.ts`, `canvas/apps/ui.tsx`; 2026-10-26]
App panels default to centered modals; the pin pins one to the window like a
pinned desk, in the org pin layer (canvas pins were retired 2026-10-26; migration
0069 floats old ones). Native Apps chrome uses
the shared modal/settings kit. The app row opens its most recently used copy or creates
one, + always creates, and new copies are named Panel N. App-row gears open
app-wide settings (description above General/Permissions tabs); saved-panel and
open-header gears open settings for that exact copy (the Agent settings Name row,
then General/State/Connections/Fire event/History tabs, no section headers),
including closed panels
without running HTML. See the same custom-app topic for placement, permission
and tool parity.
[decided: user 2026-10-26; verified: `canvas/apps/{dialog,events,settings,ui}.tsx`, `domain/apps/labels.rs`]
History rows are only event.fired and panel.started/stopped; event/orgtree.emit
write kind message rows apart (host relays them to orgtree.on); 256 per kind.
An app's own fire emits custom_apps_history, not custom_apps_changed: that
refresh re-posts state.changed, so an app firing on it would loop.
[decided: user 2026-10-26/27; verified: `domain/apps/{storage,bridge}.rs`]
A visible app panel is always running; a hidden one need not be stopped (DB
CHECK, migration 0067). Hide keeps the runtime; Power off and Stop all bump
run_generation, which fences bridge sessions and desktop leases. Hidden running
copies stay mounted and parked inside the viewport, never display:none or
offscreen, because Chromium throttles such frames. See
[custom apps](docs/rust-engine/custom-apps.md#background-panels-2026-10-26).
[decided: user 2026-10-26; verified: `domain/apps/{runtime,storage,bridge}.rs`, `canvas/apps/ui.tsx`]
App events carry privacy across subscriber/overflow handoffs; authorized delivery
keeps content while watchdog diagnostic output/history omit it.
Hide refuses prompts but keeps the running session; power off and replacement
discard prompts and authority, while grant edits use a separate revision from code. Portable version1 app bundles never carry grants/IDs/links or
machine placement; imports get fresh closed copies and implicit local org authority.
Bundle bounds, export files and import pinning are in [custom apps](docs/rust-engine/custom-apps.md#whole-app-portability-backend).
Templates carry only inert app definitions/initial data; restore creates no copies
or grants. Panel links and their app.event signals were removed (user
2026-10-26); agents follow copies only through app_listener subscriptions.
See the same topic for cursor limits.
[verified: `canvas/apps/actions.ts`, `canvas/apps/{host,permissions}.tsx`, `domain/apps/{bridge,files,storage,wire}.rs`; 2026-10-26]

Mail list previews cap tags at three, with active filter matches first and a
hover-only (+n) count; detail and picker tags remain uncapped. See
[mail tags](docs/rust-engine/mail-tags.md). [decided: user 2026-10-25; verified: `canvas/mail.tsx`]

Text-edit and spelling menus use Chromium's context flags and the originating
webContents/session, including popouts. See [text menus](docs/agents/desktop-and-renderer.md#text-editing-and-spelling-menus-2026-10-24-445).
[verified: `main/editmenu.ts`, `canvas/contextmenu.tsx`; 2026-10-24]

Only undelivered mail collapses under one queue separator, including system
cards; current-turn input and the live reply stay visible. Actor activity guards
current-turn membership. See [pending mail](docs/rust-engine/pending-mail-collapse.md).
[decided: user 2026-10-24 21:36Z; verified: `canvas/{desk,transcriptflow}.tsx`]
Spelling probes complete a typed word boundary before asserting native markers;
see [the capture control](docs/agents/development-and-verification.md#renderer-capture-and-rig-traps).

Muse thought durations use matching native reasoning item start/completion
boundaries, never a whole-turn duration or an item update as a start. Missing
starts stay unknown. See [Muse thought timing](docs/rust-engine/muse-thinking-time.md).
[decided: user 2026-10-24; verified: `runtime/muse_thinking.rs`, `runtime/actor.rs`]

Menus on transparent boundaries measure the pressed text element for position,
retaining their original identity anchor. See [viewport anchoring](docs/agents/desktop-and-renderer.md#selection-menu-viewport-anchor-2026-10-24-445).
[verified: `canvas/contextmenu.tsx`; 2026-10-24]

Standalone user MCP cards describe the user handler's supported fields, with pre-dispatch refusal of unsupported options; do not clone agent mail/interrupt capabilities into them. See [the user-endpoint contract](docs/rust-engine/STANDALONE-ENGINE.md#user-tool-card-boundary-2026-10-23). [decided: user 2026-10-23; verified: `tools/usermcp.rs`]

Ticket/presentation menu actions capture their owning composer before metadata reads; Quick chat owns only its canvas content. See [composer ownership](docs/agents/docket-and-presentations.md#object-actions-belong-to-a-composer-2026-10-22). [verified: `canvas/composerobjects.tsx`; 2026-10-22]

Template watchdog import stages paused without smoke or immediate effects, then arms eligible portable dogs after all rows exist. Never export runtime memo or credential references, including nested fire-action credentials; explicit audiences restore through grant_tx. See [template links](docs/rust-engine/template-links.md). [verified: `domain/template_links.rs`, `runtime/watchdogs.rs`, 2026-10-22]

Template node creation records one net inherited-audience delta around all canonical node steps, before the unchanged explicit-grant restore phase. Keep notices in the transaction and publish Effects only after commit. See [template portability](docs/rust-engine/template-portability.md). [verified: `domain/templates.rs::create_nodes`, `http/orgops.rs::create`;2026-10-23]

Recursive project fires must construct nested futures with `util::boxed(|| ...)`: `Box::pin(f())` still grows debug poll frames at every level, even with the depth-four cutoff. See [fire-action stack verification](docs/rust-engine/tool-cards.md#fire-actions). [verified: `domain/listeners.rs`, 2026-10-22]

AGY auth proof runtime counts use positively correlated PID/cwd/agent ownership;
unknown owners still fail. See [rig attribution](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/proofs/agy-auth-wake.mjs`; 2026-10-25]

Undo identity snapshots order complete id/name pairs by id before strict
comparison; keep every identity and history guard. See [identity controls](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/proofs/undo-history.mjs`; 2026-10-26]

Seed waits share one helper-grace-plus-execution budget; local helper non-seed
defaults and placement settings stay intact. See [seed settling](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/seed-settle.mjs`; 2026-10-25]

An ended ledger row can precede its quota freeze record; quota proofs wait for
the outcome itself. See [quota synchronization](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `runtime/actor.rs::end_turn`, `tools/rig/proofs/agy-lane.mjs`; 2026-10-25]

Cold-reset UI proofs observe untouched effective defaults and wait for persisted
OFF/ON edits; dirty-only auto-save need not store untouched fields. See
[reset synchronization](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/proofs/cold-reset-default.mjs`; 2026-10-25]

Session-boundary removal proofs wait for published idle and cleared inflight
as well as ledger completion; keep the lawful busy refusal. See
[removal synchronization](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/proofs/codex-accounts.mjs`, `domain/account_removal.rs`; 2026-10-25]

New-hire layout proofs reset and observe auto-saved account state between
variants; use the current permission label without dropping its geometry guard.
See [layout synchronization](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/desktop/new-agent-account.cjs`; 2026-10-25]

Read-only org-account picker probes keep saved-disabled bindings and raw console
warnings; a failed driver's empty console fallback is not a no-warning proof.
See [picker controls](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/desktop/org-accounts-picker.cjs`; 2026-10-25]

Provider-chip probes use the current Done text in both browser pagers and retain
catalog/OpenRouter negatives and raw warnings. See [pager controls](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/desktop/provider-chips.cjs`; 2026-10-25]

Focused-retire probes match the Fit tooltip's shortcut hint at both camera
samples; retain visible Focus and the retire-other negative. See [Fit controls](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/desktop/retire-focused-fit.cjs`; 2026-10-25]

Startup-switch probes use Run on boot in selectors and the label oracle, with
the synthetic bridge retaining decline/accept and exact-write guards. See [startup controls](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/{desktop,proofs}/run-on-startup.*`; 2026-10-25]

## Setting text case

Every setting name, description/help text, settings section header and settings-screen button label uses sentence case: capitalize the first word and retain proper nouns, product names, acronyms and literal identifiers (Orgtree, Claude Code, Codex, Hubchat, MCP, org.md). Apply this to new and changed settings and keep quoted glossary/user-documentation labels aligned. [decided: user 2026-10-24, settings capitalization]

## Read this first

Windows installer task suspension is transactional across Prepare/copy/Register;
keep the protected snapshot and failure/exit hooks, defer starts until commit,
capture a fresh baseline before each new suspension, and distinguish disabled
tasks from triggers off. Silent post-Prepare exits restore explicitly before
Quit; GUI-end callbacks alone do not run on that path. Startup failures have visible
Retry/Quit without bypassing Session 0. See [update recovery](docs/rust-engine/run-on-boot.md#failed-updates-and-startup-recovery-445).
[verified: `tools/boot-engine-task.ps1`, `build/installer.nsh`, `main/{runonstartup,sessionlaunch,index}.ts`; 2026-10-26]

Providers Refresh and post-login verification share serialized ordinary discovery; the default Codex row reuses the native sign-in flow. Tool refresh requires inspection + runtime. See [provider refresh](docs/agents/providers-and-accounts.md#explicit-provider-refresh-and-default-codex-sign-in-2026-10-23). [verified: `providers/status_refresh.rs`, `canvas/accountsregistry.tsx`;2026-10-23]

1. **Work on the assigned line and scope.** Current development is the Rust engine in `engine/rs/` on local `rust-engine`; the assignment/team notes name the current release line and exact base. The 3.x Python rewrite is stopped; its procedures are historical. Read [PLAN §10](docs/rust-engine/PLAN.md#10-user-facing-differences--complete-ledger), [DECISIONS](docs/rust-engine/DECISIONS.md) and [HANDOFF](docs/rust-engine/HANDOFF.md). Preserve 3.x product behavior unless a signed decision changes it. Current user rulings and the assignment take precedence over old notes. [decided: user 2026-10-06, DECISIONS 1–2, 45]
2. **Keep source, live data and ownership separate.** Use your own worktree and branch from the exact base assigned by the integrator. Never edit another author's checkout or use a bare shared `git stash`. Never link or copy source or `node_modules` between worktrees. Commit your work before probing a base or mutating it for a control. Rebase/cherry-pick with `git -c rerere.enabled=false`; inspect resolutions and Unicode before staging. Follow current team instructions for source/output locations. [Worktree guide](docs/skills/orgtree-working/workspace/worktrees-and-git/SKILL.md); [machine traps](docs/skills/orgtree-working/workspace/machine-traps/SKILL.md). [decided: user 2026-10-05; team charter]
3. **Do not touch live Orgtree data.** Work only on authorized source and your own scratch. Do not build an installer, install, restart, publish, release, tag or push without explicit assignment. Integration and releases belong to the coordinator or its named owner. Never use a bare SAFE_START engine as a substitute for an isolated test rig: it can still read real sign-ins and run provider probes. [Rig guide](docs/rust-engine/test-rig.md). [decided: user/team charter; verified: apps/desktop/main/policy.ts]
4. **Prepare before heavy work.** Heavy build/check/test/renderer/capture/packaging phases require the current machine-wide build permit, memory floor, process containment and assigned output scope. Read the current project Summary/team instructions and [build guide](docs/skills/orgtree-working/workspace/builds-under-the-lock/SKILL.md); do not revive the retired file lock or Python/P03 recipes. Release the permit immediately after the phase, before reports or unrelated work. Do not end a turn with your children still running. [decided: user/team charter]
5. **Use the current verification phase.** Run the author's focused checks appropriate to the change; use a meaningful failing control where it fits. Independent review, full combined rounds and publishing checks follow the current user/coordinator phase, not an old blanket rule. Do not run the full baseline or broad suites without assignment. A skipped, empty, timed-out or crashed test is not a pass. Keep raw status/signal/error and measured limits; check that the intended source actually ran. [Verification notes](docs/agents/development-and-verification.md). [decided: user 2026-10-16, phase-specific verification; team charter]
6. **Respect decisions and boundaries.** Search current source comments and the relevant topic before changing behavior. Keep one owner per piece; respect stopped work, waivers and review caps. A folder/tool grant is not authority for unrelated work or deletion. After a timed-out write, read state before retrying. Report exact committed/tested/integrated/built states separately. [decided: user/team charter]

For operating-policy ownership and stale inherited-checkout guidance, use the [current rule-home map](docs/agents/development-and-verification.md#current-operating-rule-homes). Keep mutable local limits and the current phase in their designated shared/team/project home. [decided: user 2026-10-22, operating-rule reconciliation]

Before launching any test/rig/capture/fixture window, follow [session and clipboard isolation](docs/agents/development-and-verification.md#test-window-session-and-clipboard-isolation-2026-10-24): Session 0 or a never-switched private desktop, never the user's signed-in desktop or real clipboard. [decided: coordinator 2026-10-24]

Before renderer or desktop-main tests, visual captures or rig proofs, read the [test and capture traps](docs/agents/development-and-verification.md#renderer-capture-and-rig-traps): reduce DOM assertions to scalars, run main's own closures rather than one handler's text, wait for paint, and verify the PNG and the engine log being measured. [decided: coordinator 2026-10-21, standing-note relocation; main closures verified 2026-10-22: `tests/run-as-administrator.test.mjs`]

Run renderer tests only through `apps/desktop/renderer/tests/run.mjs` (it takes `--test-name-pattern`) and root tests through `npm test` / `node tests/run.mjs [files]`. Bare `node --test`, or bare `timeout`, has no Job, heap cap or timeout: one red DOM assertion grew such a run to 41 GB. See [memory guards](docs/agents/development-and-verification.md#renderer-test-memory-guards-2026-10-26). [decided: coordinator 2026-10-26; verified: `tests/run.mjs`, renderer `tests/{run,testguard}.mjs`]

Rig live-root guards retain import-time `APPDATA`/home/data-override paths after fixture environment replacement; fixture/keeper allowlists carry validated `RIG_PROTECTED_ROOTS` across fresh imports without narrowing the captured set. Set original overrides before importing the rig. See [rig isolation](docs/rust-engine/test-rig.md). [verified: `tools/rig/{lib,broker-synthetic}.mjs`, `tools/rig/tests/live-roots.test.mjs`; 2026-10-22]

Seed-completion waits account for the helper grace before CLI execution; retain
placement settings and bounded failure. See [rig seed timing](docs/rust-engine/test-rig.md#what-keeps-it-safe).
[verified: `tools/rig/proofs/account-windows.mjs`; 2026-10-25]

## Engine and desktop invariants

- Chat video/audio cards are click-to-load, capped at256MiB and streamed only
  after ordinary file authorization; single byte ranges are bounded to the
  opened file's size snapshot. Preserve existing image behavior, Download and
  compact staging/Files rows. Release playback offscreen/hidden/unmount/source
  changes and keep native controls from desk navigation. See
  [media cards](docs/rust-engine/chat-media-cards.md).
  [decided: user2026-10-25,4.5.0; verified: `canvas/media.tsx`, `http/media_file.rs`]

- Native proof admission accepts the owner's C build home/run scope and retained
  D rigs, preserving canonical/reparse and disposable metadata/DB checks. See
  [native fixture inputs](docs/agents/development-and-verification.md#renderer-capture-and-rig-traps).
  [verified: `domain/native_fixture.rs`; 2026-10-25]

- Every file the engine compile reads outside its crates (an `include_str!` path
  or a `build.rs` input such as `docs/releases.json`) is copied by
  `standalone/Dockerfile` and has its own exception in its allowlist;
  `tests/standalone-docker-context.test.mjs` checks both. See
  [Changelog build inputs](docs/rust-engine/STANDALONE-ENGINE.md#changelog-build-inputs-2026-10-25-445).
  [verified: `standalone/Dockerfile`, `orgtree-engine/build.rs`; 2026-10-25]

- Live credit edits subtract the control's accepted grant, not stale tree state;
  draft commits remain absolute. See [draft edits](docs/agents/desktop-and-renderer.md#draft-permission-edits-2026-10-24).
  [verified: `canvas/creditgrant.tsx`; 2026-10-25]

- Unset **New hires go** defaults to Centre; preserve valid saved End/Start/Centre
  choices. See [hire position](docs/agents/desktop-and-renderer.md#new-hire-position-2026-10-23).
  Null before/after anchors are omitted for agent/project creation; explicit
  indices, real anchors and superior placement retain precedence. See
  [creation ordering](docs/rust-engine/agent-ordering.md).
  [decided: user 2026-10-24; verified: `hireposition.ts`, `domain/ops/ordering.rs`; 2026-10-25]

- Limit fallback considers native Claude/Codex sign-ins even without registry
  rows, after registered subscriptions and before paid keys. Preserve native
  eligibility and fresh room checks; never retry the same physical login.
  See [native fallback](docs/agents/providers-and-accounts.md#native-limit-fallback-2026-10-24).
  [verified: `runtime/freeze.rs`, `freeze/continuation.rs`; 2026-10-24]

- Files readers merge accepted org-record commits as well as legacy live bumps;
  runtime-only publications keep their cursor. Keep record-without-bump controls
  for mounted readers. See [Files](docs/rust-engine/agent-files.md).
  [verified: `canvas/files.tsx`, `tests/files.test.tsx`; 2026-10-24]

- Credential brokers retain ordered20/25/30second lookup/pipe/request bounds and kill/reap timed-out lookup children; local gh help/version skips auth. Keep fixed codes, native fallback and decision94 caching unchanged. See [bridge deadlines](docs/rust-engine/credential-bridge.md#bounded-lookup-deadlines-2026-10-24). [verified: `credential_{bridge,broker,deadlines}.rs`, `main/credential-bridge.ts`;2026-10-24]

- New-hire preferences (version/session/peer mail/cold-turn override) are stored atomically before warm/start; version-specific effort/speed checks use the staged pin and selected Muse login. Creation tools expose them; restoration retains saved preferences. See [hire preferences](docs/agents/engine-and-storage.md#hire-preferences-2026-10-24). [verified: `domain/ops.rs`, `providers/fast_mode.rs`; 2026-10-24]
- Organization/default settings auto-save dirty fields serially (text/numbers after 750 ms); org.md alone retains explicit revision-checked Save, never blur/close. Project draft gear stages each change before Create. See [settings auto-save](docs/agents/desktop-and-renderer.md#settings-auto-save-2026-10-24). [decided: user 2026-10-24]
- Draft Charter/Model/Scope/Tools tabs share controls with live settings, including credits; edits persist locally without closing and final Hire alone submits all staged fields. Agent/project draft settings omit footer Close buttons and show the shared header X; project draft height fits content with viewport-bounded scrolling. Keep the publish callback stable across draft updates and let wrapped rows scroll at natural height. See [draft edits](docs/agents/desktop-and-renderer.md#draft-permission-edits-2026-10-24). [verified: `canvas/{modals,cards,newproject}.tsx`, `styles.css`; 2026-10-24]

- One-time agent messages/notices suppress new reply-audience grants without
  revoking existing reach; retain the independent header marker through all mail
  readers. See [one-time mail](docs/agents/mail-and-hub.md#one-time-agent-mail-2026-10-24-445).
  [decided: user/coordinator 2026-10-24; verified: `tools/mailtools.rs`, `domain/mail.rs`]

- Working-only checkups skip docket preparation; reminder routing reads only
  the active work page's named identities and required deployment ancestry.
  Never preload unrelated retired reporting history. See [working checkups](docs/rust-engine/working-checkups.md).
  [verified: `runtime/reminders{,/pages}.rs`; 2026-10-23]

- Claude usage retries honor both the per-key minute floor and provider deadline;
  repeated 429s back off to 15 minutes, with only genuine success resetting them.
  See [usage throttling](docs/agents/providers-and-accounts.md#claude-usage-throttling-backoff-2026-10-23-445).
  [decided: coordinator 2026-10-23; verified: `usage.rs`]

- Fresh Work/Presented openings use attention/unread, scoped last-viewed identity,
  then topmost. Continued readers and explicit links preserve their targets.
  See [opening rules](docs/agents/docket-and-presentations.md#opening-priority-2026-10-23).
  [decided: user 2026-10-23; verified: `canvas/readeropening.ts`, `http/docs.rs`, `domain/docket.rs`]


- Codex sealed reasoning keeps a thought placeholder, not ciphertext; agent
  transcript reads include bounded supplied thinking and sealed markers. Keep
  supplied thinking out of verbose traces, including encoded nested MCP results.
  Keep
  Codex tool chips visible in the ordinary row form. See [thinking history](docs/rust-engine/codex-thinking-history.md).
  [verified: `runtime/codex_thinking.rs`, `tools/orgview.rs`; 2026-10-23]
  New Codex thoughts retain native-pair or observed item-boundary durations;
  missing starts/history stay unknown. [decided: user 2026-10-24; verified: `runtime/codex_thinking/timing.rs`]

- Preserve nonblank streamed text before taking a turn; native-identity receipts
  reconcile late completions in place. Thinking is separate. See [unfinished
  responses](docs/rust-engine/incomplete-responses.md). [verified:
  `runtime/actor.rs`, `runtime/convo.rs`; 2026-10-23]

- DnD targeted status calls change only DnD, require runtime+descendant authority,
  and allow the target to clear any hold itself. Idle targets arm the next turn;
  admission consumes the flag under its agent-row lock after claiming opening mail.
  Clearing triggers native delivery now without a count cap; harness boundaries and
  size budgets remain. See [DnD](docs/skills/orgtree-working/runtime/do-not-disturb/SKILL.md).
  [verified: `domain/dnd.rs`, `tools/mailtools.rs`, `runtime/actor.rs`; 2026-10-22]

- The native window-controls edge fixture bundles the full renderer stylesheet with embedded font assets; preserve its styles and hit-test/mutation assertions. See [native edge probe assets](docs/agents/development-and-verification.md#native-window-controls-edge-probe-assets). [verified: `tools/test-window-controls-edge-native.mjs`; 2026-10-22]
- The seven scratch-note/taskbar/tray/native-tab root tests allocate fresh temporary output leaves without author-specific environment variables. Optional output overrides require the current `ORGTREE_AGENT` scope, canonical containment and no linked ancestors; cleanup rechecks directory identity. See [test output setup](docs/agents/development-and-verification.md#portable-root-test-output). [verified: `tests/helpers/test-output.mjs`; 2026-10-22]

- Desk model eligibility uses the staffing tier's eligible managed accounts as well as its native-login flags. A spent native login cannot hide a tier with another eligible account; the picker prefers native when usable, otherwise submits and discloses an eligible managed ID. Current-model queue cancellation leaves the account alone. [verified: `canvas/deskmodel.tsx`, `desk-model-instant.test.tsx`; 2026-10-22]
- Antigravity conditional models retain their last confirmed in-memory catalog
  on inconclusive refresh failures only for the same silently checked principal.
  Metadata changes quarantine cached offers until one bounded identity recheck;
  a different/unknown login clears them. Catalog results carry their own identity;
  successful omission/empty and auth refusals still remove models. See
  [conditional Gemini tiers](docs/agents/providers-and-accounts.md#e-f9bfc5ac5f086eb7).
  [verified: `providers/{agy_auth,agy_models,mod}.rs`; 2026-10-22]

- State badges pass card focus/select gestures through. The serving-account badge is a focusable informational span with native title = aria-label; it has no button role or pointer/click handler. Other state markers remain inert, with halt/unstick actions separate on the desk. [decided: user 2026-10-22 09:58Z; verified: `canvas/desk.tsx`, `statebadgefocus.test.tsx`]

- Helper transcript tool inputs use the ordinary credential redactor before
  capture and on retained reads; never publish raw partial JSON. See
  [helper transcripts](docs/rust-engine/helper-transcripts.md).
  [verified: 2026-10-21, `runtime/helper_transcript.rs`, `http/nodes.rs`]

- Transcript mail requires a private successful dispatcher receipt, not a tool
  basename or returned JSON. ID-less MCP completions correlate original own-server
  provenance plus dispatcher arguments/result; display-name unwrapping is not an
  authority check. The canonical read rechecks current project reach and shares
  normal inbox visibility. See [manual mail provenance](docs/rust-engine/manual-mail-provenance.md).
  [verified: `runtime/manual_mail.rs`, `runtime/convo.rs`, `tools/project_inbox.rs`; 2026-10-21]


- Claude completed thinking retains observed monotonic start/stop elapsed seconds
  per native block; the renderer uses row-level legacy timing only for a single
  thought. A transmitted thinking-specific duration takes precedence over
  computed time; never use a whole-turn duration. Missing historical timing stays unknown; never infer it from row
  timestamps. See [Claude thought timing](docs/rust-engine/claude-thinking-time.md).
  [decided: user 2026-10-21 20:48Z; verified: `runtime/claude_thinking.rs`, `actor.rs`, `canvas/desk.tsx`]


- Ready once command/process/usage/slot/fair_queue creation returns its real
  effects and fire actions inline, without a dog row/fire mail/holder wake.
  Slots keep durable leases; inline queue copies are consumed once and ACK
  custody persists without a listener. Pending, silence and event/new-content
  behavior stays unchanged. Usage creation evaluates cached levels once;
  repeating usage dogs first fire now then follow edges, existing dogs do not
  refire on upgrade. [decided: user 2026-10-21 18:05:58Z, 18:13:24Z;
  verified: `runtime/watchdogs/{immediate,usage,usage_eval}.rs`, `domain/{slots,projects}.rs`]


- Card fit measures the resting layout, excluding transient full-name overlays;
  hovering/unhovering a long agent or project name cannot change its face scale.
  Real content changes still refit. The retired chip is last in both header rows.
  [decided: user 2026-10-21 17:35Z–17:37Z; verified: `canvas/{cardface,cardname,cards,projectcard}.tsx`]

- Project identity hover is the name alone when no coloured header fact chips
  render, even on named links and mini cards. Header and hover share
  `canvas/projectheaderfacts.ts`; projects with chips retain the name-class rule.
  Their facts are the exact chip texts in slot/listener/queue order, joined by
  ` · `; multiple listener chips join by `; ` within that category.
  [decided: user 2026-10-21 15:56:49Z, 15:59:29Z and 16:00:17Z;
  verified: `canvas/OrgCanvas.tsx`, `canvas/projectcard.tsx`]

- Windows startup tasks remain enabled for explicit demand launches. “Run on boot” off disables **every boot/logon trigger** on the owned boot engine and credential helper tasks; it never starts any of them. Installer stop temporarily disables tasks and restores prior states if draining fails. Keep the protected `RunOnStartup` preference and one UAC prompt per change. [decided: user 2026-10-10, coordinator 2026-10-21; verified: `tools/boot-engine-task.ps1`, `apps/desktop/main/runonstartup.ts`]

- **The engine always runs in Session 0 (decision 94, replacing decision 93's restart target).** Restarts, updates and crash recovery start it through the S4U boot task, also with Run on boot off; the boot host runs one engine, as before decision 93; the sign-in helper is the per-session agent host. The strict invariants, verbatim (the user 2026-10-22 07:30:14Z; any violation is a bug): 1. The main engine ALWAYS runs in Session 0: through restarts, updates, reboots and crash recovery. It never runs in the user's session. 2. The session-1 host (sign-in helper) runs in the user's session(s) while the user is signed in. 3. At each turn start, agents run in the signed-in session whenever it is reachable. They fall back to Session 0 only when it isn't: the user is signed out, or the helper is truly unreachable after the bounded grace, which is logged. 4. At sign-out, running turns are cut off and resume in Session 0. 5. After a restart or update, both sessions are available immediately. No agent starts a turn in Session 0 when it could start in session 1. 6. Agents are notified whenever the session-1 host goes up or down while the Session 0 engine keeps running: one notice per debounced transition, none on the engine's own restart. 7. Elevation is all-or-nothing: the Session 0 engine and the session-1 host are both elevated or neither, with no in-between state. 8. Elevation costs exactly one UAC prompt when the setting changes. There are no repeat prompts on restart, update, reboot, sign-in or helper restart. The one-off "Run this session as admin" button: one prompt per click, elevating both together until the next normal restart. Also: 9, Session 0 agents keep git/gh credentials through the bridge (a memory-only cache of what a signed-in broker served, never persisted, serialized or logged, lost at restart; otherwise the `[no-desktop]` refusal); 6 refined, no helper notice when the engine cycles with it; 10, the tree's `session_placement` drives the Session 0 badge; the one-off button is retired for 4.4.0. An installed build that cannot read its tasks refuses (`sessionlaunch.ts` `UNREADABLE_TASKS`), never starting the desktop's own engine. Code: `session_host::turn_waits_for_helper` (every turn start) and `falls_back_for_want_of_helper` (the logged fallback, also for a first turn after the grace), `session_watch` (silent startup grace, helper-stopped notice, `keepalive_due`), `core_monitor` `keep_or_restore`, `credential_bridge::same_rights` and `412 [rights]`, `credential_broker` `elevated`/`leaves_on`, `credential_bridge::ServedCache`. See [decision 94](docs/rust-engine/run-on-boot.md#the-engine-stays-in-session-0-decision-94). [decided: user 2026-10-22 07:27Z-07:38Z, coordinator Q1/Q4/Q5; verified: `host.rs`, `main/sessionlaunch.ts`, `runtime/session_host.rs`, `runtime/session_watch.rs`, `credential_bridge.rs`, `credential_broker.rs`; proof `session0-handover.mjs`, run unsplit]

- **A CLI is reused only where its turn runs it, warming waits for the sign-in helper, and the helper's arrival takes idle Session 0 CLIs (2026-10-22).** Every harness's reuse check compares `hosted_in()` with the placement the turn chose as well as the prompt fingerprint: a full-access Codex seat has the same sandbox, and so the same prompt, in both sessions, and before this its Session 0 Codex ran its turns there while the helper hosted. Warming and a start by hand (`Actor::start_ahead`) wait in `session_settle` as a turn start does, so the warming after an engine start no longer starts CLIs in Session 0 before the helper is back, and they keep the next turn's `use` pick. When a helper starts hosting (the engine's start included), `runtime::rehost_all` closes each idle CLI parked in Session 0 and warms it again in the signed-in session, within warming's memory floor: never one in a turn, one holding background work, or one whose own choice is Session 0 (the user 14:21Z: "Move them at sign-in"). Bound such work by permits its actor holds until done (`REHOSTING`'s place travels in `AgentMsg::Rehost`), never by dispatch chunks: a timed-out reply does not stop a queued move, and sweeps overlap. `core_process::Sessions::read` passes over a session Windows lists as WTSDown or WTSReset, which is being torn down; any other failed call still makes the reading unknown, logged once per stretch with the call. Rig runs warm only with `warming` (`ORGTREE_RIG_WARMING`). [decided: user 2026-10-22 14:21Z, coordinator 14:19Z; verified: `runtime/actor.rs`, `runtime/mod.rs`, `runtime/session_watch.rs`, `core_process.rs`; proof `warm-placement.mjs`]

- **A turn is mid-turn from its admission.** `start_turn` claims the mail and sets `inflight_at`, then
  waits for the helper, starts the CLI and builds the ORG STATE; `begin_turn` sets `self.turn` last.
  The published view's `starting` (turn slot held, no turn yet) covers that window and the chart reads
  it as "▶ mid-turn". "Never finished — the engine stopped mid-turn" means a claimed turn with none
  running or starting: judge a dead turn from `inflight_at` only together with `busy`/`starting`.
  [verified: `runtime/actor.rs::{start_turn,runtime_value}`, `runtime/envelope.rs::live_from_view`; 2026-10-22]

- **Retry a conflicted write only through `ops::conflict_retry`** (`conflict_retry_when` for a writer with
  its own conflict test, as account removal's 55P03). Up to `CONFLICT_ATTEMPTS` (10) tries, each after a
  full-jitter exponential backoff (up to 20 ms, doubling to 1280 ms) and after its transaction rolled back;
  the last conflicted try refuses (`UserError::Conflict`: nothing changed, retry it). Topology ops run
  SERIALIZABLE, so concurrent ones conflict by design: three fixed 20/40/60 ms retries left 7 of 22
  concurrent retires failing (2026-10-22, `tools/rig/proofs/retire-concurrent.mjs`).
  [verified: `domain/{ops,audiences,undo,account_removal}.rs`; 2026-10-22]

- **A Claude Code tool call that seems to hang may never have reached the engine.** Claude Code
  (2.1.292) starts an MCP call without `readOnlyHint` only when no other call runs, and Orgtree sends
  no annotations: a reply's state-changing Orgtree calls run one at a time, after every earlier call in
  that reply, a foreground subagent included. Look for the call's `tools.call` in the engine log
  before debugging the engine (22 retires, 2026-10-22: none arrived). Agent guidance lives in
  `orgtree-harness-claude-code` (orgtree-app › harnesses).
  [verified: live log 2026-10-22 19:38–19:40Z; Claude Code 2.1.292 tool executor]

- **PostgreSQL never runs as administrator.** It refuses to ("Execution of PostgreSQL by a user with administrative permissions is not permitted"), so on Windows `pg.rs` starts the postmaster only through `winproc::spawn_restricted`: `restricted_medium_token` (a LUA token: Administrators, Power Users and every other group Windows counts as elevated deny-only; no privilege but SeChangeNotify; Medium; a user default DACL), its real pid, both log streams, `pg_ctl` stop and the engine's job. initdb restricts itself; keep `PG_RESTRICT_EXEC` cleared for it. Never start postgres.exe with the engine's own token: an elevated engine (Run as admin) keeps its rights for its agents only. Likewise, create every pipe that the user's own processes open (hosted CLI stdio, the tool bridge, OpenCode mail) with `winproc::create_user_pipe`. That is the default pipe security plus the engine's user and a Medium label; an elevated engine's default would make them read-only for the helper. See [decision 94](docs/rust-engine/run-on-boot.md#the-engine-stays-in-session-0-decision-94). [decided: coordinator 2026-10-21 22:51Z, the user's alpha.29 run; verified: `pg.rs`, `winproc.rs`; test `pg::rights_tests`]

- **"Elevated" means what Windows and Task Manager say.** `token_rights` measures the engine, its boot host and the sign-in helper: Windows' own `TokenElevation`, Administrators enabled, or a High label; any one is elevated. `CreateRestrictedToken` without `LUA_TOKEN` leaves "Local account and member of Administrators group" (S-1-5-114) enabled, and Windows reads that token as elevated even at Medium with Administrators deny-only (alpha.33's engine and mail hub in Task Manager, Run as admin off); `LUA_TOKEN` alone keeps the High label. The restart notice reports the setting and the rights measured for the engine and its helper, never the setting alone. Tests copy an elevated token they may only query (`token_probe::elevated_source`, the linked token of a UAC-filtered session); nothing elevated runs. See [run-on-boot.md](docs/rust-engine/run-on-boot.md#the-engine-stays-in-session-0-decision-94). [decided: user 2026-10-22 11:21Z-11:22Z; verified: `token_rights.rs`, `winproc.rs`, `domain/runtime_notices.rs`; tests `winproc::restricted_tests`]

- **The installer's tasks match their operator by SID, never by the COM name.** Task Scheduler's COM `Principal.UserId` gives the account NAME of a task registered by SID, while its XML keeps the SID the installer registered and checks (both owned tasks on alpha.34, measured read-only). The Run as admin and Run on boot elevated scripts resolve the operator to a SID before they compare (`runasadmin.ts` `OPERATOR_FUNCTIONS`: XML first, a name translated); what does not resolve never matches, nor does a record without an operator. An elevated script's failure reaches the desktop only through `LastChangeFailure` in the protected HKLM Runtime key, under the change's nonce: never a file the user can write, which a planted link could redirect. See [run-on-boot.md](docs/rust-engine/run-on-boot.md#tasks-and-the-installers-record). [verified: `apps/desktop/main/runasadmin.ts`, `runonstartup.ts`, the user's PC 2026-10-22 13:10Z; tests `tests/session-task-settings.test.mjs`]

- MQTT/WebSocket watchdog `send` uses the dog's existing authorized connection;
  MQTT requires a publish topic and shares the 64 KiB encoded-payload cap.
  Disconnected sends do not queue for reconnect. See [MQTT watchdogs](docs/rust-engine/mqtt-watchdogs.md).
  [decided: user 2026-10-21 13:44:58Z; verified: `runtime/watchdogs/mqtt.rs`, `mqtt/conn.rs`]
  Network watchdog `configure` changes `connection_messages` (notice by default, wake or off), with a required valid choice
  and owner/authorized-superior reach, without reconnecting or replaying hellos.
  See [WebSocket connection notices](docs/rust-engine/websocket-watchdogs.md#connection-notifications).
  [verified: `tools/mod.rs`, `runtime/watchdogs.rs::configure_connect`, 2026-10-21]

- State belongs to an agent actor or an org feed task; communicate through their channels. No global locks. Keep queues bounded and reads paged/indexed; work must not grow with inactive history. Transactions are short, lock only needed rows and contain no provider calls, file I/O or process control. Read the [engine/storage notes](docs/agents/engine-and-storage.md) and the current source contract before changing a writer or feed. [decided: user, PLAN §2.2]
- Apply `#[logged]` to engine free functions and inherent `impl` blocks, not individual associated functions inside an annotated impl. Use `#[nolog]` for secrets and justified hot helpers. Never serialize secrets or print them through `Debug`; masking field names is not a safety net. Preserve typed refusals and existing authorization checks. [decided: user, DECISIONS 5, 34–36; verified: engine/rs/orgtree-logged/src/lib.rs, engine/rs/orgtree-engine/src/trace.rs]
- Keep startup identity about the agent itself. Reports, peers, credits, open questions, mail and other live state arrive in the turn envelope. Do not let unrelated tree changes rewrite another agent's cached prefix. Generated instructions must not name tools whose groups are disabled; charters and supplied notes stay verbatim. Provider/account/model/session or prefix changes can alter cache continuity; never promise a cache hit. [Instructions and skills](docs/agents/instructions-and-skills.md). [verified: runtime/identity.rs, domain/tool_groups.rs]
- Desktop loads/actions use HTTP and pushed org/app sockets; agent tools use their harness transport. Keep renderer payloads, scope and lifecycle behavior compatible unless the user signed a change. Reuse shared desk, link, menu, window and state helpers rather than forking controls. Maintain bounded history reads and the owning-window behavior of pins, popouts, focus and geometry. Read the relevant [desktop notes](docs/agents/desktop-and-renderer.md) and [provider notes](docs/agents/providers-and-accounts.md) before editing those paths. [decided: user, DECISIONS 13–14; verified: renderer contract]
- **One link, one behaviour.** Every link to the same kind of thing (agent, project, docket item, file, watchdog, document, mail, org, account, ...) uses ONE shared context-menu builder and ONE shared tooltip source on every surface: transcript text and mentions, tool cards and annotations for every harness, canvas cards and mini icons, desks, inbox, docket, presentations, lists, menus and popouts, including context-menu submenus that act as links (Owner..., Presenter... and the like), which get the same submenu and tooltip as any other link to that thing. Its context menu is the same wherever a menu applies, and its hover tooltip is exactly the same text, except for the signed name rule in [agent-identity-tooltip](docs/rust-engine/agent-identity-tooltip.md): name-visible links omit the name, links whose name is not immediately visible (icon-only and the like) put it first, far-zoom cards omit it; this applies to projects as well as agents. Within each of those classes the text is identical. Every other explicit user ruling that makes a particular link different also stays; quote that ruling to the user when the difference comes up. A surface that cannot offer an item must say why in source. Do not hand-build a menu or tooltip for a link. [decided: user 2026-10-21 06:45Z, 06:47Z, 06:47:53Z, 06:48:13Z, 06:49:18Z]
  Ticket links share current `Status · full title` hover text; an unknown status
  leaves the title alone. See [ticket identity hover](docs/agents/desktop-and-renderer.md#ticket-identity-hover).
  [decided: user 2026-10-21 17:38:28Z; verified: `canvas/objecttooltip.ts`]
- Follow the [Windows machine-traps page](docs/skills/orgtree-working/workspace/machine-traps/SKILL.md) before shell/file edits: preserve UTF-8/CRLF, write escape-heavy scripts as files, do not treat JSON quoting as shell escaping, and verify resolved paths/activity before authorized cleanup. [decided: user/coordinator 2026-10-16]

## Find the detailed rule

Read the topic relevant to your change, then its linked source/contract. The preserved records include superseded states and old evidence limits; their dates, explicit replacements, current source and signed decisions determine applicability. Moving a record does not make it a new ruling.

| Topic | Read before changing |
| --- | --- |
| [Engine and storage](docs/agents/engine-and-storage.md) | Actors, bounded reads, transactions, migrations, logging and data contracts. |
| [Agent runtime](docs/agents/agent-runtime.md) | Turns, context, compaction, warm processes, sessions, interrupts and transcript recovery. |
| [Providers and accounts](docs/agents/providers-and-accounts.md) | Harnesses, model/effort offers, account binding, credentials, usage and inference routes. |
| [Instructions and skills](docs/agents/instructions-and-skills.md) | Identity prefixes, tool cards, notes, globals, shared skills and glossary delivery. |
| [Organization tree and tools](docs/agents/org-tree-and-tools.md) | Scope, authority, topology, credits, hiring, lifecycle and typed tool contracts. |
| [Projects and concurrency](docs/agents/projects-and-concurrency.md) | Project folders, policy, slots, listeners, watchdogs, queues and coordination. |
| [Mail and hub](docs/agents/mail-and-hub.md) | Delivery, mentions, inboxes, outside authority, files, Hubchat and hub transport. |
| [Docket and presentations](docs/agents/docket-and-presentations.md) | Work records, questions, documents, attachments, viewers and attention. |
| [Desktop and renderer](docs/agents/desktop-and-renderer.md) | Canvas, desks, links, menus, windows, geometry, rendering and visual behavior. |
| [Startup and release](docs/agents/startup-and-release.md) | Boot, shutdown, placement, installers, native integration, updates and release evidence. |
| [Development and verification](docs/agents/development-and-verification.md) | Worktrees, build/resource rules, tests, evidence, platform traps and maintenance. |
| [Legacy and superseded records](docs/agents/legacy-and-superseded.md) | 3.x implementation/procedures, stopped work, historical states and earlier guidance. |

The [built-in glossary](docs/skills/orgtree-working/SKILL.md) covers agent tools and working rules; [the app reference](docs/skills/orgtree-app/SKILL.md) covers screens/settings; [workflows](docs/skills/orgtree-workflows/SKILL.md) covers suggested team patterns. Use the current tool schema and read the named page before first acting in its area. Keep screen/settings inventories and `tree.json` current in the same landing. Shared findings and decisions belong in the narrowest team/project/org scratch whose readers need them, within write scope; [hierarchical shared memory](docs/skills/orgtree-working/workspace/shared-folders/SKILL.md) explains inherited notes and session-start copies.

## Keep this file current

- **Put detailed facts in their topic document in the same landing as the change.** Date them in UTC, keep the existing `[decided: …]` / `[verified: …]` attribution and source links, and state what changed or was superseded. New signed Rust decisions go in [DECISIONS](docs/rust-engine/DECISIONS.md). Add a root line only when it is essential before any work starts. Do not prepend per-feature or per-landing logs here. [decided: user 2026-10-20, repository instruction reduction]
- Consolidate repeated current guidance in the relevant topic; keep superseded details in the [history reference](docs/agents/legacy-and-superseded.md). The earlier entries have preservation markers: if moving one, update its destination in [coverage.json](docs/agents/coverage.json); if superseding one, retain its original record in history and write the replacement with its date/source. Do not silently rewrite or remove an attributed record.
- Keep this guide **well below 60,000 bytes**. It is loaded into agent sessions. Topic docs are read on demand. Keep `main` public-safe: no credentials, secrets, email addresses, personal names/paths or live data; use generic examples. Do not add a root `CLAUDE.md`. [decided: user 2026-10-05, 2026-10-20]
- Check documentation-only changes with `node docs/agents/check-coverage.mjs --self-test` and `git diff --check`. The checker proves all original nonblank lines/entry bodies and ruling/verification tags remain reachable; it also checks the root budget and local navigation. Its [usage and reconciliation procedure](docs/agents/README.md#preservation-check) explains how to incorporate concurrent landings before handing an exact SHA to the coordinator.

## Older section links

Compatibility links to the original section records:

<a id="orgtree-400-rust-engine-read-this-first"></a>[orgtree-400-rust-engine-read-this-first](docs/agents/development-and-verification.md#e-f76fd81794788f25)<br>
<a id="what-orgtree-is-and-where-it-stands"></a>[what-orgtree-is-and-where-it-stands](docs/agents/legacy-and-superseded.md#e-208587af261f95e0)<br>
<a id="architecture"></a>[architecture](docs/agents/legacy-and-superseded.md#e-a7e56472b11bd3c8)<br>
<a id="processes-and-the-desktopengine-boundary"></a>[processes-and-the-desktopengine-boundary](docs/agents/legacy-and-superseded.md#e-c56984b7084f1ccc)<br>
<a id="storage"></a>[storage](docs/agents/legacy-and-superseded.md#e-569b3623b1f9d2fd)<br>
<a id="turns-jobs-and-the-feed-built-today-vs-320"></a>[turns-jobs-and-the-feed-built-today-vs-320](docs/agents/legacy-and-superseded.md#e-1eb7e758aa691fb2)<br>
<a id="code-map"></a>[code-map](docs/agents/legacy-and-superseded.md#e-99bfbdbace3575da)<br>
<a id="design-rules-and-invariants"></a>[design-rules-and-invariants](docs/agents/legacy-and-superseded.md#e-0507d142fa252ea1)<br>
<a id="data-model-320"></a>[data-model-320](docs/agents/legacy-and-superseded.md#e-76435f20db8b6fff)<br>
<a id="transactions-and-locks"></a>[transactions-and-locks](docs/agents/legacy-and-superseded.md#e-6b8ad861528d902e)<br>
<a id="history-must-cost-nothing"></a>[history-must-cost-nothing](docs/agents/legacy-and-superseded.md#e-15606c8a09b30a5f)<br>
<a id="background-work-the-feed-and-turns"></a>[background-work-the-feed-and-turns](docs/agents/legacy-and-superseded.md#e-060e49d7c8167ba6)<br>
<a id="processes-privileges-and-startup"></a>[processes-privileges-and-startup](docs/agents/legacy-and-superseded.md#e-f238eaa6f9df1847)<br>
<a id="desktop-and-renderer"></a>[desktop-and-renderer](docs/agents/legacy-and-superseded.md#e-efef587deabb5245)<br>
<a id="product-rulings"></a>[product-rulings](docs/agents/legacy-and-superseded.md#e-e10014dd52fcebe9)<br>
<a id="org-agents-and-topology"></a>[org-agents-and-topology](docs/agents/legacy-and-superseded.md#e-3f4a1233215d38db)<br>
<a id="turns-mail-and-notices"></a>[turns-mail-and-notices](docs/agents/legacy-and-superseded.md#e-2e8c3efa8f0b52f7)<br>
<a id="docket-questions-and-attention"></a>[docket-questions-and-attention](docs/agents/legacy-and-superseded.md#e-85049c25eb1366bf)<br>
<a id="providers-accounts-and-usage"></a>[providers-accounts-and-usage](docs/agents/legacy-and-superseded.md#e-9914c59ebc94e1f5)<br>
<a id="desktop-ui"></a>[desktop-ui](docs/agents/legacy-and-superseded.md#e-3898c44fbc17f6fb)<br>
<a id="installer-updates-and-data"></a>[installer-updates-and-data](docs/agents/legacy-and-superseded.md#e-7ccf4b6a79900f27)<br>
<a id="development-workflow"></a>[development-workflow](docs/agents/legacy-and-superseded.md#e-633ee0e230c60afb)<br>
<a id="branches-and-worktrees"></a>[branches-and-worktrees](docs/agents/legacy-and-superseded.md#e-169809c0b4e4aaf5)<br>
<a id="tests"></a>[tests](docs/agents/legacy-and-superseded.md#e-c38f86e06d76d7c3)<br>
<a id="reviews-and-landing"></a>[reviews-and-landing](docs/agents/legacy-and-superseded.md#e-9a8992eb8974885d)<br>
<a id="evidence-and-reporting"></a>[evidence-and-reporting](docs/agents/legacy-and-superseded.md#e-4fdd08ec9b1019e1)<br>
<a id="releases-builds-and-updates"></a>[releases-builds-and-updates](docs/agents/legacy-and-superseded.md#e-09f5223553b01ead)<br>
<a id="machine-traps"></a>[machine-traps](docs/agents/development-and-verification.md#e-802759bf35d36260)<br>
<a id="gotchas-in-orgtrees-own-agent-tools"></a>[gotchas-in-orgtrees-own-agent-tools](docs/agents/legacy-and-superseded.md#e-02a966787cf8cf65)<br>
<a id="removed-and-dead-ideas"></a>[removed-and-dead-ideas](docs/agents/legacy-and-superseded.md#e-962161abcd765385)<br>
<a id="where-the-detail-lives"></a>[where-the-detail-lives](docs/agents/legacy-and-superseded.md#e-8d3b3b0a9bb77e9d)<br>
<a id="mcp-imports-from-installed-harnesses-2026-10-15"></a>[mcp-imports-from-installed-harnesses-2026-10-15](docs/agents/instructions-and-skills.md#e-696c902e76e39caa)<br>
<a id="shared-skills-and-installed-plugin-imports-2026-10-15"></a>[shared-skills-and-installed-plugin-imports-2026-10-15](docs/agents/instructions-and-skills.md#e-87e9373ea83fb86f)

- Ancestor scope/funding/presenter reads traverse the complete chain and refuse cycles. Scope/funding retain root-first row-lock order; presenter reads share the ordered scope helper. No org-wide lock is added. See [ancestor-chain.md](docs/rust-engine/ancestor-chain.md). [verified: `domain/{ops,projects,docs}.rs`;2026-10-23]

- Organization templates retain nested-v1 files with no node/depth ceiling and a 16 MiB file bound. Raw tree indexing, flat ownership and iterative export/plan avoid recursive Clone/Drop. Save reads all live nodes by keyset paging and keeps project queue/event policy, per-agent speed and explicit OpenRouter pins. See [template-portability.md](docs/rust-engine/template-portability.md). [decided: user 2026-10-22; verified: `domain/template_wire.rs`, `domain/templates.rs`, `http/templates.rs`]

- Reply selections use exact canonical source-part digests and Unicode-scalar ranges; the server derives immutable excerpt/context snapshots and preserves ordinary recipient/attention checks. Never anchor by a quote substring or expose hidden/sealed text. See [selection replies](docs/rust-engine/selection-replies.md). [verified: `engine/rs/orgtree-engine/src/domain/reply_sources.rs`, `apps/desktop/renderer/src/canvas/selectionmap.ts`; 2026-10-23]
