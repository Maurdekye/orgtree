# Providers and accounts

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Harnesses, model/effort offers, account binding, credentials, usage and inference routes.

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

## Fast mode during a queued model switch (2026-10-22)

User scope saves and agent retool validate the next-turn target in
`pending_switch.tier`, falling back to the serving tier when none is queued.
Exact-model capability checks still apply; speed-only saves preserve the switch
and the running turn's speed evidence. See [fast mode](../rust-engine/fast-mode.md).
[verified: `http/nodes.rs`, `domain/ops.rs`, `providers/fast_mode.rs`]

<a id="e-5ef50fb6f47c902d"></a>

## Fast-mode hire/rehire/staff/retool fields share exact-model validation;

Original section: Unsectioned integration notes. Source lines 262–269.

<!-- preserved:e-5ef50fb6f47c902d -->
- Fast-mode hire/rehire/staff/retool fields share exact-model validation;
  speed-only retool keeps the CLI and descendants untouched. New hires and
  Quick chat use per-tier org `default_fast_mode` (OFF, explicit false wins);
  rehire keeps saved speed. `orgtree_fast_defaults` reads/patches defaults;
  writes require a top-level live agent, with projects transparent. Scope
  inspection reports saved speed. See [fast mode](../../docs/rust-engine/fast-mode.md).
  [decided: user/coordinator 2026-10-18; verified: `providers/fast_mode.rs`,
  `domain/ops/fast_defaults.rs`, `tools/{defs,orgview}.rs`, `App.tsx`]
<!-- /preserved:e-5ef50fb6f47c902d -->

<a id="e-062352c49c6ccc08"></a>

## User-facing local inference providers are Language model servers (compact

Original section: AGENTS.md — working on Orgtree. Source lines 372–376.

<!-- preserved:e-062352c49c6ccc08 -->
- User-facing local inference providers are **Language model servers** (compact
  account labels: **LM server: <name>**), distinct from editor LSP servers.
  Internal `langserver` IDs, routes, keys, skill paths and filenames stay
  compatible; there is no migration. [decided: user 2026-10-19 20:56Z;
  verified: `canvas/langserver.tsx`, `providers/catalog.rs`, `org_accounts.rs`]
<!-- /preserved:e-062352c49c6ccc08 -->

<a id="e-69b4cf77157eb8e2"></a>

## Enabled, installed harnesses explicitly classified hire_reason=signed_out

Original section: AGENTS.md — working on Orgtree. Source lines 593–600.

<!-- preserved:e-69b4cf77157eb8e2 -->
- Enabled, installed harnesses explicitly classified `hire_reason=signed_out`
  retain dashed disabled hire tokens on card edges, Quick chat, desk model
  pickers and the hire sheet. Conditional catalog absence and staffing filters
  cannot hide these previews; they grant no entitlement. Sign-in advice uses
  the structured reason, never parsed error text. Antigravity previews retain
  model switches/legacy hiding. Local language model servers do not require the host
  CLI's native subscription login. See [signed-out hire tokens](../../docs/rust-engine/signed-out-hire-tokens.md).
  [decided: user/coordinator 2026-10-19; verified: `providers/mod.rs`, `canvas/{shared.ts,cards.tsx,OrgCanvas.tsx}`]
<!-- /preserved:e-69b4cf77157eb8e2 -->

<a id="e-fc5adcb239ef98b4"></a>

## A live desk's model letter opens the existing hire tokens with warm shared

Original section: AGENTS.md — working on Orgtree. Source lines 617–626.

<!-- preserved:e-fc5adcb239ef98b4 -->
- A live desk's model letter opens the existing hire tokens with warm shared
  default-account availability. Clicking a tier immediately uses the default
  account and latest version through existing switch/scope/history paths;
  account/version editing stays in settings. Only cross-provider resets confirm;
  same-provider busy changes queue directly with a next-turn toast and history
  Undo. Picking the running tier only cancels its queued model change, preserving
  account and version. This replaces the staged account/version/Apply row and
  same-provider busy confirmation. Retired chips remain passive. See the
  [model tab](../../docs/skills/orgtree-app/agent-settings/agent-model-tab/SKILL.md).
  [decided: user/coordinator 2026-10-19 21:34Z; verified: `canvas/{deskmodel,desk,identity}.tsx`]
<!-- /preserved:e-fc5adcb239ef98b4 -->

<a id="e-3eaff86aad07edbe"></a>

## Queued model/account selectors show the queued target. Explicitly choosing

Original section: AGENTS.md — working on Orgtree. Source lines 628–633.

<!-- preserved:e-3eaff86aad07edbe -->
- Queued model/account selectors show the queued target. Explicitly choosing
  the serving model/account again submits the existing cancellation operation;
  an untouched settings Save preserves both queues. A combined cancellation
  sends both operations, including through history; unedited version pins stay
  omitted. [decided: user 2026-10-19 16:59–17:00Z;
  verified: `canvas/{modals,deskmodel}.tsx`]
<!-- /preserved:e-3eaff86aad07edbe -->

<a id="e-ff8b88dacd68cab6"></a>

## Quick chat shares the Agents-list switchboard mark for the selected top-level

Original section: AGENTS.md — working on Orgtree. Source lines 978–987.

<!-- preserved:e-ff8b88dacd68cab6 -->
- Quick chat shares the Agents-list switchboard mark for the selected top-level
  superior and its option row. Default models prefer Opus, Sol, Argon, Wonder,
  then any hireable tier; shared staffing availability gates account/model-spent
  usage, with `native_ok` separate from the existing `default_ok` host flag.
  Credit checks follow user cascade/project transparency and the top grant cap.
  Keep per-org manual > template > app-wide manual precedence; an unavailable
  remembered model stays stored; effort memory stays independent and otherwise inherits. See
  [Quick chat defaults](../../docs/rust-engine/quickchat-model-defaults.md).
  [decided: user 2026-10-18 17:13–17:15Z; verified:
  `QuickChatBox.tsx`, `quickchat-availability.ts`, `domain/staffing.rs`]
<!-- /preserved:e-ff8b88dacd68cab6 -->

<a id="e-208aaf23923f2257"></a>

## Quick chat treats missing/non-array staffing tiers and malformed tier/account

Original section: AGENTS.md — working on Orgtree. Source lines 989–992.

<!-- preserved:e-208aaf23923f2257 -->
- Quick chat treats missing/non-array staffing tiers and malformed tier/account
  rows as unavailable, rather than dereferencing partial startup/error bodies.
  Only literal true enables a native choice. [verified: `quickchat-availability.ts`,
  `tests/quickchat-availability.test.tsx`; coordinator follow-up 2026-10-18]
<!-- /preserved:e-208aaf23923f2257 -->

<a id="e-b72d800b0848076a"></a>

## Agent-facing Orgtree tool results append engine-measured execution time: 0.432ms

Original section: AGENTS.md — working on Orgtree. Source lines 1343–1350.

<!-- preserved:e-b72d800b0848076a -->
- Agent-facing Orgtree tool results append engine-measured `execution time: 0.432ms`
  as a final text block (Codex: separate `inputText`), preserving the primary
  text byte-for-byte and its JSON parseability. Measure with a monotonic clock
  around common dispatch, including refusals; do not fabricate harness-native
  tool timings. The synthetic rig's primary-text API keeps its JSON contract.
  See [tool result timing](../../docs/rust-engine/tool-result-timing.md).
  [decided: user/coordinator 2026-10-18; verified: `tools/{mod,result_timing}.rs`,
  `runtime/{claude,codex}.rs`, `bridge.rs`]
<!-- /preserved:e-b72d800b0848076a -->

<a id="e-c1a0700754d29d77"></a>

## Model-change tool chips retain the locked applied before/after tiers in

Original section: AGENTS.md — working on Orgtree. Source lines 1436–1443.

<!-- preserved:e-c1a0700754d29d77 -->
- Model-change tool chips retain the locked applied before/after tiers in
  `refs.model_change`; legacy results leave the old model unknown. Historical
  `TierChip`s omit agent-bound tooltips, while the agent link keeps its current
  model. Omit a redundant new card only when that current model is known to
  match; queued/no-op/refused/staffing calls gain no transition. See
  [model tool chips](../../docs/rust-engine/tool-model-changes.md).
  [decided: user 2026-10-17 22:59Z/23:01Z; verified: `domain/ops.rs`,
  `runtime/convo.rs`, `canvas/{modelchange,toolrefs}.tsx`]
<!-- /preserved:e-c1a0700754d29d77 -->

<a id="e-377fed72a36aa810"></a>

## The startup no-harness warning prefers the engine's bounded harness registry

Original section: AGENTS.md — working on Orgtree. Source lines 1572–1578.

<!-- preserved:e-377fed72a36aa810 -->
- The startup no-harness warning prefers the engine's bounded harness registry
  read, falling back to desktop presence only for an unavailable/old engine.
  Both locators recognize Claude's native `~/.local/bin` install and Windows
  npm global `claude.cmd` without PATH. Engine launch keeps its real-executable
  and explicit-override precedence; presence scans never execute or sign in.
  [decided: coordinator/user 2026-10-19; verified: `main/harnesses.ts`,
  `main/index.ts`, `providers/mod.rs`]
<!-- /preserved:e-377fed72a36aa810 -->

<a id="e-ff3db6aeec73beca"></a>

## Renderer agent links use the native title tooltip with catalog model/version,

Original section: AGENTS.md — working on Orgtree. Source lines 1802–1810.

<!-- preserved:e-ff3db6aeec73beca -->
- Renderer agent links use the native title tooltip with catalog model/version,
  effort and (only for multi-account providers) bound/default account joined by
  ` · `. The host resolves current `/api/providers` and `/api/accounts` reads,
  clears title on context-menu open, omits missing values and queued switches,
  marks draft effort `(not started)` and archived models `(retired)`. See
  [agent identity hover tooltip](../../docs/rust-engine/agent-identity-tooltip.md).
  [decided: user/coordinator 2026-10-17; verified from source:
  `canvas/agentnav.tsx`, `canvas/OrgCanvas.tsx`, `canvas/contextmenu.tsx`,
  `canvas/docket.tsx`, `providers/catalog.rs`]
<!-- /preserved:e-ff3db6aeec73beca -->

<a id="e-a564bc8b1fddeaa8"></a>

## Static catalog tiers with numbered model IDs include the default model in

Original section: AGENTS.md — working on Orgtree. Source lines 1812–1816.

<!-- preserved:e-a564bc8b1fddeaa8 -->
- Static catalog tiers with numbered model IDs include the default model in
  `versions`, even for a single version: this supplies display labels (Astra 6,
  Terra 5.6, Pro 3.1). A single entry does not imply a version picker; renderer
  settings require more than one choice. [decided: user 2026-10-19 11:40Z;
  verified: `providers/catalog.rs`, `canvas/modals.tsx`]
<!-- /preserved:e-a564bc8b1fddeaa8 -->

<a id="e-b7f9dbece8eb87d6"></a>

## A known empty effort offer (Some([])) means the model accepts no effort

Original section: AGENTS.md — working on Orgtree. Source lines 1842–1846.

<!-- preserved:e-b7f9dbece8eb87d6 -->
- A known empty effort offer (`Some([])`) means the model accepts no effort
  setting: hide its effort display/control and send no effort argument. An
  unknown offer (`None`) remains distinct. The org default is computed as an
  effective value and is not persisted per agent. [verified: `providers/catalog.rs`,
  `runtime/actor.rs`, `canvas/OrgCanvas.tsx`, `canvas/desk.tsx`]
<!-- /preserved:e-b7f9dbece8eb87d6 -->

<a id="e-4abd59b8db2da07a"></a>

## A halted agent's status duration is measured from halt.at (falling back to

Original section: AGENTS.md — working on Orgtree. Source lines 1863–1867.

<!-- preserved:e-4abd59b8db2da07a -->
- A halted agent's status duration is measured from `halt.at` (falling back to
  `requested_at` for legacy state), not its last turn. The desk header and
  near-zoom card show `Halted <duration>`; far zoom shows only the halt icon.
  Accessible text may say “Halted for <duration>”. Usage freeze remains a
  separate state. [verified from source: `canvas/desk.tsx`, `canvas/cards.tsx`]
<!-- /preserved:e-4abd59b8db2da07a -->

<a id="e-ba6e78946ef37539"></a>

## An uninitialized manual hire's model icon opens the same SpawnChips token

Original section: AGENTS.md — working on Orgtree. Source lines 1889–1895.

<!-- preserved:e-ba6e78946ef37539 -->
- An uninitialized manual hire's model icon opens the same `SpawnChips` token
  pyramid as node hiring and Quick chat (replacing the plain tier menu).
  Picking a tier changes the local draft only: preserve form and placement,
  drop incompatible account bindings and map known effort levels as the bar
  does. Final Hire submits that tier through the existing admission gate.
  [decided: user 2026-10-16 10:54Z, 2026-10-17 19:29Z; verified: `canvas/cards.tsx`, `canvas/OrgCanvas.tsx`, `canvas/pickerpopover.tsx`;
  contract: `docs/rust-engine/draft-model-picker.md`]
<!-- /preserved:e-ba6e78946ef37539 -->

<a id="e-de9536d0894c40bc"></a>

## Claude usage 429s retain quiet last-good bars only while younger than 900 s

Original section: AGENTS.md — working on Orgtree. Source lines 2065–2072.

<!-- preserved:e-de9536d0894c40bc -->
- Claude usage 429s retain quiet last-good bars only while younger than 900 s
  and the remaining wait is at most 60 s. Otherwise use the existing unavailable
  branch with pause wording. Waits never re-date bars/auth. All Claude callers,
  including force, share a 60 s attempt floor; provider retry expiry overrides
  that floor on the next scheduler pass. Same-key desktop readers await one
  in-flight result; tool refresh retains its explicit in_progress status.
  [decided: coordinator 2026-10-15 10:09Z; verified: `usage.rs`; contract and
  evidence limits: `docs/rust-engine/claude-usage-waits.md`]
<!-- /preserved:e-de9536d0894c40bc -->

<a id="e-e06a5b8145fc0fa6"></a>

## EPIC usage effects compare a finite, fresh reading with the last valid

Original section: AGENTS.md — working on Orgtree. Source lines 2150–2155.

<!-- preserved:e-e06a5b8145fc0fa6 -->
- EPIC usage effects compare a finite, fresh reading with the last valid
  reading of the same account/window (kind, group, label and model). Missing,
  unavailable and stale readings never replace that baseline. Use each host
  readout's identity with its own limits, and named OpenRouter key readings;
  the aggregate glow peek loses account identity. [verified: `epic/director.ts`,
  `usage.rs`; regression: `epicmode-usage`; 2026-10-16]
<!-- /preserved:e-e06a5b8145fc0fa6 -->

<a id="e-affff87e1e66e667"></a>

## Muse usage Refresh stays visible, disabled and dimmed in host/registered

Original section: AGENTS.md — working on Orgtree. Source lines 2200–2205.

<!-- preserved:e-affff87e1e66e667 -->
- Muse usage Refresh stays visible, disabled and dimmed in host/registered
  Usage cards and the reusable account usage panel. The hover text explains
  that Muse usage arrives at the end of a turn. Gate by provider identity,
  never the account ID or label; other providers and engine refresh paths stay
  unchanged. [decided: user 2026-10-14 23:05UTC; verified from source:
  `App.tsx`, `accountusage.tsx`; see [Muse Refresh](../../docs/rust-engine/muse-usage-refresh.md)]
<!-- /preserved:e-affff87e1e66e667 -->

<a id="e-b2c58c562c706ba0"></a>

## Appearance presets are LMS Gold, Muse Eggshell and Antigravity Navy. Shared

Original section: AGENTS.md — working on Orgtree. Source lines 2207–2211.

<!-- preserved:e-b2c58c562c706ba0 -->
- Appearance presets are LMS Gold, Muse Eggshell and Antigravity Navy. Shared
  provider/preset order keeps Orgtree first, then Claude/Codex/Antigravity/Muse/
  OpenRouter/LS, with Custom last; preset IDs, accent colours and saved values
  are unchanged. [decided: user 2026-10-14 23:01–23:02UTC; verified:
  `themes.tsx`, `canvas/accounts.tsx`, `packages/contracts/visual-theme.ts`]
<!-- /preserved:e-b2c58c562c706ba0 -->

<a id="e-b35efdeec6f0ab66"></a>

## Providers headers use family names Claude/ChatGPT/Gemini/Muse with dim

Original section: AGENTS.md — working on Orgtree. Source lines 2275–2280.

<!-- preserved:e-b35efdeec6f0ab66 -->
- Providers headers use family names Claude/ChatGPT/Gemini/Muse with dim
  harness names Claude Code/Codex/Antigravity/Muse Code. OpenRouter's dim
  subtitle is REST API; each key's own harness label remains. IDs, status,
  controls and Harnesses registry names are unchanged.
  [decided: user 2026-10-14 17:53–17:54UTC; verified from source:
  `canvas/accounts.tsx`, `canvas/openrouter.tsx`]
<!-- /preserved:e-b35efdeec6f0ab66 -->

<a id="e-83b1b844b2e77cea"></a>

## Org settings Accounts uses a short explanation (32 words), preserving the

Original section: AGENTS.md — working on Orgtree. Source lines 2295–2299.

<!-- preserved:e-83b1b844b2e77cea -->
- Org settings Accounts uses a short explanation (32 words), preserving the
  current-turn boundary and conditional same-provider move/stop meaning. Per-row
  globally-disabled account help stays. [decided: user 2026-10-14 18:46UTC;
  verified: `orgaccounts.tsx`, `org_accounts.rs`; see
  [copy evidence](../../docs/rust-engine/org-accounts-copy.md)]
<!-- /preserved:e-83b1b844b2e77cea -->

<a id="e-cce160a6ecaa7998"></a>

## Background work keeps an agent's process open (user 2026-10-14, "keep open",

Original section: AGENTS.md — working on Orgtree. Source lines 2344–2360.

<!-- preserved:e-cce160a6ecaa7998 -->
- Background work keeps an agent's process open (user 2026-10-14, "keep open",
  Muse and Claude Code; decision 77). A turn's end with warming off, warming
  switched off, and the idle cap `hold` the process (`proc_held`, unparked:
  the cap neither counts nor evicts it) while a background task runs, the CLI
  owes the next turn a result, or results settled in the last turn (3 s
  grace); it closes once that is over. Usage limit, settings change, stop,
  halt, time-limit kill, shutdown, retire still end it and report losses; a
  startup-file edit does not replace a held process. Claude Code starts a
  turn of its own 40-110 ms after a background task's notification: the actor
  interrupts it at its `system init` (an idle CLI prints nothing before its
  input), ignores its lines and result (`claude_own`), and only then wakes an
  idle agent; the chip gets the command's output from the notification's
  `.output` file. See [background work](../../docs/rust-engine/background-work.md).
  [decided: user 2026-10-14 09:44:51Z via coordinator; the startup-file edit:
  coordinator 2026-10-14 10:56Z; verified from source:
  `runtime/actor.rs`, `runtime/tasks.rs`; measured: real Claude Code 2.1.292
  probes 2026-10-14; rig proofs pending]
<!-- /preserved:e-cce160a6ecaa7998 -->

<a id="e-a88669ac8447f816"></a>

## Antigravity background launches share providers::agy_auth: Windows exact

Original section: AGENTS.md — working on Orgtree. Source lines 2362–2379.

<!-- preserved:e-a88669ac8447f816 -->
- Antigravity background launches share `providers::agy_auth`: Windows exact
  credential metadata → silent zero-argument auth check → guarded command.
  Signed-in check reply is exit 0 + `Already authenticated as …` (measured
  AGY 1.3.5); never require empty output. A clean refusal latch is silently
  rechecked on a forced read after 30 s or after 5 min; prompt/unknown-output
  latches hold until credential metadata changes (AGY refreshes tokens in place
  without changing it). No Sign in UI. Sole exception: discovery's
  `agy --version` (`agy_auth::version`) runs unchecked so Harnesses shows the
  version when signed out (measured: 94 ms, no CLI log, credential untouched). Headless
  flags/closed stdin alone are not an OAuth guard; the check/use and in-flight
  concurrency risks remain. Non-Windows silently revalidates after a five-minute
  refusal cooldown. See [background auth](../../docs/rust-engine/antigravity-background-auth.md).
  [verified: `providers/agy_auth.rs`; decided: user/coordinator 2026-10-14]
  Keep AGY guard futures heap-owned at the public/capture boundaries and pipe
  buffers heap-allocated; round 434 reproduced debug actor stack overflow on
  the original inline implementation. Check inline future size and unchanged
  lane proofs; do not increase stack limits or suppress lints to hide it.
  [verified: round 434 own-tip failure; `providers/agy_auth.rs`, 2026-10-14]
<!-- /preserved:e-a88669ac8447f816 -->

<a id="e-9b5a9e6395aa4974"></a>

## Antigravity keeps ONE sign-in per Windows user (Credential Manager target

Original section: AGENTS.md — working on Orgtree. Source lines 2389–2400.

<!-- preserved:e-9b5a9e6395aa4974 -->
- Antigravity keeps ONE sign-in per Windows user (Credential Manager target
  `gemini:antigravity`): a separate `USERPROFILE` folder still reads it, with or
  without `.gemini\antigravity-keyring-unavailable` (two user-approved probes,
  AGY 1.3.5, 2026-10-16). A registered google subscription row that is not the
  default sign-in is its own `agy_auth::Login` (`USERPROFILE`/`HOME` at its
  folder, own latch/stamp) and runs only when its silent check names an account
  the default sign-in does not; else it is latched `not_isolated` and refused,
  never silently run on the default sign-in. The Add dialog offers only an API
  key for Antigravity. Never run the real `agy` from an Antigravity seat (shared
  sign-in). See [Antigravity accounts](../../docs/rust-engine/antigravity-accounts.md).
  [decided: user/coordinator 2026-10-16 20:41Z; verified: `providers/agy_auth.rs`,
  `runtime/actor.rs`, `usage.rs`, `canvas/accountsregistry.tsx`]
<!-- /preserved:e-9b5a9e6395aa4974 -->

<a id="e-6fab4fc503a41d49"></a>

## Antigravity admission, balancing and fallback capacity read a registered

Original section: AGENTS.md — working on Orgtree. Source lines 2402–2411.

<!-- preserved:e-6fab4fc503a41d49 -->
- Antigravity admission, balancing and fallback capacity read a registered
  profile's `agy:<id>` usage cache, matching its probe and reset-evidence
  routing. Missing/stale/failed profile evidence stays unknown; it never
  borrows native capacity. Ambient or missing-folder aliases still read `agy`;
  API keys have no subscription reading. Placement validates the selected
  profile's quota; staffing keeps a tier offered when an eligible profile can
  serve it while still refusing the exhausted native choice.
  [verified: `usage.rs::reading_of`, `domain/ops.rs`, `domain/staffing.rs`,
  `usage/agy_reading_tests.rs`, 2026-10-17; contract:
  `docs/rust-engine/antigravity-accounts.md`]
<!-- /preserved:e-6fab4fc503a41d49 -->

<a id="e-369825f5ce9d8407"></a>

## App settings Harnesses is a compact registry list: installed state, cached

Original section: AGENTS.md — working on Orgtree. Source lines 2433–2438.

<!-- preserved:e-369825f5ce9d8407 -->
- App settings Harnesses is a compact registry list: installed state, cached
  discovery version (unknown when absent), and missing-only install links.
  OpenRouter / Language model server tags use selectable registry provider IDs;
  listing does not launch CLIs or change authentication. See
  [compact harness settings](../../docs/rust-engine/harness-settings.md).
  [decided: user 2026-10-14 10:59Z; verified: `harnesses.rs`, renderer `canvas/harnesses.tsx`]
<!-- /preserved:e-369825f5ce9d8407 -->

<a id="e-988db85a8654dd9b"></a>

## Halted list rows reuse canvas StopIcon and var(--bad), keep the halt clock

Original section: AGENTS.md — working on Orgtree. Source lines 2440–2445.

<!-- preserved:e-988db85a8654dd9b -->
- Halted list rows reuse canvas StopIcon and var(--bad), keep the halt clock
  separate from the last/previous status age, and reserve the summary line
  when empty. Completed halt.at wins, with requested_at as legacy fallback;
  halting uses requested_at. Durable halt still precedes usage freeze. All
  AgentTray hosts share this. [decided: user/coordinator 2026-10-14;
  docs/rust-engine/halted-list-rows.md]
<!-- /preserved:e-988db85a8654dd9b -->

<a id="e-5e375afe25817588"></a>

## Codex thread/resume IGNORES dynamicTools (codex-cli 0.160.0): a resumed

Original section: AGENTS.md — working on Orgtree. Source lines 2460–2466.

<!-- preserved:e-5e375afe25817588 -->
- Codex `thread/resume` IGNORES `dynamicTools` (codex-cli 0.160.0): a resumed
  thread keeps the cards it STARTED with, restored from its rollout's first line
  (`session_meta.payload.dynamic_tools`). Before every resume the actor writes
  the current cards there (`codex::sync_rollout_tools`); without it Codex agents
  never see new tools, kinds or scope changes. A probe that resumes with the
  SAME tools proves nothing. [verified: `runtime/{codex,actor}.rs`, real Codex +
  fakellm probe, 2026-10-18]
<!-- /preserved:e-5e375afe25817588 -->

<a id="e-2be2b5793b619ee6"></a>

## A shell command Muse moves to the background (after ~10 s) can finish after

Original section: AGENTS.md — working on Orgtree. Source lines 2468–2484.

<!-- preserved:e-2be2b5793b619ee6 -->
- A shell command Muse moves to the background (after ~10 s) can finish after
  its turn. Muse hands its result to the session itself, once, and starts
  turns of its own to deliver it; Orgtree still cancels those (admission) and
  warns about the cancels once a minute, not per cancel (Muse restarts one
  every ~55 ms). The actor follows such calls past their turn (`muse_bg`): a
  late settle writes the result onto the chip in its original row; an idle
  agent gets one waking system message naming the call as its chip does (its
  description, else its command) and how it ended, never the output (on real
  Muse the model gave its call a description, so a proof must not expect the
  command line); a host that ends with such commands running marks their
  chips and tells the agent once (Muse says nothing of them). A usage limit
  still closes the host (a frozen agent's commands end at the wall); with
  warming off, background work now keeps it open (entry above; this replaced
  "background work does not keep a host open", 2026-10-14). See [Muse:
  commands moved to the background](../../docs/rust-engine/muse-code.md). [decided:
  coordinator 2026-10-13 18:53Z; verified: `actor.rs` `on_muse_late`,
  `muse_lost`, real Muse 1.4.6 probes 2026-10-13 and proof 2026-10-14]
<!-- /preserved:e-2be2b5793b619ee6 -->

<a id="e-ab2beaa8e32e0f5d"></a>

## Registered usage Refresh forwards force=true to the existing boolean query;

Original section: AGENTS.md — working on Orgtree. Source lines 2514–2520.

<!-- preserved:e-ab2beaa8e32e0f5d -->
- Registered usage Refresh forwards `force=true` to the existing boolean query;
  normal reads remain cached. Available last-good bars carrying a provider error
  display that refresh failure without changing the dated observation; later clean
  data clears it. Preserve unavailable/unsupported/spend/standing branches and
  existing cooldown/scope rules. See [usage Refresh](../../docs/rust-engine/usage-refresh.md).
  [decided: coordinator 2026-10-13 18:57/21:21UTC; verified: renderer `api.ts`,
  `canvas/accounts.tsx`, Rust `http/accounts.rs` `Force`/`usage_registered`]
<!-- /preserved:e-ab2beaa8e32e0f5d -->

<a id="e-a2189e6bb35b52a5"></a>

## Every secondary OpenRouter usage card uses the shared Refresh header with

Original section: AGENTS.md — working on Orgtree. Source lines 2522–2526.

<!-- preserved:e-a2189e6bb35b52a5 -->
- Every secondary OpenRouter usage card uses the shared Refresh header with
  independent pending/error/age state. Only its manual force calls that key's
  registered endpoint; normal key-map reads stay cache-only. Original key Refresh
  remains unchanged. [decided: user 2026-10-13 21:49UTC; verified: `App.tsx`
  `OpenRouterKeyUsageSection`, Rust `usage.rs` `registered` OpenRouter branch]
<!-- /preserved:e-a2189e6bb35b52a5 -->

<a id="e-b343415b45ac8060"></a>

## Muse in Windows Session 0 (the installed app's boot-task engine): Muse's

Original section: AGENTS.md — working on Orgtree. Source lines 2535–2546.

<!-- preserved:e-b343415b45ac8060 -->
- Muse in Windows Session 0 (the installed app's boot-task engine): Muse's
  OS sandbox cannot start a command there, so a write seat's host starts with
  `--disable-sandbox`; read-only seats have no shell; bypass seats, and every
  seat outside Session 0, are unchanged. Without the sandbox Muse asks Orgtree
  only about a shell statement its policy cannot settle (in stages, next entry;
  2026-10-14, replacing "about no command") and its file tools write outside
  the agent's folders (measured). The user kept this knowingly. User 2026-10-14 16:39UTC removed
  the long Muse paragraph from Providers, superseding the October13 display
  request; ordinary provider status remains. Runtime posture is unchanged.
  See [Muse Session 0](../../docs/rust-engine/muse-code.md). [decided: user
  2026-10-13 18:53Z, kept 20:16Z; verified: `muse.rs` `os_sandbox`, real Muse
  1.4.6 probes 2026-10-13; display removal verified: `canvas/accounts.tsx`, 2026-10-14]
<!-- /preserved:e-b343415b45ac8060 -->

<a id="e-9a2af120e6eef670"></a>

## Muse approvals: Orgtree refuses with MSP's denied choice when offered, else

Original section: AGENTS.md — working on Orgtree. Source lines 2548–2564.

<!-- preserved:e-9a2af120e6eef670 -->
- Muse approvals: Orgtree refuses with MSP's `denied` choice when offered, else
  Muse's once-only `abort` ("Reject"): real Muse 1.4.6 offers no `denied`, and
  `abort` rejects that one call while the turn goes on. Never take a choice that
  persists (`allow_local_prefix`, session scope). Before this a refusal found no
  choice and the call waited until the silence limit. See [Muse
  sessions](../../docs/rust-engine/muse-code.md). [decided: coordinator 2026-10-13
  20:15Z; verified: `muse.rs` `choice`, real Muse 1.4.6 probe 2026-10-13]
  2026-10-14: Muse asks about a compound shell command in stages, one per
  statement its policy cannot settle; `approval/request` names the first, each
  `approval/updated` notification the next `currentRequirementId`, and the call
  never starts until every stage is decided. Answer every open stage once, as
  the call (the read loop's `next_stage`); answering only the request left the
  user's agent waiting 6 min until interrupted. An approval allowed by the scope
  but offered only as a session or persistent rule is refused once, saying why.
  [decided: coordinator 2026-10-14 (the turn proceeds or fails promptly);
  verified: `muse.rs` `decision`, `next_stage`, real Muse 1.4.6 session log and
  event journal 2026-10-14]
<!-- /preserved:e-9a2af120e6eef670 -->

<a id="e-edb7589e1f1d8305"></a>

## A Muse tool call that produces nothing for the turn's silence limit

Original section: AGENTS.md — working on Orgtree. Source lines 2591–2600.

<!-- preserved:e-edb7589e1f1d8305 -->
- A Muse tool call that produces nothing for the turn's silence limit
  (`turn_idle_s`) is stopped by itself and the turn goes on: a `turn/steer`
  note naming the limit, then MSP `task/stop` on the call's item id; the clock
  restarts. A silent model (nothing in flight, or only work Muse moved to the
  background), a stopped call still running one limit later, and the total
  ceiling still end the turn. Other lanes still end the whole turn on any
  silence (unchanged, no ruling). See [Muse: tool calls past the silence
  limit](../../docs/rust-engine/muse-code.md). [decided: user 2026-10-13 18:32Z;
  verified: `actor.rs` `stop_silent_muse_tools`, `muse.rs` `stop_task`, real
  Muse 1.4.6 probes 2026-10-13]
<!-- /preserved:e-edb7589e1f1d8305 -->

<a id="e-d5a8bff01373edd4"></a>

## OpenRouter has one header Add action beside its provider switch for first

Original section: AGENTS.md — working on Orgtree. Source lines 2616–2623.

<!-- preserved:e-d5a8bff01373edd4 -->
- OpenRouter has one header Add action beside its provider switch for first
  and subsequent keys. Every key's row and settings are alike (one shared form
  for its custom name, harness and optional replacement secret); there is no
  separate naming action and no first-key-only row. Provider drafts close on backdrop clicks and
  Escape when idle, discard unsaved entries, and ignore inside-started drag-out
  clicks. Busy saves keep the existing dismissal guard. [decided: user
  2026-10-13 18:16–18:17UTC; verified: `canvas/openrouter.tsx`,
  `openrouterkeys.tsx`, `providerdialog.tsx`, `modalpin.tsx`]
<!-- /preserved:e-d5a8bff01373edd4 -->

<a id="e-44970aeb1c6988fe"></a>

## Muse Wonder Full uses shared tier blue #80b8ff, replacing dusty rose;

Original section: AGENTS.md — working on Orgtree. Source lines 2632–2635.

<!-- preserved:e-44970aeb1c6988fe -->
- Muse Wonder Full uses shared tier blue `#80b8ff`, replacing dusty rose;
  light/solarized icons and hire buttons keep blue on a dark backing. Preserve
  the Muse provider cyan and other tiers. See [Muse colours](../../docs/rust-engine/muse-code.md).
  [decided: user 2026-10-13 17:52UTC; verified: renderer `styles.css`, 2026-10-13]
<!-- /preserved:e-44970aeb1c6988fe -->

<a id="e-c22d820b1c2774eb"></a>

## Provider/category/collection labels use Language model servers, including tier

Original section: AGENTS.md — working on Orgtree. Source lines 2670–2678.

<!-- preserved:e-c22d820b1c2774eb -->
- Provider/category/collection labels use **Language model servers**, including tier
  families, navigation and theme names. Wording about one server stays singular;
  protocol/API/storage IDs remain `langserver`. The engine's
  `catalog::provider_label` names one agent's provider in messages, so it stays
  "Language model server"; the switched-off refusal comes from `catalog::turned_off`
  ("Language model servers are turned off…"). See the terminology audit in
  [compact Providers](../../docs/rust-engine/provider-compact.md).
  [decided: user 2026-10-12 21:22Z; verified from source: renderer labels and
  `providers/{catalog,mod}.rs`, `domain/ops.rs`, 2026-10-13]
<!-- /preserved:e-c22d820b1c2774eb -->

<a id="e-33538510be2bba5f"></a>

## Provider model-chip panels align with their key/server cards at both edges.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2826–2830.

<!-- preserved:e-33538510be2bba5f -->
- Provider model-chip panels align with their key/server cards at both edges.
  A sibling full-panel native button opens the same browser as +; chips remain
  independent controls above it. Keep empty-space and Enter/Space browsing, chip
  toggling, and keyboard focus distinct. [decided: user 2026-10-13 19:13UTC;
  verified: `canvas/modelbrowser.tsx`, `styles.css` `.orr-toggles`]
<!-- /preserved:e-33538510be2bba5f -->

<a id="e-a008e2b6781a9be1"></a>

## OpenCode is an optional OpenRouter/language model server harness over the reusable

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2841–2858.

<!-- preserved:e-a008e2b6781a9be1 -->
- OpenCode is an optional OpenRouter/language model server harness over the reusable
  ACP1 transport. Discovery must negotiate an installed OpenCode 2.x entrypoint;
  before its first result, admission and launch share a filesystem-locator
  fallback so restart recovery can resume immediately. A completed negative
  discovery stays refused, and every launch still negotiates ACP before loading
  a session. [verified: `runtime/opencode.rs`, `harnesses.rs`,
  `tools/rig/proofs/opencode-startup.mjs`, 2026-10-20]
  the per-seat OpenRouter pin still wins. Default/acceptEdits deny Code Mode
  execute; bypass permits nested calls and fetch. Direct file approvals check
  folder grants, shell follows the bash switch, and neither claims an OS sandbox.
  Config-injected MCP is direct (`codemode:false`); the first prompt observes
  bridge initialize/tools-list plus a measured 250 ms catalog settle, or continues
  after five seconds with an explicit unobserved-tools note. The owned mail hook
  below replaces next-turn-only delivery on its verified version. Custom-provider cost/cache lifetime
  remain unknown. Credentials stay in isolated launch environment/config and
  launch directories are removed at teardown. See [ACP contract and evidence
  limits](../../docs/rust-engine/opencode-acp.md). [decided: user/coordinator 2026-10-13;
  verified from source: `runtime/{acp,acp_scope,opencode}.rs`, `bridge.rs`]
<!-- /preserved:e-a008e2b6781a9be1 -->

<a id="e-0fb555a747840725"></a>

## Model browser list children must not flex-shrink: OpenRouter and Language

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2879–2882.

<!-- preserved:e-0fb555a747840725 -->
- Model browser list children must not flex-shrink: OpenRouter and Language
  Server rows and sticky vendor headings keep their natural height inside the
  capped scrolling frame. See [model browser layout](../../docs/rust-engine/model-browser-layout.md).
  [verified: `styles.css` `.orr-list > *`, 2026-10-13]
<!-- /preserved:e-0fb555a747840725 -->

<a id="e-64a6f5dcb156fa8b"></a>

## Secondary account removal keeps exclusive account-reference protection and

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2927–2933.

<!-- preserved:e-64a6f5dcb156fa8b -->
- Secondary account removal keeps exclusive account-reference protection and
  atomic rebound. Its late default-org lock is NOWAIT: on contention, confirm
  whole-transaction rollback before the existing bounded retry/backoff, so an
  org-first folder/settings writer cannot become a deadlock victim of that
  late lock. Never skip locked defaults or publish provisional effects.
  [verified: `domain/account_removal.rs`, 2026-10-12; proof/limits in
  `docs/rust-engine/approved-folder-grants.md`]
<!-- /preserved:e-64a6f5dcb156fa8b -->

<a id="e-8044942de6457651"></a>

## Muse Code runs as muse serve (MSP v1), one warm host per agent, always

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2949–2985.

<!-- preserved:e-8044942de6457651 -->
- Muse Code runs as `muse serve` (MSP v1), one warm host per agent, always
  `--contributor-mode off` (never the user's saved setting, never changed) and
  never `META_API_KEY` on a subscription seat. A Muse tier is offered only
  while the signed-in account's own catalog lists it (a row without
  `profileId` is bundled, not an entitlement); a turn arriving before startup
  discovery waits for it (at most 60 s) rather than reading "not offered".
  Read-only grants are never workspace roots (Muse gives every root write
  access). Cost and cache lifetime stay unknown: Muse publishes neither. The
  rig runs the real binary with `up --real-muse <muse-bin-*.exe>`. A seat on
  a registered Muse login runs only what that login's own catalog offers
  (checked at launch), and the limit fallback picks only a login whose own
  catalog offers the seat's exact model (pinned version included). An
  API-key login runs in its own roots (`profiles/muse-key-<id>`) and is a
  fallback only while the provider's key switch is on. The user's own Muse
  login is a limit-fallback target after registered subscriptions (same
  switch, catalog, gates, proven room). A Muse seat is placed, tuned and
  pinned by its own login's catalog (`ops::muse_admit`,
  `providers::check_effort_on`); login reads happen before transactions and
  an unknown login is refused. A retool naming an account and an effort
  checks the effort on that account. Every hire and settings surface reads
  each login's offer and levels from `/api/providers` › `muse.logins` (pushed
  when a login's offer changes) and names an eligible subscription login when
  the one a no-account hire lands on lacks the model; never a key. A level
  saved with no account named is judged on the login the next turn runs on (a
  queued account move's: `accounts::next_turn_login`). Removing a Muse login
  moves a live seat to the own login, else to the first registered
  subscription login that offers its exact model, each passing every
  continuation gate (never a key); with none it waits frozen, its held request
  kept; a removal that releases a freeze gives its held request back as wake
  mail in the same transaction; queued intents naming the login follow.
  Continue-on (route, tool,
  automatic) refuses a login whose own catalog lacks the seat's exact model or
  is unknown, before anything changes, and a frozen seat's choices leave such
  logins out. Every Muse turn carries the current workspace roots; MSP
  requests and the launch fingerprint input are never logged.
  [decided: user 2026-10-12 18:32-20:31Z, lead 2026-10-13, DECISIONS 76;
  verified: real Muse 1.4.6 and rig proofs 2026-10-13; `docs/rust-engine/muse-code.md`]
<!-- /preserved:e-8044942de6457651 -->

<a id="e-8353c4a324717ba5"></a>

## Built-in organization templates are the files in engine/docs/templates/, listed in

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2987–2999.

<!-- preserved:e-8353c4a324717ba5 -->
- Built-in organization templates are the files in `engine/docs/templates/`, listed in
  `BUNDLED` (`domain/templates.rs`) and written once each into `~/.orgtree/templates`
  (note `.seeded`): adding one reaches existing installs once, an edited file is never
  touched and a deleted one stays deleted. `devteam (muse)` (`devteam-muse`) has the
  shape of the Claude and Codex ones: coordinator `wonder` (quick chat starts on it),
  implementer `wonder-full`, redteam `wonder`, curator `spark`; seats and grants come
  from the planner's offers, so an unsigned or unentitled Muse tier blocks its slot like
  any other provider's. The planner's "checking the sign-in" wording covers only Claude
  and Codex. [decided: user 2026-10-13 18:23Z; verified: `domain/templates.rs` tests]
  `devteam (antigravity)` (`devteam-antigravity`) has the same shape: `argon` for
  coordinator (quick chat), implementer and redteam, `flash` for the curator; no
  fallbacks. Argon is offered only while Antigravity lists it, so its slots block
  otherwise. [decided: user 2026-10-14 17:55Z; verified: `domain/templates.rs` tests]
<!-- /preserved:e-8353c4a324717ba5 -->

<a id="e-f0f3830753f2e4b7"></a>

## Models are LISTED most expensive (highest seat) first within each provider, every provider (Claude fable,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3001–3019.

<!-- preserved:e-f0f3830753f2e4b7 -->
- Models are LISTED most expensive (highest seat) first within each provider, every provider (Claude fable,
  opus, sonnet, haiku; Muse wonder-full, wonder, spark). Antigravity is grouped by model
  family in the renderer: Claude-backed Antigravity (agy-opus/agy-sonnet), then Gemini
  (pro/argon/barium/carbon/flash); seats sort within each group and ties keep catalog
  order. The engine's `catalog::listed()` remains seat-sorted; the renderer uses
  `bySeatDesc` / `*_TIERS_LISTED` except for the shared Antigravity grouping helper in
  `shared.ts` (hire sheet, Settings, and canvas hire tokens). Hire-token strips keep their
  existing cheapest-first direction. A new tier orders
  itself. The declaration order of `catalog::TIERS` and of `TIERS`, `CODEX_TIERS`, … is NOT a
  display order: it is the DEFAULT order (the first offered model: the hire sheet's
  pre-selection, Quick chat's fallback) and must not be reordered for display. The user's
  chosen OpenRouter models list by output price descending, then input price, then name,
  free ones after the priced and unknown prices last, never as $0 (`openrouter::by_price_desc`,
  `byOpenrouterPriceDesc`); the OpenRouter model browser and language model server lists keep their own
  order. User-visible text says "most expensive first" / "cheapest first", never "dearest"
  (the OpenRouter picker's price-sort toggle; "dearest" read as odd wording, user
  2026-10-14). [decided: user 2026-10-13 19:14-19:15Z, 2026-10-14 10:57Z, 2026-10-16;
  coordinator clarified family order 2026-10-16; verified: `catalog.rs`, `openrouter.rs`,
  `shared.ts` and their tests, `pricesortlabel.test.tsx`]
<!-- /preserved:e-f0f3830753f2e4b7 -->

<a id="e-38577ea23e4ca107"></a>

## Hire tokens sort cheapest seat first WITHIN each provider row/column, with

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3021–3027.

<!-- preserved:e-38577ea23e4ca107 -->
- Hire tokens sort cheapest seat first WITHIN each provider row/column, with
  stable equal-price order and the existing inward family-count ordering.
  `SpawnChips` uses each token's current catalog-backed seat lookup; hidden
  tiers stay hidden. Quick chat and expanded/far strips use the same component.
  Model selectors, hire-sheet dropdowns and defaults keep the October13 order.
  See [hire-token price order](../../docs/rust-engine/hire-token-price.md).
  [decided: user 2026-10-14 10:43UTC; verified: `canvas/cards.tsx`, `QuickChatBox.tsx`]
<!-- /preserved:e-38577ea23e4ca107 -->

<a id="e-67e64bd3b6d62117"></a>

## The user's undo history (migration 0023, domain/undo.rs): the user's own move,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3070–3081.

<!-- preserved:e-67e64bd3b6d62117 -->
- **The user's undo history** (migration 0023, `domain/undo.rs`): the user's own move,
  hire, retire and retool gestures record one typed entry each (numeric ids, positions,
  configured values; never request bodies, credentials or text), 100 per org, durable.
  `/ops` (covered ops), `nodes/{nid}/reorder|account|scope` and `POST /gesture` run as
  one-step or multi-step gestures in ONE serializable transaction; undo/redo replay the
  forward ops as `Actor::User` behind guards on the touched facts only, and any refusal
  marks that entry refused (refuse-then-older). Lock order: `ot.undo_heads` row, org row,
  agent rows. Agent tools, approvals and replays never record. Routes are under
  `/undo-history` (`/history` is the Settings browser); the feed's org group `undo`
  carries `undo_history`. A new recorded op must add its kind or stay out of
  `RECORDED_OPS`. See [undo history](../../docs/rust-engine/undo-history.md).
  [decided: user 2026-10-14 18:27Z, coordinator 18:34Z; verified: `domain/undo.rs`]
<!-- /preserved:e-67e64bd3b6d62117 -->

<a id="e-7f5ec26488919e76"></a>

## Several OpenRouter keys at once, every key alike. Each key is its own hidden registry

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3083–3129.

<!-- preserved:e-7f5ec26488919e76 -->
- **Several OpenRouter keys at once, every key alike.** Each key is its own hidden registry
  row (provider `openrouter`, kind `apikey`, secret in `ot.account_secrets`), id
  `openrouter-N` (N from 1, never reused); a key's lane is its id. **No key is special**
  (user 2026-10-14 18:00Z): never special-case a key's id, never add an "original" or
  "primary" key. Migration 0022 renumbered the old first key (`openrouter-key`, lane
  `openrouter`) to `openrouter-1` with every reference, and bound its unbound seats. The one
  symmetric default: a seat with no OpenRouter key bound bills the first key in the key
  list (`openrouter::first_key`: `ord`, then N); a hire naming none is placed by
  `best_allowed` and bound. Use `openrouter::seat_key`/`keys` and
  `org_accounts::lane_of`/`seat_lane`. See [keys](../../docs/rust-engine/openrouter-keys.md).
  - **Usage:** cache and history keys are key ids. Every key's reading is
    `openrouter_keys_usage` or `GET /api/openrouter/keys/usage`; `openrouter_usage_peek`
    combines every key's limits. The prepaid balance belongs to the OpenRouter account, so
    each key's row says "account balance".
  - **Placement** follows the other providers: explicit key, org default, placement
    balancing, opt-in fallback; removal is reassign-or-freeze for every key
    (`account_removal::remove_key`: its seats move to the first other key a continuation
    accepts, else a live seat freezes; defaults naming it are cleared; its id is retired;
    its late org scan is `FOR UPDATE NOWAIT` with rollback-then-backoff retry, as `remove`).
  - **Secrets:** a replacement bumps `extra.credential_gen`; the fingerprint's account
    part carries `#credential-N`, so a warm CLI on the old secret is replaced at the next
    turn boundary, and a usage read answered for a replaced key is discarded. Key writes
    lock the OpenRouter rows and refuse a duplicate secret inside the transaction. The
    usage readers and `openrouter::doc` are `#[nolog]` (readings carry provider text), and
    the wire log omits `/api/openrouter` route bodies except `/models`.
  - **Toggles:** every key has its own active switch
    (`PUT /api/accounts/{id}/enabled`). Org lanes carry `enabled` and `disabled_reason`;
    an org tick cannot turn on a key switched off app-wide.
  - **Harness per key** (replaces the global harness, 2026-10-13): each key row stores
    `extra.harness` (seeded at every start from the old `openrouter.harness`, which
    now only seeds; a new key takes the first key's). A seat's `extra.harness` is
    what its session runs on; `openrouter::seat_harness` is the one precedence point:
    a hire's explicit `harness` pins the seat (`extra.harness_pin`, wins over the key),
    else the billed key's. `start_turn` moves a seat whose stamp differs, at the
    boundary only, to a fresh session with a summary (`agent_sessions` end reason
    "harness switch"; a new cache namespace). The once-only migration pins seats whose
    stamp differed from their key's, so the upgrade moved no seat. Favorites stay global.
  - **Installed harnesses only:** `src/harnesses.rs` is the one registry (Claude Code,
    Codex, Antigravity, Muse Code; opencode joins here) behind every harness choice
    and `GET /api/harnesses` (App settings › Harnesses). Choosing a harness that is
    not installed is refused (key, hire pin, language model server); a saved one since
    uninstalled refuses its launch saying so and is never substituted. "Installed" is
    the discovered file still present, else a launch's lookup: nothing is spawned.
    The staffing offers (templates, Quick chat, hire menus) leave out OpenRouter keys
    and language model server models whose harness is not installed. Every UI harness picker
    lists ALL supported harnesses: installed first, a separator, the rest greyed out
    and disabled (`HarnessOptions`, `canvas/harnesses.tsx`; user 2026-10-13 22:20Z).
<!-- /preserved:e-7f5ec26488919e76 -->

<a id="e-d48651cd0dfa30c9"></a>

## Source record

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3131–3134.

<!-- preserved:e-d48651cd0dfa30c9 -->
  [decided: user 2026-10-11 22:35Z and 22:50Z, coordinator on ids/lanes; user
  2026-10-13 19:04Z (per key), 19:08Z (pin wins), 19:15Z (installed only, every
  selector); verified: `src/openrouter.rs`, `src/harnesses.rs`, `src/runtime/actor.rs`,
  `src/org_accounts.rs`, `src/usage.rs`; detail: `docs/rust-engine/openrouter-keys.md`]
<!-- /preserved:e-d48651cd0dfa30c9 -->

<a id="e-5aace97a5f530d6a"></a>

## On-demand orgtree_usage reads the saved cache under inspection permission.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3157–3175.

<!-- preserved:e-5aace97a5f530d6a -->
- On-demand `orgtree_usage` reads the saved cache under inspection permission.
  Optional single-account refresh also needs inherited runtime permission;
  inactive accounts remain inspectable but cannot be refreshed. Manual attempt
  floors are per lane across orgs (60 s, Google 300 s); shared reservations
  prevent overlapping readers; Claude's shared 60 s floor also covers automatic
  reads (coordinator 2026-10-15, superseding unchanged-Claude-cadence here). Never re-date
  old observations or serialize raw cached provider documents. Raw readers,
  parsers, profile/history processing and cache peeks omit raw argument/return
  logging; safe availability/window-count/SQLSTATE diagnostics remain. So do the
  app feed (`AppFeed::set_value`/`snapshot`, the actor's `broadcast`/`snapshot`)
  and the HTTP handlers serving readings; the wire log omits `/api/app/records`
  and `usage`-segment route bodies. [decided: coordinator 2026-10-13]
  Query availability and successful refresh classification also consume the
  latest genuine auth observation across checked physical native aliases;
  signed-out overlay preserves dated quota bars. Imported logins stay separate.
  [verified: tools/usage.rs, usage/query.rs; 2026-10-12]
  [verified: usage.rs, account_marks.rs, usage_history.rs; 2026-10-12] Contract and
  proof limits: [usage-query-proposal.md](../../docs/rust-engine/usage-query-proposal.md).
  [decided: user/lead-astra 2026-10-11 22:35Z; verified: usage.rs, tools/usage.rs]
<!-- /preserved:e-5aace97a5f530d6a -->

<a id="e-3a7085d66f9ee1d1"></a>

## Agent settings calls the built-in harness permissions Native Tools, explains

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3194–3207.

<!-- preserved:e-3a7085d66f9ee1d1 -->
- Agent settings calls the built-in harness permissions **Native Tools**, explains
  their Claude Code/Codex/Antigravity origin, and gives every native toggle a
  concise description. Shared hire-default and draft-scope controls use the same
  copy. The external registry section is **MCP Servers** (superseding the initial
  MCP Tools wording). Credit grant belongs in Scope. Agent settings has a Tools
  tab immediately after Scope, containing Native Tools / Orgtree Tools / MCP
  Servers in that order; folders come last in Scope. This supersedes placing
  tools at the bottom of Scope. Hire Defaults and draft forms retain their
  existing tab structure. Agent settings
  and Hire Defaults share equivalent field labels, descriptions and option text,
  retaining current-agent versus future-hire context and org folder revocation
  semantics. Preserve bindings, defaults and superior-permission enforcement.
  Copy audit and lightweight verification: [agent-settings-copy.md](../../docs/rust-engine/agent-settings-copy.md).
  [decided: user 2026-10-11 17:35–17:39Z and 19:46Z; verified: renderer `canvas/modals.tsx`]
<!-- /preserved:e-3a7085d66f9ee1d1 -->

<a id="e-c066b3d6611c6a43"></a>

## Native tray refresh must resynchronize the Run on boot checkbox (it was

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3232–3242.

<!-- preserved:e-c066b3d6611c6a43 -->
- Native tray refresh must resynchronize the **Run on boot** checkbox (it was
  "Run on startup"; "Run on sign-in" where Orgtree cannot start at boot) from
  committed preferences even while its menu is open, and when that menu is
  shown again. Do not replace an open native Menu object: update the existing
  item in place. A UAC write can finish after a refresh constructed a menu from
  the old value; refreshing only updater/engine/mailhub rows leaves startup's
  checkmark stale despite a successful save. Keep rejection restoration and
  UAC/task-write semantics intact. See [startup toggle acceptance and tray
  regression](../../docs/rust-engine/startup-toggle-acceptance.md).
  [verified from source-composition regression and live saved-state differential,
  2026-10-11; packaged native repaint remains a next-alpha verification limit]
<!-- /preserved:e-c066b3d6611c6a43 -->

<a id="e-08d3c761dc9c8bd2"></a>

## The engine always starts at boot; agents run in the signed-in session while

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3254–3317.

<!-- preserved:e-08d3c761dc9c8bd2 -->
- **The engine always starts at boot; agents run in the signed-in session while
  the operator is signed in.** "Run on boot" switches the boot engine task and
  the "Orgtree Credential Helper" task together (the HKLM record keeps only
  `RunOnStartup`); there is no "engine starts" choice and no sign-in engine
  task any more (the installer only recognizes the old one, to delete it).
  While the helper holds the bridge's host role, every agent's next CLI starts
  through it in the operator's session (`runtime/session_host.rs`): all five
  harnesses, bypassPermissions seats included (`HOST_BYPASS_SEATS`; supersedes
  decision 68 Q1). Otherwise, or when a hosted start fails, the engine starts
  it in Session 0. Rules that are easy to break:
  - placement is chosen only at a turn's start (`want_hosted`), never during a
    turn; a CLI that still holds background work moves at a later turn;
  - a harness's CLI goes through `session_host::spawn` and its child is a
    `Launched`, so stop, kill and the forced-kill records work in either
    session; the helper starts only `hostable()` file names, so a new harness
    adds its executable there;
  - a hosted CLI's stdio pipe names come from `src/hosted_pipes.rs`, which
    the engine and the helper binary both include; never write the prefix on
    one side only (the engine once served `orgtree-cli-` pipes while the
    helper took only `orgtree-codex-` ones, so every hosted launch fell back
    to Session 0; a broker test now pairs the two sides);
  - a hosted CLI that ends while the helper that started it is gone
    (`helper_gone`) ends its turn as "the user's Windows session ended", never
    as a failure, and one new turn resumes it at once where the turn-start
    rule places it, unless the turn had been ended on purpose (interrupt,
    halt, time limit, retirement: `may_be_session_end`); the kill record gets
    a `codex-session-ended` line;
  - `orgtree_session` (no tool group, like `orgtree_status`) answers from the
    caller's actor (`AgentMsg::Session`, `session_view`) by the rule a turn's
    start applies: change `want_hosted` or `codex_seat` and `session_view`
    changes with it;
  - placement is a session id, not a yes/no: `session_host::choose` (on-demand
    `use`, then the scope `session` preference, then Session 0) over
    `credential_bridge::HostLeases`, one helper lease per session; every
    harness spawn names the session and a hosted CLI knows it (`hosted_in`);
  - `orgtree_interrupt` on yourself needs no group (`interrupt_rule`); its
    `restart` wake comes from `end_turn` (a turn is taken once), never from
    the interrupt itself;
  - `session_watch` tells every agent of a sign-in or sign-out once, keeps
    what it told in `<data>\session-placement.json`, fires
    `session.signed_in`/`signed_out`, runs the sign-in checkups and the
    helper keepalive; a rig engine starts only a proof's task, never
    `\Orgtree Credential Helper`;
  - session notices go out only on a real move (the last placement is
    `ot.agents.extra.session`); the restart notice's "Session access at start"
    line is added at delivery; an agent last in the signed-in session waits
    at its first turn until 60 s after the engine's start for the helper.
    Startup absence is unknown until the first hosting observation or that
    deadline; the watcher still runs keepalive during the grace. Explicit
    Session 0 skips the wait. Once placement is established, later helper
    loss uses the normal debounce, including for an agent's first turn.
    [decided: user 2026-10-20 startup-transient fix; verified:
    `src/runtime/session_watch.rs`, `src/runtime/actor.rs`];
  - anything that starts the background engine (recovery, a restart) goes
    through `startEngineTask()`, which is the boot task. Never run the console
    `orgtree-engine.exe` from an interactive-token task: it opens a window at
    every sign-in.
  [decided: user 2026-10-16 09:37Z-09:43Z, 11:01Z and 11:03Z, coordinator
  rulings A-E 09:43Z; verified: `tools/boot-engine-task.ps1`,
  `apps/desktop/main/runonstartup.ts`, `src/runtime/session_host.rs`,
  `src/hosted_pipes.rs`, `src/credential_broker_host.rs`,
  `src/runtime/actor.rs`, `src/tools/session.rs`; details
  `docs/rust-engine/run-on-boot.md`, decisions 84 (which replaced decision 79),
  85 and 86]
<!-- /preserved:e-08d3c761dc9c8bd2 -->

<a id="e-53c25f4cba8ddf82"></a>

## Antigravity Claude 5.5 uses separate agy-sonnet / agy-opus tiers (seats

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3345–3352.

<!-- preserved:e-53c25f4cba8ddf82 -->
- Antigravity Claude 5.5 uses separate `agy-sonnet` / `agy-opus` tiers (seats
  2 / 4), enabled together in Runtime settings and off by default. They have
  no versions, keep Antigravity provider/account/theme, and share only the
  native Claude model colours. Their quota is `3p-5h` plus `3p-weekly`, separate
  from Gemini; token prices and context capacity are unknown. See
  [`antigravity-claude.md`](../../docs/rust-engine/antigravity-claude.md) for the
  measured CLI contract, gates and verification limits. [user 2026-10-07;
  verified from agy 1.3.1 model/zero-token usage output and source smokes]
<!-- /preserved:e-53c25f4cba8ddf82 -->

<a id="e-00a33b65c082e5f6"></a>

## No credential banners, annotations, tray/menu warnings or success notices.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3400–3403.

<!-- preserved:e-00a33b65c082e5f6 -->
- No credential banners, annotations, tray/menu warnings or success notices.
  Engine diagnostic fields and log lines remain; agents explain tool failures
  to the user. [recorded-decision: user 2026-10-07 16:12Z, superseding the
  15:49Z banner rule; verified-from-source: renderer shell and desktop tray]
<!-- /preserved:e-00a33b65c082e5f6 -->

<a id="e-65ffec1175101e7f"></a>

## The Windows credential bridge serves git HTTPS and PATH-resolved gh from

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3488–3497.

<!-- preserved:e-65ffec1175101e7f -->
- The Windows credential bridge serves git HTTPS and PATH-resolved gh from
  signed-in Electron main. Only isolated engines inject adapters; native helper
  chains and gh remain usable without a broker. Token-group/PID/SID proof binds the broker;
  agent generation plus CLI PID/creation time binds revocable helper authority.
  Busy pipe/slot bursts wait briefly and never mark a broker dead. Startup
  reclaims stale static shim links; see the Antigravity terminal verification
  limit in the bridge document. Its routes bypass wire logging. Never persist bridge
  secrets or pass the desktop token to agents. The sign-in helper is described below.
  [recorded-decision and verified-from-source: 2026-10-07; DECISIONS 51;
  `docs/rust-engine/credential-bridge.md`]
<!-- /preserved:e-65ffec1175101e7f -->

<a id="e-148227f00377e674"></a>

## Windows Codex hosting has a separate leased host slot: the sign-in helper can

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3499–3506.

<!-- preserved:e-148227f00377e674 -->
- Windows Codex hosting has a separate leased host slot: the sign-in helper can
  host sandboxed seats while the desktop retains the credential bridge. Git uses
  native askpass after the existing helpers; unknown prompts and bridge misses
  retain original askpass precedence. Explicit credential.interactive=false/never
  disables bridge lookup. Production sandbox network policy is unchanged;
  network Git still requires escalation. [verified: 2026-10-11;
  `engine/rs/orgtree-engine/src/credential_bridge.rs`, `credential_bridge/askpass.rs`;
  details and measured limits: `docs/rust-engine/sandbox-git-credentials.md`]
<!-- /preserved:e-148227f00377e674 -->

<a id="e-7e6960f131c464dc"></a>

## Windows boot credential detection is advisory: the boot task remains S4U.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3556–3561.

<!-- preserved:e-7e6960f131c464dc -->
- Windows boot credential detection is advisory: the boot task remains S4U.
  Session 0/batch-token warnings survive later interactive sign-in; a successful
  empty Credential Manager query does not prove old DPAPI secrets decrypt. No
  admission gate or restart is added. [verified-from-source and read-only probe:
  2026-10-07; `docs/rust-engine/boot-credential-warning.md`; user warn-only ruling
  12:33Z, credential bridge separately requested 12:40Z]
<!-- /preserved:e-7e6960f131c464dc -->

<a id="e-e5c8ba491ae56395"></a>

## Escape cancels a desk's prepared reply exactly as its × (DeskChat root

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3632–3636.

<!-- preserved:e-e5c8ba491ae56395 -->
- Escape cancels a desk's prepared reply exactly as its × (`DeskChat` root
  fieldset, bubbling). Anything that already took the Escape (`useEsc` stack,
  menus, the effort pop-out, which now claims it) goes first, as do an open
  `.lb-overlay`/`.picker-overlay` and IME composition; with no reply Escape is
  untouched. [user 2026-10-13; verified: `tests/escapereply.test.tsx`]
<!-- /preserved:e-e5c8ba491ae56395 -->

<a id="e-5f7ddb74229ad300"></a>

## Staffing effort choices describe launch-time model capabilities, not the

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3645–3660.

<!-- preserved:e-5f7ddb74229ad300 -->
- Staffing effort choices describe launch-time model capabilities, not the
  `live_effort` flag for mid-turn controls, in each harness's own names (user
  2026-10-12 20:01Z): Claude/OpenRouter Claude Code's five `--effort` levels,
  Codex the model's `model/list` levels from background discovery (menu reads
  never spawn a CLI; `none`/`minimal` kept), Muse the catalog row's variants,
  Antigravity its tier-specific vocabulary. Argon offers low/medium/high
  (2026-10-16, replacing its low/high restriction after offline CLI evidence);
  the shared mapper drives both offers and next-turn `--effort` delivery, with
  conditional availability unchanged. See [Argon effort](../../docs/rust-engine/argon-effort.md).
  [verified: `providers/catalog.rs`, `providers/mod.rs`, `runtime/actor.rs`, `runtime/agy.rs`]
  `catalog::EFFORT_ORDER` (none..max)
  orders them all; a saved level a tier does not name launches as the highest
  it names at or below it, else its lowest, and the saved value is never
  rewritten (`launch_effort`; the effort bar shows the same clamp). Replaces
  "every tier offers Claude Code's five". [verified from source: 2026-10-07,
  2026-10-13; `docs/rust-engine/staffing-effort-parity.md`, `muse-code.md`]
<!-- /preserved:e-5f7ddb74229ad300 -->

<a id="e-2c0466923e044a00"></a>

## Limit marks: fresh successful provider probes may clear an older mark for the

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3788–3792.

<!-- preserved:e-2c0466923e044a00 -->
- Limit marks: fresh successful provider probes may clear an older mark for the
  same account/pool; cached, failed, missing or incomplete readings cannot. A
  successful turn uses its captured admission account/time, never a later rebind.
  Neither path resumes frozen agents. Unknown imported pools stay manual.
  [verified from source: 2026-10-07, `src/account_marks.rs`, `src/runtime/actor.rs`]
<!-- /preserved:e-2c0466923e044a00 -->

<a id="e-13305338e5d822f2"></a>

## A refused turn's parsed reset is never shortened to the five-minute probe

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3794–3804.

<!-- preserved:e-13305338e5d822f2 -->
- A refused turn's parsed reset is never shortened to the five-minute probe
  floor by an expired/repeated countdown. Select the latest relative, ISO/offset,
  local-clock or structured reset; elapsed local clocks roll to tomorrow. A
  newer successful cached reading may only lengthen the same serving account's
  applicable full window. On 4.4.0, registered Antigravity profiles use their own
  `agy:<id>` cache; ambient or missing-folder bindings use `agy`, matching the
  serving login. Missing profile evidence never borrows native usage.
  Structured evidence is turn-local; quota timers still
  add 60 seconds and manual release keeps its override. Missing reset keeps the
  prior fallback. See [freeze recovery](../../docs/rust-engine/freeze-recovery.md).
  [decided: user 2026-10-17; verified: `runtime/usage_reset.rs`, `runtime/actor.rs`]
<!-- /preserved:e-13305338e5d822f2 -->

<a id="e-3840538deeb43edf"></a>

## Freeze reset recovery accepts RFC3339 until and legacy numeric until_ts

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3806–3813.

<!-- preserved:e-3840538deeb43edf -->
- Freeze reset recovery accepts RFC3339 `until` and legacy numeric `until_ts`
  (including a version-matched promised wake); old display labels are not clocks.
  Imports normalize them; existing imported rows need no repair. Limit probes still
  require org auto-resume, pure connection retries do not. Timers compare the exact
  freeze before clearing, retry disabled settings/transient errors, and explain
  blocked wakes even with verbose logging off.
  [verified from source and eight-case scratch timer/restart smoke: 2026-10-07;
  `docs/rust-engine/freeze-recovery.md` records scope and limits]
<!-- /preserved:e-3840538deeb43edf -->

<a id="e-2cd87d5c566b2f94"></a>

## Tree/scope parity (2026-10-07): remove host CLAUDE_CODE_ before selected-account

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3959–3967.

<!-- preserved:e-2cd87d5c566b2f94 -->
- **Tree/scope parity (2026-10-07):** remove host `CLAUDE_CODE_*` before selected-account
  environment injection. Omitted hire account uses a compatible org default, otherwise primary,
  never the parent's binding. Superior insertion authorizes the target (self allowed below top
  level) and inherits its effective capabilities. Retool refuses grants above its caller and
  raises intermediate managers for valid deep grants; report those expansions. State inspection
  reports effective scope and refuses explicitly invisible targets. Its visible set
  is the chart's set plus all own descendants, even at self visibility; archives
  remain opt-in. [recorded decision: user 2026-10-07 08:28Z, DECISIONS 49; verified from source;
  details and measured limits: `docs/rust-engine/tree-scope-parity.md`]
<!-- /preserved:e-2cd87d5c566b2f94 -->

<a id="e-a10c94d726187564"></a>

## No global locks of any kind. State is owned, not shared: each running agent's state belongs

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3974–3978.

<!-- preserved:e-a10c94d726187564 -->
- **No global locks of any kind.** State is owned, not shared: each running agent's state belongs
  to its actor and changes only through messages on its channel; each org's feed is one task;
  registries are lock-free maps. Database transactions are short, lock only the rows they change,
  and never contain provider calls, file IO or process control. Every queue is bounded and every
  list read has a `LIMIT`. [PLAN §2.2]
<!-- /preserved:e-a10c94d726187564 -->

<a id="e-fad546a496e8a0a9"></a>

## Never derive Serialize on a struct that holds a secret (a key, token, password or

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3985–3990.

<!-- preserved:e-fad546a496e8a0a9 -->
- **Never derive `Serialize` on a struct that holds a secret** (a key, token, password or
  credential). [decided: rust-engine session, relayed by the coordinator 2026-10-06] Why: logged
  arguments and return values are serialized into the log, and the log masks a value only when its
  JSON field name is on the masked list (`token`, `key`, `password`, `api_key`, `authorization`…,
  see `masked()` in `trace.rs`); a value logged through `Debug` is not masked at all. So also never
  give a secret-holding type a `Debug` that prints the secret.
<!-- /preserved:e-fad546a496e8a0a9 -->

<a id="e-030ac4cb5f62b3e5"></a>

## Tab highlight colors (2026-10-07, verified from source). Generic button

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4056–4072.

<!-- preserved:e-030ac4cb5f62b3e5 -->
**Tab highlight colors (2026-10-07, verified from source).** Generic button
hover/focus uses `--button-accent`, which can follow the focused provider.
Tab buttons override that token with their scoped `--accent` so highlighting
and selection follow the same theme. Keep that override on the button itself
and preserve selected-state fills/underlines separately from hover/focus.
Forced Chromium DPR does not change Windows frame DPI: compare `GetDpiForWindow` before
claiming native DPI coverage. Rust sibling ties use the numeric database id (wire `ord`),
not creation time. [verified: `main/windows.ts`, renderer `canvas/deskhosts.tsx`,
`windowlayout.ts`, `treeorder.ts`; Rust `domain/tree.rs`, `domain/ops.rs`]
Move previews assign destination max(live sibling order) + 1, as Rust `move_node`
does; same-parent moves keep their order. [decided: rust-engine session via coordinator,
2026-10-06; verified: renderer `canvas/shared.ts`, Rust `domain/ops.rs`]
Ring drag reorders use the mirrored full-circle angle around the eye, unwrapped
in sibling order; only the open last-to-first gap separates the list ends.
The insertion marker and reorder request share that slot. Row ordering and
ring layout/hire-arrow direction stay unchanged. [verified from source:
2026-10-07, renderer `canvas/ringreorder.ts`, `canvas/OrgCanvas.tsx`]
<!-- /preserved:e-030ac4cb5f62b3e5 -->

<a id="e-e5fe37876cb27595"></a>

## Codex Windows runner timeouts (2026-10-07). A workspace-write seat can fail

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4085–4096.

<!-- preserved:e-e5fe37876cb27595 -->
**Codex Windows runner timeouts (2026-10-07).** A workspace-write seat can fail
before shell startup while its authorized per-command escalated retry succeeds;
the observed difference is not necessarily a new-agent launch bug. Preserve the
shell-and-write approval gate; plan/edit-disabled seats cannot escape their
sandbox this way. The exact elevated timeout also reproduces outside every Windows
job on Codex 0.160.0 and 0.159.2; the deeper CLI-versus-local-setup cause remains open.
The actor now persists a once-per-turn diagnostic for only the exact completed
startup failure, freshly checks authority and steers an eligible same-command
retry through the existing gate. Restricted seats get no escape route; uncertain
steer delivery is recorded and never replayed. No startup prefix is rewritten.
[verified from source: `runtime/codex.rs`, legacy `supervisor.py`; measured comparison:
`docs/rust-engine/codex-sandbox-runner.md`]
<!-- /preserved:e-e5fe37876cb27595 -->

<a id="e-69f83b10921dd414"></a>

## Secondary account removal (2026-10-07, P37). Rebind live/archived bindings,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4098–4108.

<!-- preserved:e-69f83b10921dd414 -->
**Secondary account removal (2026-10-07, P37).** Rebind live/archived bindings,
queued account/model intents and org/app hiring defaults in one transaction before
removing a secondary account. Busy Codex/Antigravity session boundaries refuse
all changes; busy Claude keeps the running session. Per-account database reference
guards drain concurrent binders and reject removed identities; IDs are never
reused. Legacy missing import references remain supported. Session changes use
4.0's same-agent handoff. Runtime effects happen after commit, never under locks.
Removal preserves the shared queued intents' order and caller metadata; only
`ops::apply_pending` consumes them. The shared admission guard also checks session_id.
[verified from source: `domain/account_removal.rs`, account-reference migration;
measured disposable smoke; detail: `docs/rust-engine/account-removal.md`]
<!-- /preserved:e-69f83b10921dd414 -->

<a id="e-af121f7a862c018c"></a>

## OpenRouter key add/replace and language model server add/configure forms open in

Original section: Keep this file current. Source lines 4126–4147.

<!-- preserved:e-af121f7a862c018c -->
- OpenRouter key add/replace and language model server add/configure forms open in
  separate `ProviderDialog` surfaces above App settings; keep their API bindings,
  draft/save semantics and nested model browser intact. The dialog uses
  `ModalOverPins`, so it must not be moved back inside a pinned settings stacking
  context. See [provider dialogs](../../docs/rust-engine/provider-dialogs.md).
  Each language model server card exposes its existing app-wide `enabled` switch directly.
  Org Accounts keeps `allowed` separate from optional effective `enabled` and
  `disabled_reason`: a globally-off lane may be revoked but not newly allowed;
  provider feed changes refresh availability. Account-list generations discard stale
  replies; saves invalidate reads and defer refresh until completion, protecting
  full allowlist writes from pre-save snapshots. [verified: `canvas/langserver.tsx`,
  `orgaccounts.tsx`; decided: user 2026-10-11]
  Switchboard context actions use the shared Open submenu for Inbox, Global
  docket, Presentations and Shared scratch folder (including its existing nested
  folder actions). Agents list and Org settings remain top-level. This replaces
  the 2026-10-11 flat Open layout. [decided: user 2026-10-19 17:27Z;
  verified: `canvas/cards.tsx`]
  Hire an agent uses the existing tier
  submenu and `spawn(USER, tier)` root draft, never an arbitrary agent parent.
  [verified: `canvas/cards.tsx`, `canvas/OrgCanvas.tsx`; decided: user 2026-10-11]
  See [switchboard menu](../../docs/rust-engine/switchboard-menu.md).
  [decided: user 2026-10-11; verified: renderer provider dialog tests, 2026-10-11]
<!-- /preserved:e-af121f7a862c018c -->

<a id="e-b6c16e1f1ec841ea"></a>

## When you find an engine gotcha or a design invariant, or a new decision or ruling is

Original section: Keep this file current. Source lines 4149–4151.

<!-- preserved:e-b6c16e1f1ec841ea -->
**When you find an engine gotcha or a design invariant, or a new decision or ruling is
made, update this file in the same landing as the change it concerns.** If no code
changed, land a small follow-up commit that touches only this file.
<!-- /preserved:e-b6c16e1f1ec841ea -->

<a id="e-692d3321fe4ed9ba"></a>

## Model palettes share the transparent .quickchat-pop-model wrapper across

Original section: Read this first. Source lines 4175–4179.

<!-- preserved:e-692d3321fe4ed9ba -->
- Model palettes share the transparent `.quickchat-pop-model` wrapper across
  desk, Quick chat and card callers. The desk offers model tokens only.
  Desk sizing must not reintroduce a panel background, border or shadow.
  [decided: user 2026-10-19 18:31Z; verified: renderer `styles.css`,
  `canvas/{deskmodel,pickerpopover}.tsx`]
<!-- /preserved:e-692d3321fe4ed9ba -->

<a id="e-f9bfc5ac5f086eb7"></a>

## Conditional Gemini tiers: Argon (gemini-4-argon) and speculative Barium

Original section: Providers, accounts and usage. Source lines 4812–4837.

<!-- preserved:e-f9bfc5ac5f086eb7 -->
- **Conditional Gemini tiers:** Argon (`gemini-4-argon`) and speculative Barium
  (`gemini-4-barium`, green `#8FFF9F`) are offered only when the account's `agy models`
  registry lists the exact base id or its supported effort suffix. Each is gated
  independently; existing agents retain their tier. Barium copies Argon's placeholder
  seat, effort and usage rates. [decided: user 2026-10-05; verified:
  `providers.py`, `canvas/shared.ts`, `tests/test_barium_tier.py`]
  Speculative Carbon (`gemini-4-carbon`, letter C, chartreuse `#c6ff00`) copies Barium the
  same way in the 4.x code: hidden until `agy models` lists it, then offered like the
  other two. [decided: user 2026-10-10; verified: `providers/catalog.rs`,
  `providers/mod.rs` `agy_offers` test, `tests/carbon.test.tsx`]
  4.x reads the registry when it matters, never by polling: once at engine start, and on
  `POST /api/providers/agy-models/refresh`, which every model choice sends as it opens
  (hire sheet and menus, agent Model tab, rehire list, hire defaults, quick staffing,
  Quick chat's model pop-up, the Providers tab: `useAgyModelsRefresh`/`refreshAgyModels`).
  One read in flight, a result under 30 s reused; a changed list is republished live
  (`providers::refresh_agy_models`). [decided: user 2026-10-14] The read is
  `agy --log-file diagnostics/agy-probe/models-probe.log models`, rows `<id>	<label>`,
  started only through `agy_auth::checked_output` (never bare).
  A failed or empty read (signed out) offers none of the three; the hire strips,
  staffing and `orgtree_list_tiers` all follow `providers::agy_offered`. A hire, a model
  switch or a rehire naming one that is not listed is refused (409) after one fresh read
  (`ops::agy_admit`, 3.x `provider_hire_gate`); a plain rehire on the stored tier is not
  gated and running seats are never touched. [decided: coordinator 2026-10-14, 3.x parity] Until
  2026-10-14 the port never filled `agy_models`, so none was ever offered. Rig:
  `fakecli/agy-models.txt`. [verified: `providers/agy_models.rs`,
  `tools/rig/proofs/agy-conditional-tiers.mjs`]
<!-- /preserved:e-f9bfc5ac5f086eb7 -->

<a id="e-7e963ca25fff4917"></a>

## Hire tokens treat a missing Claude/Codex/Antigravity row as absent only after

Original section: Providers, accounts and usage. Source lines 4838–4843.

<!-- preserved:e-7e963ca25fff4917 -->
- Hire tokens treat a missing Claude/Codex/Antigravity row as absent only after
  `/api/providers` reports `checking: false`: Rust omits uninstalled harnesses.
  Canvas strips/menus and Quick chat share `hireOf`'s absence gate; unresolved,
  checking or older payloads stay unknown. Muse's catalog gate is unchanged.
  [decided: user 2026-10-19 10:21-10:26Z; verified: `canvas/shared.ts`,
  `canvas/OrgCanvas.tsx`, `QuickChatBox.tsx`, `tests/freshhire.test.tsx`]
<!-- /preserved:e-7e963ca25fff4917 -->

<a id="e-0c4327cbc9ba6c01"></a>

## Hire chips additionally require an enabled account allowed for the current org.

Original section: Providers, accounts and usage. Source lines 4848–4854.

<!-- preserved:e-0c4327cbc9ba6c01 -->
- Hire chips additionally require an enabled account allowed for the current org.
  Canvas and Quick chat read the canonical `accounts-allowed` lane decisions;
  explicit denial hides every provider family, including Muse and runtime models.
  Unknown reads preserve discovery/sign-in behavior. Settings/account changes refresh
  the decision, and stale replies cannot cross orgs or supersede newer reads.
  [decided: user 2026-10-19 12:32-12:33Z; verified: `orghire.ts`,
  `canvas/shared.ts`, `tests/orghire.test.tsx`]
<!-- /preserved:e-0c4327cbc9ba6c01 -->

<a id="e-481dc2499ef81d25"></a>

## Model-switch menus use the same org-aware hire states as canvas chips;

Original section: Providers, accounts and usage. Source lines 4855–4863.

<!-- preserved:e-481dc2499ef81d25 -->
- Model-switch menus use the same org-aware hire states as canvas chips;
  only the agent's current model survives unavailability. Quick staff request
  suggestions also require an enabled, org-allowed lane, without changing the
  later authentication/quota checks. Routed models require their installed
  harness: provider discovery omits language model server models lacking it and marks
  OpenRouter absent when none of its stored keys has one. Loading and installed
  signed-out previews remain distinct from confirmed absence.
  [decided: user 2026-10-19 14:14Z; verified: `canvas/OrgCanvas.tsx`,
  `canvas/shared.ts`, `domain/staffing.rs`, `providers/mod.rs`]
<!-- /preserved:e-481dc2499ef81d25 -->

<a id="e-16bf3fdb3b7bdf49"></a>

## (verified-from-source): agent settings MODEL_VERSIONS includes Haiku 5.5/4.5, matching Rust providers/catalog.rs. The cu

Original section: Where the detail lives. Source lines 5142–5142.

<!-- preserved:e-16bf3fdb3b7bdf49 -->
- 2026-10-07 (verified-from-source): agent settings MODEL_VERSIONS includes Haiku 5.5/4.5, matching Rust providers/catalog.rs. The current tree payload does not expose version choices; keep the renderer fallback table synchronized. Model/version/effort/account changes remain staged until Save.
<!-- /preserved:e-16bf3fdb3b7bdf49 -->
