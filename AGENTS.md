# AGENTS.md — working on Orgtree

Read this file before working in this repository. It is the startup guide, not a landing log. Detailed rules, source references and the complete earlier notes live in the [topic index](docs/agents/README.md).

Recursive project fires must construct nested futures with `util::boxed(|| ...)`: `Box::pin(f())` still grows debug poll frames at every level, even with the depth-four cutoff. See [fire-action stack verification](docs/rust-engine/tool-cards.md#fire-actions). [verified: `domain/listeners.rs`, 2026-10-22]

## Read this first

1. **Work on the assigned line and scope.** Current development is the Rust engine in `engine/rs/` on local `rust-engine` (4.4.0). The 3.x Python rewrite is stopped; its procedures are historical. Read [PLAN §10](docs/rust-engine/PLAN.md#10-user-facing-differences--complete-ledger), [DECISIONS](docs/rust-engine/DECISIONS.md) and [HANDOFF](docs/rust-engine/HANDOFF.md). Preserve 3.x product behavior unless a signed decision changes it. Current user rulings and the assignment take precedence over old notes. [decided: user 2026-10-06, DECISIONS 1–2, 45]
2. **Keep source, live data and ownership separate.** Use your own worktree and branch from the exact base assigned by the integrator. Never edit another author's checkout or use a bare shared `git stash`. Never link or copy source or `node_modules` between worktrees. Commit your work before probing a base or mutating it for a control. Rebase/cherry-pick with `git -c rerere.enabled=false`; inspect resolutions and Unicode before staging. Follow current team instructions for source/output locations. [Worktree guide](docs/skills/orgtree-working/workspace/worktrees-and-git/SKILL.md); [machine traps](docs/skills/orgtree-working/workspace/machine-traps/SKILL.md). [decided: user 2026-10-05; team charter]
3. **Do not touch live Orgtree data.** Work only on authorized source and your own scratch. Do not build an installer, install, restart, publish, release, tag or push without explicit assignment. Integration and releases belong to the coordinator or its named owner. Never use a bare SAFE_START engine as a substitute for an isolated test rig: it can still read real sign-ins and run provider probes. [Rig guide](docs/rust-engine/test-rig.md). [decided: user/team charter; verified: apps/desktop/main/policy.ts]
4. **Prepare before heavy work.** Heavy build/check/test/renderer/capture/packaging phases require the current machine-wide build permit, memory floor, process containment and assigned output scope. Read the current project Summary/team instructions and [build guide](docs/skills/orgtree-working/workspace/builds-under-the-lock/SKILL.md); do not revive the retired file lock or Python/P03 recipes. Release the permit immediately after the phase, before reports or unrelated work. Do not end a turn with your children still running. [decided: user/team charter]
5. **Use the current verification phase.** Run the author's focused checks appropriate to the change; use a meaningful failing control where it fits. Independent review, full combined rounds and publishing checks follow the current user/coordinator phase, not an old blanket rule. Do not run the full baseline or broad suites without assignment. A skipped, empty, timed-out or crashed test is not a pass. Keep raw status/signal/error and measured limits; check that the intended source actually ran. [Verification notes](docs/agents/development-and-verification.md). [decided: user 2026-10-16, author tests until publishing; team charter]
6. **Respect decisions and boundaries.** Search current source comments and the relevant topic before changing behavior. Keep one owner per piece; respect stopped work, waivers and review caps. A folder/tool grant is not authority for unrelated work or deletion. After a timed-out write, read state before retrying. Report exact committed/tested/integrated/built states separately. [decided: user/team charter]

Before renderer or desktop-main tests, visual captures or rig proofs, read the [test and capture traps](docs/agents/development-and-verification.md#renderer-capture-and-rig-traps): reduce DOM assertions to scalars, run main's own closures rather than one handler's text, wait for paint, and verify the PNG and the engine log being measured. [decided: coordinator 2026-10-21, standing-note relocation; main closures verified 2026-10-22: `tests/run-as-administrator.test.mjs`]

## Engine and desktop invariants

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

- Windows startup tasks remain enabled for explicit demand launches. “Run on boot” off disables **every boot/logon trigger** on the owned boot engine, credential helper and user-session engine tasks; it never starts any of them. Installer stop temporarily disables tasks and restores prior states if draining fails. Keep the protected `RunOnStartup` preference and one UAC prompt per change. [decided: user 2026-10-10, coordinator 2026-10-21; verified: `tools/boot-engine-task.ps1`, `apps/desktop/main/runonstartup.ts`]

- **The engine runs in the signed-in session after a restart or update.** At the console, restarts, updates and crash recovery run the owned "Orgtree User Session Engine" task (interactive token, windowless via `orgtree-credential-broker.exe session-engine`). Its `session-launch signin` hands the engine over: `core-handover.lock`, the durable `core-handover.json`, generation-bound native admission, graceful stop, start here. A failure before the stop leaves the old engine untouched; after it, exactly one boot-task rollback. The boot host never starts Session 0 while the operator is at the console: it waits, falls back after the sign-out debounce, and claims recovery after 120 s through the shared durable claim. The boot host is one process for the whole boot: each engine it starts gets its own readiness window, and its own engine settles an earlier loss or delegation (the loop does not read while `host::once` runs). Cold boot keeps S4U in Session 0. One “Run as admin” sets all three tasks' run levels in one UAC write, and its sign-in trigger needs Run on boot too; “Run this session as admin” is one UAC prompt per click and never changes it. See [decision 93](docs/rust-engine/run-on-boot.md#restarts-and-updates-while-signed-in-decision-93). [decided: user 2026-10-21 15:27Z, coordinator 15:29Z/16:27Z; verified: `session_launch.rs`, `boot_supervisor.rs`, `host.rs`, `main/sessionlaunch.ts`; proof `session0-handover.mjs`, run unsplit]

- **PostgreSQL never runs as administrator.** It refuses to ("Execution of PostgreSQL by a user with administrative permissions is not permitted"), so on Windows `pg.rs` starts the postmaster only through `winproc::spawn_restricted`: `restricted_medium_token` (Administrators/Power Users deny-only, no privilege but SeChangeNotify, Medium, a user default DACL), its real pid, both log streams, `pg_ctl` stop and the engine's job. initdb restricts itself; keep `PG_RESTRICT_EXEC` cleared for it. Never start postgres.exe with the engine's own token: an elevated engine (Run as admin, Run this session as admin) keeps its rights for its agents only. Likewise, create every pipe that the user's own processes open (hosted CLI stdio, the tool bridge, OpenCode mail) with `winproc::create_user_pipe`. That is the default pipe security plus the engine's user and a Medium label; an elevated engine's default would make them read-only for the helper. See [decision 93](docs/rust-engine/run-on-boot.md#restarts-and-updates-while-signed-in-decision-93). [decided: coordinator 2026-10-21 22:51Z, the user's alpha.29 run; verified: `pg.rs`, `winproc.rs`; test `pg::rights_tests`]

- MQTT/WebSocket watchdog `send` uses the dog's existing authorized connection;
  MQTT requires a publish topic and shares the 64 KiB encoded-payload cap.
  Disconnected sends do not queue for reconnect. See [MQTT watchdogs](docs/rust-engine/mqtt-watchdogs.md).
  [decided: user 2026-10-21 13:44:58Z; verified: `runtime/watchdogs/mqtt.rs`, `mqtt/conn.rs`]
  WebSocket `configure` changes only `notify_on_connect`, with a required boolean
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
