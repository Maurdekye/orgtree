# Orgtree v2.0 user decisions (current, chronological)

This is the binding record of what the user has decided for Orgtree v2. Entries are in time order and the NEWEST ENTRY WINS wherever two conflict. The original 5 September brief is preserved verbatim in `docs/v2-original-design-brief.md`. It REMAINS THE REFERENCE FOR REQUIREMENTS except where a newer explicit decision below overrides, defers or removes a point; silence here does not waive anything the brief asks for. The scope index below is a summary of the current state, not an exhaustive list of what is retained. `docs/supplied-design-decisions.md` is the coordinator's earlier working record of the same rulings; this file supersedes it as the reference. Transport, startup and credential mechanics are owned by `docs/engine-contract.md`, and the v1 feature inventory by `docs/v1-parity-inventory.md`; this file does not restate them.

All times are UTC on 7 September 2026 unless stated. The hard stop is 2026-09-08 01:00 UTC (04:00 Israel).

## Current scope index

Where things stand after the last decision recorded (7 September, 21:53:11 UTC, relayed by the coordinator 21:55 UTC).

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
- Integrated Docker-free mail hub. Authenticated peer connections between installations are retained, managed in a Connections area (host, listen and advertised-endpoint configuration, or connect to an existing hub), with correspondence shown in the existing Mail views. No separate hub application UX and no invitation-first onboarding.
- Multi-provider support (Claude, Codex, Antigravity, OpenRouter) with configured-connection authentication and usage visibility.
- Crash/restart recovery resumes every agent that was mid-turn, preserving session continuity and reconciling uncertain tool results rather than repeating mutations; idle agents are not resumed merely because a queue exists. The same resume applies after import; import may run while the source v1 keeps running, with a duplicate-work warning.
- Notifications default to needs-attention only (questions, urgent mail, ticket attention); routine events are configurable. History, documents and work records are kept until manually removed.
- Default agent folder grant is the chosen project folder.
- Visual style: preserve and improve the existing graph and desk layout; performance and native-window improvements allowed; no wholesale neutral redesign.

**Excluded from v2 MVP (user decisions):**
- Kiosk mode and every public/browser-sharing exposure.
- Git tracking/management features (the v1 Git workspace and git-backed docket verification).
- ALL multi-account management: registration, configuration-directory management, hire balancing, reassignment UI and any fallback/failover. Keep provider, harness and account identity separate in the architecture so a later provider-agnostic, symmetric account system remains possible; do not transplant the v1 fallback registry. (Deferral LIFTED for the account system on 2026-09-09 â€” see the dated 2026-09-09 entries: design and implementation explicitly authorized, Git prerequisite waived for accounts only.)
- Mobile application development and integration.
- ALL agent execution sandboxing and isolation (containers, disks, kiosk sandboxes). Electron renderer isolation, credential boundaries and folder/tool authority remain as application safety controls; they are not agent execution sandboxes.

**Rules already fixed for the later multi-account system (21:06 to 21:09 UTC):** accounts at a limit or without authentication wait by default; moving an existing agent needs an explicit user or supervising-agent decision, never automatic fallback; every registered account is available to every organization by default; accounts remain symmetric and provider-agnostic. New-account setup (21:07 UTC) supports both imported and Orgtree-managed profile directories, validated by Orgtree through each harness's own sign-in flow rather than a recreated provider login UI. Agents on different accounts of the same provider are tinted lighter or darker variants of the provider colour, independent of work status (21:09 UTC).

**After MVP, conditionally, within the same hard stop:** if agreed MVP parity plus the additions above complete early with usage allowance and time remaining, proceed FIRST to integrating the existing Git system, THEN to the provider-agnostic symmetric multi-account system, THEN to the dedicated mobile app (21:14 UTC). No new permission is needed to begin these phases once MVP is achieved. This replaces the earlier "stop at parity" instruction.

**Phase gate (21:18 UTC, binding now):** none of Git, accounts or mobile may be approached, designed or implemented until the current MVP has full parity with the requested scope. The user's supplied requirements for those phases are recorded in the time-ordered list below only so they are not lost; they are not elaborated here and generate no research or questions.

**Peer mail topology (21:22 UTC):** one Orgtree installation hosts the mail hub and is manually configured for public network exposure; other installations connect to it, as in v1. Authenticated transport with scoped credentials is required. This is an explicit public mail-transport exception and does not reopen public browser UI, API or kiosk exposure. Kiosk and agent isolation stay out for the foreseeable future.

**Process (21:37 and 21:53 UTC):** user-facing updates travel by orgtree mail; every decision answered to an earlier coordinator generation stays binding; iteration includes real screenshots of the running product for the coordinator's visual review.

**Unconditional stop:** at the FIRST of usage-limit exhaustion or 2026-09-08 01:00 UTC, stop all work immediately, regardless of completion. Checkpoint before the deadline. No post-deadline continuation, review or report turns except enforcement.

## Decisions in time order

### 5 September 2026: first design brief (historical)

The user's discussion draft. Retained from it, as later confirmed: product owns installation and operation; repository and product named `orgtree`; standalone Chromium-based desktop application with a Windows installer; provider- and harness-neutral architecture that shows provider differences honestly and never manufactures equivalence; replaceable themes with a neutral default where a provider theme changes no privileges or routing; separate data for development; copy-based import that never modifies the live v1 root; untrusted agent output, Markdown, HTML and external pages gain no desktop privileges; three responsibilities (desktop interface, organization engine, provider/harness adapters) with explicit boundaries; distinguish provider, model, harness, account and route.

Explicitly superseded from it by later entries: "no repository, implementation or framework commitment", selective parity with a keep/redesign/defer/omit review, open engine language and framework, and its ordering of design stages. Explicitly deferred: multi-account management and the mobile app. Every other requirement in the brief still applies unless a dated entry below changes it.

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

- 21:07:54 UTC, account setup for the later account system (newest, wins on conflict): BOTH imported account profile directories and Orgtree-managed profile directories are approved, so setup is seamless. Orgtree manages profile setup and connection validation; do not assume provider authentication can or should be recreated inside the Orgtree UI. Prefer each harness's supported sign-in flow, with provider-specific feasibility verified before implementation. The conditional phase order stays: complete MVP, then Git integration, then accounts, all within the 01:00 UTC hard stop.

- 21:09:23 UTC, account visual identity reaffirmed (newest, wins on conflict): agents using different accounts within the SAME provider get lighter or darker variants of that provider's colour, like alternate team colours for the same fighter. This means account distinction within a provider, not a different provider assignment. The provider's base identity stays consistent, and the account tint is independent of work-status colour and symbols. Already required by the original brief; reaffirmed for the conditional multi-account phase after MVP and Git.

- 21:14:15 UTC, conditional mobile phase (recorded, not to be designed or built now): kiosk and agent sandbox/isolation stay OUT for the foreseeable future, not a next milestone. If full MVP AND Git AND symmetric accounts finish before limits or the deadline, the next phase is the dedicated mobile app; the 01:00 UTC hard stop is unchanged. Supplied mobile requirements: NO canvas; main overview like the current Agents List; tap an agent for a transcript or minimal desk with tabs; back to the list and swipe between organization Mail, Docket and Presentations; NO Git or Connections views on mobile; grab handles beside agents. Connect directly to the PC through QR pairing carrying the WAN endpoint and credentials; the user proposes NAT traversal or UPnP so no separate external server is needed. Reachability is not guaranteed; UPnP, traversal and failure policy are unclarified and no relay may be assumed silently.
- 21:16:13 UTC, mobile purpose: a quick, easy companion for interacting with desktop agents without visiting the PC, NOT the primary management or observation interface. Prioritize fast agent access, conversation, replies and pending requests over a dense dashboard.
- 21:17:12 UTC, mobile answers: Android first with a portable design; grab handles do BOTH sibling reorder and reparenting with clear hierarchy and drop behaviour; FULL organization controls through simpler screens while keeping the quick-companion purpose (not read-and-respond only); DIRECT connections only, no relay and no static infrastructure operated by the project, unreachable networks stated truthfully with no hidden fallback; QR endpoint and auth setup remain required and UPnP success is not universal.
- 21:18:19 UTC, PHASE GATE (binding now): Git, accounts and mobile are POST-MVP phases and are NOT to be approached, designed or implemented until the current MVP has FULL parity with the requested scope. Decisions already supplied are preserved; no further post-MVP questions, research or design. This supersedes the earlier request to keep clarifying future-phase questions. Current work is exclusively MVP; enter Git, then accounts, then mobile only after verified MVP completion, still within the hard stop.
- 21:19:13 UTC, mobile background: the mobile app stays CONNECTED while running in the background (corrects an earlier "while open" wording), respecting foreground-service OS behaviour and limits; no relay or static infrastructure by implication. At 21:20:13 the user asked for one final question battery before leaving; that authorized final clarification only, not early post-MVP implementation.
- 21:22:57 UTC, peer topology and mobile endpoint (newest, wins on conflict): desktop peer mail uses the mail hub hosted by ONE Orgtree installation, MANUALLY configured for public network exposure, with other installations connecting to it, the same topology as v1. Host-or-connect configuration is the product flow; no invitation-first onboarding. Authenticated transport and scoped credentials remain required; this public MAIL TRANSPORT exception is explicit and is not a return of any public browser UI, API or kiosk exposure. The Connections area presents hosting, listen and advertised-endpoint configuration and connecting to an existing hub. For mobile, a changed direct endpoint may need a manual update or a new QR scan; an optional user-supplied dynamic-DNS hostname is acceptable; no automatic discovery service or relay is implied. The final question battery is resolved; no further user input is needed now.

- 21:37:56 UTC, communication: all user-facing updates from the coordinator go by orgtree mail from now on, because the transcript is not reliably visible to the user after compaction. Existing work and scope continue; no design question was pending.
- 21:53:11 UTC, continuity and visual review (newest, wins on conflict): retain and apply every answer given to the previous coordinator generation; no earlier decision changed. While iterating, obtain real screenshots of the running product (Playwright or the existing Electron capture is acceptable) so the coordinator visually reviews the application and uses the findings to improve it. Screenshot capture is assigned to acceptance, visual inspection to the coordinator. This adds visual verification to the existing behaviour checks and changes no settled scope or phase gate.

- 2026-09-09, symmetric multi-account phase AUTHORIZED (recorded by feature-fable per coordinator direction; times UTC): at 14:13:20 the user explicitly authorized multi-account design NOW and at 14:14:02 assigned design AND implementation to feature-fable â€” the 21:18 phase gate's Git prerequisite is lifted for ACCOUNTS ONLY; every retained 21:06â€“21:09 rule stands. Subsequent rulings during design review, newest wins: 15:39:49 Antigravity sign-in is the usage-panel "Open Antigravity terminal" opening the installed CLI's own interactive entry plus a manual Refresh â€” an approved explicit departure from the Claude/Codex scriptable flow; AG is in scope. 17:58 (coordinator, from retained requirements): existing key/token credentials remain supported as distinct credential kinds, compatibility only â€” new setup offers only imported and Orgtree-managed profile directories, no silent migration or conversion. 18:11 (coordinator, from the retained no-rollover requirement): no automatic rollover for ANY agent; api_fallback leaves placement entirely; the org API key is represented as an account with affected nodes explicitly migrated on concrete durable evidence (unconditional key use binds; conditional/ambiguous is documented and held), binding thereafter wins uniformly. 18:18 (coordinator): D-152's fable ride-along mark is KEPT â€” same account only, one-directional, absent-only, source horizon, with inferred provenance stored and displayed separately from measured evidence and durable expiry across restarts; no probing turns, no automatic movement. ANSWERED BY THE USER at 18:38:22 (relayed 18:39/18:40): legacy org-specific API keys KEEP their existing org restriction â€” origin-organization scoping for migrated org-key accounts is the explicit declared exception to the all-accounts-all-organizations rule; an authorized supervisor may reassign a descendant to ANY registered account available to that organization (no already-in-use introduction gate), with node-authority and account-availability checks both enforced; the proposed "try anyway" early release for inferred marks is NOT approved and is left out â€” inferred marks keep explicit provenance, their source horizons and existing expiry/resume behavior. Root approved proceeding with the cleared design and private implementation at 18:40; the account-authority delta goes back to redteam-opus for a bounded check; stage-2 implementation review and coordinator personal approval remain required; no live migration or restart.

- 2026-09-09 20:27:31 UTC: agents lists keep their original ordinary opening, navigation and dismissal behavior; add pin/popout controls without turning the ordinary list into a modal.
- 2026-09-09 20:38:17 and 20:41:21 UTC: coordinator-astra and feature-fable implement the remaining authorized work themselves, run development checks and merge directly. No separate agent review process or intermediate clearance gates. The user will review the combined result after everything is merged. This supersedes the stage-2/Opus/coordinator-approval requirements above for this corrective wave; deferred automated-import work remains deferred.

## How to use this file

Add new user decisions at the end of the time-ordered list with their UTC timestamp, then update the scope index so it reflects the newest state. Do not edit the verbatim brief. If a decision here conflicts with `docs/engine-contract.md`, the contract is a technical realization of these decisions and should be corrected to match, not the other way round.


## 2026-09-11: opt-in account fallback after usage limits

The operator amended the earlier prohibition on automatic account rollover:
account fallback is adjustable per agent, inherits an organization default,
and defaults to OFF. After a successful fallback, KEEP the replacement as the
agent's saved account; do not automatically return to the original account.

Fallback requires an eligible account with fresh, usable capacity for the same
provider/model lane. Unknown or stale usage is not proof of capacity. Claude
and Codex profiles support this check. Antigravity has neither separate profile
selection for turns nor a usage readout, so its control explains that it is
unavailable. API-key accounts are not fallback destinations.

The background pass runs independently of auto-resume and the old account's
reset deadline. It reuses frozen-turn replay and validates settings, account,
node generation and freeze identity again before saving a switch. Account
switches are recorded with their cache/session continuity effects. A provider
cache starts cold; Codex crosses a session boundary.


## 2026-09-12: every account's usage is visible, and agents choose the lane

Two decisions on the same day, the second answering a gap found while reviewing
the first.

**08:0x UTC — show agents what the user sees, and tell them how to use it.**
"i want you to be able to see the same information i see in the current usage
modal", and: load-balance among the accounts signed in at once, taking remaining
usage and time until refresh into account. The rules the operator stated, which
the managed instructions now carry verbatim in effect:

- when every account of a provider is far from its reset, prefer the one with
  LOWER usage;
- when one account resets sooner than another, spend that one FIRST and leave
  the later-resetting account alone until the first is used up or has reset;
- Claude: a Fable model spends BOTH the standard weekly limit and the Fable
  weekly limit, while Opus and the lower tiers spend only the standard one;
- Codex: Luna accumulates only in the gpt-reserve limit and does not touch the
  normal weekly limit until reserve is completely full — the two exceptions
  being the reserve preference turned off, or the reserve lane unavailable;
- never start a model on an account where a window it spends is at 100%. This is
  per ACCOUNT and not per model: "don't hire a model on a specific account when
  [an] allowance it consumes on that account is at 100%, but if that allowance
  is available elsewhere, then you can still hire it."

The turn envelope's `[PROVIDER USAGE]` board therefore carries one lane per
registered account, with its own windows, reset instants, freshness and honest
unavailability, plus an `accounts:` roster naming each lane. It is a cache-only
read: a board rendered on every turn of every agent spends no upstream request.

**08:36 UTC — and the tools must let them act on it.** "yes, the agent hire /
rehire / retool tools should be able to decide which account to hire on." The
board could say which account had room while nothing agent-facing could place
work there, so `account` is now an argument of `orgtree_hire` (which account a
new seat runs on), `orgtree_rehire` (which account an archived agent comes back
on — omitted, it returns on the one it was archived with), `orgtree_retool`
(rebind a live report) and `orgtree_staff` (whichever of the two it composed).

The value is the registry account id, which the roster prints as
`account=<id>`; a lane name, label or email is refused, as is an account whose
provider does not match the tier's. Every retained rule from 2026-09-11 and
2026-09-09 still binds: authority is strictly downward and an agent never
chooses its own billing; there is no automatic movement; a rebind cannot clear a
binding; and a Codex account change remains a session boundary whose continuity
effect is disclosed rather than hidden.


## 2026-09-12 — Primary account selection and one displayed account name

The user confirmed that agents must be able to retool a secondary-bound
agent back to primary, and that the same choice must work in the operator
UI. The user also requested one canonical name/value across account settings,
Usage, the turn board and hire/rehire/retool/staff, with collision, rename and
backward-compatibility behavior tested.

Implementation: secondary accounts use their existing immutable registry
name (for example `claude-4`). The UI and board display that exact name;
there is no separate label-derived lane slug to translate. Historical labels
remain stored metadata and do not redirect selection when edited, duplicated
or made equal to another account's name. Names are never reused on removal.
No account-rename feature is added. Existing registry IDs/aliases remain
accepted through the existing provider and organization validator.

Primary is displayed as `claude/primary`, `openai/primary` or `google/primary`.
These values work through the UI and all four agent selection paths even
without a registered ambient row. `primary` is a contextual shorthand for the
target tier's provider. A provider-qualified mismatch is refused. Selecting
primary clears the secondary binding and restores existing ambient auth and
fallback rules; it does not claim a sign-in, available quota or a billing
mode that has not yet been observed. Empty strings retain their legacy
new-hire-only behavior; omission keeps hire defaults or an existing binding.

Retool remains strictly downward and refuses a busy agent. Rehire/staff
finish scope, audience, topology, docket and kiosk checks before assignment
can export a session or notify an account change; assignment is saved before
the agent is driven. A Codex account change, including primary, preserves the
pre-switch session as a knowledge bearer and starts fresh. A no-op keeps the
session. Account names, previous binding, session/cache boundary and bearer
are disclosed in the result/audit, with a safe summary retained in operation
receipts. An account switch is a new cache namespace; publishing the updated
managed instructions and tool definitions also changes their cached prefix.
