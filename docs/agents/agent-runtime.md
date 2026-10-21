# Agent runtime

## Mail and transcript mention correlation

The renderer, native duplicate predicate and mail read-clear require matching
sender/prose plus a mail creation time from zero through ten seconds after the
mention timestamp. Earlier mail and unknown/invalid timestamps cannot cover a
mention; repeated wording outside that window remains independent. The ten
seconds is a conservative hardening choice: the controlled correspondence test
uses a three-second gap and verifies both boundaries, not a measurement of live
provider latency. Slow copies may remain duplicated. Exact event provenance is
a possible later improvement, outside 4.4.0. [decided: coordinator 2026-10-21
23:15Z; verified: `mailattention.ts`, `domain/mail_attention.rs`,
`tests/mentionmailtime.test.tsx`]

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Turns, context, compaction, warm processes, sessions, interrupts and transcript recovery.

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

<a id="e-e71373a072b7b615"></a>

## Automatic known-cold cheap compaction defaults ON/25% for new orgs and

Original section: Unsectioned integration notes. Source lines 92–102.

<!-- preserved:e-e71373a072b7b615 -->
- Automatic known-cold cheap compaction defaults ON/25% for new orgs and
  fresh installations. Explicit app defaults win, then explicit template/org
  choices. Migration 0045 pins existing unset/partial org policy to the old
  effective value (including trashed orgs); app defaults stay untouched.
  Legacy import runs after migrations and pins the old effective policy via
  the shared pure helper at insertion. The app-defaults form does not
  incidentally write this setting. See
  [compaction policy](../../docs/skills/orgtree-app/org-settings/org-policies-compaction/SKILL.md).
  [decided: user/coordinator 2026-10-20; verified: `settings.rs`,
  `feed/groups.rs`, `domain/tree.rs`, `migrations/0045_cheap_compact_default.sql`,
  `shell/defaults.tsx`, `tools/rig/proofs/cheap-defaults.mjs`]
<!-- /preserved:e-e71373a072b7b615 -->

<a id="e-4ceb1e01984483a6"></a>

## Transcript live tool and thought clocks use whole seconds below 60s, then

Original section: Unsectioned integration notes. Source lines 110–115.

<!-- preserved:e-4ceb1e01984483a6 -->
- Transcript live tool and thought clocks use whole seconds below 60s, then
  the shared duration minute/hour style (`2m 05s`, `1h 02m`); recorded thoughts
  and helper task durations share that longer form. Exact-second hover titles
  and elapsed-second-aligned tick scheduling are unchanged. [decided: user
  2026-10-20 09:45:58Z; verified: `canvas/{toolclock,desk}.tsx`,
  `tests/clockminutes.test.tsx`]
<!-- /preserved:e-4ceb1e01984483a6 -->

<a id="e-05e939b10aafe580"></a>

## WebSocket watchdogs (kind=websocket, orgtree_watchdog action=send) keep a

Original section: Unsectioned integration notes. Source lines 163–183.

<!-- preserved:e-05e939b10aafe580 -->
- WebSocket watchdogs (`kind=websocket`, `orgtree_watchdog action=send`) keep a
  connection per dog (`src/ws`). Their credentials (headers, bearer, Basic,
  query, secret hellos) never reach a list, card, mail, transcript or log: the
  URL a connection dials (with its credential query) and the upgrade request
  live only in `#[nolog]` code in `ws/conn.rs` (an `http::Request` argument
  would log its URI); tungstenite traces whole upgrade requests, so its
  `log` records are dropped by `EngineLayer` (`trace.rs` `silenced`, matched by
  the `log.target` field, since tracing-log's own target is `log`); and
  `util::mask_url_secrets` masks secret-named query values of ws URLs in logged
  strings and transcripts. A target with such a parameter is refused at create.
  A fire action takes credentials (mqtt's too) only as a file path, since a dog
  stores and lists its fire actions as written: create refuses inline ones, a
  key from `domain::watchdogs::CREDENTIAL_KEYS` or a URL carrying them, and
  `convo::redact_tool_input` blanks them at any depth of fire actions. Logged
  arguments mask a `query` or `headers` object whole (`trace.rs` `hidden`).
  A send's text is the agent's own and stays in transcripts. Messages are
  untrusted: fires and `list` tag them `(untrusted · see EXTERNAL)`. See
  [websocket watchdogs](../../docs/rust-engine/websocket-watchdogs.md).
  [decided: user 2026-10-19 21:00Z/21:01:59Z, coordinator 21:14Z, fire actions
  2026-10-20; verified: `src/ws/*`, `runtime/watchdogs{,/websocket}.rs`,
  `runtime/convo.rs`, `trace.rs`, `util.rs`]
<!-- /preserved:e-05e939b10aafe580 -->

<a id="e-8258982acbfa9d46"></a>

## Inline ticket links in transcript tool calls use a thin inset left edge from

Original section: AGENTS.md — working on Orgtree. Source lines 364–370.

<!-- preserved:e-8258982acbfa9d46 -->
- Inline ticket links in transcript tool calls use a thin inset left edge from
  the shared docket status palette. Exact current references refresh on the
  accepted native org cursor (identity + revision) and legacy live-change epoch;
  native record frames deliberately bypass the legacy bus, so both are needed.
  Runtime-only frames at the same cursor do not refetch. Captured transition labels remain historical.
  No polling or card geometry changes. [decided: user 2026-10-19 21:14Z;
  verified: `canvas/toolrefs.tsx`, `recordsession.ts`, `livebus.ts`, `styles.css`; follow-up user 2026-10-20 06:33Z]
<!-- /preserved:e-8258982acbfa9d46 -->

<a id="e-304ae6410d9739c1"></a>

## Expanded shell rows can show ephemeral Codex/Muse output and genuine ACP

Original section: AGENTS.md — working on Orgtree. Source lines 578–585.

<!-- preserved:e-304ae6410d9739c1 -->
- Expanded shell rows can show ephemeral Codex/Muse output and genuine ACP
  execution-content snapshots. Keep 32 KiB UTF-8 tails/256 KiB per actor, 4 Hz max,
  turn/tool identity and clear-on-final/interrupt/exit. Never persist interim
  bytes or change final output; byte handlers remain `#[nolog]`. Claude/agy have
  no new file polling. Installed OpenCode2.0.28 omits ACP progress output.
  See [shell output](../../docs/rust-engine/shell-output-stream.md).
  [decided: user/coordinator2026-10-19; verified: `runtime/shell_output.rs`,
  `runtime/actor.rs`, `renderer/src/shelloutput.tsx`, `renderer/src/convo.ts`]
<!-- /preserved:e-304ae6410d9739c1 -->

<a id="e-d347372a2be259dc"></a>

## Urgent mail cards use the explicit urgent mail flag for an orange-red

Original section: AGENTS.md — working on Orgtree. Source lines 649–653.

<!-- preserved:e-d347372a2be259dc -->
- Urgent mail cards use the explicit `urgent` mail flag for an orange-red
  (`#ff4500`) edge and an `urgent` text chip in transcript and inbox surfaces;
  mailbox-attention alone keeps its existing styling. [decided: user
  2026-10-19 17:19Z; verified: `events/segments.tsx`, `canvas/mail.tsx`,
  `styles.css`]
<!-- /preserved:e-d347372a2be259dc -->

<a id="e-c6640a20d790d4a1"></a>

## Project history keeps ACK queue-state notes and explicit-open transcript

Original section: AGENTS.md — working on Orgtree. Source lines 910–913.

<!-- preserved:e-c6640a20d790d4a1 -->
- Project history keeps ACK queue-state notes and explicit-open transcript
  receipts without claiming mail. Sent history never creates received-mail
  receipts, including the AGY fallback; legacy project rows remain compatible.
  [verified: `tools/project_inbox.rs`, `runtime/manual_mail.rs`; 2026-10-18]
<!-- /preserved:e-c6640a20d790d4a1 -->

<a id="e-9cd29e6d5c5db841"></a>

## The shared Canvas/Attention header shows a glowing @ button before the

Original section: AGENTS.md — working on Orgtree. Source lines 1044–1050.

<!-- preserved:e-9cd29e6d5c5db841 -->
- The shared Canvas/Attention header shows a glowing @ button before the
  killswitch for live agents’ unobserved transcript markers. It uses the
  existing urgent-mail badge appearance, newest-first focus, highlight and
  observed clearing; mail attention is excluded. Mention jumps select Chat
  on an already-open desk. See [header](../../docs/skills/orgtree-app/app-shell/org-header-and-menu/SKILL.md).
  [decided: user 2026-10-18 15:33Z/15:33:55Z; verified:
  `shell/mentionbutton.tsx`, `App.tsx`, `canvas/desk.tsx`]
<!-- /preserved:e-9cd29e6d5c5db841 -->

<a id="e-fd45696b160e1ef3"></a>

## Unread user mail with a standalone @user in visible prose/quotes shares

Original section: AGENTS.md — working on Orgtree. Source lines 1074–1080.

<!-- preserved:e-fd45696b160e1ef3 -->
- Unread user mail with a standalone @user in visible prose/quotes shares
  urgent mailbox counts, notifications, needs-attention and read clearing;
  it never acquires an urgent flag/reason. A matching sender/prose mention
  blurb is represented once by the mail and cleared atomically on read;
  unrelated mentions and transcript highlights remain. [decided: user
  2026-10-18 14:38–14:41Z; verified: `domain/mail_attention.rs`,
  `http/mailbox.rs`, `mailattention.ts`, `attention/feed.ts`]
<!-- /preserved:e-fd45696b160e1ef3 -->

<a id="e-1e91df39f182ab07"></a>

## The Attention list's transcript @user mention row (MentionRowView) is the

Original section: AGENTS.md — working on Orgtree. Source lines 1081–1090.

<!-- preserved:e-1e91df39f182ab07 -->
- The Attention list's transcript @user mention row (`MentionRowView`) is the
  inbox's unread `.mailrow` with the attention cue mention mail wears: agent, a
  `.mentionkind` pill (the `.askkind` look), time, then ONE excerpt from
  `mentionExcerpt`. It drops the engine blurb's partial words and keeps a short
  lead-in whole, else starts at the @user sentence, else '…' + the nearest
  words within 24 characters; @user is marked inline without padding and
  ellipses sit only at the ends. The detail pane shows the same text whole.
  Replaced the centred two-box cut-out (c984db0). [decided: user 2026-10-18
  14:39Z; verified: `attention/{mentionrow.tsx,feed.ts,attention.css}`,
  `tests/attnmentionrow.test.tsx`]
<!-- /preserved:e-1e91df39f182ab07 -->

<a id="e-8c72fbf922e19b8e"></a>

## Do Not Disturb is a durable per-turn flag controlled by self status.dnd.

Original section: AGENTS.md — working on Orgtree. Source lines 1092–1101.

<!-- preserved:e-8c72fbf922e19b8e -->
- Do Not Disturb is a durable per-turn flag controlled by self status.dnd.
  Every harness gates ordinary mail before steering or interrupt; only urgent
  bypasses. User-origin urgent mail may omit a reason; agent-origin urgency
  requires current DND plus a nonblank reason. The armed user composer marks
  its ! and message-box outline orange-red (#ff4500). Turn end and
  recovery release unread mail in order within the prompt byte budget. Inbox
  previews do not consume; explicit fetch/chunk reads held mail once. See
  [DND](../../docs/skills/orgtree-working/runtime/do-not-disturb/SKILL.md).
  [decided: user 2026-10-18 13:44–13:49Z; verified: `domain/{dnd,mail}.rs`,
  `runtime/actor.rs`, migration 0033, `canvas/{dnd,desk,projectdesk}.tsx`]
<!-- /preserved:e-8c72fbf922e19b8e -->

<a id="e-88be5b07d34995c5"></a>

## Org outbox reading headers group the sender's shared AgentLink (badge

Original section: AGENTS.md — working on Orgtree. Source lines 1121–1127.

<!-- preserved:e-88be5b07d34995c5 -->
- Org outbox reading headers group the sender's shared `AgentLink` (badge
  inside), `as @org`, hub recipient and delivery glyph as one wrapping
  attribution. Reply/time form a trailing, baseline-aligned group. The same
  MailList header survives pop-out adoption; ordinary inbox/transcript headers
  retain their own layout. Never wrap the fragment-based `AgentName` in a
  plain bold element for compound attribution. [decided: user 2026-10-18 13:18Z;
  verified: `canvas/mail.tsx`, `styles.css`, `tests/outboxheader*`]
<!-- /preserved:e-88be5b07d34995c5 -->

<a id="e-dfcad01d6f6abf09"></a>

## Desk mention/reply jumps use centerTranscriptTarget on the owning transcript

Original section: AGENTS.md — working on Orgtree. Source lines 1261–1266.

<!-- preserved:e-dfcad01d6f6abf09 -->
- Desk mention/reply jumps use `centerTranscriptTarget` on the owning transcript
  only; never call all-ancestor `scrollIntoView` on its rows or header chips.
  Composer focus uses `preventScroll`. Hidden-overflow desk frames can otherwise
  scroll, losing their header and leaving a band below the composer.
  [decided: user 2026-10-18 11:19Z; verified: `canvas/{desk,deskscroll}.ts*`,
  `tests/deskframe.test.tsx`]
<!-- /preserved:e-dfcad01d6f6abf09 -->

<a id="e-d70208b1cf3476ae"></a>

## On a project desk, presentation-card Reply stages a typed document target in

Original section: AGENTS.md — working on Orgtree. Source lines 1307–1312.

<!-- preserved:e-d70208b1cf3476ae -->
- On a project desk, presentation-card Reply stages a typed document target in
  the project composer; its reader can broadcast the reply with Alt+B. The
  broadcast endpoint resolves targets separately for each recipient before
  sending, so recipient-scoped mail/transcript access stays enforced.
  [decided: user 2026-10-18 17:09Z; verified: `http/nodes.rs`,
  `canvas/{docs,gallery,mail,projectdesk}.tsx`]
<!-- /preserved:e-d70208b1cf3476ae -->

<a id="e-a50407a75a21655d"></a>

## Transcript @user highlights come from each assistant message's own text,

Original section: AGENTS.md — working on Orgtree. Source lines 1327–1333.

<!-- preserved:e-a50407a75a21655d -->
- Transcript `@user` highlights come from each assistant message's own text,
  never the dismissible attention/jump selection. Shared Msg and genuine live
  assistant prose use one message-level theme-relative layer (10% accent,
  75% inset edge); do not add a second paragraph tint. Dismissal still clears
  attention, and its navigation effect only reveals/scrolls to the message.
  [decided: user/coordinator 2026-10-18 11:04Z/11:07Z; verified:
  `canvas/desk.tsx`, `styles.css`, `tests/user-mention-highlight.test.tsx`]
<!-- /preserved:e-a50407a75a21655d -->

<a id="e-315f95088080e970"></a>

## Agent, project and hub contact mentions (4.4.0): typing @ in Quick chat, the

Original section: AGENTS.md — working on Orgtree. Source lines 1394–1426.

<!-- preserved:e-315f95088080e970 -->
- Agent, project and hub contact mentions (4.4.0): typing `@` in Quick chat, the
  desk composer and `MailReplyBox` offers live agents and projects (`state ===
  'live'`), with projects wearing the `.project-mark` folder icon; `Tab`/`Enter`
  completes `@<name> ` without sending. When the menu opens, loaded rows of the
  open transcript are scanned once (skipping Markdown code spans/blocks and
  `[ORG STATE]` envelopes) so entries mentioned in the transcript come first
  (newest first) ahead of never-mentioned entries, and the menu draws in
  reverse order (bottom-to-top) with the bottom entry highlighted by default
  and on filter changes (`ArrowUp` moves to older mentions and then the rest).
  Inline `@<name>` tokens matching
  `world.agents` link in Markdown (`refmd.tsx`) and plain text (`reflinks.tsx`)
  and carry project folder icons/context menus; `runtime/convo.rs` `tool_refs`
  emits project chips for project tool calls. `@net:<address>` and
  `@org:<slug>` render as `HubContactChip`: an adjacent `@org:<slug>` on this
  install opens in a new window (`requestOpenOrg`), otherwise `hubchat_pc`
  opens `hubchat://chat?to=<address>` (`policy.ts`, `windows.ts`) or shows an
  inert `"Hubchat isn't installed"` tooltip. `Copy mention` on every agent and
  project context menu copies `@<name>`. Agent and project `Open` submenus omit
  the word `"Open"` (`Desk`, `Desk as a pinned window`, `Desk in a separate window`,
  `Inbox`, `Scratch folder`, `Docket`, `Presentations`, `Project mailbox`,
  `Project folder`, `Project docket`), nest team opens (`Team scratch folder`,
  `Team docket`, `Team presentations`) in submenus of their individual items
  when both exist (inline when only one exists), offer both individual and team
  `Presentations` unconditionally when handlers are supplied. Both node kinds
  start `Open` with `Desk`, `Desk as a pinned window`, `Desk in a separate window`
  in that order; labels stay fixed when the existing callback raises an already
  placed desk. Team and the other entries follow below. Offer only
  `Hire under this project` and `New project…` in
  the project context menu (hiring above/beside uses the card's hire tokens).
  [decided: user 2026-10-17, 2026-10-18 07:10Z–07:28Z, 11:16Z, 2026-10-20 10:47Z–10:48Z (replaces differing desk labels/order and top-down mentions menu order); verified: `canvas/agentmentions.tsx`,
  `canvas/agentmenu.tsx`, `canvas/contextmenu.tsx`, `canvas/desk.tsx`, `canvas/projectdesk.tsx`,
  `canvas/reflinks.tsx`, `canvas/refmd.tsx`, `runtime/convo.rs`,
  `runtime/identity.rs`, `tests/agentmentions.test.tsx`, `tests/projectnode.test.tsx`]
<!-- /preserved:e-315f95088080e970 -->

<a id="e-a26110be196d3160"></a>

## Inline helper transcripts reuse the desk's Msg/ToolChip/input disclosures,

Original section: AGENTS.md — working on Orgtree. Source lines 1453–1459.

<!-- preserved:e-a26110be196d3160 -->
- Inline helper transcripts reuse the desk's `Msg`/`ToolChip`/input disclosures,
  with a separate bounded fold store and no parent input or nested helper reads.
  New private snapshots preserve native content order with UTF-16 text offsets;
  legacy snapshots keep their available grouped content. Do not invent missing
  helper timing or usage. See [helper transcripts](../../docs/rust-engine/helper-transcripts.md).
  [decided: user/coordinator 2026-10-17; verified: `canvas/helpertranscript.tsx`,
  `runtime/helper_transcript.rs`]
<!-- /preserved:e-a26110be196d3160 -->

<a id="e-03969cce47110e8f"></a>

## Antigravity completed-step thinking uses the launched login home and exact

Original section: AGENTS.md — working on Orgtree. Source lines 1485–1500.

<!-- preserved:e-03969cce47110e8f -->
- Antigravity completed-step thinking uses the launched login home and exact
  process-bound conversation/step, with a bounded read-only committed SQLite
  snapshot (including live WAL), zero lock waiting and
  no thought text in logs. A receipt and thought-before-response rows commit
  atomically, preventing replay/restart duplicates. Busy/exclusive writers and
  rollback journals skip without recovery. `immutable=1` must not be used:
  it hides current committed WAL frames. Snapshot limits
  limits and synthetic checks: [AGY thinking](../../docs/rust-engine/antigravity-thinking.md).
  Keep identity stamping, transcript page/notice restoration and chat HTTP
  response bodies unlogged: nested logged arguments/returns can leak content
  even when outer callers are unlogged. This also protects ordinary text.
  [decided: user 2026-10-17 17:10Z; verified: `runtime/agy_thinking.rs`,
  `runtime/actor.rs`, `runtime/convo.rs`, `http/nodes.rs`; 2026-10-17 author
  checks: 12 tests including real PostgreSQL replay/rollback and verbose-log
  canaries through write/full/incremental reads pass after red controls; installed
  history visibility remains an alpha check]
<!-- /preserved:e-03969cce47110e8f -->

<a id="e-5ee771eaca732224"></a>

## Agent Compact… opens one normal/cheap choice shared with the desk context

Original section: AGENTS.md — working on Orgtree. Source lines 1502–1531.

<!-- preserved:e-5ee771eaca732224 -->
- Agent Compact… opens one normal/cheap choice shared with the desk context
  wheel. Normal capability comes from the actual harness route; unsupported or
  unreadable capability disables normal with a reason. A POST started:false is
  a refusal, never a success toast. Direct Halt/Unhalt have no ellipsis; team
  bulk compaction uses two counted confirm buttons (normal/cheap), plus Cancel,
  with count-only summaries and covered agent names in each line's tooltip,
  not inline lists. Mid-turn and no-measured-context skip lines appear under
  BOTH Cheap and Normal, each with complete hover names; other shared reasons
  appear once. Normal-only reasons stay under Normal, with unsupported harnesses
  grouped. No expanders or radios. [decided: user 2026-10-19 11:47Z;
  verified: canvas/bulkcompact.tsx]
  [decided: user/coordinator 2026-10-18 17:28-17:58Z]
  Opening only reads Normal
  support; pending/zero-target Normal is disabled while eligible Cheap remains
  available. Normal previews unsupported/sessionless/unreadable seats as skips and only reports
  admitted requests as started; there is no fallback to Cheap. The single-agent
  modal retains a cold-cache warning only for backend evidence, never idle age.
  Agent orgtree_compact is team-gated and strict-descendant only; capability
  shares the UI effective-harness resolver and never starts an actor. Compact
  rechecks authority at actor admission and keeps agent origin (no user-contact
  grant/deep-reach notice). started means admitted, never completed; no fallback.
  A later native unsupported result overrides an earlier capability hint if the
  route changes between preflight and admission.
  Actor impl already applies #[logged] to methods; adding it again duplicates
  generated wrappers and fails compilation (orgtree-logged/src/lib.rs).
  [decided: coordinator 2026-10-18 18:26Z; verified: tools/compaction.rs,
  domain/compaction.rs, runtime/actor.rs]
  See [compact choice](../../docs/rust-engine/compact-choice.md).
  [decided: user/coordinator 2026-10-17/18; verified: `canvas/agentcompact.tsx`,
  `canvas/bulkcompact.tsx`, `http/nodes.rs`, `domain/compaction.rs`]
<!-- /preserved:e-5ee771eaca732224 -->

<a id="e-178a632520192efd"></a>

## Per-agent fast mode is node-local and applies next turn without changing

Original section: AGENTS.md — working on Orgtree. Source lines 1533–1562.

<!-- preserved:e-178a632520192efd -->
- Per-agent fast mode is node-local and applies next turn without changing
  model/account/session or restarting a warm CLI. Advertised Codex fast/priority
  tiers use `serviceTierForTurn` (OFF sends explicit `default`); first-party Opus
  uses `fastMode` flag settings and acknowledged `apply_flag_settings`, never
  `/fast`. Hide unsupported controls and ignore stored true on unsupported models.
  Preserve native refusals and reported usage; never infer a multiplier or cache hit.
  The fast next-turn badge compares saved scope to `fast_mode_current`, captured
  only after native turn acceptance; idle/unknown/command turns clear it. Keep
  the field in the runtime overlay allowlist, never infer it from save success.
  The queued-fast badge shares the account/model/effort next-turn group in
  the desk header and near-zoom badge row; only
  supported live/busy seats with known opposite serving speed show it. No
  next-turn cards render in the composer. Its bolt keeps the top 30px row;
  either pending speed direction uses a darker highlight, steady on the ordinary
  highlight and steady off none (user 2026-10-19 13:40–13:41Z).
  Queued controls show saved intent; speed hover names the next and current
  values. Shared pending cards say `next turn: <value>` (user 13:46Z).
  effort and Send stay in a separate
  right-aligned lower row (user16:47Z restores the original vertical placement). [decided:
  user/coordinator 2026-10-19 13:39Z, replacing the composer queued-card placement;
  verified: `canvas/{nextturn,effort,desk,cards,fastmodebutton}.tsx`, `styles.css`]
  Near-zoom cards show a passive bolt (tooltip "fast") for supported active speed:
  busy reads known fast_mode_current; idle reads saved scope. Unknown busy speed
  is silent. The rich agent hover ends with "fast"; idle desk speed help is unchanged.
  [decided: user/coordinator 2026-10-18 14:15-14:17Z; verified:
  canvas/cards.tsx, canvas/OrgCanvas.tsx]
  [decided: user/coordinator 2026-10-17 17:49–17:52Z; verified:
  `providers/fast_mode.rs`, `runtime/{actor,claude,codex}.rs`, `canvas/fastmode.ts`,
  `recordoverlay.ts`, `canvas/fastmodebutton.tsx`; user 2026-10-18 12:51Z;
  contract: [Fast mode](../../docs/rust-engine/fast-mode.md)]
<!-- /preserved:e-178a632520192efd -->

<a id="e-64713a95e5f11ce8"></a>

## Session-placement loss requires three two-second misses; recovery is immediate.

Original section: AGENTS.md — working on Orgtree. Source lines 1611–1619.

<!-- preserved:e-64713a95e5f11ce8 -->
- Session-placement loss requires three two-second misses; recovery is immediate.
  Overdue ticks are skipped and each recovered blip logs once. A per-engine
  placement hint keeps turn selection stable during debounce without extending
  authenticated leases; unreachable retained hosts hold an unsent launch on the
  actor's bounded admission-retry timer, retaining any on-demand session choice.
  A typed pending-placement error must never enter terminal launch failure.
  See [session blips](../../docs/rust-engine/session-placement-blips.md).
  [decided: user/coordinator 2026-10-17; verified: `runtime/session_watch.rs`,
  `runtime/session_host.rs`, `credential_bridge.rs`]
<!-- /preserved:e-64713a95e5f11ce8 -->

<a id="e-bfc26c8383df59ce"></a>

## Turn-body ORG STATE and PROVIDER USAGE headers use a full snapshot for a new

Original section: AGENTS.md — working on Orgtree. Source lines 1648–1654.

<!-- preserved:e-bfc26c8383df59ce -->
- Turn-body ORG STATE and PROVIDER USAGE headers use a full snapshot for a new
  session, then semantic row deltas or one-line references (including small
  reports). Ages never trigger refreshes; usage freshness/reset/limit transitions
  do. Both baselines advance only after accepted delivery and persist under
  `extra.envelope`; identity/tools stay unchanged. See [header deltas](../../docs/rust-engine/turn-header-deltas.md).
  [decided: user/coordinator 2026-10-17; verified: `runtime/envelope.rs`,
  `runtime/envelope/delta.rs`, `runtime/actor.rs`, `usage.rs`]
<!-- /preserved:e-bfc26c8383df59ce -->

<a id="e-46b46bbac1e4ded8"></a>

## Live token updates retain unchanged settled transcript row identities and

Original section: AGENTS.md — working on Orgtree. Source lines 1698–1704.

<!-- preserved:e-46b46bbac1e4ded8 -->
- Live token updates retain unchanged settled transcript row identities and
  segmented projections. Rebuild duplicate claims for live rows every render;
  changed content/routes invalidate Msg, mail replies compare current availability,
  and stable navigation calls the latest desk handler. Retain segmented source-row
  projections when a different row grows. File-card dedup clones only changed rows.
  [verified: `assistantMessages.ts`, `canvas/{desk,transcriptflow}.tsx`;
  2026-10-17; diagnostics: `docs/rust-engine/stream-cadence.md`]
<!-- /preserved:e-46b46bbac1e4ded8 -->

<a id="e-fe2d66c6dc8c0d6f"></a>

## Transcript tool counts (4.4.0) are always ~ estimates from one lazy

Original section: AGENTS.md — working on Orgtree. Source lines 1712–1730.

<!-- preserved:e-fe2d66c6dc8c0d6f -->
- Transcript tool counts (4.4.0) are always `~` estimates from one lazy
  gzip o200k_base plus one process-local correction per harness. Token slots
  use a shared decorative I-beam text-cursor marker
  (user 2026-10-18, replacing the earlier serif `T`), preserving full accessible count labels. Token
  previews use `t`/`kt`; hover keeps the estimate qualifier and full comma-grouped
  figure with `tool output:`/`thinking:` labels. Time hover uses labeled ms with
  three decimals only from sufficient source precision; coarse stamps say so.
  Token and time slots share inline separator spacing and MUI icon sizing.
  [decided: user 2026-10-18; verified: `canvas/{tokencount,toolclock}.tsx`]
  Count observed output before display clipping; do not tokenize in React or use status/input
  summaries as output. Calibrate only complete attributed text receipts; child
  totals and prompt deltas are not result receipts. Provider thinking totals
  require one completed thought in the response scope; Claude fragments share
  `message.id`. Live occupancy is provider-only, coalesced in an agent runtime
  overlay, without mid-turn DB/tree writes. Usage accumulators leave occupancy
  absent until a valid receipt; reported zero is real. Only observed Claude text
  (including explicit empty text) supports an output count. Contract and limits:
  [transcript tokens](../../docs/rust-engine/transcript-token-counts.md).
  [decided: user/coordinator 2026-10-17; verified: `runtime/{token_counts,live_usage,actor,next_turn}.rs`, `canvas/{tokencount,toolclock,desk}.tsx`]
<!-- /preserved:e-fe2d66c6dc8c0d6f -->

<a id="e-acd6869f16605c72"></a>

## New Claude Agent/Task calls retain bounded helper transcripts privately per

Original section: AGENTS.md — working on Orgtree. Source lines 1897–1904.

<!-- preserved:e-acd6869f16605c72 -->
- New Claude Agent/Task calls retain bounded helper transcripts privately per
  root call. Expanded tool rows read live first-level activity; nested helper
  tools keep ordinary details. Never merge child usage/events into the parent
  turn or expose private snapshots in the feed. Other harnesses/history and
  helpers continuing after the parent turn remain deferred in this alpha slice.
  [decided: user/coordinator 2026-10-16; verified from source:
  `runtime/helper_transcript.rs`, `http/nodes.rs`, `canvas/helpertranscript.tsx`;
  contract: `docs/rust-engine/helper-transcripts.md`]
<!-- /preserved:e-acd6869f16605c72 -->

<a id="e-8ba1f4bbeec50f02"></a>

## orgtree_next_turn {} is always-available, self-only and read-only. Dirty

Original section: AGENTS.md — working on Orgtree. Source lines 1919–1927.

<!-- preserved:e-8ba1f4bbeec50f02 -->
- `orgtree_next_turn {}` is always-available, self-only and read-only. Dirty
  covers prefix/namespace changes only, with no retention timing fields or hit
  promise. Launches record private per-file instruction baselines independently
  of cache receipts; legacy/unreadable copies stay unknown. Shared/team edits
  keep their existing next-process-start delivery. Compaction reuses current
  policy and distinguishes live/last-turn occupancy and uncertain harness timing.
  Contract and measured limits: [next-turn query](../../docs/rust-engine/next-turn-query.md).
  [decided: user/coordinator 2026-10-16; verified from source: `tools/next_turn.rs`,
  `runtime/actor.rs`, `runtime/next_turn.rs`, `runtime/startup.rs`]
<!-- /preserved:e-8ba1f4bbeec50f02 -->

<a id="e-0722cab2be6d37b5"></a>

## Live thought bodies must not flex-shrink inside the transcript: the

Original section: AGENTS.md — working on Orgtree. Source lines 2033–2038.

<!-- preserved:e-0722cab2be6d37b5 -->
- Live thought bodies must not flex-shrink inside the transcript: the
  display:contents reply wrapper exposes .thoughtbody.live as a .msgs flex
  item, and its overflow:auto otherwise permits an 8px padding-only sliver.
  Preserve the 320px border-box cap/scrolling and all non-live thought states.
  See [streaming thoughts](../../docs/rust-engine/streaming-thought-height.md).
  [measured: b77512f base Electron reproduction, 2026-10-15]
<!-- /preserved:e-0722cab2be6d37b5 -->

<a id="e-48e7cad0e0ef4520"></a>

## Docket ticket menus match transcript ticket menus through shared

Original section: AGENTS.md — working on Orgtree. Source lines 2192–2198.

<!-- preserved:e-48e7cad0e0ef4520 -->
- Docket ticket menus match transcript ticket menus through shared
  ticketReferenceActions/ticketOwnerAction: Open details always opens/keeps,
  Owner submenu, separator, copy title/slug/reference. Docket-only Fold/Staff
  follow a final separator under existing gates; row-draw staffing warm-up
  stays. Explicit copy title owns its position with no automatic duplicate.
  Transcript behavior stays unchanged. [decided: user 2026-10-14 23:06:53Z;
  docs/rust-engine/docket-ticket-menu-parity.md]
<!-- /preserved:e-48e7cad0e0ef4520 -->

<a id="e-709649bded862bbe"></a>

## Antigravity committed mid-turn mail clears only the next-tool row pointer

Original section: AGENTS.md — working on Orgtree. Source lines 2232–2237.

<!-- preserved:e-709649bded862bbe -->
- Antigravity committed mid-turn mail clears only the next-tool row pointer
  (`Turn.codex_row`); keep existing tool-to-row mappings so in-flight results
  finish on their original rows. Invocation-hook injection does not restart or
  interrupt the turn. CLI trajectory receipt is not evidence of model obedience.
  See [mail order](../../docs/rust-engine/antigravity-mail-order.md).
  [decided: coordinator 2026-10-14 22:43Z; verified: `runtime/actor.rs`]
<!-- /preserved:e-709649bded862bbe -->

<a id="e-4be0ac29ab948d67"></a>

## : Multi-replies retain every authorized immutable snapshot beside

Original section: AGENTS.md — working on Orgtree. Source lines 2310–2323.

<!-- preserved:e-4be0ac29ab948d67 -->
- 2026-10-14: Multi-replies retain every authorized immutable snapshot beside
  legacy first `reply_to`; `orgtree_message.metadata.replies` requires matching
  first. USER 23:11Z corrected the earlier same-sender reading: any replyable
  event within one transcript/conversation may be combined, regardless of author,
  and the reply has one recipient. Cross-transcript references remain refused.
  Desk/user inbox collectors append and dedupe; no external
  human org-inbox composer or fan-out. Hub shape stays first `reply_to` plus
  bounded `meta.replies` with fallback context; migration0021 indexes new links,
  old rows normalize without backfill. Event/card identity is qualified and new
  event quotes omit machine-context segments, including empty visible user turns;
  other events retain authoritative immutable reply quotes when text grows.
  See [multi-replies](../../docs/rust-engine/multi-replies.md).
  [decided: user/coordinator 2026-10-14; verified from source: `domain/replies.rs`,
  `tools/mailtools.rs`, `http/nodes.rs`, `net.rs`, renderer `eventReply.ts`]
<!-- /preserved:e-4be0ac29ab948d67 -->

<a id="e-80d4344789d0c858"></a>

## Successful presented documents and sent files in transcripts render the ordinary

Original section: AGENTS.md — working on Orgtree. Source lines 2325–2329.

<!-- preserved:e-80d4344789d0c858 -->
- Successful presented documents and sent files in transcripts render the ordinary
  timed, expandable tool row followed by their original untimed cards. PresentationCard
  shares the desk document menu; sent files retain existing link/row menus, with no
  new file menu. Failed calls remain tool rows. [decided: user/coordinator 2026-10-14;
  verified: `desk.tsx`, `docs.tsx`, `img.tsx`]
<!-- /preserved:e-80d4344789d0c858 -->

<a id="e-e63d63c5ff5e6463"></a>

## Completed tool-input fixtures use input_seq and the on-demand toolinput

Original section: AGENTS.md — working on Orgtree. Source lines 2331–2334.

<!-- preserved:e-e63d63c5ff5e6463 -->
- Completed tool-input fixtures use `input_seq` and the on-demand `toolinput`
  response, never an inline `input` property. Display red controls reverse only
  the named behavior in current composed source, preserving running-turn ownership.
  [verified: `toolinput.tsx`, `tools/rig/toolchip-display-check.mjs`, 2026-10-14]
<!-- /preserved:e-e63d63c5ff5e6463 -->

<a id="e-610bbe11d6ea29f1"></a>

## Transcript orgtree_work ticket refs carry status_change only from a

Original section: AGENTS.md — working on Orgtree. Source lines 2336–2342.

<!-- preserved:e-610bbe11d6ea29f1 -->
- Transcript `orgtree_work` ticket refs carry `status_change` only from a
  committed mutation result's locked `previous_status` and final status.
  Shared tool rows reuse docket wording/colours; failures, no-ops and legacy
  missing before-states show nothing extra. Archive preserves status. See
  [status transitions](../../docs/rust-engine/tool-work-status-transitions.md).
  [decided: user 2026-10-14 12:44UTC; verified from source: `domain/docket.rs`,
  `runtime/convo.rs`, renderer `docketstatus.tsx`, `toolrefs.tsx`]
<!-- /preserved:e-610bbe11d6ea29f1 -->

<a id="e-f6eba311ade9ca38"></a>

## Codex and Antigravity tools following reply text use a separate transcript

Original section: AGENTS.md — working on Orgtree. Source lines 2453–2458.

<!-- preserved:e-f6eba311ade9ca38 -->
- Codex and Antigravity tools following reply text use a separate transcript
  row (`actor::codex_row`). Lane proofs inspect the scripted turn's new rows,
  requiring completed results after the greeting, rather than greeting.tools.
  Feed snapshots keep every shared record, including events_count; the removed
  always-true filter excluded nothing. See [lane checks](../../docs/rust-engine/stream-order.md#lane-proof-row-selection).
  [verified: `runtime/actor.rs`, `feed/mod.rs`, `tools/rig/proofs/{agy,codex}-lane.mjs`, 2026-10-14]
<!-- /preserved:e-f6eba311ade9ca38 -->

<a id="e-fa93e652c29f0711"></a>

## Transcript bundles include unsent, delivering and recorded passive system

Original section: AGENTS.md — working on Orgtree. Source lines 2486–2491.

<!-- preserved:e-fa93e652c29f0711 -->
- Transcript bundles include unsent, delivering and recorded passive system
  notices in one ordered presentation pass; delivery carriers alone are not
  boundaries. Stable mail IDs retain disclosure state across delivery. Authored
  queued mail keeps the six-row pending fold; live output breaks notice runs.
  [decided: user 2026-10-14 10:26Z; verified from source:
  `canvas/transcriptflow.tsx`, `events/systemruns.tsx`]
<!-- /preserved:e-fa93e652c29f0711 -->

<a id="e-52a21908c0d028fa"></a>

## Transcript bundles are display-only runs of passive system notices (the

Original section: AGENTS.md — working on Orgtree. Source lines 2492–2498.

<!-- preserved:e-52a21908c0d028fa -->
- Transcript bundles are display-only runs of passive system notices (the
  inbox's `isSystemNotice` predicate), at two or more. User/agent notices,
  waking requests, tools and lifecycle rows break runs; unproven legacy
  authorship stays visible. Preserve mounted cards, reply/turn anchors and
  pending-run behavior. See [transcript notices](../../docs/rust-engine/transcript-notice-bundles.md).
  [decided: user 2026-10-13 23:01?23:02Z; verified from source:
  `events/systemruns.tsx`, `events/segments.tsx`, `canvas/desk.tsx`]
<!-- /preserved:e-52a21908c0d028fa -->

<a id="e-8a5ae3fc6391a396"></a>

## Tool writing is an observed per-call stream phase, separate from execution.

Original section: AGENTS.md — working on Orgtree. Source lines 2637–2668.

<!-- preserved:e-8a5ae3fc6391a396 -->
- Tool writing is an observed per-call stream phase, separate from execution.
  Claude-compatible tool block start/stop clocks persist as `writing_secs` in
  the admitted chip; unobserved/history clocks remain unavailable. Active
  snapshots use tool IDs and retire with committed rows. Shared live chips use
  pencil/right-arrow status icons, immediate icon-only clocks, and bounded ephemeral
  streamed-input previews; finished dots remain, counts only expand. Full time
  wording stays in aria/tooltips; unsupported observations are never invented.
  Ticket references use Open details / Owner… / separator / three copy actions;
  Owner uses the canonical agent menu, click/Enter focuses, hover/Right expands.
  Tool reference metadata parses the primary JSON before an appended tool timing
  block; bounded transcript reads repair missing refs from retained results
  without rewriting history. Document/mail cards keep their separate ToolCard
  channel. [verified: `runtime/convo.rs`, `runtime/actor.rs`; user 2026-10-19]
  Ticket/watchdog link menus share direct-object
  action builders and the current-org per-window registry.
  Monitor fire/quiet card watchdog names retain their object menu after a dog
  is spent or removed: show "no longer exists" with copy-name/ID actions only.
  [decided: user 2026-10-19; verified: renderer `events/card.tsx`, `canvas/objectnavhost.tsx`]
  Updated per user 2026-10-14 10:29–10:46UTC, relayed by coordinator-opus. See
  [timing, menu contract and verification status](../../docs/rust-engine/tool-writing-and-link-menus.md).
  [decided: user 2026-10-13 17:47–17:50UTC; verified from source:
  `runtime/toolwriting.rs`, renderer `toolclock.tsx`, `objectactions.ts`, `objectnav.tsx`]
  2026-10-14: a live clock or the executing icon runs only for a call of the
  turn running now. The engine publishes that turn's admission
  (`turn_started_at`, beside `busy`, in the node's runtime view and the chat
  payload; null while idle). A call that started before it belongs to an
  earlier turn: if that turn left it open it shows unavailable (arrow + dash),
  never a live count or an invented end time. An unknown start (the composer's
  optimistic busy, a slot wait) times no call. A writing clock stops once known
  to be an earlier turn's. [decided: coordinator 2026-10-14 (docket
  tool-calls-left-open-by-an-earlier-turn-count-up); verified: `toolclock.tsx`
  `useLiveCall`, `actor.rs` `runtime_value`/`live_view`]
<!-- /preserved:e-8a5ae3fc6391a396 -->

<a id="e-0507dbafa88eea64"></a>

## Native Claude/Codex context overflow gets one durable cheap-reset retry;

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2777–2784.

<!-- preserved:e-0507dbafa88eea64 -->
- Native Claude/Codex context overflow gets one durable cheap-reset retry;
  delivered original mail is recalled, never re-acknowledged. Size compaction
  checks the latest threshold after completed idle turns and before admission;
  resets clear session/measurement and native compaction invalidates old peaks.
  Keep retry wake/session/turn/counter settlement atomic. See
  [context recovery](../../docs/rust-engine/context-full-recovery.md).
  [decided: user/coordinator 2026-10-20; verified: `runtime/context_reset.rs`,
  `runtime/actor.rs`, `tools/rig/proofs/context-full-recovery.mjs`]
<!-- /preserved:e-0507dbafa88eea64 -->

<a id="e-376a429c8255b045"></a>

## OpenCode 2.0.28 uses only the bundled plugin for mail between tool calls,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2859–2869.

<!-- preserved:e-376a429c8255b045 -->
- OpenCode 2.0.28 uses only the bundled plugin for mail between tool calls,
  preserving DND/urgent filtering, durable batch identity and atomic transcript/mail
  acknowledgement. Unknown admission returns once at the next turn, marked
  "may already have been delivered mid-turn"; it never remains held indefinitely.
  Other versions or an unavailable hook retain next-turn delivery. This replaces
  the next-turn-only rule, not ACP itself; no tool boundary means no live delivery. See
  [plugin contract and limits](../../docs/rust-engine/opencode-mail.md).
  Generic turn acknowledgement and context-full claim return exclude outstanding
  bridge custody; reconciliation runs before actor turn boundaries.
  [decided: user/coordinator 2026-10-20; verified: `runtime/opencode_mail.rs`,
  `runtime/opencode.rs`, `tools/rig/proofs/opencode-mail.mjs`, 2026-10-20]
<!-- /preserved:e-376a429c8255b045 -->

<a id="e-32cff994d6fcc51d"></a>

## orgtree_read_transcript returns structured node/access, busy, occupancy and

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3380–3385.

<!-- preserved:e-32cff994d6fcc51d -->
- `orgtree_read_transcript` returns structured node/access, busy, occupancy and
  estimated-occupancy fields plus message role/text/full stored tools. Cap only
  text at 1,200 Unicode characters; default `last` is 30, bounded to 1–80.
  Preserve the self/downward gate and do not start an actor to read metadata.
  [verified-from-source: 2026-10-07; 3.x `api.py`, Rust `tools/orgview.rs`;
  `docs/rust-engine/read-transcript-parity.md`]
<!-- /preserved:e-32cff994d6fcc51d -->

<a id="e-c94c95b5e3e5e18b"></a>

## Transcript and mail content must remove actual U+0000 before PostgreSQL

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3393–3398.

<!-- preserved:e-c94c95b5e3e5e18b -->
- Transcript and mail content must remove actual U+0000 before PostgreSQL
  text/jsonb writes. Use `util::pg_text` / `pg_json` (borrow clean input), or
  `pg_json_mut` for owned JSON; `convo::take_tool_inputs` sanitizes before splitting
  full inputs from desk rows. Preserve other Unicode and binary image bytes.
  Batch transcript failures log and continue per row; history uses savepoints.
  [verified-from-source: 2026-10-07; `docs/rust-engine/transcript-nul.md`]
<!-- /preserved:e-c94c95b5e3e5e18b -->

<a id="e-68d64074e99ca5d8"></a>

## Cold-turn admission and forecasts share the measured-context threshold gate.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3548–3554.

<!-- preserved:e-68d64074e99ca5d8 -->
- Cold-turn admission and forecasts share the measured-context threshold gate.
  Compatible receipts carry an expiry verdict for the composer's shared clock;
  reset clears the old receipt before publishing. Idle reconfiguration replaces
  the CLI at once (busy waits for turn end), under existing warming guards; a
  local process replacement alone does not invalidate a provider receipt.
  [verified-from-source and isolated smoke: 2026-10-07;
  `docs/rust-engine/cold-turn-warning.md`]
<!-- /preserved:e-68d64074e99ca5d8 -->

<a id="e-3ff988a1ae3577cb"></a>

## Tool arguments live in ot.convo.tool_inputs, apart from the normal body

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3603–3607.

<!-- preserved:e-3ff988a1ae3577cb -->
- Tool arguments live in `ot.convo.tool_inputs`, apart from the normal `body`
  projection. Tool chips carry only `input_seq`; expansion reads one agent/row/tool
  through the guarded API. Codex original call arguments come from its own rollout
  on demand and are retained separately; never expose unrelated transcript records.
  [verified from source: 2026-10-07; `docs/rust-engine/tool-inputs.md`]
<!-- /preserved:e-3ff988a1ae3577cb -->

<a id="e-e8cac0647fdc7168"></a>

## Transcript auto-follow releases only on user scroll intent: upward wheel/keys,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3763–3770.

<!-- preserved:e-e8cac0647fdc7168 -->
- Transcript auto-follow releases only on user scroll intent: upward wheel/keys,
  scrollbar drag or touch drag. A scroll event or changed scrollTop alone is not
  intent: browser anchoring, streams, images, prepends, resize and disclosure/jump-card
  clicks keep the bottom pin. Resume only on user movement down to within 8px
  of the bottom (including delayed downward momentum) or
  jump-to-bottom; retain 3.x's row anchors, paging and context-menu hold.
  [decided: user 2026-10-07 09:31/09:37Z; 2026-10-18 13:36Z; verified-from-source and mounted smoke:
  renderer `canvas/desk.tsx`, `docs/rust-engine/transcript-scroll-intent.md`]
<!-- /preserved:e-e8cac0647fdc7168 -->

<a id="e-2281a9f876bf101b"></a>

## Failed transcript first loads and earlier pages retry every five seconds through

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3772–3778.

<!-- preserved:e-2281a9f876bf101b -->
- Failed transcript first loads and earlier pages retry every five seconds through
  the shared conversation store. Retain the failed cursor/window and existing rows;
  share in-flight cursor requests and synchronously capture each reader's row anchor
  before retrying. The last visible desk unsubscribing cancels retries; hidden retained
  hosts do not subscribe, while detached desks remain visible.
  [recorded-decision: user 2026-10-07 08:19Z; verified-from-source and mounted mock smoke:
  renderer `convo.ts`, `canvas/desk.tsx`]
<!-- /preserved:e-2281a9f876bf101b -->

<a id="e-1531f06ab072cae7"></a>

## Turn slots and CLI replacement (2026-10-07). Slots count admitted turns across all orgs,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3854–3859.

<!-- preserved:e-1531f06ab072cae7 -->
**Turn slots and CLI replacement (2026-10-07).** Slots count admitted turns across all orgs,
not parked CLIs. Publish admission before slow CLI startup; release the slot when taking the
finished turn, before fallible cleanup. Stream and exit notifications carry a process incarnation,
so a replaced CLI cannot finish its successor's turn. Exit observations log the incarnation,
PID, reason and OS status (or explicit uncertainty). [verified: `runtime/actor.rs`, `sched.rs`,
`claude.rs`, `codex.rs`, `agy.rs`; details: `docs/rust-engine/turn-slot-lifecycle.md`]
<!-- /preserved:e-1531f06ab072cae7 -->

<a id="e-406c46dd5d4dfcd4"></a>

## An ev member the schema lacks hides the card (2026-10-20). The renderer decodes ev

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3870–3878.

<!-- preserved:e-406c46dd5d4dfcd4 -->
**An `ev` member the schema lacks hides the card (2026-10-20).** The renderer decodes `ev`
against `renderer/src/generated/events.schema.json`, closed to unlisted members, and a
delivered transcript row whose mail rows do not all decode falls back to its raw text: one
unknown member turns the whole delivery, other mail included, into plain text. When an
engine event gains a member, add it to the schema, the `generated/events.ts` type and
MANIFEST and `events/project.ts` in the same landing, optional when stored mail lacks it.
mqtt and websocket fires' `source` and fire actions' `fire_actions` were unlisted until
2026-10-20. Watchdog fire cards draw JSON in fire lines and fire-action results with the
tool-call `StructuredJson` (`events/firelines.ts`). [verified: `events/{decode,wire,card}.ts`]
<!-- /preserved:e-406c46dd5d4dfcd4 -->

<a id="e-0cf17758e3d509a8"></a>

## Live compaction row (docket show-a-live-compacting-for-xs-event-while-an-age): when a

Original section: Turns, mail and notices. Source lines 4771–4783.

<!-- preserved:e-0cf17758e3d509a8 -->
- **Live compaction row** (docket show-a-live-compacting-for-xs-event-while-an-age): when a
  harness reports a provider compaction's start (Claude Code `system` status `compacting`,
  Codex `contextCompaction` item, Muse `compaction` item `inProgress`) the actor appends one
  desk row (`kind: compact`, `compact_state: running`, `compact_started_at` = the engine's
  receipt time) and its end closes the same row (`done`/`failed`, `compact_ended_at`); an end
  with no start adds the old finished row with no times. A CLI exit or a turn ending
  mid-compaction closes it `interrupted` with no end time, and `convo::close_open_compactions`
  does the same at engine start for rows a killed engine left `running`. No start or duration
  is ever invented, and harnesses that report no start (Antigravity, OpenCode, OpenRouter,
  language model servers) show nothing. Transcript only; cheap compact is a different thing. The
  desk counts up with `CompactingLine` (`toolclock.tsx`). [decided: user 2026-10-15; verified:
  `tools/rig/proofs/compaction-live.mjs`; the CLI events are from the 2.1.292 binary and
  the Codex 0.160 schema, not a live run]
<!-- /preserved:e-0cf17758e3d509a8 -->

<a id="e-f6529802f7441855"></a>

## Shared snapshot cleanup keeps the current global digest, the newest other

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5163–5171.

<!-- preserved:e-f6529802f7441855 -->
- Shared snapshot cleanup keeps the current global digest, the newest other
  complete snapshot (timestamp ties too), and managed session/launch/grant paths.
  A bounded owner task registers process tokens before materialization; tokens
  live through warm CLIs and cache keepalives. Current-session metadata persists
  across restart; unknown legacy bindings or unreadable references defer cleanup.
  Only owned, link-free direct children of `shared-skills` are removed; abandoned
  owned stages need an age over one hour. No live profile/OS-process scan.
  [verified: `providers/skills/retention.rs`, `runtime/actor.rs`; decided:
  coordinator 2026-10-17; details: `docs/rust-engine/shared-skills.md`]
<!-- /preserved:e-f6529802f7441855 -->

<a id="e-45523cd2be941642"></a>

## Agent and project links share one renderer base (NodeLink, AgentLink,

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5220–5231.

<!-- preserved:e-45523cd2be941642 -->
- Agent and project links share one renderer base (`NodeLink`, `AgentLink`,
  `ProjectLink`, `createNodeLinkEl`, `TierChip`, `nodeTierOf`, and re-exported
  `nodeMenuAction` / `ticketOwnerAction` in `canvas/identity.tsx`), giving
  mentions, agents-list rows, docket actors, mail/transcript senders, and
  context-menu submenus (`Owner…`, `Presenter…`, `Project…`) the same `16×16`
  inline badge/folder icon (`.project-mark` in `--org-accent`), org-theme mention
  colour (`--org-agent-text` / `--org-accent`), navigation/copy attributes, and
  rich hover tooltip (`agentTooltipInfo` in `canvas/OrgCanvas.tsx`). Markdown
  inline backtick spans (single or multi-backtick) and fenced code blocks never
  parse or highlight mentions (`splitInlineCodeSpans` / `stripMarkdownCode` in
  `canvas/shared.ts`). [decided: user 2026-10-18; verified: `canvas/identity.tsx`,
  `canvas/reflinks.tsx`, `canvas/refmd.tsx`, `canvas/agentmentions.tsx`]
<!-- /preserved:e-45523cd2be941642 -->

<a id="e-9f38bed72023c79e"></a>

## Interrupt/restart (2026-10-20): orgtree_interrupt accepts restart:true

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5249–5258.

<!-- preserved:e-9f38bed72023c79e -->
- Interrupt/restart (2026-10-20): `orgtree_interrupt` accepts `restart:true`
  for a runtime-authorized descendant. `queued:true` scopes a completion-triggered
  stop to the current turn: Claude holds PostToolUse, AGY holds PostInvocation;
  Codex/Muse/ACP notifications can cut the next step off early (accepted by user).
  Parallel observed work settles first. Pending retool/account/model/session
  changes can be applied with both flags. Background work refuses queued/restart;
  natural end is a no-op stop with the requested restart. See
  [tool guide](../../docs/skills/orgtree-working/runtime/tool-interrupt/SKILL.md) and
  [parity](../../docs/harness-parity.md). [decided: user 2026-10-20;
  verified: `runtime/actor/interrupt_control.rs`, `runtime/interrupt.rs`]
<!-- /preserved:e-9f38bed72023c79e -->

## Antigravity (AGY) tool-call annotations and historical chip healing (2026-10-20)

- `runtime/convo.rs` `unwrap_tool_call` normalizes Antigravity tool names and
  arguments onto the shared chip/annotation pipeline: strips the `default_api:`
  prefix, maps eager `mcp_orgtree_orgtree_<tool>` calls and lazy `call_mcp_tool`
  wrappers (`{ServerName, ToolName, Arguments}`) to `mcp__orgtree__<tool>` (or
  `mcp__<server>__<tool>`) with unwrapped `Arguments`, extracts PascalCase file
  paths (`Path`, `FilePath`, `AbsolutePath`, `TargetFile`, `NotebookPath`) in
  `tool_file_paths` and command/search/message summaries (`toolSummary`,
  `CommandLine`, `Description`, `Path`, `Pattern`, `Query`, `DirectoryPath`,
  `SearchPath`, `Url`, `Uri`, `Prompt`, `Name`, `Role`, `Recipient`, `Message`)
  in `tool_arg`, redacts watchdog credentials inside `call_mcp_tool` in
  `redact_tool_input`, and correlates fallback MCP `ToolCard` payloads (`mail`,
  `mails`, `presentation`, `file`) by verified response text/object ID or call
  arguments when `claudecode/toolUseId` is absent, omitting ambiguous matches
  (`tools/mod.rs`, `runtime/actor.rs`, `runtime/convo.rs`). `convo::read`
  (`restore_stored_tool_inputs` and `restore_result_refs`) and `http/nodes.rs`
  (`toolinput`, gated on the chip's `call_mcp_tool` name via
  `unwrap_stored_tool_input`) heal historical AGY transcript rows on read
  without leaking private inputs or altering other tools' retained inputs.
  [decided: user/coordinator 2026-10-20; verified: `runtime/convo.rs`,
  `runtime/actor.rs`, `runtime/manual_mail.rs`, `tools/mod.rs`, `http/nodes.rs`,
  `runtime/convo_work_ref_tests.rs`]
