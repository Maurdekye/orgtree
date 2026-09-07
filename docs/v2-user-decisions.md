# Orgtree v2.0 user decisions (current, chronological)

This is the binding record of what the user has decided for Orgtree v2. Entries are in time order and the NEWEST ENTRY WINS wherever two conflict. The original 5 September brief is preserved verbatim in `docs/v2-original-design-brief.md` and is historical: everything in it that is not repeated or confirmed below has been superseded. `docs/supplied-design-decisions.md` is the coordinator's earlier working record of the same rulings; this file supersedes it as the reference. Transport, startup and credential mechanics are owned by `docs/engine-contract.md`, and the v1 feature inventory by `docs/v1-parity-inventory.md`; this file does not restate them.

All times are UTC on 7 September 2026 unless stated. The hard stop is 2026-09-08 01:00 UTC (04:00 Israel).

## Current scope index

Where things stand after the last decision recorded (7 September, 21:06 UTC, relayed by the coordinator 21:07 UTC).

**Foundation (settled):**
- Electron desktop application, Windows installer first, platform-agnostic for later macOS/Linux builds. Chromium UI stays.
- Engine: reuse and reorganize the existing Python backend, bundled with the application as a real interpreter directory. No rewrite. v1 source is copied into this repository and modified here; the v1 repository is never a runtime dependency and is never edited.
- Separate v2 data root from first run. First run starts fresh; import of v1 organizations is a copy-only, validated action available later in Settings. The live v1 root is never moved or modified.
- Exit on close OFF by default (closing the last main window keeps the engine running in the tray); explicit tray/toolbar Exit closes everything. Start at login ON by default, quiet in tray. Never prevent system sleep.
- Harness setup is DETECT ONLY: warn when no harness is found and link to Claude Code, Codex and Antigravity. No automatic installation.
- Updates download and apply automatically at a safe idle point, never interrupting an agent turn. Distribution via GitHub PRERELEASE in Maurdekye/orgtree; unsigned prototype installer accepted with the Windows trust warning disclosed. Installer offers current-user (default) or all-users.
- Uninstall keeps organization data and history.

**MVP target: full parity with current Orgtree** (every feature in `docs/v1-parity-inventory.md`) minus the exclusions below, plus:
- Unfinished v1 work that is retained: contextual (right-click) actions, pinned-modal overlap fading with a toggle and adjustable opacity, supervised unstick, and other authorized unfinished features. Workers reuse private v1 checkpoints where they exist.
- Reply to an individual chat message or event (v2 only): stable source identity org/agent/generation/event, removable composer preview, source navigation when available, quoted context to the agent, metadata preserved through drafts, window transfer, send receipts, reload and compaction; unavailable sources stay explicitly unavailable with the quote retained.
- Download buttons for presented documents and HTML prototypes. HTML with local assets downloads as a complete ZIP; single-file HTML may download directly. Downloaded HTML never gains desktop privileges. HTML presentations may load internet resources.
- Integrated Docker-free mail hub. Authenticated peer connections between installations are retained, managed in a Connections area, with correspondence shown in the existing Mail views. No separate hub application UX.
- Multi-provider support (Claude, Codex, Antigravity, OpenRouter) with configured-connection authentication and usage visibility.
- Crash/restart recovery resumes every agent that was mid-turn, preserving session continuity and reconciling uncertain tool results rather than repeating mutations; idle agents are not resumed merely because a queue exists. The same resume applies after import; import may run while the source v1 keeps running, with a duplicate-work warning.
- Notifications default to needs-attention only (questions, urgent mail, ticket attention); routine events are configurable. History, documents and work records are kept until manually removed.
- Default agent folder grant is the chosen project folder.
- Visual style: preserve and improve the existing graph and desk layout; performance and native-window improvements allowed; no wholesale neutral redesign.

**Excluded from v2 MVP (user decisions):**
- Kiosk mode and every public/browser-sharing exposure.
- Git tracking/management features (the v1 Git workspace and git-backed docket verification).
- ALL multi-account management: registration, configuration-directory management, hire balancing, reassignment UI and any fallback/failover. Keep provider, harness and account identity separate in the architecture so a later provider-agnostic, symmetric account system remains possible; do not transplant the v1 fallback registry.
- Mobile application development and integration.
- ALL agent execution sandboxing and isolation (containers, disks, kiosk sandboxes). Electron renderer isolation, credential boundaries and folder/tool authority remain as application safety controls; they are not agent execution sandboxes.

**Rules already fixed for the later multi-account system (21:06 UTC):** accounts at a limit or without authentication wait by default; moving an existing agent needs an explicit user or supervising-agent decision, never automatic fallback; every registered account is available to every organization by default; accounts remain symmetric and provider-agnostic.

**After MVP, conditionally, within the same hard stop:** if agreed MVP parity plus the additions above complete early with usage allowance and time remaining, proceed FIRST to integrating the existing Git system, THEN to the provider-agnostic symmetric multi-account system. No new permission is needed to begin these phases once MVP is achieved. This replaces the earlier "stop at parity" instruction.

**Unconditional stop:** at the FIRST of usage-limit exhaustion or 2026-09-08 01:00 UTC, stop all work immediately, regardless of completion. Checkpoint before the deadline. No post-deadline continuation, review or report turns except enforcement.

## Decisions in time order

### 5 September 2026: first design brief (historical)

The user's discussion draft. Retained from it, as later confirmed: product owns installation and operation; repository and product named `orgtree`; standalone Chromium-based desktop application with a Windows installer; provider- and harness-neutral architecture that shows provider differences honestly and never manufactures equivalence; replaceable themes with a neutral default where a provider theme changes no privileges or routing; separate data for development; copy-based import that never modifies the live v1 root; untrusted agent output, Markdown, HTML and external pages gain no desktop privileges; three responsibilities (desktop interface, organization engine, provider/harness adapters) with explicit boundaries; distinguish provider, model, harness, account and route.

Superseded from it: "no repository, implementation or framework commitment", selective parity with a keep/redesign/defer/omit review, open engine language and framework, and its ordering of design stages. See the entries below.

### 6 September 2026

- 08:20 UTC, account configuration and hire placement: alternative configuration directories, symmetric accounts, all usage shown together, agent-chosen account placement, account tints. DEFERRED on 7 September 20:29 UTC (see below); retained only as the future design target.
- 08:40 UTC, pinning and popout: individual agent or modal tabs pop out into separate native windows alongside pinning; one shared organization, popout is a view operation. STILL BINDING.
- 08:45 and 09:11 UTC, dedicated mobile remote access with QR pairing and NAT traversal, no user-run servers. EXCLUDED from v2 until MVP clearance on 7 September 20:05 to 20:11 UTC.

### 7 September 2026

- 20:05 to 20:11 UTC: new empty repository at E:/Libraries/Desktop/orgtree; planning, prototype implementation and commits are authorized (supersedes "nothing begins now"). Target ALL current Orgtree features for parity except kiosk/public exposure, Git tracking/management, fallback account systems and mobile. Easy Windows setup in minutes, auto updates, background startup, tray icon with active-agent statistics, integrated Docker-free mail hub. Platform agnosticism for future macOS/Linux; Windows first. Codex usage conservation lifted for the push; Codex hires only Astra and Luna. Fable may do architectural design and review. v1 bug work may continue in parallel without displacing v2.
- 20:13:47 UTC: the user pasted the 5 September brief in full (preserved in `docs/v2-original-design-brief.md`).
- 20:25 UTC: ELECTRON selected as the desktop framework; earlier open-framework wording superseded. 4.5 hours stated for planning and implementation; prioritize a working foundation, then expand parity with explicit remaining scope.
- 20:29:06 UTC: MULTI-ACCOUNT MANAGEMENT DEFERRED from the prototype (supersedes the 6 September 08:20 decision as prototype scope and the account-placement questions). Later target: provider-agnostic, symmetric accounts, equal capabilities, no main/secondary distinction. Multi-provider support stays in scope and is distinct from multiple accounts per provider. Preserve the provider/harness/account identity separation; build no registration, balancing or reassignment now.
- 20:31:40 UTC, foundation answers: reuse and reorganize the existing Python engine bundled with Electron, no rewrite; Exit on close defaults OFF with explicit exit available; harness setup DETECT ONLY with a visible no-harness state and links to Claude Code, Codex and Antigravity.
- 20:34:48 UTC, defaults and sandbox removal: preserve and improve the existing layout and visual style; auto updates at a safe idle point; Start at login ON by default; REMOVE ALL kiosk and agent sandbox/isolation features (supersedes the parity inventory's optional container/disk sandbox rows). Deadline fixed at 04:00 Israel / 01:00 UTC 8 September.
- 20:37 UTC: NEW feature, reply to an individual chat message or event (v2 only), with the identity, preview, navigation, quoting and persistence rules listed in the scope index. Implementation details are the coordinator's to propose.
- 20:39 to 20:40 UTC: after crash or machine restart resume all agents that were mid-turn, with session continuity and reconciliation of uncertain tool results; installer current-user default with all-users option; unsigned prototype installer accepted; publish GitHub PRERELEASE in Maurdekye/orgtree and use its releases for auto updates; review large integrated blocks rather than small patches, workers commit, test and land their bounded owned work without small-step clearance; keep asking consequential product decisions while the user is awake.
- 20:40:51 and 20:42:03 UTC: HARD STOP at 04:00 Israel / 01:00 UTC 8 September regardless of MVP completion, to preserve Codex usage; checkpoint before it. Add Download buttons for presented documents and HTML prototypes, preserving original source and usable filenames; downloaded HTML has no desktop privileges.
- 20:43:38 UTC: resume agents recorded as active after import validation and restore enabled automation; source v1 stays copy-only. HTML presentations may load internet resources. Notifications default to needs-attention only, routine events configurable. History, documents and work records kept until manually removed. GitHub push uses the existing Maurdekye credential through a per-command helper; never overwrite global auth.
- 20:45:57 and 20:46:36 UTC: stop at the first of full parity minus omissions plus planned additions, usage limit, or 04:00 Israel (the parity condition is later replaced, see 20:50 to 21:03). Copy import may resume while v1 keeps running, warn about duplicate work, never require stopping v1. HTML prototype download is a complete ZIP with local assets; single-file HTML may download directly. First run STARTS FRESH; import later in Settings. Default agent folder grant is the chosen project folder. Copy licensed v1 source into this repository and modify the copy; never depend on or edit the old repository at runtime. Retain contextual actions and pinned-modal overlap fading with toggle and adjustable opacity; reuse private v1 checkpoints.
- 20:50 to 21:03 UTC (newest, wins on conflict): never prevent system sleep. Uninstall keeps data and history. Retain authenticated peer connections between installations; public browser access stays excluded. Closing the main window leaves popouts open; explicit tray/toolbar Exit closes every window; restore previous popouts and monitor layout on manual reopen; login startup stays quiet in the tray. Connections area for peer pairing, setup and status, with correspondence in the existing Mail views, no separate hub UX. Full parity INCLUDES currently unfinished v1 work (modal overlap fading, contextual actions, supervised unstick, other authorized unfinished features) plus event replies and document/HTML downloads, which must be retained explicitly in the docket. CHANGED STOP POLICY: if MVP parity and additions complete early with allowance and time remaining, proceed first to existing Git system integration, then to the provider-agnostic symmetric multi-account system; usage exhaustion or 01:00 UTC remains the unconditional hard stop. The user asked for remaining post-MVP Git and account choices to be raised before they become unavailable; no new permission is needed to begin those phases once MVP is achieved.

- 21:06:15 UTC, multi-account rules for the later account system (newest, wins on conflict): accounts that reach limits or lose authentication WAIT by default; reassignment requires an explicit decision by the user or an authorized supervising agent, never automatic fallback or rollover. Users AND supervising agents may move existing agents across accounts, within descendant authority boundaries, and any session or cache continuity change must be visible. ALL registered accounts are available to all organizations by default; the proposed per-organization opt-in was rejected. Accounts stay symmetric and provider-agnostic with no main/secondary distinction. New-account setup by importing profile directories or creating managed separate profiles is under discussion and not verified across harnesses.

## How to use this file

Add new user decisions at the end of the time-ordered list with their UTC timestamp, then update the scope index so it reflects the newest state. Do not edit the verbatim brief. If a decision here conflicts with `docs/engine-contract.md`, the contract is a technical realization of these decisions and should be corrected to match, not the other way round.
