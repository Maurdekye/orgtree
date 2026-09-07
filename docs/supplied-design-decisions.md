# Orgtree v2.0 � supplied design brief and current rulings

Source: user pasted �Orgtree v2.0 � first design brief�, discussion draft 5 September 2026, in the 2026-09-07 20:13:47 UTC message. This file records its requirements and decisions; it is not a verbatim reproduction.
Original backlog reference: orgtree-v2-standalone-provider-agnostic-desktop.

## Existing decisions retained
- Product owns installation and operation of an agent organization; value is easier operation, understanding and recovery, beyond wrapping the webpage.
- Repository/product name orgtree; standalone Chromium-based desktop application, Windows installer first.
- Provider- and harness-neutral architecture, terminology, workflows and account handling. Explicit unsupported capabilities; no false equivalence.
- Replaceable themes with neutral default, documented colors/type/spacing/accents. Provider theme does not change privileges or routing. Status uses text/symbols as well as color.
- Register accounts through alternate configuration directories; replace proprietary fallback setup tokens. All accounts symmetric, no primary/secondary hierarchy. Show all usage together, distinguish unknown from zero. Agents may choose account placement for new hires. Account identity uses lighter/darker tints independently of status/model. Credentials stay in configuration context, never renderer data/transcripts/diagnostics. Separate account cache namespaces, no promised cache hit.
- Individual agent or modal tabs pop out into separate native windows alongside pinning. One authoritative organization/session, not duplicate agents. Pin stays in current window; popout supports OS tiling/multiple monitors.
- Initial development uses separate data. Import copies and validates v1 data without moving/modifying live v1. Application rollback and database compatibility are separate.

## Responsibilities and contracts
1. Desktop interface: windows, navigation, notifications, themes, input.
2. Organization engine: agents, lifecycle, permissions, docket, mail, storage, scheduling, recovery.
3. Provider/harness adapters: authentication, process/API invocation, tools, usage receipts, limits and sessions.
Distinguish provider, model, harness, account and execution route. Neutral start/interrupt/resume/observe contract must be validated against at least two materially different execution paths. Inventory existing code as port/wrap/rewrite rather than automatically discarding it.

## Required product design
- Wizard: install app/runtime, choose data location, connect supported account/harness, create/open organization; no Git/development environment required to operate it. Provider/harness dependency and licensing handling remains explicit.
- Daily use: restore organizations/windows; clear active/waiting/attention state; closing a view does not inherently stop agent; explicit quit/stop semantics to settle.
- Recovery: distinguish completed, survived and unknown outcomes. Unknown effects never automatically repeated as though known not to have happened.
- Updates: code/data separated, compatibility checks, recoverable backups/import, safe pause of active agents before update.
- Untrusted agent output/markdown/HTML/external pages gain no desktop privileges. Renderer isolation and agent-command permissions are separate controls.

## Decisions still open in the brief
- Close-last-window behavior: keep background engine, ask, or stop. Suggested explicit Close window vs Stop and quit.
- Existing-agent account/model/provider changes and assigned-account unavailable behavior; approved hire placement does not decide migration/failover.
- Harness installation managed/discovered/both; config-dir validation and duplicate accounts; simultaneous usage freshness and capacity exposure.
- Portable export versus continuous synchronization; third-party adapters/themes versus built-in initially; historical session preservation when original harness missing.
- Engine language and desktop framework; signed distribution/update strategy; saved window/draft ownership behavior.
- Candidate additions: exact-target notifications, project shortcuts, command palette/global shortcut/taskbar progress/workspace layouts.

## Earlier mobile design (deferred by newer user instruction)
Authenticated end-to-end separate mobile app, direct desktop streaming, QR pairing and NAT traversal without user port forwarding or server setup. Trust/revocation, endpoint changes, fallback connectivity/relay and pixel-vs-structured stream remained open. No relay chosen. This entire mobile development/integration scope is now excluded until MVP clearance; do not implement it during MVP.

## Newer rulings override the old discussion draft
2026-09-07 20:05�20:11 UTC:
- New empty repo exists at E:/Libraries/Desktop/orgtree. Planning then prototype implementation and committing are authorized; old �no repo or implementation authorized� is superseded, with current joint architecture discussion proceeding first.
- Target all current Orgtree features for parity except kiosk/public exposing, Git tracking/management, fallback account systems and mobile development/integration. Old selective-parity proposal is superseded by this target list.
- Easy Windows setup in minutes; auto updates; background startup; tray/toolbar icon with active-agent statistics; integrated Docker-free mail hub.
- Platform agnosticism prioritized for future native macOS/Linux application builds; Windows only initial release target. Chromium decision remains unless user changes it.
- Codex usage conservation lifted for prototype push until stated 6pm Pacific reset. Codex hires only Astra/Luna; no Sol/Terra. Fable architectural design/review permitted.
- Existing v1 bug work can continue in parallel; do not let it replace the v2 discussion.

## Framework implication
Electron matches both retained Chromium UI requirement and cross-platform desktop target. Tauri uses Chromium/WebView2 only on Windows, WebKit on macOS/Linux; it would require revising the cross-platform Chromium requirement. Avalonia is portable but requires a non-web UI rebuild and a separate HTML rendering plan. No framework selection recorded yet.

## Graphics inspection � 2026-09-07
Coordinator read feature-astra/graphics-findings.md at source ac75a0d. Verified source mechanisms: offscreen graph nodes/edges remain mounted (no viewport intersection filtering), nested desk/camera transforms, animated shadows and glows, and continuously scheduled RAF with React updates gated by activity. Counterevidence: desks mount when opened, popouts retain one composer owner, and scoped source search found no blanket transform promotion or backdrop blur. No measured VRAM diagnosis or framework ranking. Proposed v2 validation: compare visible-only graph rendering, screen-coordinate rich desks, effects budgets and idle scheduling on identical isolated scenes; measure frame times, CPU, RAM, GPU memory and window-close recovery. These are design recommendations, not approved behavior changes or completed optimizations.

## Framework selected and execution window � user 2026-09-07 20:25 UTC
Electron is explicitly selected as the established desktop framework. Earlier open-framework wording is superseded. User states 4.5 hours for planning and implementation before reset; treat this as an urgent time budget, not a guarantee that all parity can be finished. Prioritize working foundation then expand parity with explicit remaining scope. Major choices to settle next: reuse/reorganize packaged Python engine versus rewrite; background close/quit behavior; assigned account unavailable behavior without fallback; managed/discovered provider harness setup. Copy-only migration, native popout tabs, symmetric accounts and four MVP exclusions remain settled.

## Multi-account scope correction � USER 2026-09-07 20:29:06 UTC
Multi-account management is explicitly DEFERRED from the prototype, superseding earlier prototype inclusion and account-placement questions. It remains a later v2 target: provider-agnostic, symmetric accounts with no main/secondary distinction and equal capabilities. Do not transplant Claude Code-exclusive fallback registry or unpredictable overrides. Multiple-provider support remains in prototype scope; it is distinct from managing multiple accounts for a provider. Preserve architecture separation of provider/harness/account identity so later implementation is possible, without building account registration, balancing or reassignment features now. User has not yet answered engine/background/setup choices; those remain open.

## Final foundation choices � USER answers 2026-09-07 20:31:40 UTC
- Engine: reuse and reorganize existing Python, bundled with Electron application; no engine rewrite.
- Background: setting Exit on close defaults OFF. Closing the last window normally keeps background operation; enabling the setting exits on close. Explicit exit remains available.
- Harness setup: DETECT ONLY. Installation/setup warns that Orgtree cannot function if no harnesses are found and provides links to Claude Code, Codex and Antigravity (agy) for user download. Do not automatically install harnesses. No-harness state must be visible in wizard; exact normal UI diagnostic behavior may remain functional.
Question q34029edf answered and resolved. Implementation foundation may begin under prior authorization. Electron, bundled Python, separate data, copied import, multi-provider support and deferred multi-account remain binding.

## Product defaults and sandbox removal � USER answers20:34:48UTC
- Appearance: preserve and improve existing graph/desk layout and visual style; performance/nativewindow improvements allowed, no neutral wholesale redesign.
- Updates: auto download/apply at safe idle point, no interrupting agentturns.
- Start at login ENABLED by default, configurable; Exit on close remains OFF by default.
- Remove ALL kiosk and agent sandbox/isolation features from v2, not merely Docker requirement. No agent isolation in MVP. This supersedes parity inventory optional container/disk sandbox rows. Electron untrusted content isolation, credential boundaries and existing tool/folder authority remain application safety controls; do not confuse with removed agent execution sandboxes.
- User explicitly supplied04:00Israel deadline,01:00UTCSep8, supersedes approximate00:55 time arithmetic. Recurring progress watchdog wd88bedf0c and one-shot endpoint wddf854849 armed.
Question q78d510fc answered/resolved. All launch-design questions answered; proceed implementation and identify any truly new behavior gaps as they arise.

## Reply to individual chat events � USER20:37:01/18UTC
NEW V2 feature: right-click any individual chat message or event and Reply; outgoing usermessage references that precise event for the recipientagent. Implement in v2 only, notv1. Stable source identity org/agent/generation/event, user-visible removable composer replypreview, source navigation when available, and referenced quoted context toagent. Preserve reply metadata through draft/windowtransfer and sendreceipts; ref must not silentlypoint to another event afterreload/compaction. Technicalimplementationdetails are coordinatorproposed torealize userbehavior, notfurtheruserchoices. Any persisted event unavailable aftermigration remains explicitlyunavailable with retainedquote rather than resolvingbyposition.

## Latest binding overrides � 2026-09-07 20:34�20:38 UTC
- Preserve and improve the current UI. Start at login ON; Exit on close OFF. Auto-apply updates only when idle.
- Remove ALL agent execution sandbox/isolation/kiosk functionality. Electron renderer sandboxing for untrusted content remains a separate security boundary, not agent execution sandboxing.
- All multi-account management is deferred; multi-provider support retained. Mobile, Git management, public exposure and fallback excluded.
- Deadline is 2026-09-08 01:00 UTC (04:00 Israel), superseding the approximate 00:55 calculation.
- Right-click any chat message/event -> Reply. Draft/send includes exact source org/agent/generation/event identity and bounded quoted context. Preview is removable, source can be jumped to, reference survives draft transfer/reload/receipt. Engine validates source, never trusts client-supplied actor provenance.
