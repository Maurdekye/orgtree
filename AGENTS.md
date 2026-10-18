# AGENTS.md — working on Orgtree

- The shared Canvas/Attention header shows a glowing @ button before the
  killswitch for live agents’ unobserved transcript markers. It uses the
  existing urgent-mail badge appearance, newest-first focus, highlight and
  observed clearing; mail attention is excluded. Mention jumps select Chat
  on an already-open desk. See [header](docs/skills/orgtree-app/app-shell/org-header-and-menu/SKILL.md).
  [decided: user 2026-10-18 15:33Z/15:33:55Z; verified:
  `shell/mentionbutton.tsx`, `App.tsx`, `canvas/desk.tsx`]

- Project and agent desk member/report rows share `DeskJumpCards`: more than
  16 cards collapse behind the same counted disclosure, using the existing
  Display preference. Project canvas, pin, pop-out and Attention hosts all
  render `ProjectDesk`; parent navigation stays separate. Agent retired
  controls and watchdog ordering are retained. [decided: user 2026-10-18 14:45Z;
  verified: `canvas/{deskjumpcards,desk,projectdesk}.tsx`]

- Agent/project Open menu parents click/Enter the existing temporary-desk
  action; hover/Right still expand. Hire a subordinate uses the org's current
  remembered/template Quick chat tier only if that exact tier is offered,
  otherwise expands without substituting. Read the choice at menu-open time.
  See [menu parent actions](docs/rust-engine/menu-parent-actions.md).
  [decided: user 2026-10-18 14:25Z/14:34Z; verified: `canvas/{agentmenu,cards,OrgCanvas}.tsx`]

- Unread user mail with a standalone @user in visible prose/quotes shares
  urgent mailbox counts, notifications, needs-attention and read clearing;
  it never acquires an urgent flag/reason. A matching sender/prose mention
  blurb is represented once by the mail and cleared atomically on read;
  unrelated mentions and transcript highlights remain. [decided: user
  2026-10-18 14:38–14:41Z; verified: `domain/mail_attention.rs`,
  `http/mailbox.rs`, `mailattention.ts`, `attention/feed.ts`]
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

- Do Not Disturb is a durable per-turn flag controlled by self status.dnd.
  Every harness gates ordinary mail before steering or interrupt; only urgent
  bypasses, and agent urgency requires current DND plus a reason. Turn end and
  recovery release unread mail in order within the prompt byte budget. Inbox
  previews do not consume; explicit fetch/chunk reads held mail once. See
  [DND](docs/skills/orgtree-working/runtime/do-not-disturb/SKILL.md).
  [decided: user 2026-10-18 13:44–13:49Z; verified: `domain/{dnd,mail}.rs`,
  `runtime/actor.rs`, migration 0033, `canvas/dnd.tsx`]

- Team panels reuse the canvas Agents `tray-panel` frame and direct `AgentTray`,
  with Active in `PinFrame.headerActions`; no settings wrapper or bottom Close.
  The inline desk Team tab puts Active and existing PanelCorner buttons in an
  in-flow toolbar outside the tray, leaving a full-width filter below. See
  [Team panel chrome](docs/rust-engine/team-panel-chrome.md).
  [decided: user 2026-10-18 14:22Z/14:44Z; verified: `canvas/{team,desk,projectdesk}.tsx`, `styles.css`]

- Right-clicking an agent or project link inside an agent or project desk
  (`data-desk-mention-scope` on `.desk-body` in `DeskChat` and `ProjectDesk`)
  prepends **Mention** above **Copy mention** and the rest of the shared context
  menu. Choosing **Mention** inserts `@<name> ` at the desk composer's caret (or
  appends it with a separating space when the composer was not focused),
  focuses the composer, and leaves the caret after the trailing space without
  sending. Portaled modals rendered from a desk sit outside `.desk-body` and do
  not inherit **Mention**. [decided: user 2026-10-18 15:39Z; verified:
  `canvas/{agentmentions,contextmenu,desk,projectdesk}.tsx`,
  `tests/agentmentions.test.tsx`]

- Org outbox reading headers group the sender's shared `AgentLink` (badge
  inside), `as @org`, hub recipient and delivery glyph as one wrapping
  attribution. Reply/time form a trailing, baseline-aligned group. The same
  MailList header survives pop-out adoption; ordinary inbox/transcript headers
  retain their own layout. Never wrap the fragment-based `AgentName` in a
  plain bold element for compound attribution. [decided: user 2026-10-18 13:18Z;
  verified: `canvas/mail.tsx`, `styles.css`, `tests/outboxheader*`]

- Project mail's plain delivery marker uses `→ @recipient` through shared
  `AgentName`, in list rows and reading panes (including pop-outs). A list row
  that shows a queue state (`showsQueueState`) takes three lines: sender and
  time; its kind/urgent chips and the queue state (`.lmeta`, line 1's face and
  `1lh` height); the preview. In a project's own mailbox (`projectMail`, both
  folders) every row with chips does too. The recipient yields with an
  ellipsis and never wraps; other rows keep two lines (replaced "recipient
  width yields before the sender" on line 1, user 2026-10-18 14:24Z). Gotcha: in a
  bare desk (`desk-body eye-chat`: desk modals, pinned and popped desks)
  `.eye-chat .cc-name` wraps any `.cc-name` styled by two classes, so the
  delivery name's rule has three. Full delivery details live in the tooltip,
  using `queue.held_at` projected from `extra.claimed.at`, never the message's
  sent-at; absent claim time says so. Other queue-state labels retain their
  meaning. [decided: user/coordinator 2026-10-18 12:46–12:49Z, user 14:24Z;
  verified: `canvas/mail.tsx`, `styles.css`, `feed/compute.rs`]
- Project `release_slot` and own `slots` status are available with either team
  or watchdogs. Watchdog-only cards expose just those actions; dispatch refuses
  other project actions and force release, and status filters other agents. Full
  project control still needs team. Scope denial is checked on each call.
  [decided: user 2026-10-18 12:55Z; verified: `domain/tool_groups.rs`,
  `tools/{defs,mod,treetools}.rs`]

- User mail to projects shares the agent `context.deep_reach` ancestor-notice
  transaction. User fan-out shares `ForwardedUserNotices` for one logical send:
  each live real-agent ancestor receives one passive notice, and only a committed
  admission consumes it. Project fair-queue copies do not forward again. Agent
  reply grants and the post-delivery project audience grant retain their paths.
  [decided: user 2026-10-18 12:47Z; verified: `domain/{mail,runtime_notices}.rs`,
  `http/nodes.rs`]

- Hub-contact chip consumers discover `hubchat_pc` through one shared full
  desktop phone-status read, independently of the phone panel. The cheap phone
  card omits that fact. Window focus refreshes stale availability after 60s;
  failures/malformed values preserve the known state. Local orgs retain local
  routing; genuinely absent Hubchat chips remain inert. [decided: user 2026-10-18 12:51Z;
  verified: `canvas/agentmentions.tsx`, `tests/hubavailability.test.tsx`]

- Project acknowledgement timeout uses `scope.mail_queue_ack_reminders` (1–10,
  default 3) for BOTH held mail and idle concurrency slots. It sends that many
  20-minute reminders, then reclaims at the next checkup; timeout/checkup gates
  and default timing stay unchanged. Tool `settings.ack_reminders` shares the
  canonical queue op. Project settings puts timeout, max attempts and reminders
  in a bottom Acknowledgement section shown only for ack mode or slots >=1.
  [decided: user 2026-10-18 12:21Z; verified: `domain/{projects,slots,ops}.rs`,
  `tools/defs.rs`, `canvas/modals.tsx`]

- Panel open buttons/menus activate existing detached windows through the live
  window registry (native restore/show/focus) and raise existing pins, including
  an already top pin. This replaces the old top-pin toggle-off rule. Agent and
  project desk tabs activate only matching node/generation panels; closed or
  unrelated windows leave normal inline tab selection intact. See
  [panel activation](docs/rust-engine/panel-activation.md).
  [decided: user 2026-10-18 12:09Z; verified: `windowlife.ts`,
  `canvas/{modalpin,panelcorner,desk,projectdesk,OrgCanvas}.tsx`, `App.tsx`]

- Inbox tag popovers close 250ms after the pointer leaves a 100px margin around
  trigger and popup; reentry, typed search and held keys protect the picker.
  Filtered mail remembers its selected matching row; only a NEW mail carrying
  ALL selected tags may replace it. The compact hidden-unread entry uses a
  server aggregate, clears tags and opens the global oldest unread message by
  exact id, even beyond loaded pages. See [mail tags](docs/rust-engine/mail-tags.md).
  [decided: user 2026-10-18 11:30–11:31Z; verified: `inboxselection.ts`,
  `canvas/{mailtagpicker,tagpointerdismiss,mail}.ts*`, `domain/mail_tags.rs`]

- Shared reply quotes activate their original target from the whole block or
  Enter/Space, preserving nested links and text selection. Presentation labels
  use current titles or an exact org/id read, never raw ids; missing targets keep
  a clear fallback. Older message jumps page on demand and center only their
  owning list. See [reply quote navigation](docs/rust-engine/reply-quote-navigation.md).
  [decided: user 2026-10-18 11:21–11:22Z; verified: `canvas/{replypreview,mailreply,presentationtitle,desk,mail}.ts*`]

- Desk mention/reply jumps use `centerTranscriptTarget` on the owning transcript
  only; never call all-ancestor `scrollIntoView` on its rows or header chips.
  Composer focus uses `preventScroll`. Hidden-overflow desk frames can otherwise
  scroll, losing their header and leaving a band below the composer.
  [decided: user 2026-10-18 11:19Z; verified: `canvas/{desk,deskscroll}.ts*`,
  `tests/deskframe.test.tsx`]
- User, agent and project Inbox/Sent history pages seek strictly before a
  numeric mail id (200 user rows, 150 node rows plus one lookahead), separately
  from the unchanged bounded live-feed windows. Keep admitted org/node scope,
  external-inbox visibility, read/delivery states and project queue metadata.
  Loaded older rows merge with the live head without rewinding the cursor or
  changing selection; replies, reads and deletion keep their original routes.
  Normalize omitted/null live folders before indexing them; validate pages
  before React state updates so malformed 2xx bodies retain rows/cursor and
  offer Retry. Null/undefined live windows keep their loading meaning.
  See [mail history paging](docs/rust-engine/mail-history-paging.md).
  [decided: user/coordinator 2026-10-18; verified: `domain/mail_history.rs`,
  `http/{mailbox,nodes}.rs`, `usemailhistory.ts`, `App.tsx`, `canvas/mail.tsx`]
- Presentation list rows use plain, single-line owner text and a muted inline
  `by` attribution, clipped with a title; clicking the name selects the document.
  Keep navigable identities in the details pane and the shared `Presenter…` /
  `Project…` menus, which reuse `nodeMenuAction` like ticket `Owner…`. Feed/body
  reads carry recorded attribution; legacy chips resolve it at menu open with
  the context-menu opening guard. [decided: user 2026-10-18 11:25–11:27Z;
  verified: `canvas/{gallery,docs}.tsx`, `canvas/objectactions.ts`,
  `feed/compute.rs`, `http/docs.rs`]

- orgtree_project settings/configure exposes all Project settings as an
  atomic explicit patch. It reuses canonical ops/reach, preserves false/zero/
  empty values and renames last. Ancestor agents can force-release/unqueue slots;
  broadcast retains per-recipient messaging/attachment authority. Gallery list/read
  and project scratch reads use project reach. Permanent deletion stays user-only.
  Running CLIs retain startup tool schemas: verify claim AND release before taking
  a slot. [decided: user/coordinator 2026-10-18 10:51Z–10:57Z; verified:
  `domain/ops.rs`, `tools/{treetools,orgview,defs}.rs`]
- A successful agent-desk composer send selects that desk's Chat tab after
  acknowledgement. Pending/refused sends retain the selected tab; desk hosts,
  pins, pop-outs and other desks are retained. Project desks have no Chat tab.
  [decided: user 2026-10-18 10:57Z; verified: `canvas/desk.tsx`,
  `tests/desksendtab.test.tsx`]
- The project composer keeps its unsent text by project identity and shares the
  bounded per-node sent history; unmodified Up/Down recall only at the first/
  last line with no selection, preserving the pre-recall draft. Alt+B toggles
  broadcast alongside Alt+N for notice; a successful broadcast disarms, while
  a failed request leaves it armed. [decided: user 2026-10-18 13:56–13:59Z;
  verified: `canvas/projectdesk.tsx`, `tests/projectdesk.test.tsx`]
- Agent replies, mail, docket descriptions and presentations must name agents,
  projects and docket items as mentions, outside code spans. The unconditional
  MENTIONS paragraph reaches full/trimmed profiles even without messaging tools;
  @user keeps its attention-only meaning. See `orgtree-mail-basics` in the
  working glossary. [decided: user 2026-10-18 11:03Z; verified: `runtime/identity.rs`]
- Agent/project desks offer Team via the existing Agents List, restricted to
  self plus descendants from the shared feed map. Keep filter/Active, ordering,
  navigation and canonical menus shared. `agent-team` uses PanelCorner/PinFrame
  and generation-checked window restoration. The switchboard menu opens the
  global Agents list. See [Team tab](docs/rust-engine/team-tab.md).
  The skills tree assigns `AgentTeamView` to `canvas/agents-list` and `TeamModal`
  to `desk/agent-desk`; keep both homes with exported Team screens.
  [verified: `docs/skills/tree.json`, `canvas/team.tsx`; 2026-10-18]
  [decided: user 2026-10-18 10:53–10:56Z; verified: `canvas/{team,desk,projectdesk,OrgCanvas,agentmenu,cards}.tsx`]
- Transcript `@user` highlights come from each assistant message's own text,
  never the dismissible attention/jump selection. Shared Msg and genuine live
  assistant prose use one message-level theme-relative layer (10% accent,
  75% inset edge); do not add a second paragraph tint. Dismissal still clears
  attention, and its navigation effect only reveals/scrolls to the message.
  [decided: user/coordinator 2026-10-18 11:04Z/11:07Z; verified:
  `canvas/desk.tsx`, `styles.css`, `tests/user-mention-highlight.test.tsx`]

- In an agent's desk context, presentation context menus on both the desk-header
  presentation chips (`.desk-docs .doc-badge`) and rows in the Presented tab
  (`AgentGalleryView`) offer `Reply to` when the desk accepts mail (`canMail` and
  not evicted). Choosing it stages a `kind: 'document'` reply target in the desk
  composer using the same reply-target mechanism as replying to mail. [decided:
  user 2026-10-18 08:54Z; verified: `canvas/docs.tsx`, `canvas/gallery.tsx`,
  `canvas/desk.tsx`, `eventReply.ts`, `tests/contextmenu.test.tsx`]

- Agent-facing Orgtree tool results append engine-measured `execution time: 0.432ms`
  as a final text block (Codex: separate `inputText`), preserving the primary
  text byte-for-byte and its JSON parseability. Measure with a monotonic clock
  around common dispatch, including refusals; do not fabricate harness-native
  tool timings. The synthetic rig's primary-text API keeps its JSON contract.
  See [tool result timing](docs/rust-engine/tool-result-timing.md).
  [decided: user/coordinator 2026-10-18; verified: `tools/{mod,result_timing}.rs`,
  `runtime/{claude,codex}.rs`, `bridge.rs`]
- Projects pass active audiences to live direct members as their own; no nested
  relay. Migration 0032 also expands project grantors to their direct live agents:
  A->B reaches B's members; reverse access needs B->A. User project mail/broadcast
  grants only the project, never personal member rows. Direct user contact grants
  only without effective user access; manual Acquire still creates an explicit
  grant while inherited. Keep ancestor forwarding separate from contact grants.
  Operational checks use the effective view; explicit grant administration does
  not. Org-inbox remains agent-only. See [project audiences](docs/rust-engine/project-audiences.md).
  [decided: user/coordinator 2026-10-18 14:09–14:12Z; verified:
  `domain/{mail,runtime_notices,audiences}.rs`, `http/nodes.rs`, `0032_project_member_audiences.sql`]


- `orgtree_present project=P` needs no user audience for agents strictly below
  P, including nested-project members. Ancestors still need the user audience;
  unrelated projects still fail reach, and no-project calls keep the audience
  requirement. This recursive presentation exception is separate from direct-only
  project audience inheritance. [decided: user 2026-10-18 07:38Z; verified:
  `domain/docs.rs`, `tools/rig/proofs/project-present.mjs`]
- EPIC whole-window shakes stop during pointer movement or a held press,
  settle for 250ms, and stay off while hovering clickable controls (including
  watchdog chips, links, fields and the org inbox). Each stage owns and removes
  its document's capture listeners; adopted pop-out targets are duck-typed.
  Camera transforms and other EPIC effects are untouched. See
  [pointer stability](docs/rust-engine/epic-mode-final.md#pointer-stability-2026-10-18).
  [decided: user 2026-10-18 07:49Z; verified: `epic/stage.ts`]

- Watchdog detail cards name every listener type and explain its actual trigger.
  Slot claims show their current queue ordinal or their granted slot/lease and
  spent state, using the slots projection and shared current watchdog snapshot.
  Silence is separate; only file/command/process use polling cadences, while
  project mail is pushed and event-mode stream/activity/event use minimum gaps.
  Keep desktop `notice` projection from `memo.notice` so passive alerts are not
  described as wakes. See [watchdog card](docs/rust-engine/watchdog-detail-card.md).
  [decided: user 2026-10-18; verified: `canvas/watchdogdescription.ts`,
  `canvas/modals.tsx`, `domain/watchdogs.rs`]

- Exact tracing-event-count tests must isolate process-global callsite caches
  from parallel tests. The session-blip regression runs its assertion in one
  exact child test, primes the no-subscriber-first case, then rebuilds interest
  after installing the collector; thread-local subscribers alone do not isolate
  cached interest. Production placement/logging code is unchanged.
  [verified: `runtime/session_watch.rs` tests, tracing-core 0.1.36; 2026-10-18]

- Agent, project and hub contact mentions (4.4.0): typing `@` in Quick chat, the
  desk composer and `MailReplyBox` offers live agents and projects (`state ===
  'live'`), with projects wearing the `.project-mark` folder icon; `Tab`/`Enter`
  completes `@<name> ` without sending. Inline `@<name>` tokens matching
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
  [decided: user 2026-10-17, 2026-10-18 07:10Z–07:28Z, 11:16Z (replaces differing desk labels/order); verified: `canvas/agentmentions.tsx`,
  `canvas/agentmenu.tsx`, `canvas/contextmenu.tsx`, `canvas/projectdesk.tsx`,
  `canvas/reflinks.tsx`, `canvas/refmd.tsx`, `runtime/convo.rs`,
  `runtime/identity.rs`, `tests/agentmentions.test.tsx`, `tests/projectnode.test.tsx`]

- Tool-card JSON literals stay in separate `#[inline(never)]` pure builders:
  a monolithic debug `defs::all()` frame overflows during default-stack actor
  admission. Keep the outer logging boundary and serialized tool order/contracts;
  the captured c89111b byte fixture guards them. Verify actual default-stack
  fake-CLI admission rather than increasing stack sizes. See
  [tool-card stack safety](docs/rust-engine/tool-cards.md#stack-safety).
  [verified: `tools/defs.rs`, `main.rs`; 2026-10-17]

- Model-change tool chips retain the locked applied before/after tiers in
  `refs.model_change`; legacy results leave the old model unknown. Historical
  `TierChip`s omit agent-bound tooltips, while the agent link keeps its current
  model. Omit a redundant new card only when that current model is known to
  match; queued/no-op/refused/staffing calls gain no transition. See
  [model tool chips](docs/rust-engine/tool-model-changes.md).
  [decided: user 2026-10-17 22:59Z/23:01Z; verified: `domain/ops.rs`,
  `runtime/convo.rs`, `canvas/{modelchange,toolrefs}.tsx`]

- Committees without a dedicated manager use a project under their supervisor;
  large/complex committees may instead put members directly under a dedicated
  non-voting manager, with no committee project. Set the actual host's Subordinates
  may message each other OFF to preserve independence. The full workflow lives
  in `orgtree-committee-mode` (orgtree-workflows > collaboration-patterns).
  [decided: user 2026-10-17 22:00Z/22:10Z/22:12Z; coordinator 22:12Z applies
  the existing peer-mail rule to the manager]

- Inline helper transcripts reuse the desk's `Msg`/`ToolChip`/input disclosures,
  with a separate bounded fold store and no parent input or nested helper reads.
  New private snapshots preserve native content order with UTF-16 text offsets;
  legacy snapshots keep their available grouped content. Do not invent missing
  helper timing or usage. See [helper transcripts](docs/rust-engine/helper-transcripts.md).
  [decided: user/coordinator 2026-10-17; verified: `canvas/helpertranscript.tsx`,
  `runtime/helper_transcript.rs`]

- Markdown links to local Windows files may use `file:///C:/...` or another
  drive letter; normalize only this empty-authority form before sanitization and
  keep it reveal-only. Unsupported file URLs stay plain text after sanitization
  removes their href. [verified: `apps/desktop/renderer/src/canvas/shared.ts`,
  `apps/desktop/renderer/tests/windowslinks.test.ts`; 2026-10-17]
- Idle ages on the desk, card and tray use the completed turn's `ended_at`;
  open/legacy rows without it retain the `started_at` fallback. Active time
  remains on `inflight_at`, including ordinary Antigravity hook mail delivery.
  All harnesses share this projection. See [turn clocks](docs/rust-engine/turn-completion-clock.md).
  [decided: coordinator 2026-10-17; verified: `domain/tree.rs`, `runtime/actor.rs`, `canvas/desk.tsx`]
- Shared/team scratch initialization creates a header-only `AGENTS.md` if missing,
  using checked managed components and exclusive creation; existing files, even
  empty ones, are untouched. Org opening backfills shared notes, launch snapshots
  initialize held team/project folders before reading notes, and folder serving
  retries on first use. Agent fallback creation stays limited to writable scope.
  [decided: user 2026-10-17 17:26Z; verified: `shared_notes.rs`, `orgs.rs`,
  `runtime/{actor,identity}.rs`, `http/nodes.rs`]

- Antigravity completed-step thinking uses the launched login home and exact
  process-bound conversation/step, with an immutable bounded history read and
  no thought text in logs. A receipt and thought-before-response rows commit
  atomically, preventing replay/restart duplicates. WAL/journal visibility
  limits and synthetic checks: [AGY thinking](docs/rust-engine/antigravity-thinking.md).
  Keep identity stamping, transcript page/notice restoration and chat HTTP
  response bodies unlogged: nested logged arguments/returns can leak content
  even when outer callers are unlogged. This also protects ordinary text.
  [decided: user 2026-10-17 17:10Z; verified: `runtime/agy_thinking.rs`,
  `runtime/actor.rs`, `runtime/convo.rs`, `http/nodes.rs`; 2026-10-17 author
  checks: 12 tests including real PostgreSQL replay/rollback and verbose-log
  canaries through write/full/incremental reads pass after red controls; installed
  history visibility remains an alpha check]

- Agent Compact… opens one normal/cheap choice shared with the desk context
  wheel. Normal capability comes from the actual harness route; unsupported or
  unreadable capability disables normal with a reason. A POST started:false is
  a refusal, never a success toast. Direct Halt/Unhalt have no ellipsis; team
  bulk compaction uses two counted confirm buttons (normal/cheap), plus Cancel,
  with both target/skip previews visible and no radios. Opening only reads Normal
  support; pending/zero-target Normal is disabled while eligible Cheap remains
  available. Normal previews unsupported/sessionless/unreadable seats as skips and only reports
  admitted requests as started; there is no fallback to Cheap. The single-agent
  modal retains a cold-cache warning only for backend evidence, never idle age.
  See [compact choice](docs/rust-engine/compact-choice.md).
  [decided: user/coordinator 2026-10-17/18; verified: `canvas/agentcompact.tsx`,
  `canvas/bulkcompact.tsx`, `http/nodes.rs`, `domain/compaction.rs`]

- Per-agent fast mode is node-local and applies next turn without changing
  model/account/session or restarting a warm CLI. Advertised Codex fast/priority
  tiers use `serviceTierForTurn` (OFF sends explicit `default`); first-party Opus
  uses `fastMode` flag settings and acknowledged `apply_flag_settings`, never
  `/fast`. Hide unsupported controls and ignore stored true on unsupported models.
  Preserve native refusals and reported usage; never infer a multiplier or cache hit.
  The fast next-turn badge compares saved scope to `fast_mode_current`, captured
  only after native turn acceptance; idle/unknown/command turns clear it. Keep
  the field in the runtime overlay allowlist, never infer it from save success.
  The same queued-fast badge appears beside the active bolt at near zoom; only
  supported live/busy seats with known opposite serving speed show it. Composer
  badge and bolt share the top 30px row; effort and Send stay in a separate
  right-aligned lower row (user16:47Z restores the original vertical placement). [decided:
  user/coordinator 2026-10-18 14:51-14:52Z; verified: `canvas/{nextturn,desk,cards}.tsx`, `styles.css`]
  Near-zoom cards show a passive bolt (tooltip "fast") for supported active speed:
  busy reads known fast_mode_current; idle reads saved scope. Unknown busy speed
  is silent. The rich agent hover ends with "fast"; desk speed help is unchanged.
  [decided: user/coordinator 2026-10-18 14:15-14:17Z; verified:
  canvas/cards.tsx, canvas/OrgCanvas.tsx]
  [decided: user/coordinator 2026-10-17 17:49–17:52Z; verified:
  `providers/fast_mode.rs`, `runtime/{actor,claude,codex}.rs`, `canvas/fastmode.ts`,
  `recordoverlay.ts`, `canvas/fastmodebutton.tsx`; user 2026-10-18 12:51Z;
  contract: [Fast mode](docs/rust-engine/fast-mode.md)]

- State inspection memoizes effective ancestry only within its immutable
  request snapshot, retaining the total 1024-node ancestry cap and visibility
  refusals. Folder clamps normalize each list entry once; pure path helpers
  are unlogged. Snapshot projection runs on a blocking worker after releasing
  the read-only database client, with its request tracing span and outer
  scope/count logs preserved. See [scope follow-up](docs/rust-engine/session-placement-blips.md#scope-inspection-follow-up).
  [decided: coordinator 2026-10-17; verified: `tools/orgview.rs`, `domain/scope.rs`]

- Session-placement loss requires three two-second misses; recovery is immediate.
  Overdue ticks are skipped and each recovered blip logs once. A per-engine
  placement hint keeps turn selection stable during debounce without extending
  authenticated leases; unreachable retained hosts hold an unsent launch on the
  actor's bounded admission-retry timer, retaining any on-demand session choice.
  A typed pending-placement error must never enter terminal launch failure.
  See [session blips](docs/rust-engine/session-placement-blips.md).
  [decided: user/coordinator 2026-10-17; verified: `runtime/session_watch.rs`,
  `runtime/session_host.rs`, `credential_bridge.rs`]

- Renderer document-level event handlers (native agent tooltip, Markdown image
  fallback, copyCode/revealFile/lightbox) must be registered on EVERY owning
  document, including adopted pop-out panels, with cleanup on redock/close;
  binding only the global `document` silently breaks pop-outs. [verified:
  `popout.tsx`, `agentnav.tsx`, `shared.ts`; coordinator 2026-10-17]

- Watchdog recurrence survives restart: persisted next poll/quiet slots skip
  missed periods with at most one catch-up and keep the original phase. Actual
  last-check/fire timestamps remain evidence. Polling silence checks the target
  first; a fresh match suppresses overdue quiet mail. Explicit resume begins a
  new recurrence; process DOWN remains edge-only. See [watchdog recurrence](docs/rust-engine/watchdog-recurrence.md).
  [decided: user/coordinator 2026-10-17; verified: `runtime/watchdogs.rs`, migration0027]

- Orgtree tool cards keep call contracts and glossary pointers; procedures live
  in the named guides. Input schemas and mail shapes are unchanged. Twenty-three
  rare cards permit native Claude search, 22 common cards stay eager; the SDK
  server must not override that policy. Scope denial still omits groups. Native
  deferral and provider-token savings require client evidence, not metadata alone.
  See [tool cards](docs/rust-engine/tool-cards.md). [decided: user/coordinator
  2026-10-17; verified: `tools/defs.rs`, `runtime/actor.rs`]

- The generic specification/feedback and hardening release pattern has its home
  in `orgtree-iterative-development` (orgtree-workflows › collaboration-patterns).
  Phase gates and release-line routing there are suggested workflow rules, not
  automatic product permissions. [decided: user 2026-10-17 14:50Z; documented:
  `docs/skills/orgtree-workflows/collaboration-patterns/iterative-development/SKILL.md`]

- Turn-body ORG STATE and PROVIDER USAGE headers use a full snapshot for a new
  session, then semantic row deltas or one-line references (including small
  reports). Ages never trigger refreshes; usage freshness/reset/limit transitions
  do. Both baselines advance only after accepted delivery and persist under
  `extra.envelope`; identity/tools stay unchanged. See [header deltas](docs/rust-engine/turn-header-deltas.md).
  [decided: user/coordinator 2026-10-17; verified: `runtime/envelope.rs`,
  `runtime/envelope/delta.rs`, `runtime/actor.rs`, `usage.rs`]

- Claude shared-skill exports account for native discovery: exact launch-profile
  org metadata selects the personal synced bucket; enabled installed plugins
  use that profile's settings plus cwd overrides. Identical native bundles omit
  the bare export, while unknown/disabled sources retain fallback and distinct
  resources stay distinct. Claude omits the three Codex-only skill families.
  Launch, idle and forecast share this selection. See [shared skills](docs/rust-engine/shared-skills.md).
  [decided: coordinator/user 2026-10-17; verified: `providers/skills/native.rs`, `runtime/actor.rs`]

- EPIC heat's world grid bounds use the complete borrowed canvas layout,
  including virtualized edge cards. Never derive those bounds from only mounted
  cards: camera pan/zoom would regrid and resample temperatures. Heat inherits
  the cards' `.space` transform without a camera loop. [decided: user 2026-10-17
  12:58Z; verified: `epic/heatmap.ts`; contract:
  [EPIC heat](docs/rust-engine/epic-activity-sound.md#heat-equation)]

- User-mail custom tags (4.4.0): at most eight trimmed 1-32-character tags,
  normalized by lowercase key in an org dictionary with first committed spelling.
  User mail and normalized memberships commit atomically; tagged non-user routes
  refuse before attachments/transport, including mixed fan-out. Tag filtering
  precedes bounded cursor windows: all selected toggles must match (AND). Used
  tags cursor-page indexed memberships; a dedicated UserMail revision refreshes
  filtered mail/catalogs even after deletion outside the visible windows. Chips hash
  the normalized name to a stable hue; `--mail-tag-*` (one palette per contrast
  family) makes them in-sRGB tints with AA text on every surface, which
  `tests/mail-filter-bar.test.tsx` recomputes (replaced the opaque, gamut-clipped
  L .88 fill, user 2026-10-18 11:32Z). Every mail/filter/popover tag chip toggles
  its normalized key. Picking closes the popover and returns focus to its trigger;
  reopening preserves multi-tag AND selection. The inbox filter bar is ONE 24px
  border-box field, also inside `.settings`: tag-icon trigger, chips, the text
  filter (MailTagPicker `children`) and clear sit inside it (replaced three
  separate 24px boxes). The fixed tag popover must override the modal's
  centering transform and takes the field's width, 240-320px.
  [decided: user 2026-10-18; verified: `canvas/mail.tsx`, `canvas/mailtagpicker.tsx`, `canvas/mailtags.ts`, `styles.css`]
  See [mail tags](docs/rust-engine/mail-tags.md). [decided: user/coordinator
  2026-10-17; verified: `domain/mail_tags.rs`, `usemailtags.ts`, `canvas/mailtags.ts`]

- User inbox deletion (4.4.0) is available only from a received-message row
  context menu and requires confirmation. The engine deletes only a user-recipient
  copy, prunes unused tag labels in the same transaction, then publishes
  `Change::UserMail`; sender history, other mailbox copies and attachment files
  remain. See [mail tags](docs/rust-engine/mail-tags.md#deleting-a-user-inbox-message-440).
  [decided: user 2026-10-17; verified: `http/mailbox.rs`, `canvas/mail.tsx`, `App.tsx`]
- Live token updates retain unchanged settled transcript row identities and
  segmented projections. Rebuild duplicate claims for live rows every render;
  changed content/routes invalidate Msg, mail replies compare current availability,
  and stable navigation calls the latest desk handler. Retain segmented source-row
  projections when a different row grows. File-card dedup clones only changed rows.
  [verified: `assistantMessages.ts`, `canvas/{desk,transcriptflow}.tsx`;
  2026-10-17; diagnostics: `docs/rust-engine/stream-cadence.md`]

- The user inbox remembers the last opened received mail per org for the current
  app session. On reopening, it restores and scrolls to that row only when no
  new inbox message arrived and the row is still retained and included by the
  active filters. See [inbox screens](docs/skills/orgtree-app/desk/inbox-screens/SKILL.md).
  [decided: user 2026-10-17; verified: `App.tsx`, `canvas/mail.tsx`]

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
  [transcript tokens](docs/rust-engine/transcript-token-counts.md).
  [decided: user/coordinator 2026-10-17; verified: `runtime/{token_counts,live_usage,actor,next_turn}.rs`, `canvas/{tokencount,toolclock,desk}.tsx`]

- Per-node **Subordinates may message each other** defaults ON. OFF gates
  all agent mail between the same actual parent's direct children unless the
  sender holds an active directional audience. Projects remain transparent for
  reporting; separate physical groups retain reporting-peer reach. Their shared
  nearest agent superior may grant between direct siblings. Stored `scope.peer_mail`
  is node-local, never inherited; peer-only user saves retain project transparency,
  support undo and do not restart CLIs. The live envelope reports current policy;
  the shared wire list hides lateral links for both GL/SVG at every zoom.
  See [peer mail](docs/rust-engine/peer-mail.md). [decided: user/coordinator
  2026-10-17; verified: `domain/peer_mail.rs`, `domain/mail.rs`, `canvas/OrgCanvas.tsx`]

- EPIC tray mute (4.4.0) is the optional native boolean `epicMuted`, persisted
  and broadcast with `epicMode`; its checkbox is visible only while EPIC is on
  and refreshes even in an open native menu. A 300ms final master gain fade
  silences ambience, events and reverb without stopping heat/motion. Saved
  mute applies before startup greetings. [decided: user 2026-10-17 11:06Z;
  verified: `main/tray-epic.ts`, `epic/{audio,pref,sync}.ts`; contract:
  [EPIC sound](docs/rust-engine/epic-activity-sound.md#tray-mute)]

- EPIC 4.4.0 activity audio uses the existing busy/activity tree state: six
  capped, count-scaled layers on the existing bus. User feedback at 13:24Z on
  2026-10-18 removes the baseline agent drone; unclassified mid-turn work
  retains its heat source without an audio layer.
  The App lends its latest tree reference (no copy/listener/audio off) so
  enabling mid-turn starts immediately. Sounds feed a world-space Jacobi heat
  equation beneath the cards; reduced motion shows a static baseline. Tool
  signatures hash normalised names into mechanical material impacts. Machinery
  layers and real-link transport pulses make the working-factory palette;
  five original 4.3.2 event phrases remain alongside it: hire, victory, turnEnd,
  answer and coins (user 21:25Z). Their event mapping is in the sound contract.
  Reduced motion disables pulses. Working cards stay still: user feedback
  at 19:33Z removes the piston bump, replacing the coordinator's 09:42Z approval. Contract and tests:
  [EPIC activity sound](docs/rust-engine/epic-activity-sound.md).
  [decided: user 2026-10-17 09:18–09:41Z, 19:33Z, 21:25Z; 2026-10-18 13:24Z; verified: `epic/{activity,ambience,audio,heatfield,heatmap,toolvoice}.ts`]

- Project nodes (4.4.0) are `ot.agents` rows with `kind = 'project'`: free tree nodes that run
  no turns, with a folder (`_teams/<id>`), a mailbox and presentations. Invariants:
  - Every query that picks agents to run, warm, notify, remind or count filters
    `kind = 'agent'`.
  - An agent's superior is `ot.superior_of(id)`, its nearest agent ancestor, not `parent_id`.
  - A project's scope is transparent: `scope::clamp` passes its parent's scope through.
  - Its `grant_credits` mirrors its live children's stake and is re-settled by
    `projects::settle_credits` at the end of every `run_in_tx`, so costs go to the nearest
    agent above (user 2026-10-16 20:40Z).
  - Project mail reaches agents only through `fair_queue` dogs: one watcher per mail, the
    least recently woken first.
  - New awaits on the actor's turn path (`load_ctx`, `mail::send`) are `Box::pin`ned. Inline,
    they overflowed the debug engine thread's stack at turn start.
  - A project's description (`charter`) is the team charter of its subtree: `load_ctx`'s
    cascade takes it in place of `team_charter` for a project ancestor (user 2026-10-17 19:14Z).
  Design and rulings: [project nodes](docs/rust-engine/PROJECT-NODES.md).
  [decided: user 2026-10-16 16:11Z–2026-10-17 19:14Z; verified: `domain/projects.rs`, `domain/ops.rs`,
  `runtime/actor.rs`, migration 0025]

- Names typed into manual hire UI and project-name UI trim leading/trailing spaces and replace
  each run of spaces with one hyphen before validation. Other invalid characters keep their
  existing errors; agent hire/staff tools do not normalize. [decided: user 2026-10-17 19:22Z;
  verified: `canvas/nameinput.ts`, `canvas/cards.tsx`, `canvas/OrgCanvas.tsx`]

- Renderer agent links use the native title tooltip with catalog model/version,
  effort and (only for multi-account providers) bound/default account joined by
  ` · `. The host resolves current `/api/providers` and `/api/accounts` reads,
  clears title on context-menu open, omits missing values and queued switches,
  marks draft effort `(not started)` and archived models `(retired)`. See
  [agent identity hover tooltip](docs/rust-engine/agent-identity-tooltip.md).
  [decided: user/coordinator 2026-10-17; verified from source:
  `canvas/agentnav.tsx`, `canvas/OrgCanvas.tsx`, `canvas/contextmenu.tsx`,
  `canvas/docket.tsx`, `providers/catalog.rs`]

- A known empty effort offer (`Some([])`) means the model accepts no effort
  setting: hide its effort display/control and send no effort argument. An
  unknown offer (`None`) remains distinct. The org default is computed as an
  effective value and is not persisted per agent. [verified: `providers/catalog.rs`,
  `runtime/actor.rs`, `canvas/OrgCanvas.tsx`, `canvas/desk.tsx`]

- Standalone engine (4.4.0): `orgtree-engine standalone` runs the engine with
  no desktop — mandatory token (`ORGTREE_STANDALONE_TOKEN` or the generated
  `<data>/standalone-token`, also accepted as `Authorization: Bearer`),
  loopback bind unless `ORGTREE_BIND`, exact `ORGTREE_PORT`, fresh-root
  cluster bootstrap, no parent watcher. `serve`/`host` ignore all of it and
  are unchanged. Token headers are masked in the verbose wire log. The user
  MCP endpoint (`POST /api/mcp`, `/api/orgs/{slug}/mcp`, standalone only)
  acts as the user (user ruling 2026-10-16): `tools::usermcp` implements each
  tool against the desktop's own user paths (`Actor::User`, `Who::User`,
  `From::User`), never a fake agent caller; agent-only tools are not listed.
  Contract, deferred work (headless sign-in, Docker verification) and tests:
  [standalone engine](docs/rust-engine/STANDALONE-ENGINE.md).
  [decided: user 2026-10-12, 2026-10-16; verified: `config.rs`, `launch.rs`,
  `http/{mod,usermcp}.rs`, `tools/usermcp.rs`, `tools/rig/standalone-engine.mjs`]

- A halted agent's status duration is measured from `halt.at` (falling back to
  `requested_at` for legacy state), not its last turn. The desk header and
  near-zoom card show `Halted <duration>`; far zoom shows only the halt icon.
  Accessible text may say “Halted for <duration>”. Usage freeze remains a
  separate state. [verified from source: `canvas/desk.tsx`, `canvas/cards.tsx`]

- Fresh-session recovery leads with current docket scope/blockers/dependencies,
  recorded shell directory and recent superior mail before older context. Shell
  inputs in saved history/digest retain 8,192 UTF-8 bytes with explicit clipping;
  legacy missing inputs stay unknown. Write any command you'll re-run into
  breadcrumbs.md or a script file the first time you run it. See
  [recovery commands](docs/rust-engine/recovery-commands.md).
  [decided: coordinator 2026-10-16; verified: `runtime/convo.rs`]

- Windows taskbar lists active orgs in a custom Recent category above fixed
  Tasks (Home, New org). Org logos and matching HomeOutlined/Add action glyphs
  use content-addressed app-owned ICOs; the app feed carries logo hashes only.
  Windows privacy refusal of custom categories keeps fixed Tasks available.
  The native app feed updates names/membership/logos; unchanged contents
  never rewrite the shell list. Strict `--orgtree-taskbar=` navigation queues
  until window routing is ready, including single-instance handoffs; orgs use
  their canonical window and relaunches drop the one-shot navigation argument.
  [decided: user 2026-10-16 and 2026-10-17 19:11–19:12Z;
  verified: `main/{jumplist,jumplist-icons,index}.ts`, `appfeed.rs`, `profile_pictures/mod.rs`;
  contract and verification limits: `docs/rust-engine/taskbar-jumplist.md`]

- An uninitialized manual hire's model icon opens the same `SpawnChips` token
  pyramid as node hiring and Quick chat (replacing the plain tier menu).
  Picking a tier changes the local draft only: preserve form and placement,
  drop incompatible account bindings and map known effort levels as the bar
  does. Final Hire submits that tier through the existing admission gate.
  [decided: user 2026-10-16 10:54Z, 2026-10-17 19:29Z; verified: `canvas/cards.tsx`, `canvas/OrgCanvas.tsx`, `canvas/pickerpopover.tsx`;
  contract: `docs/rust-engine/draft-model-picker.md`]

- New Claude Agent/Task calls retain bounded helper transcripts privately per
  root call. Expanded tool rows read live first-level activity; nested helper
  tools keep ordinary details. Never merge child usage/events into the parent
  turn or expose private snapshots in the feed. Other harnesses/history and
  helpers continuing after the parent turn remain deferred in this alpha slice.
  [decided: user/coordinator 2026-10-16; verified from source:
  `runtime/helper_transcript.rs`, `http/nodes.rs`, `canvas/helpertranscript.tsx`;
  contract: `docs/rust-engine/helper-transcripts.md`]

- The canvas Agents list, Quick chat superior picker and dynamic Attention desk
  each have an independent persisted active-only filter. Quick chat and desk
  default off; toggling one never changes another. [decided: user 2026-10-16;
  verified: `App.tsx`, `QuickChatBox.tsx`, `AttentionView.tsx`, `policy.ts`]

- The built-in Orgtree skill library is also called the glossary or Orgtree
  Encyclopaedia (encyclopedia). These are equivalent terms; keep the library
  name and `orgtree-working`/`orgtree-app` category IDs; `orgtree-workflows`
  adds suggested workflows (user 2026-10-17). Root descriptions,
  the tree manifest, agent introduction and Refresh tooltip carry the aliases.
  [decided: user 2026-10-16; verified: `runtime/identity.rs`, `docs/skills/tree.json`,
  `canvas/modals.tsx`]

- `orgtree_next_turn {}` is always-available, self-only and read-only. Dirty
  covers prefix/namespace changes only, with no retention timing fields or hit
  promise. Launches record private per-file instruction baselines independently
  of cache receipts; legacy/unreadable copies stay unknown. Shared/team edits
  keep their existing next-process-start delivery. Compaction reuses current
  policy and distinguishes live/last-turn occupancy and uncertain harness timing.
  Contract and measured limits: [next-turn query](docs/rust-engine/next-turn-query.md).
  [decided: user/coordinator 2026-10-16; verified from source: `tools/next_turn.rs`,
  `runtime/actor.rs`, `runtime/next_turn.rs`, `runtime/startup.rs`]

- Working checkups depend on current `working` status and more than 20 minutes
  of inactivity, with no docket requirement (user 2026-10-16; replaces the
  2026-09-10 actionable-work gate). Docket reminders are independent and keep
  their blocked/user-held exclusions. If both are due, the docket reminder
  wins that sweep; its resulting turn refreshes the working timer. Existing
  busy/queued/delivery and turn-admission gates remain. Contract and evidence:
  [working checkups](docs/rust-engine/working-checkups.md).
  [decided: user 2026-10-16; verified: `engine/rs/orgtree-engine/src/runtime/reminders.rs`]

- Autonomous org Logo edits use `orgtree_org_logo`, gated only by inherited
  `tools.orgtree.logo` (on by default, including old scopes; user 2026-10-15
  22:10Z). Use the existing bounded native picture decoder/store/publisher.
  Only this agent tool joins user undo history: atomic picture+journal write,
  identity/permission/folder recheck after decode, new revision for undo/redo,
  stale edit refusal. Keep normalized image data out of traces/history feeds.
  Contract and verification limits: [Logo tool](docs/rust-engine/profile-pictures.md#autonomous-logo-tool-431).
  [decided: user 2026-10-15 22:07–22:10Z; verified from source:
  `tools/logo.rs`, `domain/undo.rs`, `profile_pictures/*`]

- Canvas background themes (App settings > Display): optional
  `DesktopPreferences.canvasBackground` (absent = the original parallax dot
  grid, byte-identical) selects the `.canvas-bg` layer — `dots`, `line-grid`,
  `hex-dots`, `hex-lines`, `checkerboard` (2×2 square checkerboard; legacy
  unversioned `'square-tiles'` selections/intensities migrate here, while
  `version: 2` selects the new gapped `'square-tiles'`), `square-tiles`,
  `triangle-tiles`, `hex-tiles`, and `ascii` (labeled **Claude Waves**, placed
  last in the picker; stored `'ascii'` and `'claude-waves'` resolve to
  `'ascii'`) — each with a per-theme intensity stored sparsely, drawn in
  current theme colours, mobile off. New themes pan/zoom 1:1 like a floor; only
  dots keep the 0.88 parallax. Hex lines and the three gapped tile presets
  (`square-tiles`, `triangle-tiles`, `hex-tiles`) are SVG masks over a
  theme-colour fill (`var(--line)`), with each tile drawn as its own closed
  outlined polygon inset from its `{4,4}`, `{3,6}`, or `{6,3}` cell so
  neighbouring tiles have a small even gap and share no edges. Claude Waves
  (`ascii`) is an exact-match WebGL2 re-implementation of the Claude Code
  backdrop algorithm (user 2026-10-15 19:55Z, 2026-10-16: real renderer studied
  read-only, re-implemented independently, NO Anthropic code in repo/docs/tests):
  wind-field + glyph passes in `canvas/asciigl.ts`, spec + CPU mirror in
  `canvas/asciifield.ts`, seeded per-mount visit, world-coordinate sampling
  with zoom-out density floor (`z >= 0.35`, `gridScale >= 0.75 * dpr`) and
  cached glyph atlases, pointer stir/ripples/heart, 180s settle-to-calm, hidden
  pause, still mode under reduced motion, graceful load backoff (`opacity: 0`
  when `busy-off` so no frozen world frame sticks to the viewport, 1.5s→8s
  auto-recovery retry, `WEBGL_lose_context` / `webglcontextlost` +
  `webglcontextrestored` resource regeneration), and silent absence without
  hardware WebGL2. Contract, evidence and limits:
  [canvas background themes](docs/rust-engine/canvas-background-themes.md).
  [decided: user 2026-10-15, 2026-10-16; verified from source:
  `canvas/canvasbackground.tsx`, `canvas/asciigl.ts`, `contracts/canvas-background.ts`, `main/policy.ts`]

- Muse last-good usage is durable per account in `ot.kv` (`muse_usage:<id>`),
  restored before discovery with original observation age and no new auth
  evidence. Removal deletes its key in the account transaction; writers take
  KEY SHARE on the account row to prevent late durable resurrection. Read
  projection makes passed-reset Muse windows unknown (never zero), with no
  bar and `reset; awaiting reading`; other providers are unchanged.
  [decided: coordinator 2026-10-15 11:47Z; verified from source:
  `usage/muse_cache.rs`, `usage.rs`, `domain/account_removal.rs`; contract and
  measured limits: `docs/rust-engine/muse-usage-cache.md`]

- Native Muse metadata refreshes cached display identity even when quota is
  absent or unchanged. The overlay preserves quota age and auth evidence;
  unknown identity clears the prior email and never enters durable quota.
  [decided: coordinator 2026-10-17; verified: `usage.rs`; contract:
  `docs/rust-engine/muse-usage-cache.md`]

- Presentations and docket panels share panel-level Alt+Up/Down navigation
  over their filtered, unfolded row order. Their list root takes focus once
  on opening so auto-selected entries accept arrows without a click; keep an
  already focused descendant and never reclaim focus on later list polls.
  Preserve editor/ask ownership and boolean draft markers on reply/ask
  components, including attachments and inactive question tabs; virtualized
  docket selections mount before nearest scrolling. Mail's own handler stays
  unchanged. Contract/evidence:
  [panel Alt arrows](docs/rust-engine/panel-alt-navigation.md).
  [decided: user/coordinator 2026-10-15; verified from source:
  `canvas/{panelsteps,gallery,docket,mail,asks}.ts*`, `shortcuts.ts`]
- 2026-10-15: Antigravity identity is delivered as bounded, numbered always-on rules,
  never by writing scratch AGENTS.md. Own AGENTS.md is native and excluded from the
  identity mirror. Exact legacy generated envelopes move to unique byte-preserving
  backups at process replacement; other notes stay untouched. Interior edits in an
  envelope are recoverable from backup, not automatically active. See
  [AGY standing notes](docs/agy-standing-notes.md) for the approved migration and
  native budget limits. Identity output and migration canonicalize the trusted
  scratch parent (allowing macOS system aliases), then reject links/reparse points
  at scratch itself and below before writes or stale-part removal. Migration
  skips native AGENTS.md leaf symlinks untouched. [verified: `runtime/agy.rs`, `runtime/startup.rs`;
  decided: coordinator 2026-10-15]

- 2026-10-15: `identity_parts` returns (engine rules, standing notes). On Antigravity
  the notes always start their own numbered always-on part, so notes growth never
  truncates the rules (user D2, 2026-10-15 12:41Z). Seats on a lane in
  `identity::SKILL_LANES` get the trimmed rules (`TRIM_*`, short always-in-force rules
  plus pointers to built-in skill pages); every other seat keeps the full text byte for
  byte. The five current lanes are enabled after the synthetic native-binding/read
  proof `tools/rig/proofs/instructions-trim-skills.mjs` passed 37/37 (2026-10-16):
  each fake agent opened the original two categories, a section and a leaf, and all resources
  match source. This is not real-model skill-choice or native-version evidence.
  Add future lanes only with delivery evidence and with the library shipped, since
  `trim_tests::every_skill_pointer_names_a_page_in_the_library` reads
  `docs/skills/tree.json`. Design and rulings ledger: `docs/skills/INSTRUCTIONS-TRIM.md`
  (branch `skilltree-opus-trim`). [decided: user 2026-10-15 12:41Z (D1-D3); verified:
  `runtime/identity.rs`, `runtime/agy.rs`, `runtime/actor.rs`]

- Live thought bodies must not flex-shrink inside the transcript: the
  display:contents reply wrapper exposes .thoughtbody.live as a .msgs flex
  item, and its overflow:auto otherwise permits an 8px padding-only sliver.
  Preserve the 320px border-box cap/scrolling and all non-live thought states.
  See [streaming thoughts](docs/rust-engine/streaming-thought-height.md).
  [measured: b77512f base Electron reproduction, 2026-10-15]

- EPIC Mode, the final version (branch `epic/final`): the Opus take's architecture
  with the best of the four takes folded in; comparison, credits, inventory and
  verification in [EPIC Mode final](docs/rust-engine/epic-mode-final.md). The secret
  switch is the last row of Settings › Developer, drawn in nothing but the background
  until hovered (`--panel-2`), revealed in the theme accent when checked, invisible
  again when unticked; stored as optional native `DesktopPreferences.epicMode`
  (boolean only, absent = off). OFF CONTRACT: one preference subscription per window
  (`epic/sync.ts`), a borrowed latest-tree reference, and null-checked taps (`epic?.frame` in App.tsx,
  `epic?.refused` on `req`'s failure path; `interruptNode` returns the bare request
  while off). Never add listeners, DOM or audio outside `epic/director.ts`, which
  loads only by `import()` when on and removes everything when it stops. A tree is a
  selection: a hire needs a recent `created`, a retirement live→archived. The org
  socket's only `node_event` pulses are `turn_done`, `frozen` and `renamed`
  (`changes.rs`); read every other agent change from trees. No effect
  celebrates a request the engine refused or did not carry out (the interrupt waits
  for `interrupted: true`), and a 100% usage reading is a reading, never "LIMIT".
  One stage frame loop that sleeps when idle; while only lingering marks
  (`Stage.leave`: at most 48, none past 30 s, aged on the clock) are alive
  it draws 15 frames a second on a timer. Sounds are Web Audio synthesis and art is canvas drawing,
  never assets. Check the strict renderer and test configs as well as root: the
  test overlay must clear the inherited `exclude: ["tests"]`.
  [decided: user 2026-10-14 23:38–23:43Z; the lingering marks and the slow lane: user
  2026-10-15, plan approved by the coordinator; verified from source: `epic/*`, `api.ts`,
  `appfeed.ts`, `changes.rs`, 2026-10-15; branch `epic/final`; measured: `epicmode-linger`]

- Claude usage 429s retain quiet last-good bars only while younger than 900 s
  and the remaining wait is at most 60 s. Otherwise use the existing unavailable
  branch with pause wording. Waits never re-date bars/auth. All Claude callers,
  including force, share a 60 s attempt floor; provider retry expiry overrides
  that floor on the next scheduler pass. Same-key desktop readers await one
  in-flight result; tool refresh retains its explicit in_progress status.
  [decided: coordinator 2026-10-15 10:09Z; verified: `usage.rs`; contract and
  evidence limits: `docs/rust-engine/claude-usage-waits.md`]

- Startup reveals every restored main window, including org-bound error windows;
  background starts retain the set hidden. Quit/update/installer/signal/final
  Windows session paths capture all open placements before teardown; only the
  first final session event captures, so later closes cannot shrink membership.
  A cancelled session query and a refused installer do not latch shutdown.
  [decided: user/coordinator 2026-10-15; verified: `main/index.ts`; contract and
  measured limits: `docs/rust-engine/org-window-reopen.md`]
- When an Orgtree system, tool, screen, panel or setting changes, update its
  built-in skill leaf and the [skill-tree manifest](docs/skills/tree.json) in
  the same landing. Add a leaf for a new public tool or setting and extend
  the source inventory used by `tests/skills-tree-coverage.test.mjs` when
  its UI representation changes. The [tree](docs/skills/TREE.md) assigns
  each fact one home; registered category descriptions stay short.
  [decided: user 2026-10-15, built-in skills scope]

- Measuring inside a desk on the canvas: `.space` carries the camera's `scale(view.z)`
  and `.desk-inner` its own `scale(0.13333 × --desk-dpi)`, so `getBoundingClientRect()`
  is in screen px while offsets, padding, scroll and text measured in the element's
  font stay in its own px. Multiply those by the element's screen scale
  (`box.width / offsetWidth`) before adding them to a screen position. Pinned and
  popped-out desks are scale 1, so the mistake shows only on the canvas: EPIC Mode's
  typing sparks landed up to 92 px off the caret this way (fixed in `caretSpot`;
  [EPIC Mode final](docs/rust-engine/epic-mode-final.md)). [verified: `epic/director.ts`,
  `canvas/docket.tsx`; measured: `tools/rig/epic-mode-visual.mjs` typing scene,
  2026-10-15]

- A textarea has no API for its caret's position on screen. EPIC Mode's
  `caretSpot` lays the text out in a hidden copy of the field (its font,
  spacing, wrapping and exact content width without the scrollbar), puts
  everything from the caret in a marker span and reads the marker's first
  client rect; a zero-width space marks the end of the text or of a line,
  since it never moves a break. Measuring by newlines alone misses soft wraps:
  the typing sparks stayed at the end of the first line (user report
  2026-10-16). jsdom lays nothing out, so check wrapping in Electron
  (`tools/rig/epic-mode-visual.mjs`, typing scene). A visual fixture that
  models the caret must also model what `caretSpot` clamps (4 screen px inside
  the right edge).
  [verified: `epic/director.ts`; measured: typing scene, 2026-10-16]

- Photographing a popped-out window in the offscreen capture: a child opened by
  `window.open` from an `offscreen: true` page never produces a frame, even when its
  `webPreferences` are offscreen too (`capturePage()` returns an empty image, no
  `paint` event, `showInactive()` does not help; the DOM receipt still passes and the PNG
  is a 0-byte file). Open it from `setWindowOpenHandler` as a hidden ordinary window
  (`show: false`, `paintWhenInitiallyHidden: true`, no `offscreen`): it captures at its full
  size. [measured: `tests/epicmode-capture.cjs` wrap pass, 2026-10-16]

- A wheel over the canvas is not a zoom by where it lands: OrgCanvas's wheel listener
  leaves `.pinwin`, `.tray`, `.desk-over` and `.overlay` to the browser's own scrolling
  and zooms everywhere else, clamped to [min zoom, `Z_MAX`]. EPIC Mode's hands therefore
  judge a wheel by what it moved over the next frames: a zoom only for a wheel the canvas
  took (`defaultPrevented`) that changed the `scale()` on `.space`, a scroll for any
  scroll offset from the target up, nothing otherwise
  ([EPIC Mode final](docs/rust-engine/epic-mode-final.md)). [verified: `epic/director.ts`,
  `canvas/OrgCanvas.tsx`; measured: `tools/rig/epic-mode-visual.mjs` wheel scene,
  2026-10-15]

- EPIC Mode must not strobe, and its shakes and blurs stay within comfort bounds
  (photosensitivity). The stage enforces them for every effect, so a new effect flashes,
  dips, shakes and blurs the window only through `Stage.flash`, `flicker`, `shake` and
  `blur`: no two flashes or brown-out dips start closer than `FLASH_GAP_MS` (340 ms; a
  flash asked for sooner waits and later ones join it), so at most three a second, on
  screen too (each is timed from the frame it first shows in, never from its schedule); a
  shake is at most 20 px for 0.9 s, a weaker one never cuts a stronger one short, and the
  window shakes at most 1 s of any 2 s; a blur (a `backdrop-filter` layer of the stage's
  own) is at most 6 px over the window or 10 px at its edges, for 0.7 s, one per 0.6 s;
  under `prefers-reduced-motion` nothing shakes or blurs and flashes are half as strong. An
  event's shake and blur come from its weight (`WEIGHT` in the director). Attention and
  halt space their repeated flashes `FLASH_EVERY_MS` (360 ms) apart, and urgent mail's
  alarm tints every window showing the org in smooth pulses 0.8 s apart (never under
  0.4 s), with a klaxon at EPIC's normal level, until the mail is read or for 8 s
  ([EPIC Mode final](docs/rust-engine/epic-mode-final.md)). [decided: user 2026-10-15;
  coordinator 2026-10-15 (flash merging, the flicker cap); verified: `epic/director.ts`,
  `epic/stage.ts`; measured: `epicmode-comfort`, `epicmode-urgent`,
  `tools/rig/epic-mode-visual.mjs` urgent and blur sections, 2026-10-15]

- EPIC usage effects compare a finite, fresh reading with the last valid
  reading of the same account/window (kind, group, label and model). Missing,
  unavailable and stale readings never replace that baseline. Use each host
  readout's identity with its own limits, and named OpenRouter key readings;
  the aggregate glow peek loses account identity. [verified: `epic/director.ts`,
  `usage.rs`; regression: `epicmode-usage`; 2026-10-16]

- EPIC Mode has no combo meter, ranks, milestones or rank fanfare. Keep the
  small sounds' rising pitch: a private burst count resets after 2.5 s and
  climbs at most one octave at 36 events; it never keeps the stage awake.
  Momentum, charge, level, chains and progression unlock notes are separate
  and stay unchanged. This replaces the small corner combo badge ruling.
  [decided: user 2026-10-16 20:45–20:46Z; verified: `epic/director.ts`,
  `epic/stage.ts`, `epic/audio.ts`; contract: `docs/rust-engine/epic-mode-final.md`]

- EPIC Mode's progression (`epic/progress.ts`: momentum, per-agent charge, the session's
  level, chains) is plain numbers decayed from timestamps when read: never a timer, frame
  or listener for it, so a quiet org costs nothing, and chains happen only inside an
  event. It lives in memory for the app session (it survives EPIC off/on and starts fresh
  on restart); saving it is the user's call (asked 2026-10-15) and would touch only that
  module. An event's lift scales its effects only within the stage's caps and the comfort
  bounds ([EPIC Mode final](docs/rust-engine/epic-mode-final.md)). [decided: user
  2026-10-15 (part 3), plan approved by the coordinator 2026-10-15; verified:
  `epic/progress.ts`, `epic/director.ts`; measured: `epicmode-progress`, 2026-10-16]

- Personal global instruction files are shared read-only across harnesses, with
  canonical dedup against the CLI's actual account/profile native files. Use
  `startup::snapshot` for launch text and digest together; edits belong to the
  existing `startup` boundary, never a running turn. Refresh returns counts only
  and fails explicitly for unreadable sources. Rig discovery stays inside
  `rig-home`. Muse foreign-rule fallback is disabled only for Orgtree launches;
  its own rules and separate skills setting stay native. Preserve the skills
  digest in plan, idle checks and forecast during composition. [decided: user
  2026-10-15 10:21Z; verified: `runtime/global_instructions.rs`, `startup.rs`,
  `actor.rs`; [sources and limits](docs/rust-engine/global-instructions.md)]

- The revealed Rainbow mode row appears only for Custom themes. Selecting a
  preset hides it without altering saved revealed/enabled/epoch preferences;
  returning to Custom restores its prior state. [decided: user/coordinator
  2026-10-14 23:24UTC; verified: `themes.tsx`; contract:
  `docs/rust-engine/rainbow-custom-toggle.md`]

- Docket ticket menus match transcript ticket menus through shared
  ticketReferenceActions/ticketOwnerAction: Open details always opens/keeps,
  Owner submenu, separator, copy title/slug/reference. Docket-only Fold/Staff
  follow a final separator under existing gates; row-draw staffing warm-up
  stays. Explicit copy title owns its position with no automatic duplicate.
  Transcript behavior stays unchanged. [decided: user 2026-10-14 23:06:53Z;
  docs/rust-engine/docket-ticket-menu-parity.md]

- Muse usage Refresh stays visible, disabled and dimmed in host/registered
  Usage cards and the reusable account usage panel. The hover text explains
  that Muse usage arrives at the end of a turn. Gate by provider identity,
  never the account ID or label; other providers and engine refresh paths stay
  unchanged. [decided: user 2026-10-14 23:05UTC; verified from source:
  `App.tsx`, `accountusage.tsx`; see [Muse Refresh](docs/rust-engine/muse-usage-refresh.md)]

- Appearance presets are LS Gold, Muse Eggshell and Antigravity Navy. Shared
  provider/preset order keeps Orgtree first, then Claude/Codex/Antigravity/Muse/
  OpenRouter/LS, with Custom last; preset IDs, accent colours and saved values
  are unchanged. [decided: user 2026-10-14 23:01–23:02UTC; verified:
  `themes.tsx`, `canvas/accounts.tsx`, `packages/contracts/visual-theme.ts`]

- On the light surfaces (`contrast-light`, `contrast-solarized-light`) a pale
  preset accent gets a darker same-hue partner in a
  `:root[data-visual-theme="<preset>"]` rule whose declarations are all
  `!important`, because `applyTheme` sets the accent inline: Muse Eggshell
  #0077b0, Orgtree Grey #4c5565 (4.6:1 or more on every light surface and row
  wash; its hover goes darker, #39404c). Accent text, fills (white ink) and
  borders follow; charcoal and obsidian keep the preset's own accent. Pop-outs
  mirror `data-visual-theme` with the root classes and style, or those rules
  miss them. [decided: user 2026-10-18 15:34Z; verified: `styles.css`,
  `popout.tsx`, `tests/lightaccent.test.tsx`]

- Antigravity committed mid-turn mail clears only the next-tool row pointer
  (`Turn.codex_row`); keep existing tool-to-row mappings so in-flight results
  finish on their original rows. Invocation-hook injection does not restart or
  interrupt the turn. CLI trajectory receipt is not evidence of model obedience.
  See [mail order](docs/rust-engine/antigravity-mail-order.md).
  [decided: coordinator 2026-10-14 22:43Z; verified: `runtime/actor.rs`]

- User-history undo/redo and transient toast Undo share `undokeys.ts` chord
  classification; preserve native editing in the event's own document.
  Classification alone never consumes a key. See
  [renderer history and limits](docs/rust-engine/undo-history-renderer.md).
  Durable commands outlive toasts, use journal entry IDs, guard pending keys,
  and mirror worked-hire confirmation in the presentation's own document.
  Composite canvas hires/reorders and agent settings Save each use one gesture.
  Durable shortcuts use window capture before transient toast bubbling:
  owner-document discovery can register the history listener later regardless
  of JSX order. [verified: `historyui.tsx`, 2026-10-14]
  Shortcut documentation/scanning tracks `undokeys.ts` plus its durable and
  transient consumers; only the durable consumer binds redo.
  [verified: `shortcuts.ts`, `tests/shortcuts.test.tsx`, 2026-10-14]
  [decided: user/coordinator 2026-10-14; verified from source: `undokeys.ts`,
  `toasts.tsx`, `historyui.tsx`, `canvas/{OrgCanvas,modals}.tsx`]

- Desk-slot removal resolves the eligible remaining owner after the React
  commit and before publishing the registry revision. Publishing first lets
  a slot draw a stale elsewhere placeholder beside the returned live desk.
  Ordinary re-renders still do not claim ownership; borrow and detached rules
  remain in `pick`. See [desk owner close](docs/rust-engine/desk-owner-close.md).
  [decided: user 2026-10-14 18:36UTC; verified from source: `canvas/deskhosts.tsx`]

- App settings uses a 791px modal width (formerly660/726/783px), retaining the94vw
  cap and pinned-window sizing. Scope the override to `.settings.acct-panel`;
  organization/agent settings and other modals keep their own widths.
  Rig439 measured minimum783px (719px tabs +64px chrome); coordinator20:21UTC
  adds8px margin for font/scaling variation. Narrow94vw is unchanged.
  At1366×768 rig439 verifies791px panel and727/727px tab client/scroll,
  with allnine tabs visible. scrollWidth-clientWidth measures overflow only,
  not spare margin;8px remaining is inferred from earlier719px overflowing content.
  The supported offscreen runner fixesDPR1;125/150%scaling is unmeasured.
  Do not change tab labels/style. [measured: rig439; decided: user/coordinator2026-10-14;
  [panel proof and limits](docs/rust-engine/panel-widths-provider-headings.md)]
  [decided: user 2026-10-14 17:54UTC; verified: renderer `styles.css`]

- Providers headers use family names Claude/ChatGPT/Gemini/Muse with dim
  harness names Claude Code/Codex/Antigravity/Muse Code. OpenRouter's dim
  subtitle is REST API; each key's own harness label remains. IDs, status,
  controls and Harnesses registry names are unchanged.
  [decided: user 2026-10-14 17:53–17:54UTC; verified from source:
  `canvas/accounts.tsx`, `canvas/openrouter.tsx`]

- Inbox and presented-document modals collapse their list at <=896 CSS px of
  their own reading box. `NARROW_MAILER_WIDTH` aliases `NARROW_DOCS_WIDTH`,
  replacing inbox's former560px boundary; inline desk lists stay persistent.
  Both organization and agent gallery callers retain the896px value.
  On adoption into a popout or return, the list observer must be recreated
  from the current surface document's window. A main-window observer can
  retain the adopted node without delivering its new document's widths.
  Contract and measured browser proof: [popout list width](docs/rust-engine/popout-list-width.md).
  [verified: `canvas/narrowlist.tsx`, real Electron adoption/resize, 2026-10-16]
  [decided: user 2026-10-14 23:07UTC, superseding mail exception from17:51UTC;
  verified from source:
  `canvas/gallery.tsx`, `canvas/narrowlist.tsx`]

- Org settings Accounts uses a short explanation (32 words), preserving the
  current-turn boundary and conditional same-provider move/stop meaning. Per-row
  globally-disabled account help stays. [decided: user 2026-10-14 18:46UTC;
  verified: `orgaccounts.tsx`, `org_accounts.rs`; see
  [copy evidence](docs/rust-engine/org-accounts-copy.md)]

- Live tool writing/execution clocks floor actual elapsed seconds and schedule
  at boundaries relative to the observed start; completed formatting remains
  precise. Omit an unobserved writing-time slot entirely; measured zero remains
  visible, and executing tool status uses the same right arrow as execution time.
  Codex tool generation requires a genuine pre-execution observation,
  never the execution span or unrelated preceding/turn time. See
  [live clocks and probe status](docs/rust-engine/live-tool-clock.md).
  [decided: user/coordinator 2026-10-14; verified from source: `toolclock.tsx`, `desk.tsx`]

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
  See [multi-replies](docs/rust-engine/multi-replies.md).
  [decided: user/coordinator 2026-10-14; verified from source: `domain/replies.rs`,
  `tools/mailtools.rs`, `http/nodes.rs`, `net.rs`, renderer `eventReply.ts`]

- Successful presented documents and sent files in transcripts render the ordinary
  timed, expandable tool row followed by their original untimed cards. PresentationCard
  shares the desk document menu; sent files retain existing link/row menus, with no
  new file menu. Failed calls remain tool rows. [decided: user/coordinator 2026-10-14;
  verified: `desk.tsx`, `docs.tsx`, `img.tsx`]

- Completed tool-input fixtures use `input_seq` and the on-demand `toolinput`
  response, never an inline `input` property. Display red controls reverse only
  the named behavior in current composed source, preserving running-turn ownership.
  [verified: `toolinput.tsx`, `tools/rig/toolchip-display-check.mjs`, 2026-10-14]

- Transcript `orgtree_work` ticket refs carry `status_change` only from a
  committed mutation result's locked `previous_status` and final status.
  Shared tool rows reuse docket wording/colours; failures, no-ops and legacy
  missing before-states show nothing extra. Archive preserves status. See
  [status transitions](docs/rust-engine/tool-work-status-transitions.md).
  [decided: user 2026-10-14 12:44UTC; verified from source: `domain/docket.rs`,
  `runtime/convo.rs`, renderer `docketstatus.tsx`, `toolrefs.tsx`]

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
  `.output` file. See [background work](docs/rust-engine/background-work.md).
  [decided: user 2026-10-14 09:44:51Z via coordinator; the startup-file edit:
  coordinator 2026-10-14 10:56Z; verified from source:
  `runtime/actor.rs`, `runtime/tasks.rs`; measured: real Claude Code 2.1.292
  probes 2026-10-14; rig proofs pending]

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
  refusal cooldown. See [background auth](docs/rust-engine/antigravity-background-auth.md).
  [verified: `providers/agy_auth.rs`; decided: user/coordinator 2026-10-14]
  Keep AGY guard futures heap-owned at the public/capture boundaries and pipe
  buffers heap-allocated; round 434 reproduced debug actor stack overflow on
  the original inline implementation. Check inline future size and unchanged
  lane proofs; do not increase stack limits or suppress lints to hide it.
  [verified: round 434 own-tip failure; `providers/agy_auth.rs`, 2026-10-14]

- Antigravity admission/launch repeats an inconclusive silent check once after
  500 ms (Unavailable/Timeout only), reacquiring metadata and the guard each
  time. SignedOut, NotIsolated and OutputLimit never retry; exhausted admission
  leaves mail pending without signed-out evidence. Diagnostics name fixed
  stages/reasons only, never captured output. [decided: coordinator 2026-10-17;
  verified: `providers/agy_auth.rs`, `runtime/actor.rs`; contract:
  `docs/rust-engine/antigravity-background-auth.md`]

- Antigravity keeps ONE sign-in per Windows user (Credential Manager target
  `gemini:antigravity`): a separate `USERPROFILE` folder still reads it, with or
  without `.gemini\antigravity-keyring-unavailable` (two user-approved probes,
  AGY 1.3.5, 2026-10-16). A registered google subscription row that is not the
  default sign-in is its own `agy_auth::Login` (`USERPROFILE`/`HOME` at its
  folder, own latch/stamp) and runs only when its silent check names an account
  the default sign-in does not; else it is latched `not_isolated` and refused,
  never silently run on the default sign-in. The Add dialog offers only an API
  key for Antigravity. Never run the real `agy` from an Antigravity seat (shared
  sign-in). See [Antigravity accounts](docs/rust-engine/antigravity-accounts.md).
  [decided: user/coordinator 2026-10-16 20:41Z; verified: `providers/agy_auth.rs`,
  `runtime/actor.rs`, `usage.rs`, `canvas/accountsregistry.tsx`]

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

- Main app menu orders App settings / Usage / Usage history; main ShellHeader
  orders Inbox / Work (Docket) / Presentations / Org settings. `APP_FKEYS` backs
  main-window function-key actions and the Settings explainer; typing fields
  keep these keys active. F1 is app Settings, F9 org Settings. F10 arms only,
  never releases a persistent halt; Shift+F10 immediately uses killAll. Local
  arming expires after five seconds; keep mouse's 500 ms safety delay and other
  modifier chords except assigned Shift+F1/F2/F3/F6/F7/F8/F10. Shift+F1/F3 reuse menu
  New/Create window actions; Shift+F2 opens/focuses its organization submenu.
  F1-F3/F6-F9 and Shift+F2 toggle their exact open target via its normal close
  cleanup, even if pinned behind another; mouse open/raise rules stay unchanged.
  Different panel targets still stack. Repeated keydown events do nothing.
  Shift+F1/F3 remain native window navigation, never close windows on re-press.
  Shift+F6 fits the org, Shift+F7 focuses the last live agent desk, and Shift+F8
  focuses the switchboard through the canvas's existing camera actions; these
  three are no-ops while an org modal surface is open.
  [decided: user/coordinator 2026-10-14 17:58/18:02UTC]
  See [function keys](docs/rust-engine/app-menu-shortcuts.md).
  [decided: user/coordinator 2026-10-14; verified from source: `App.tsx`,
  `shell/{menu,appshortcuts}.ts*`, `KillSwitch.tsx`]

- App settings Harnesses is a compact registry list: installed state, cached
  discovery version (unknown when absent), and missing-only install links.
  OpenRouter / Language server tags use selectable registry provider IDs;
  listing does not launch CLIs or change authentication. See
  [compact harness settings](docs/rust-engine/harness-settings.md).
  [decided: user 2026-10-14 10:59Z; verified: `harnesses.rs`, renderer `canvas/harnesses.tsx`]

- Halted list rows reuse canvas StopIcon and var(--bad), keep the halt clock
  separate from the last/previous status age, and reserve the summary line
  when empty. Completed halt.at wins, with requested_at as legacy fallback;
  halting uses requested_at. Durable halt still precedes usage freeze. All
  AgentTray hosts share this. [decided: user/coordinator 2026-10-14;
  docs/rust-engine/halted-list-rows.md]

- Transfers starts collapsed in every new mail view. Keep expansion while that
  view stays open, including transfer polls; reset on mailbox org/agent changes.
  Org inbox and user/agent/desk inboxes share TransferPanel. Preserve unfinished
  counts, polling, progress, history, paging and engine jobs; no persisted flag.
  [decided: user/coordinator 2026-10-14; docs/rust-engine/transfers-default.md]

- Codex and Antigravity tools following reply text use a separate transcript
  row (`actor::codex_row`). Lane proofs inspect the scripted turn's new rows,
  requiring completed results after the greeting, rather than greeting.tools.
  Feed snapshots keep every shared record, including events_count; the removed
  always-true filter excluded nothing. See [lane checks](docs/rust-engine/stream-order.md#lane-proof-row-selection).
  [verified: `runtime/actor.rs`, `feed/mod.rs`, `tools/rig/proofs/{agy,codex}-lane.mjs`, 2026-10-14]

- Codex `thread/resume` IGNORES `dynamicTools` (codex-cli 0.160.0): a resumed
  thread keeps the cards it STARTED with, restored from its rollout's first line
  (`session_meta.payload.dynamic_tools`). Before every resume the actor writes
  the current cards there (`codex::sync_rollout_tools`); without it Codex agents
  never see new tools, kinds or scope changes. A probe that resumes with the
  SAME tools proves nothing. [verified: `runtime/{codex,actor}.rs`, real Codex +
  fakellm probe, 2026-10-18]

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
  commands moved to the background](docs/rust-engine/muse-code.md). [decided:
  coordinator 2026-10-13 18:53Z; verified: `actor.rs` `on_muse_late`,
  `muse_lost`, real Muse 1.4.6 probes 2026-10-13 and proof 2026-10-14]

- Transcript bundles include unsent, delivering and recorded passive system
  notices in one ordered presentation pass; delivery carriers alone are not
  boundaries. Stable mail IDs retain disclosure state across delivery. Authored
  queued mail keeps the six-row pending fold; live output breaks notice runs.
  [decided: user 2026-10-14 10:26Z; verified from source:
  `canvas/transcriptflow.tsx`, `events/systemruns.tsx`]
- Transcript bundles are display-only runs of passive system notices (the
  inbox's `isSystemNotice` predicate), at two or more. User/agent notices,
  waking requests, tools and lifecycle rows break runs; unproven legacy
  authorship stays visible. Preserve mounted cards, reply/turn anchors and
  pending-run behavior. See [transcript notices](docs/rust-engine/transcript-notice-bundles.md).
  [decided: user 2026-10-13 23:01?23:02Z; verified from source:
  `events/systemruns.tsx`, `events/segments.tsx`, `canvas/desk.tsx`]

- Middle-button pan uses native DOM capture on each visible canvas viewport,
  including registry-owned desk portals whose React ancestry bypasses it
  (2026-10-16). Reuse the background pan/persisted camera. Suppress middle
  mousedown/auxclick defaults; never set the eye's click-focus flag for it.
  See [middle pan](docs/rust-engine/middle-pan.md).
  [decided: user 2026-10-13 22:29UTC, 2026-10-16 13:15UTC;
  verified: `canvas/OrgCanvas.tsx`, `canvas/deskhosts.tsx`, `popout.tsx`]

- Tray Harness setup reads the engine registry, with a five-harness shell fallback;
  detected first, one separator before missing, all setup actions clickable.
  Keep legacy desktop IPC IDs and primary-click toggle behavior. See
  [tray harness setup](docs/rust-engine/tray-harness-setup.md).
  [decided: user 2026-10-13 22:22UTC; verified: desktop `harnesses.ts`, `index.ts`]

- Registered usage Refresh forwards `force=true` to the existing boolean query;
  normal reads remain cached. Available last-good bars carrying a provider error
  display that refresh failure without changing the dated observation; later clean
  data clears it. Preserve unavailable/unsupported/spend/standing branches and
  existing cooldown/scope rules. See [usage Refresh](docs/rust-engine/usage-refresh.md).
  [decided: coordinator 2026-10-13 18:57/21:21UTC; verified: renderer `api.ts`,
  `canvas/accounts.tsx`, Rust `http/accounts.rs` `Force`/`usage_registered`]

- Every secondary OpenRouter usage card uses the shared Refresh header with
  independent pending/error/age state. Only its manual force calls that key's
  registered endpoint; normal key-map reads stay cache-only. Original key Refresh
  remains unchanged. [decided: user 2026-10-13 21:49UTC; verified: `App.tsx`
  `OpenRouterKeyUsageSection`, Rust `usage.rs` `registered` OpenRouter branch]

- Failed shell errors show a compact indicator; expansion reads retained output
  via authenticated org/node/seq/tool `tooloutput`, with a UTF-8-safe 1 MiB cap
  and explicit truncation note. Keep raw output out of chat/feed and wire logs;
  successful calls/other tools keep existing clipping. See
  [retention and proof limits](docs/rust-engine/shell-error-fold.md).
  [decided: user/coordinator 2026-10-13; verified: runtime `convo.rs`, HTTP `nodes.rs`, renderer `desk.tsx`]

- Muse in Windows Session 0 (the installed app's boot-task engine): Muse's
  OS sandbox cannot start a command there, so a write seat's host starts with
  `--disable-sandbox`; read-only seats have no shell; bypass seats, and every
  seat outside Session 0, are unchanged. Without the sandbox Muse asks Orgtree
  only about a shell statement its policy cannot settle (in stages, next entry;
  2026-10-14, replacing "about no command") and its file tools write outside
  the agent's folders (measured). The user kept this knowingly. User 2026-10-14 16:39UTC removed
  the long Muse paragraph from Providers, superseding the October13 display
  request; ordinary provider status remains. Runtime posture is unchanged.
  See [Muse Session 0](docs/rust-engine/muse-code.md). [decided: user
  2026-10-13 18:53Z, kept 20:16Z; verified: `muse.rs` `os_sandbox`, real Muse
  1.4.6 probes 2026-10-13; display removal verified: `canvas/accounts.tsx`, 2026-10-14]

- Muse approvals: Orgtree refuses with MSP's `denied` choice when offered, else
  Muse's once-only `abort` ("Reject"): real Muse 1.4.6 offers no `denied`, and
  `abort` rejects that one call while the turn goes on. Never take a choice that
  persists (`allow_local_prefix`, session scope). Before this a refusal found no
  choice and the call waited until the silence limit. See [Muse
  sessions](docs/rust-engine/muse-code.md). [decided: coordinator 2026-10-13
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

- Reparent drag ghosts use the same display projection and final targets as
  the move animation, including piles and inbox clearance. Keep sibling drags
  as separators and inbox drops as audience actions. See [landing ghost](docs/rust-engine/reparent-ghost.md).
  [decided: user 2026-10-13 18:58UTC; verified: `canvas/moveghost.tsx`, `canvas/canvaslayout.ts`, `OrgCanvas.tsx`]

- Sibling drag preview is a node-height accent separator: vertical in tree rows,
  radial through the eye in rings. Preserve angular/x drop request semantics;
  marker geometry is visual-only. Ring ends use a 16-world-pixel gutter beyond
  the endpoint card's tangent extent, including a single remaining target;
  never space the endpoint marker through the unused arc. Between-agent
  midpoints are unchanged. See [reorder separator](docs/rust-engine/reorder-separator.md).
  [decided: user 2026-10-13 18:58UTC; coordinator 2026-10-16 13:58UTC;
  verified: `canvas/reorderpreview.tsx`, `canvas/ringreorder.ts`, `OrgCanvas.tsx`]
- Tray primary clicks toggle pending or visible org lists; dismissal invalidates
  late activity/HTML loads. Windows tray-induced blur consumes one immediate
  click, while outside dismissals and later clicks remain usable. Preserve the
  double-click open-app route and sandbox. See [tray toggle](docs/rust-engine/tray-toggle.md).
  [decided: user 2026-10-13 18:42UTC; verified: desktop `main/index.ts`]

- The org Docket selects its first visible unarchived, non-backlogged row once
  after opening/initial load, using current grouping/nesting/sort. Requested
  jumps and deliberate selection/clear take precedence; polls cannot reselect.
  The popped-out org surface shares DocketModal; agent/team lists are unchanged.
  [decided: user 2026-10-13 18:46UTC; verified: `canvas/docket.tsx`]

- A Muse tool call that produces nothing for the turn's silence limit
  (`turn_idle_s`) is stopped by itself and the turn goes on: a `turn/steer`
  note naming the limit, then MSP `task/stop` on the call's item id; the clock
  restarts. A silent model (nothing in flight, or only work Muse moved to the
  background), a stopped call still running one limit later, and the total
  ceiling still end the turn. Other lanes still end the whole turn on any
  silence (unchanged, no ruling). See [Muse: tool calls past the silence
  limit](docs/rust-engine/muse-code.md). [decided: user 2026-10-13 18:32Z;
  verified: `actor.rs` `stop_silent_muse_tools`, `muse.rs` `stop_task`, real
  Muse 1.4.6 probes 2026-10-13]

- Organization settings calls its Hubchat account image **Logo**. The avatar
  opens the existing chooser; pencil is always bottom-right and a separate X
  removes an existing logo. Preserve numeric-owner/intent guards, crop and API
  semantics. Empty fallback copies Hubchat org orange/initials independent of
  provider accents; the requested round shape is editor-local. Scope avatar/X
  chrome with two classes to outrank `.settings button` padding/radius/colors.
  See [Logo editor](docs/rust-engine/org-logo-editor.md).
  [decided: user 2026-10-13; verified: `canvas/orgpicture.tsx`, `orglogo.css`, `App.tsx`]

- Ctrl/Cmd+Z runs the newest visible toast Undo in its own window; keep text
  editor undo and the 12-second deadline. Clicks and mirrors consume the same
  callback once before invoking it. See [toast shortcut](docs/rust-engine/toast-undo-shortcut.md).
  [decided: user 2026-10-13 18:14UTC; verified: renderer `toasts.tsx`, `App.tsx`]

- OpenRouter has one header Add action beside its provider switch for first
  and subsequent keys. Every key's row and settings are alike (one shared form
  for its custom name, harness and optional replacement secret); there is no
  separate naming action and no first-key-only row. Provider drafts close on backdrop clicks and
  Escape when idle, discard unsaved entries, and ignore inside-started drag-out
  clicks. Busy saves keep the existing dismissal guard. [decided: user
  2026-10-13 18:16–18:17UTC; verified: `canvas/openrouter.tsx`,
  `openrouterkeys.tsx`, `providerdialog.tsx`, `modalpin.tsx`]

- Usage history cards export the former table's measured points as CSV/JSONL,
  with raw UTC/value and series identity; never export projected points or
  invent missing observations. Downloads use the clicked document so adopted
  popouts retain native download custody. Remove only the current-time rule;
  reset/crosshair/end/future markers remain. See [export contract and proof](docs/rust-engine/usage-history-export.md).
  [decided: user 2026-10-13; verified: `usagehistory.tsx`, `usagehistoryexport.ts`, 2026-10-13]

- Muse Wonder Full uses shared tier blue `#80b8ff`, replacing dusty rose;
  light/solarized icons and hire buttons keep blue on a dark backing. Preserve
  the Muse provider cyan and other tiers. See [Muse colours](docs/rust-engine/muse-code.md).
  [decided: user 2026-10-13 17:52UTC; verified: renderer `styles.css`, 2026-10-13]

- Tool writing is an observed per-call stream phase, separate from execution.
  Claude-compatible tool block start/stop clocks persist as `writing_secs` in
  the admitted chip; unobserved/history clocks remain unavailable. Active
  snapshots use tool IDs and retire with committed rows. Shared live chips use
  pencil/right-arrow status icons, immediate icon-only clocks, and bounded ephemeral
  streamed-input previews; finished dots remain, counts only expand. Full time
  wording stays in aria/tooltips; unsupported observations are never invented.
  Ticket references use Open details / Owner… / separator / three copy actions;
  Owner uses the canonical agent menu, click/Enter focuses, hover/Right expands.
  Ticket/watchdog link menus share direct-object
  action builders and the current-org per-window registry. Updated per user
  2026-10-14 10:29–10:46UTC, relayed by coordinator-opus. See
  [timing, menu contract and verification status](docs/rust-engine/tool-writing-and-link-menus.md).
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

- Provider/category/collection labels use **Language servers**, including tier
  families, navigation and theme names. Wording about one server stays singular;
  protocol/API/storage IDs remain `langserver`. The engine's
  `catalog::provider_label` names one agent's provider in messages, so it stays
  "Language Server"; the switched-off refusal comes from `catalog::turned_off`
  ("Language servers are turned off…"). See the terminology audit in
  [compact Providers](docs/rust-engine/provider-compact.md).
  [decided: user 2026-10-12 21:22Z; verified from source: renderer labels and
  `providers/{catalog,mod}.rs`, `domain/ops.rs`, 2026-10-13]

- Providers presentation keeps provider enablement in each header and account
  (OpenRouter key and language server) activation beside identity, inside the
  row's panel, with short visible labels ("Active") and full accessible names
  (`<server> active`). New provider, key or server rows follow the same pattern.
  Scope density CSS to the Providers tab; retain usage/reset/error/inactive states,
  account/key distinctions and separate add/configure dialogs. See
  [compact presentation and proof limits](docs/rust-engine/provider-compact.md).
  [decided: user 2026-10-12 20:22Z, 2026-10-14 11:42Z (language server switch);
  verified from source: `canvas/accounts.tsx`, `canvas/accountsregistry.tsx`,
  `canvas/langserver.tsx`, 2026-10-12; `canvas/openrouterkeys.tsx`, 2026-10-13]

- Native popout Close dismisses `PinFrame` through its existing close callback;
  explicit Pop in returns the same mounted content. Persistent desk Close keeps
  content but never activates a missing main-window destination or creates a
  recovery box for it. Main exit, hosted-parent recovery, temporary borrowing
  and failure recovery keep their restoration paths. See
  [Close versus Pop in](docs/rust-engine/popout-close.md).
  [decided: user 2026-10-13 08:22Z, coordinator caller ruling 08:26Z;
  verified from source: renderer `popout.tsx`, `canvas/modalpin.tsx`,
  `canvas/deskhosts.tsx`, 2026-10-13]

- Language servers setup is documented in [README](README.md#language-servers).
  Presence comes from explicitly saved servers and offered models; harness
  choices detect installed Claude Code/Codex CLIs. Keep app/server enablement,
  org access and model offerings distinct, and match the server's real context
  window. [Muse integration notes](docs/rust-engine/muse-code.md) document the integrated lane:
  detection, terminal sign-in/Refresh, managed accounts, each login's model/effort
  catalog and contributor-off behavior. Keep published availability and historical
  real-model evidence distinct from later fixture-based acceptance and remaining
  real-account/platform gaps. This replaces the conditional documentation hold.
  [verified from source: `langserver.rs`, `providers/mod.rs`, renderer
  `canvas/langserver.tsx`, `orgaccounts.tsx`, 2026-10-12;
  decided: user via coordinator 2026-10-12 22:03Z;
  verified: 2026-10-13 `providers/muse_models.rs`, `canvas/accountsregistry.tsx`,
  `main/providerlogin.ts`, `docs/rust-engine/muse-code.md`]

- Recommend each developer installs Orgtree and Hubchat, both connected to a shared standalone mailhub on a company-accessible private server. The built-in Orgtree mailhub is for individuals and small teams. This is deployment guidance, not a size cutoff, migration or runtime default change. Keep person and organization identities separate; human hub mail uses Hubchat. See [team setup](docs/team-setup.md). [decided: user 2026-10-12 10:11–10:13Z]

- Human hub mail is composed in Hubchat. The Orgtree org-inbox window is a viewer: no compose/reply/upload controls or dedicated send/staging HTTP routes. Retired staging file bodies stay omitted before authentication/404; legacy cleanup notices describe the upload failure and point to Hubchat, without asserting message admission. Keep agent mail, retained history/quotes/files, transfer custody and partial-upload cleanup. See [viewer contract](docs/rust-engine/org-inbox-viewer.md). [decided: user 2026-10-12 08:41Z; verified: 2026-10-12 `canvas/mail.tsx`, `http/orginbox.rs`, `http/mod.rs`, `net/failures.rs`]

- Org inbox isolation is an org-local, default-on boundary: `org_inbox_enabled=false` rejects new external sends before queue admission or hub contact, including local `@org:` delivery, and hides retained inbox/copies until re-enabled. Desk counts/pages, state-inspection pending counts and new quote lookups filter hidden copies; file access gates the canonical inbox path owner even through another org route. Internal agent/user mail stays usable. Publication locks org IDs in ascending order; per-org I/O cancellation never unregisters an identity or recalls remote acceptance. See [isolation boundaries and proof limits](docs/rust-engine/org-inbox-isolation.md). [decided: user 2026-10-12; verified: `domain/orginbox.rs`, `net/isolation.rs`, `http/settings.rs`]

This is the one file every agent working in this repository reads first. It collects the
design facts, user rulings, architecture and working practices that are otherwise spread
across `docs/`, past agents' notes, tickets and conversations, and it links to the detailed
docs instead of copying them. Codex reads `AGENTS.md`, and Claude Code reads it when the
repository has no `CLAUDE.md`, so **do not add a root `CLAUDE.md`**. [decided: user
2026-10-05]

> **Since 2026-10-06 the app runs Orgtree 4.0.0, a Rust engine, built on the local branch
> `rust-engine`.** Read [Orgtree 4.0.0: read this first](#orgtree-400-rust-engine-read-this-first)
> below. Everything after it describes the 3.x Python engine and its procedures: it is
> **legacy**, kept for reference and for the 3.x line, and does not apply to 4.0.0 work unless
> the 4.0.0 section points to it. [decided: user 2026-10-06 18:53Z: the 3.2.0 Python track is
> stopped]

## Orgtree 4.0.0 (Rust engine): read this first
- New-org presets with no offered slot (including fallbacks) are dimmed and
  collapsed after the first sign-in check, but remain selectable. Selection
  opens model choices and warns; edits follow the current plan, partial layouts
  retain per-slot blocking. Invalid files remain disabled, checking/unknown
  stays normal, and template filename order is preserved. See
  [preset availability](docs/rust-engine/preset-availability.md).
  [decided: user 2026-10-14 17:56:42Z; verified from source: `domain/templates.rs`,
  `http/templates.rs`, `shell/templatepicker.tsx`; batch checks pending]

- Quick chat's superior picker puts its selectable `top level` eye row
  inside the Agents List after the filter, with every agent one depth deeper.
  A filtered agent keeps its ancestor chain and a ghost root; keyboard choices
  skip ghosts and empty results cannot select a hidden root. Other Agents Lists
  keep their depths. See [superior picker root](docs/rust-engine/superior-picker-root.md).
  [decided: user 2026-10-14 10:54:49Z; verified from source: `QuickChatBox.tsx`,
  `canvas/agenttray.tsx`; batch verification pending]

- `orgtree_message`/`orgtree_send_notice` take `{metadata, body}`. Metadata
  holds every former argument, is listed first and is described as written
  first. The handler (`mailtools::flat_args`) reads it in any order and still
  takes the flat shape. Keep metadata first: the API sends each top-level
  argument whole, so `runtime::actor` sees it early and `net::typing` sends
  the hub a typing heartbeat every 500 ms (no start, no stop on the wire;
  user 2026-10-13 22:34Z) after the send's own read-only checks
  (`orginbox::may_send_extern`, never `ensure_holders`). They stop when the
  call's block ends, its tool returns, the turn or process ends, or the cap
  (120 s); Hubchat drops the row a second after the last. Never send
  content, never set the fine-grained streaming switch. The probe shares
  `on_stream_event`'s `content_block_start`/`content_block_stop` arms with
  the tool-writing clock: one arm per event type (a second is unreachable,
  and its code silently never runs). Antigravity seats
  keep the flat cards (`defs::MailShape::Flat` through `bridge::serve` /
  `serve_observed`; byte-identical to before, so their prefix is unchanged) until a no-spend
  check passes on that CLI; every other agent's tool prefix changed: one cold
  turn after the update. Measured 116/116 metadata first (bound <2.6%, not
  zero); Claude Code, Codex, Muse and opencode pass the nested shape. See
  [agent typing](docs/rust-engine/agent-typing.md).
  [decided: user 2026-10-13 20:01-20:05Z and 22:34Z, coordinator
  20:23Z/20:27Z/21:36Z; verified: `tools/defs.rs`, `tools/mailtools.rs`, `net/typing.rs`,
  `runtime/actor.rs`, `bridge.rs`, 2026-10-14]

- Provider model-chip panels align with their key/server cards at both edges.
  A sibling full-panel native button opens the same browser as +; chips remain
  independent controls above it. Keep empty-space and Enter/Space browsing, chip
  toggling, and keyboard focus distinct. [decided: user 2026-10-13 19:13UTC;
  verified: `canvas/modelbrowser.tsx`, `styles.css` `.orr-toggles`]

- Generated prompt text never names a tool the agent's Orgtree tool groups switch
  off (since `aa2d7db`). Text inside one group's branch of `identity.rs` that names
  another group's tool also needs that group on: `2f8ebae`'s team sentence named the
  inspection tool `orgtree_state_inspect` until 2026-10-13. Charters, org.md and
  folder notes stay verbatim. `group_tests::prompt_follows_every_combination_of_group_switches`
  covers all 128 combinations, so a failure there is a prompt bug. Tool descriptions
  (`tools/defs.rs`) are not group-scoped. [verified: `runtime/identity.rs`,
  `domain/tool_groups.rs`, 2026-10-13]

- OpenCode is an optional OpenRouter/language-server harness over the reusable
  ACP1 transport. Discovery must negotiate an installed OpenCode 2.x entrypoint;
  the per-seat OpenRouter pin still wins. Default/acceptEdits deny Code Mode
  execute; bypass permits nested calls and fetch. Direct file approvals check
  folder grants, shell follows the bash switch, and neither claims an OS sandbox.
  Config-injected MCP is direct (`codemode:false`); the first prompt observes
  bridge initialize/tools-list plus a measured 250 ms catalog settle, or continues
  after five seconds with an explicit unobserved-tools note. Queue mid-turn mail
  for the next turn; never label it injected. Custom-provider cost/cache lifetime
  remain unknown. Credentials stay in isolated launch environment/config and
  launch directories are removed at teardown. See [ACP contract and evidence
  limits](docs/rust-engine/opencode-acp.md). [decided: user/coordinator 2026-10-13;
  verified from source: `runtime/{acp,acp_scope,opencode}.rs`, `bridge.rs`]
- Far overview (`z < Z_MINI`) hides watchdog satellites/wires, presentation
  side chips, the switchboard's infinite credit bar, and hidden-retired list
  tokens when Hide Retired is on. The org-inbox mailbox becomes one globe
  (`PublicIcon`), matching its normal tile and modal header; preserve far sizing
  and accessibility text. [decided: user 2026-10-14 18:41UTC]
  agent left-edge accents use tier colour with provider fallback. Zooming in
  restores retained content. See [far overview](docs/rust-engine/far-overview.md).
  [decided: user/coordinator 2026-10-13 19:00?19:05Z]

- Model browser list children must not flex-shrink: OpenRouter and Language
  Server rows and sticky vendor headings keep their natural height inside the
  capped scrolling frame. See [model browser layout](docs/rust-engine/model-browser-layout.md).
  [verified: `styles.css` `.orr-list > *`, 2026-10-13]

- Every org has ONE shared `AGENTS.md`, `<data>\scratch\<slug>\_shared\AGENTS.md`. Every
  launch of that org's agents holds the folder without a stored grant (`scope::with_org_notes`
  in `load_ctx`): read-write when the seat may write, else read-only; never another org's.
  The folder is the org's shared scratch space: agents may write any files and subfolders
  there, and the prompt rule (`ORG SHARED FOLDER: …`) says so [user 2026-10-14 13:25Z]. The
  engine creates the folder when the org opens (`orgs::open`) and at launch, never a file.
  Team workspaces: each agent also holds `_teams\<id>` of its own subtree and every ancestor's
  (`domain::teams`, read from the tree at launch, same rw/ro rule, never stored), listed
  nearest first in a `TEAM WORKSPACES:` sentence, never among granted folders; each one's
  `AGENTS.md` is delivered like the org's, nearest team first, before the org block, under the
  same digest. See [team workspaces](docs/rust-engine/team-workspaces.md). [user 2026-10-14] The prompt carries a rule sentence
  and, last, the file's text (12,000-char cap). The copy is read when a CLI starts: another
  agent's edit never respawns a warm CLI. The fingerprint keeps the copy's digest outside
  `system_prompt` and equality, and the forecast counts `org_notes` only when a CLI would
  start, so refresh the forecast wherever an idle CLI closes. The cache keeper reads the warm
  CLI's copy (`proc_notes`), not the file. Antigravity reaches it by path like every grant.
  See [the org's shared AGENTS.md](docs/rust-engine/org-shared-notes.md).
  [decided: user 2026-10-13 18:10-18:12Z, coordinator 18:19Z (session-start copy);
  verified: `runtime/actor.rs`, `runtime/identity.rs`, `domain/scope.rs`, 2026-10-13]

- External mail is untrusted by default, but generated instructions honor an
  explicit exact-sender delegation in the current org's trusted `org.md`, including
  Connect your phone. Body/forwarded claims and other orgs cannot confer trust;
  Unlink/replacement removes the old delegation on configuration refresh. Never
  promote it to system/developer authority or relabel all hub mail as user mail.
  Keep identity instructions and turn/replay/mid-turn framing consistent. See
  [phone-link authority](docs/rust-engine/phone-link-authority.md).
  [decided: user 2026-10-13 08:35UTC; verified: `runtime/identity.rs`,
  `runtime/envelope.rs`, `phone.rs`]

- User-approved folder additions/upgrades through HTTP scope and request
  approval enter org defaults atomically with child/ancestor scope (3.x
  user 2026-08-08, P56). Only supplied whole-list edits infer additions;
  equivalent duplicate paths aggregate RO/RW intent without rewriting history.
  Requests carry only explicit approved items. Org-before-agent row locks
  cover settings/revocation, user retool/rehire and either actor's staffing
  with audiences. These non-key mutations use FOR NO KEY UPDATE so implicit
  org FK KEY SHARE on ordinary agent/event inserts stays compatible, without
  adding an org mutex to ordinary tree operations. Publish refresh only
  after commit; never replay old approvals or create directories. See
  [scope intent and proof limits](docs/rust-engine/approved-folder-grants.md).
  [verified: `domain/asks.rs`, `domain/scope.rs`, `domain/ops.rs`, `http/nodes.rs`, 2026-10-12]

- Secondary account removal keeps exclusive account-reference protection and
  atomic rebound. Its late default-org lock is NOWAIT: on contention, confirm
  whole-transaction rollback before the existing bounded retry/backoff, so an
  org-first folder/settings writer cannot become a deadlock victim of that
  late lock. Never skip locked defaults or publish provisional effects.
  [verified: `domain/account_removal.rs`, 2026-10-12; proof/limits in
  `docs/rust-engine/approved-folder-grants.md`]

- `orgtree_message` with kind `question` to `@net:` addresses may carry
  `options` (2-10 one-line answers of at most 100 characters, all different;
  user 2026-10-12 21:12Z) and `multiple`: Hubchat question cards. The body
  gets a numbered `Pick one:` / `Pick one or more:` list every client reads,
  and the hub payload turns a question body ending in that list into `meta`
  (`question` plus a suffix `fallback` range) only when the list passes
  `net_cards::options` as written; a hub without the `meta` feature drops it.
  Answers return as ordinary mail with `> ` and `Answer: ` / `Skipped` lines;
  Orgtree does not track whether a card is settled, and nothing relays
  `orgtree_ask`. See [Hubchat question cards](docs/rust-engine/hubchat-question-cards.md).
  [decided: user 2026-10-11 22:42-22:44Z, 2026-10-12 21:12Z; verified:
  `net_cards.rs`, `net.rs` outgoing_payload, `tools/mailtools.rs`,
  `tools/defs.rs`, 2026-10-13]

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
  `byOpenrouterPriceDesc`); the OpenRouter model browser and language-server lists keep their own
  order. User-visible text says "most expensive first" / "cheapest first", never "dearest"
  (the OpenRouter picker's price-sort toggle; "dearest" read as odd wording, user
  2026-10-14). [decided: user 2026-10-13 19:14-19:15Z, 2026-10-14 10:57Z, 2026-10-16;
  coordinator clarified family order 2026-10-16; verified: `catalog.rs`, `openrouter.rs`,
  `shared.ts` and their tests, `pricesortlabel.test.tsx`]

- Hire tokens sort cheapest seat first WITHIN each provider row/column, with
  stable equal-price order and the existing inward family-count ordering.
  `SpawnChips` uses each token's current catalog-backed seat lookup; hidden
  tiers stay hidden. Quick chat and expanded/far strips use the same component.
  Model selectors, hire-sheet dropdowns and defaults keep the October13 order.
  See [hire-token price order](docs/rust-engine/hire-token-price.md).
  [decided: user 2026-10-14 10:43UTC; verified: `canvas/cards.tsx`, `QuickChatBox.tsx`]

- Organization profile pictures use a dedicated bounded `ot.meta` record,
  not the net/tree payload. Human settings edits carry the numeric org owner;
  incoming hub merges preserve logical revisions and removal tombstones.
  Optional publication uses the org-inbox isolation gate and enabled memberships.
  Image HTTP bodies are omitted before authentication and decoder slots stay
  with blocking tasks after cancellation. See the isolated proofs and remaining
  acceptance limits in [the contract](docs/rust-engine/profile-pictures.md).
  [decided: user 2026-10-12; verified from source: `profile_pictures/`,
  `http/pictures.rs`, `net/pictures.rs`; focused proof limits documented, 2026-10-12]

- Continue-on resolves `primary`, `default` and matching native
  `<provider>/primary` (Claude/OpenAI/Google) in the shared runtime, storing NULL.
  Revalidate org/auth/activation/tier usage and ambient marks; no probe or mark
  clearing. Binding, freeze/pending release, audit and replay mail commit together.
  Native and explicit ambient-home cache aliases all constrain eligibility;
  Latest genuine auth observation wins across physical native aliases; transient
  failures/cooldown never refresh auth or last-good bars. Automatic fallback
  skips candidates failing shared eligibility, retaining order/switches/proven room.
  Explicit registry targets and automatic fallback retain their policies. See
  [primary continuation](docs/rust-engine/continue-primary.md).
  [verified: `runtime/freeze.rs`, `runtime/freeze/continuation.rs`, `usage.rs`, 2026-10-12]

- Agent `orgtree_reorder` accepts a live strict descendant and zero-based
  final live sibling `index`; `orgtree_hire`/staff's new-hire form require
  explicit `index` (0..existing live count). Superior insertion excludes its
  anchor from that count. Inspection exposes live sibling indices and child
  counts. Hire/reorder position decisions are serializable with bounded retry;
  exhausted midpoint gaps normalize only that live sibling set atomically.
  Promote/Demote aliases share Move's canonical dispatch and isolation policy;
  raw request/retry labels and existing move audit meaning are retained.
  [decided: user 2026-10-11 23:15Z; verified from source: `domain/ops.rs`,
  `domain/ops/ordering.rs`, `tools/defs.rs`, 2026-10-12;
  scope/proof: `docs/rust-engine/agent-ordering.md`]

- Canvas sibling drags and their Undo preview before the reorder endpoint answers.
  Preview Rust's live-sibling midpoint ordering through the shared chart/list tree;
  clear only the matching operation on refusal or after success plus an agreeing
  tree (five-second success fallback). An old response/read/timer cannot cancel a
  newer pending drag. [verified: renderer `canvas/pendingorder.ts`,
  `canvas/OrgCanvas.tsx`, 2026-10-11; proof: `docs/rust-engine/move-preview.md`]

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
  `RECORDED_OPS`. See [undo history](docs/rust-engine/undo-history.md).
  [decided: user 2026-10-14 18:27Z, coordinator 18:34Z; verified: `domain/undo.rs`]

- **Several OpenRouter keys at once, every key alike.** Each key is its own hidden registry
  row (provider `openrouter`, kind `apikey`, secret in `ot.account_secrets`), id
  `openrouter-N` (N from 1, never reused); a key's lane is its id. **No key is special**
  (user 2026-10-14 18:00Z): never special-case a key's id, never add an "original" or
  "primary" key. Migration 0022 renumbered the old first key (`openrouter-key`, lane
  `openrouter`) to `openrouter-1` with every reference, and bound its unbound seats. The one
  symmetric default: a seat with no OpenRouter key bound bills the first key in the key
  list (`openrouter::first_key`: `ord`, then N); a hire naming none is placed by
  `best_allowed` and bound. Use `openrouter::seat_key`/`keys` and
  `org_accounts::lane_of`/`seat_lane`. See [keys](docs/rust-engine/openrouter-keys.md).
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
    not installed is refused (key, hire pin, language server); a saved one since
    uninstalled refuses its launch saying so and is never substituted. "Installed" is
    the discovered file still present, else a launch's lookup: nothing is spawned.
    The staffing offers (templates, Quick chat, hire menus) leave out OpenRouter keys
    and language-server models whose harness is not installed. Every UI harness picker
    lists ALL supported harnesses: installed first, a separator, the rest greyed out
    and disabled (`HarnessOptions`, `canvas/harnesses.tsx`; user 2026-10-13 22:20Z).

  [decided: user 2026-10-11 22:35Z and 22:50Z, coordinator on ids/lanes; user
  2026-10-13 19:04Z (per key), 19:08Z (pin wins), 19:15Z (installed only, every
  selector); verified: `src/openrouter.rs`, `src/harnesses.rs`, `src/runtime/actor.rs`,
  `src/org_accounts.rs`, `src/usage.rs`; detail: `docs/rust-engine/openrouter-keys.md`]

- Desk pending mail folds at six rendered rows per run, after event deduplication.
  Keep current-turn input above its response and later mail below; optimistic and
  failed sends stay outside. Disclosure is local and retains mounted cards; reveal
  a pending reply target before scrolling. Mailbox/Attention grouping is unchanged.
  [decided: user 2026-10-11 22:33Z; verified: renderer `canvas/pendingrun.tsx`,
  `canvas/desk.tsx`; scope and proof: `docs/rust-engine/pending-mail-collapse.md`]

- Agent Open > Open scratch folder is a native directory-only action. Resolve
  stored/imported/renamed paths through authenticated agent identity; never
  reconstruct a path in the renderer or open a file. Missing folders report an
  error without creation. Open team scratch folder uses that agent's numeric
  own-led team id, even for a leaf. Switchboard and Org settings > Basic open
  the same org shared scratch folder. These new managed targets create on
  demand inside org scratch, refusing link/reparse/file components. Reuse the
  same IPC/engine route; scoped capability and response markers prevent older
  shells/engines silently opening personal scratch instead.
  Synthetic checks cover managed/personal paths and all three UI entries;
  the final OS opener is injected, so real file-manager launch remains untested.
  [decided: user 2026-10-16 10:16Z; verified: `http/nodes.rs`, `domain/teams.rs`,
  `main/scratch-folder.ts`; details: `docs/rust-engine/scratch-folder.md`]

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
  proof limits: [usage-query-proposal.md](docs/rust-engine/usage-query-proposal.md).
  [decided: user/lead-astra 2026-10-11 22:35Z; verified: usage.rs, tools/usage.rs]

  OpenRouter query IDs are its canonical lanes (`openrouter` for the original,
  added key IDs for the others). Public readers reserve each lane; a permitted
  manual refresh calls the private reader under its existing permit, avoiding
  self-contention. Floors and caches remain per lane. Raw canned key-check
  documents in `rig.rs` are also unlogged, while safe refresh diagnostics remain.
  [verified: `usage.rs`, `tools/usage.rs`, `rig.rs`, 2026-10-13]

- The local 4.3 alpha bundles hub **2.2.0-alpha.0** at `959ed37` (2026-10-14:
  `1dcd3c7` plus in-memory typing heartbeats, `/api/typing`), retaining
  released 2.1.1 recovery plus approved pictures and question metadata. This
  supersedes the prior `2c22e3d` pin; it is not a published hub release.
  Packaging must verify the exact pin and rebuilt payload. Existing schema 10
  blocks downgrade to 2.1.x without a pre-migration backup; no automatic backup
  is added. See [local hub adoption](docs/rust-engine/mailhub-220-alpha-pin.md).
  [verified: canonical merge, unchanged runtime blobs and package pin guard,
  2026-10-13; decided: coordinator, existing local-alpha scope]

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
  Copy audit and lightweight verification: [agent-settings-copy.md](docs/rust-engine/agent-settings-copy.md).
  [decided: user 2026-10-11 17:35–17:39Z and 19:46Z; verified: renderer `canvas/modals.tsx`]

- Hiring a superior above self, including at the root, preserves the caller's
  external seat-plus-grant allocation: the new seat and requested free grant
  come only from the caller's existing free credits. Root self-insertion is
  allowed; insertion above another root remains user-only. The new parent inherits
  the caller's **effective** scope, never broader configured defaults. Validate
  composite actions before promotion and commit both atomically; publish no
  intermediate topology or effects. Its explicit index is chosen in the final
  sibling set excluding the caller, and survives temporary-report promotion;
  returned placement describes that final set. Self-parent fallback inherits
  the caller's effective preference (org default when unset); explicit true
  is clamped to it, explicit false remains allowed. Hire/staff kickoff metadata
  reports the final parent grant after promotion in the same transaction.
  [verified from source: `domain/ops.rs`, 2026-10-14]
  The new parent's ordinary superior powers over its caller (org-allowed
  account/model/effort changes, rename, halt, retire) are inherent; its account
  is not pinned to the caller's. The transferred root grant C+G-P can exceed
  the user-hire top-level cap when C>P; stake C+G stays conserved and no cap
  check is added to promotion. [decided: coordinator 2026-10-14,
  parent-hire docket review rulings B/C]
  See [parent-hire accounting and authority](docs/rust-engine/parent-hire.md).
  [verified: isolated parent-hire rig 29/29 and neighboring credits20/scope12/
  ordering64/alias7, rig-opus batch 2026-10-13; A/D fix checks pending]

- Native tray refresh must resynchronize the **Run on boot** checkbox (it was
  "Run on startup"; "Run on sign-in" where Orgtree cannot start at boot) from
  committed preferences even while its menu is open, and when that menu is
  shown again. Do not replace an open native Menu object: update the existing
  item in place. A UAC write can finish after a refresh constructed a menu from
  the old value; refreshing only updater/engine/mailhub rows leaves startup's
  checkmark stale despite a successful save. Keep rejection restoration and
  UAC/task-write semantics intact. See [startup toggle acceptance and tray
  regression](docs/rust-engine/startup-toggle-acceptance.md).
  [verified from source-composition regression and live saved-state differential,
  2026-10-11; packaged native repaint remains a next-alpha verification limit]
- **Run on boot** changes one at a time (`changeRunOnStartup`, tray and
  Settings alike). The checkmark is the SAVED value. It changes only once the
  change has finished: about 2 s in a non-elevated stand-in, never measured
  after a real Yes. Until then the tray item is disabled and reads "Run on
  boot (changing…)". The pending flag is
  set before anything asynchronous and cleared only in that change's `finally`.
  A second request is refused without touching it. Never show the new value
  early, and never force an open menu closed: a menu open when a change begins
  or ends is rebuilt after it closes.
  [decided: lead-astra 2026-10-11 20:00Z; verified: tests/startup-tray.test.mjs
  on the real closures; native menu view unverified (agents run in Session 0)]
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
    at its first turn until 15 s after the engine's start for the helper;
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
- **Ending an engine's task does not stop a boot engine.** Since the
  core-lifecycle recovery (2026-10-12) an engine outlives its host, and a task
  End ends only the host. A manual End on the boot task therefore still leaves
  the engine running. An installer that cannot ask through the descriptor first
  writes `StopRequested` (REG_QWORD, Unix ms) into its HKLM record. A boot-mode
  engine polls that value every 2 s and stops gracefully on a request newer
  than its own start; a stale value never stops it and is never deleted. Only a
  rig run may read the request from HKCU (`ORGTREE_RIG_STOP_KEY`, under
  `crate::rig::active`). Never stop the engine by killing its host.
  [decided: coordinator 2026-10-15 11:54Z; verified: `src/install_stop.rs`,
  `tools/boot-engine-task.ps1`; proof `tools/rig/proofs/boot-host-stop.mjs` B/C; decision 80]
- **Nothing on an engine's startup path may depend on `powershell.exe`.** A
  desktop-managed engine inherits its desktop's environment, and a desktop
  started from PowerShell 7 hands on a `PSModulePath` that lists PowerShell 7's
  modules first. Windows PowerShell 5.1 then cannot load the modules PowerShell
  7 also ships (`Get-Acl`: "found in the module 'Microsoft.PowerShell.Security',
  but the module could not be loaded"). The attach descriptor's DACL read-back
  ran `Get-Acl` that way, so in the v4.3.0 release smoke no managed engine
  started ("cannot publish managed engine attachment"); it now reads the ACL
  with `GetNamedSecurityInfoW` (`host::win::verify_restricted`). Use Win32 calls
  for such checks. A Windows PowerShell child that cannot avoid such a module
  gets `windowsPowerShellEnv()` and `WINDOWS_POWERSHELL` (`apps/desktop/main/policy.ts`),
  as the desktop's own `verifyDescriptorTrust` does for its `Get-Acl`.
  [verified 2026-10-15: CI runs 38786926928 and 38794172790, `src/host.rs` tests,
  `tests/attach.test.mjs`; details `docs/rust-engine/core-recovery.md`]


- Antigravity Claude 5.5 uses separate `agy-sonnet` / `agy-opus` tiers (seats
  2 / 4), enabled together in Runtime settings and off by default. They have
  no versions, keep Antigravity provider/account/theme, and share only the
  native Claude model colours. Their quota is `3p-5h` plus `3p-weekly`, separate
  from Gemini; token prices and context capacity are unknown. See
  [`antigravity-claude.md`](docs/rust-engine/antigravity-claude.md) for the
  measured CLI contract, gates and verification limits. [user 2026-10-07;
  verified from agy 1.3.1 model/zero-token usage output and source smokes]

- Desk document metadata is newest presentation/update first (`at DESC, id
  DESC`), including replacements of old documents; the desk takes its first
  four entries. Keep the separate total count unchanged. [verified-from-source
  and disposable PostgreSQL smoke: 2026-10-07; feed/compute.rs, canvas/desk.tsx]

- Size and rect state fed by observers is set as a VALUE, and layout effects
  schedule only a changed value. A lower-priority updater (`set(prev => …)`)
  is re-run from its stale base on every higher-priority render and returns a
  new object each time; the zoom HUD's layout effect keyed on that object
  re-ran until React's nested-update limit crashed the canvas (rig finding F1).
  [verified with `tools/rig/proofs/canvas-resize-crash.mjs`: 2026-10-07;
  `canvas/OrgCanvas.tsx`]

- App and Org settings checkboxes use `SetToggle`: checkbox left, label/hint,
  on/off state right. Its optional `labelContent` preserves decorative text
  with a plain accessible name; `action` keeps independent right-side controls
  outside checkbox labels (e.g. Open logs folder). Turn-limit switches mean
  enabled; off still persists zero seconds. [user 2026-10-07 17:41–17:42Z;
  typecheck and isolated Appearance/Debug/turn-limit renderer smoke]

- Bare mail recipients preserve 3.x precedence: internal agent, exact local
  org slug, then a unique hub full slug or first name segment. Ambiguity names
  candidates; resolution never bypasses org-inbox authority. Discovery includes
  the current org (`you`) and `transports`, with hub peers in `orgs` and the
  retained 4.0 `remote` alias. [verified-from-source: 2026-10-07; F03;
  `docs/rust-engine/bare-mail-routing.md`]
- `orgtree_read_transcript` returns structured node/access, busy, occupancy and
  estimated-occupancy fields plus message role/text/full stored tools. Cap only
  text at 1,200 Unicode characters; default `last` is 30, bounded to 1–80.
  Preserve the self/downward gate and do not start an actor to read metadata.
  [verified-from-source: 2026-10-07; 3.x `api.py`, Rust `tools/orgview.rs`;
  `docs/rust-engine/read-transcript-parity.md`]
- Desktop notifications retain the complete pending inventory (keyset batches,
  no document age-out), classify typed terminal failures separately from routine
  mail, and use a persisted attention epoch rather than dismissal `set_rev`.
  Deferred work/ask triggers reconcile effective attention at commit; imports
  preserve epochs. [verified-from-source and disposable PostgreSQL/Rust smoke:
  2026-10-07; `docs/rust-engine/desktop-notifications.md`]

- Transcript and mail content must remove actual U+0000 before PostgreSQL
  text/jsonb writes. Use `util::pg_text` / `pg_json` (borrow clean input), or
  `pg_json_mut` for owned JSON; `convo::take_tool_inputs` sanitizes before splitting
  full inputs from desk rows. Preserve other Unicode and binary image bytes.
  Batch transcript failures log and continue per row; history uses savepoints.
  [verified-from-source: 2026-10-07; `docs/rust-engine/transcript-nul.md`]

- No credential banners, annotations, tray/menu warnings or success notices.
  Engine diagnostic fields and log lines remain; agents explain tool failures
  to the user. [recorded-decision: user 2026-10-07 16:12Z, superseding the
  15:49Z banner rule; verified-from-source: renderer shell and desktop tray]

- Agent settings has a horizontal grant bar (`canvas/creditgrant.tsx`). Grants
  exclude the fixed own seat; the floor is grant minus free (reports' seats and
  grants). User cascade headroom propagates root-to-parent with whole-credit
  ancestor raises, matching `ops::ensure_room`. Release uses the existing
  `reallocate` action; refusal restores the saved value. No scope save or process
  restart. [verified-from-source and mounted renderer smoke: 2026-10-07;
  user request 13:49Z, DECISIONS 52]

- Agent settings shares the canvas credit paint and stats in `creditbarpaint.tsx`;
  the horizontal bar rotates that paint and expands its initial 2x grant range
  during right-edge drags. Identity/actions sit above the tabs, and setting
  controls use `settingskit` rows. Keep the UI-only restyle separate from drag
  behavior changes. [recorded-decision / verified-from-source: 2026-10-07;
  `docs/rust-engine/agent-settings-refresh.md`, DECISIONS 52 addition]

- Event watchdogs (`kind:event`) receive pushed, allow-listed post-commit events.
  Catalog: credentials.bridge.available/unavailable, credentials.isolated/ready,
  engine.started; agent lifecycle/settings/changed, turn started/finished/failed/
  stalled/limited, mail waiting/delivered/changed, docket created/status/attention/
  question answered, account sign-in/out and limit reached/reset, hub up/down,
  credits.changed, documents created/updated, audience requested/granted/denied/
  revoked, CLI started/ready/cold/evicted, agents.active/live. Use exact dotted
  names or `prefix.*`; regex sees safe payloads only after visibility checks.
  Counts use `threshold:"below N"` or `"at least N"` (crossings only), default
  visible strict descendants (never the watcher); org totals require full visibility.
  Alert-bearing turns suppress their own owner event dogs through settlement;
  own cli.* events are always excluded to prevent delayed eviction loops.
  All runner errors back off before re-arm; missing rows stop, and output/alert
  payloads strip NUL before PostgreSQL writes.
  Batch progress, coalesce overflow, retry storage failures with visible health,
  and refresh count baselines on resume/recovery. Recover subscriptions
  before engine.started; never forward raw feed bodies or alert mail back into
  the bus. [recorded-decision and verified-from-source: 2026-10-07;
  `docs/rust-engine/event-watchdogs.md` contains exact names and semantics]

- Periodic watchdog countdowns roll forward from the last persisted check and
  effective interval in the renderer, using one shared clock. Under one hour
  they show m:ss, then h/m below a day and d/h from a day; subscribers update
  only when their displayed value changes. Ordinary polls do not refresh the
  watchdog feed; a matching silence-mode poll does when it
  resets the real silence deadline. [verified: 2026-10-17;
  `engine/rs/orgtree-engine/src/runtime/watchdogs.rs`,
  `apps/desktop/renderer/src/canvas/watchdogcountdown.tsx`]

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

- Windows Codex hosting has a separate leased host slot: the sign-in helper can
  host sandboxed seats while the desktop retains the credential bridge. Git uses
  native askpass after the existing helpers; unknown prompts and bridge misses
  retain original askpass precedence. Explicit credential.interactive=false/never
  disables bridge lookup. Production sandbox network policy is unchanged;
  network Git still requires escalation. [verified: 2026-10-11;
  `engine/rs/orgtree-engine/src/credential_bridge.rs`, `credential_bridge/askpass.rs`;
  details and measured limits: `docs/rust-engine/sandbox-git-credentials.md`]

- Windows core recovery preserves healthy peers: unexpected engine/desktop
  failure recovers only that component. Missing helpers, startup delay and
  exhausted retries do not request whole-app shutdown. Manual Quit persists a
  logon-scoped cancellation barrier before graceful drain; automatic startup
  cannot clear it. Native PID+creation stamps distinguish death from Unknown.
  This supersedes the October11 coupled-stop policy. [decided: user
  2026-10-12 09:14Z; verified: `core_state.rs`, `core_recovery.rs`,
  `apps/desktop/main/core-lifecycle.ts`; details `docs/rust-engine/core-recovery.md`]
- A refused launch says why: `core-control begin` prints one fixed-shape JSON
  refusal (each member not proven gone: role, alive/unknown, and for unknown the
  probe stage and Windows error; or which release failed), and the desktop
  records failed lifecycle commands as `core-control-failed` in its exit log,
  never raw stderr, a repeat at most once a minute. Diagnosis never changes a
  decision: Unknown stays Unknown. [verified: `core_state.rs` begin,
  `core_process.rs` diagnose, `core-lifecycle.ts`, 2026-10-13]
- Recovery attachment uses an empty local slot while retaining boot topology
  separately; failure restores task ownership, never a managed fallback. Manual
  Restart uses configured recovery only after stamped native death; healthy
  restart still authenticates its transition, and Quit cancels both paths.
  [verified: 2026-10-12 `engine.ts`, `core-lifecycle.ts`; regression
  `tests/core-recovery-review.test.mjs`]
- Anything running from the installation folder blocks an upgrade, including
  the desktop's core-recovery observer (`resources\engine\orgtree-engine.exe
  core-recovery watch`, started outside every job). A desktop closed for an
  install (installing transition) is not recovered: the observer stands down at
  once. The installer ends an older observer (4.3.0-alpha.0/alpha.1, which
  waited out 180 s and failed two real upgrades in Prepare's 150 s budget) only
  with this installation's engine image, that command line and its desktop
  verifiably gone; nothing else is killed. A boot-step timeout names what is
  still running (dialog: five; `%TEMP%\orgtree-installer-upgrade.log`: all).
  [decided: coordinator 2026-10-14; verified: `core_recovery.rs` stands_down,
  `tools/boot-engine-task.ps1`, `tools/installer-upgrade.ps1`; boundary test
  `tools/test-installer-recovery-observer.mjs`; details
  `docs/rust-engine/core-recovery.md`]

- Cold-turn admission and forecasts share the measured-context threshold gate.
  Compatible receipts carry an expiry verdict for the composer's shared clock;
  reset clears the old receipt before publishing. Idle reconfiguration replaces
  the CLI at once (busy waits for turn end), under existing warming guards; a
  local process replacement alone does not invalidate a provider receipt.
  [verified-from-source and isolated smoke: 2026-10-07;
  `docs/rust-engine/cold-turn-warning.md`]

- Windows boot credential detection is advisory: the boot task remains S4U.
  Session 0/batch-token warnings survive later interactive sign-in; a successful
  empty Credential Manager query does not prove old DPAPI secrets decrypt. No
  admission gate or restart is added. [verified-from-source and read-only probe:
  2026-10-07; `docs/rust-engine/boot-credential-warning.md`; user warn-only ruling
  12:33Z, credential bridge separately requested 12:40Z]

- Attached ask cards are grouped by request ID and ticket, never tab text.
  `asks::attached_tabs` preserves tab indices and filters exact ticket links;
  the docket reader repairs duplicate attachment lists from earlier builds.
  The full batch remains the answering form. Optimistic question counts use
  actual header request IDs, not revision keys. [verified from source and
  synthetic smoke: 2026-10-07; `docs/rust-engine/attached-ask-cards.md`]

- Cost labels show only `$X.XX`, including partial nonzero totals; unknown zero
  stays `$?`. Partial/estimated explanations stay in the existing hover titles.
  [recorded-decision: user 2026-10-07 09:49Z; verified-from-source:
  renderer `canvas/desk.tsx`, `shell/treeinfo.tsx`]

- Verbose UI-open timings use `opentiming.ts` and `/api/diagnostics/ui-open`.
  `frame_ms` means the first animation frame after ready content commits, not
  GPU presentation. Filter hidden/unfocused samples; off creates no timing
  work or diagnostic requests. Diagnostic POSTs bypass `req` mutation hooks;
  read the run's rotated `.log.*.gz` segments as well as its active log.
  [verified from source and packaged logs: 2026-10-07;
  `docs/rust-engine/docket-read-performance.md`]

- Agent unread mail is `pending` plus unacknowledged `delivering`, shared by
  tree badges, jump cards, desk tabs and mailbox folders. Counts are totals,
  never lengths of bounded display windows. Exact provider/hook receipts settle
  only their claimed batch; startup repair requires a same-agent, current-turn
  conversation receipt for each mail ID. Human/org inbox read state is separate.
  [verified from source and disposable-DB/renderer smoke: 2026-10-07;
  `docs/rust-engine/unread-mail.md`]

- Credit cascades plan before writing and stop at the acting agent's allocation.
  Moves transfer the existing subtree stake below the common ancestor; batches
  validate final net grants in one transaction. [user ruling and source verified:
  2026-10-07; docs/rust-engine/credit-cascade-boundary.md]

- Draft hire cancellation saves the camera intent (org fit or focused target)
  and exact manual pan/zoom, plus any mounted desk's keyboard/caret state.
  Restore after layout settles through the shared cancellation route; every
  draft entry uses the same snapshot and confirmation discards it. A saved
  target must still match its generation. [verified from source and isolated
  real-browser smoke: 2026-10-07; `docs/rust-engine/draft-cancel-focus.md`]

- Tool arguments live in `ot.convo.tool_inputs`, apart from the normal `body`
  projection. Tool chips carry only `input_seq`; expansion reads one agent/row/tool
  through the guarded API. Codex original call arguments come from its own rollout
  on demand and are retained separately; never expose unrelated transcript records.
  [verified from source: 2026-10-07; `docs/rust-engine/tool-inputs.md`]

- Docket UI lists use 100-row server pages with full counts and bounded named
  references; never fetch the whole archive to resolve links. Per-item docket
  `view` is exempt from logging by the user's 2026-10-07 ruling.
  [verified from source / recorded decision: 2026-10-07;
  `docs/rust-engine/docket-read-performance.md`]

- The Work docket and every agent/team docket tab share one `DocketControlBar`
  (`canvas/docket.tsx`): one wrapping row of 24px ghost controls (heading, search,
  Arrange, Sort, Show archived, Show backlogged); only the org docket folds the
  options behind its sliders button below a 760px container. The sort caption
  (`.docket-sort-why`) is the Sort select's tooltip and accessible description,
  visually hidden. Tests and probes pin the class names, ids (`#docket-group`,
  `#docket-sort`, `#docket-view-options`) and labels; keep them. [user 2026-10-13:
  "keep it minimal and small but streamlined and clean"; verified from source]
  Every docket view also shares one list/ticket split: the base `.mailer-list`
  width (36%, 140-340px); the desk and team tabs have no override. [user
  2026-10-13; coordinator ruling on team tab; verified from source]
- Passive notices repaint an event card's left edge (`.event-notice`, after the
  family rules). A variant that needs its own edge colour, like the two restart
  cards (red edge, neutral other sides), needs a rule after it that is at least as
  specific as `.msg.user.event-surface.event-notice`. [user 2026-10-13; verified
  from source, `tests/restartedge.test.tsx`]

- Escape cancels a desk's prepared reply exactly as its × (`DeskChat` root
  fieldset, bubbling). Anything that already took the Escape (`useEsc` stack,
  menus, the effort pop-out, which now claims it) goes first, as do an open
  `.lb-overlay`/`.picker-overlay` and IME composition; with no reply Escape is
  untouched. [user 2026-10-13; verified: `tests/escapereply.test.tsx`]

- Every keyboard shortcut is listed in `renderer/src/shortcuts.ts`, which App
  settings → Keyboard shortcuts renders read-only (user 2026-10-14: Settings only,
  no overlay or menu entry). `tests/shortcuts.test.tsx` scans `renderer/src` and
  `main` for key literals (`.key === 'X'`, `[...].includes(e.key)`, `accelerator:`)
  and fails both ways, so a new binding lands with its entry, or in `BUILTIN` with
  the reason it is not shown. [user 2026-10-14; verified: `tests/shortcuts.test.tsx`]

- Staffing effort choices describe launch-time model capabilities, not the
  `live_effort` flag for mid-turn controls, in each harness's own names (user
  2026-10-12 20:01Z): Claude/OpenRouter Claude Code's five `--effort` levels,
  Codex the model's `model/list` levels from background discovery (menu reads
  never spawn a CLI; `none`/`minimal` kept), Muse the catalog row's variants,
  Antigravity its tier-specific vocabulary. Argon offers low/medium/high
  (2026-10-16, replacing its low/high restriction after offline CLI evidence);
  the shared mapper drives both offers and next-turn `--effort` delivery, with
  conditional availability unchanged. See [Argon effort](docs/rust-engine/argon-effort.md).
  [verified: `providers/catalog.rs`, `providers/mod.rs`, `runtime/actor.rs`, `runtime/agy.rs`]
  `catalog::EFFORT_ORDER` (none..max)
  orders them all; a saved level a tier does not name launches as the highest
  it names at or below it, else its lowest, and the saved value is never
  rewritten (`launch_effort`; the effort bar shows the same clamp). Replaces
  "every tier offers Claude Code's five". [verified from source: 2026-10-07,
  2026-10-13; `docs/rust-engine/staffing-effort-parity.md`, `muse-code.md`]

- Agent card and Agents List menus share `canvas/agentmenu.tsx`. The hire-tier
  submenu uses `hireTierOffer` (also used by HireSheet) and opens the existing
  local draft form; only confirmation creates a seat. Halt/Unhalt shares
  `toggleAgentHalt` with the desk control, including the settling halt phase.
  Copy agent name flows directly into Focus, then Hire a subordinate.
  Open submenu follows Hire: desk, popout and pin destinations together,
  then a separator before inbox, docket, team docket and presentations.
  Destination availability keeps its existing gates.
  Switchboard tab names and desk headers reach this same builder through
  `agentnav`; they do not maintain a separate action list.
  The final separated group has clickable Cheap compact, Halt/Unhalt and
  Retire/Dissolve roots; live teams get subtree/all-subordinates submenus.
  All compaction entries use the yellow caution tint. Busy/sessionless heads
  cannot compact themselves but retain access to eligible descendants.
  Manager retirement includes its team in the engine, so its root says Dissolve.
  The switchboard header exposes the eye's general menu, including yellow
  Cheap-compact all agents and count-confirmed batch Halt/Unhalt all agents.
  This batch does not apply the broader STOP ALL organization/watchdog latch.
  Team halt actions confirm live target counts and use HTTP ops `nodes`, with
  all targets validated before the shared F05 parallel executor. Each set
  offers Unhalt only when all its live targets are halted; mixed sets offer Halt.
  Cheap compact confirms the existing `cheap_compact` operation and is
  disabled for non-live, busy or sessionless agents. [user 2026-10-07 17:16Z;
  verified from source and isolated renderer screenshots/smoke]

- The canvas Agents panel's **active** checkbox is in the shared PinFrame title
  bar beside pop-out and pin, not in the scrolling tray. It filters by the
  renderer's live-turn `busy` flag; the persisted preference also filters the
  Attention drawer. [user 2026-10-16; verified: `OrgCanvas.tsx`,
  `canvas/agenttray.tsx`, `canvas/modalpin.tsx`]

- Staffing composites use `ops::run_in_tx` and publish deferred `Effects` only
  after the caller commits. Busy model/account switches persist intents and
  apply at settlement; admission locks the agent row before claiming mail.
  Abandoned-owner recovery selects bounded policy rows, never an entire archive.
  [verified from source: 2026-10-07; `docs/rust-engine/parity-staffing.md`]

The plan is [`docs/rust-engine/PLAN.md`](docs/rust-engine/PLAN.md) (§10 lists every user-facing
difference from 3.x); the user's standing rulings are
[`docs/rust-engine/DECISIONS.md`](docs/rust-engine/DECISIONS.md), numbered, and they override the
plan and this file. Read both before you change anything. All entries below: 2026-10-06.

**What it is**
- One executable, `orgtree-engine.exe`, in the Cargo workspace `engine/rs/` (crates
  `orgtree-engine` and the `orgtree-logged` macro). It replaces the whole Python engine; the
  desktop and its UX contract stay. The Python engine stays in the tree untouched, so going back
  is "run the old build". [verified: `engine/rs/`; decided: user, DECISIONS 1–3]
- The desktop starts it from `resources/engine/orgtree-engine.exe` when packaged, or from
  `ORGTREE_ENGINE_BIN` in development. [verified: `apps/desktop/main/index.ts`, `package.json`]
- Storage: one database `orgtree_engine`, schema `ot`, in the bundled PostgreSQL cluster;
  migrations are embedded in the binary (`engine/rs/orgtree-engine/migrations/`). At first start
  it imports the 3.2 per-org databases **read-only**; the old databases and files are never
  changed. [verified: `src/pg.rs`; PLAN §3, §8]
- Stopping: the engine's callers kill its whole tree (PostgreSQL with it) soon after asking it to
  stop: the desktop's Quit after 8 s for an engine it started (3 s request + 5 s, `stop()` in
  `apps/desktop/main/engine.ts`) and after about 12 s for an attached one (`stopForQuit`, the whole
  quit capped at 26 s); the background host after 15 s (`host.rs`: 5 s request + `SHUTDOWN_WAIT`
  10 s); the installer upgrade waits 45 s and never kills (it offers Retry/Cancel); the rig keeper
  after 45 s (run.json `stopKillMs`). A killed cluster's next start fsyncs its whole data folder
  before WAL replay: 5-185 s in the rig on a busy disk. The engine reaches the database stop
  within 0.1-0.5 s of the request (agents mid-turn included); `pg_ctl stop -m fast` then gets 120 s
  (`STOP_WAIT` in `src/pg.rs`), and `checkpoint_timeout` is 5 min so a stop has little to flush
  (the live cluster dirties 0.7-1 MB a minute, p99 2.4). A CHECKPOINT before the stop, early or
  late, was measured and dropped: with nothing to overlap it only adds a second checkpoint's
  fixed cost. On a disk saturated with fsyncs even a 4 MB stop takes 3-7 s, so the 8 s budget is
  not guaranteed there; the live disk's shutdown checkpoints take under 0.3 s. Measure before
  changing any of these numbers: `tools/rig/proofs/pg-stop.mjs` stops a run with fsync on under
  each budget. [measured: rig pg-stop and a read-only summary of the live cluster's checkpoint
  log, 2026-10-10; decided: coordinator 2026-10-10]
- Engine log: one file per start, `<data>\diagnostics\logs\<start time>.log`, kept 30 days.
  Every line prefixes the emitting Tokio task as `T<id>`, or `T-` outside a task;
  this is read at emission, independent of inherited request/client/frame spans.
  [verified-from-source: 2026-10-07, `src/trace.rs`, Tokio 1.53.2 `task::try_id`;
  recorded-decision: user 2026-10-07 07:46Z, DECISIONS 34]
  [verified: `src/trace.rs`; decided: user, DECISIONS 34–36]
- Agent log context must cross spawned tasks and channel messages: use `agent:<id>/<name>`
  for actor work and `dog:<uid>/<owner name>` for watchdog work. Keep actual UI requests as
  `user`/`desktop`; HTTP has no agent credential path. Reuse identity rows already loaded,
  and instrument async futures instead of holding an entered span across an await.
  [verified from source: 2026-10-07, `src/runtime/`; measured log audit and limits:
  `docs/rust-engine/agent-log-context.md`; user clarification of DECISIONS 34]
- Request parity: questions allow 4 per call and 8 accumulated; overflow refuses without
  dropping pending tabs. Credits use `ceil(round(total, 2))`; an already-held total removes
  only the credit tab, and zero chain/cap headroom refuses. Scope items merge by identity
  (8 maximum), omit capabilities already held after ancestor clamps, and require a reason.
  Question docket links pass the existing agent read gate before card creation or routing.
  Batch submits require every live component's revision and every explicit decision;
  grants, resolution and answer mail commit together, with notifications after commit.
  [verified from source: 2026-10-07, `domain/asks.rs`, `domain/scope.rs`; Python baseline
  `4ddbfb1:engine/backend/orgtree/ledger.py`; parity P18–P20/P29/P31–P32;
  details: `docs/rust-engine/request-parity.md`]
- Accounts: every account has its own active checkbox in App settings › Providers, the
  native sign-in included; an inactive account serves no new turn and its agents' mail waits.
  [decided: user 2026-10-07, DECISIONS 41]
- Composer Enter behavior is app-wide: App settings › Display › Typing › Enter key defaults to
  Send message; Insert new line uses Ctrl+Enter to send. Questions' free-text fields are
  multiline; single-line inputs and document editors keep their own shortcuts. The app
  feed updates open windows. No one-setting General tab.
  [decided: user 2026-10-07, DECISIONS 48; verified: `http/settings.rs`, `appfeed.rs`,
  renderer `canvas/accounts.tsx`, `enterkey.ts`, `composerkeys.ts`]

- Transcript auto-follow releases only on user scroll intent: upward wheel/keys,
  scrollbar drag or touch drag. A scroll event or changed scrollTop alone is not
  intent: browser anchoring, streams, images, prepends, resize and disclosure/jump-card
  clicks keep the bottom pin. Resume only on user movement down to within 8px
  of the bottom (including delayed downward momentum) or
  jump-to-bottom; retain 3.x's row anchors, paging and context-menu hold.
  [decided: user 2026-10-07 09:31/09:37Z; 2026-10-18 13:36Z; verified-from-source and mounted smoke:
  renderer `canvas/desk.tsx`, `docs/rust-engine/transcript-scroll-intent.md`]

- Failed transcript first loads and earlier pages retry every five seconds through
  the shared conversation store. Retain the failed cursor/window and existing rows;
  share in-flight cursor requests and synchronously capture each reader's row anchor
  before retrying. The last visible desk unsubscribing cancels retries; hidden retained
  hosts do not subscribe, while detached desks remain visible.
  [recorded-decision: user 2026-10-07 08:19Z; verified-from-source and mounted mock smoke:
  renderer `convo.ts`, `canvas/desk.tsx`]

- Viewport history fill uses `before` cursor pages, not a larger moving tail:
  a burst while a window is away can make a valid enlarged tail look stalled.
  Rust cursors are decimal oldest-row sequences; preserve that cursor when
  trimming incremental rows, and retain the read range from page-request start.
  Caller/browser `AbortError` and superseded errors are silent; `TimeoutError`
  remains a real failure. [verified-from-source and mounted mock: 2026-10-07;
  `docs/rust-engine/transcript-history-retries.md`]

- Limit marks: fresh successful provider probes may clear an older mark for the
  same account/pool; cached, failed, missing or incomplete readings cannot. A
  successful turn uses its captured admission account/time, never a later rebind.
  Neither path resumes frozen agents. Unknown imported pools stay manual.
  [verified from source: 2026-10-07, `src/account_marks.rs`, `src/runtime/actor.rs`]

- A refused turn's parsed reset is never shortened to the five-minute probe
  floor by an expired/repeated countdown. Select the latest relative, ISO/offset,
  local-clock or structured reset; elapsed local clocks roll to tomorrow. A
  newer successful cached reading may only lengthen the same serving account's
  applicable full window. On 4.4.0, registered Antigravity profiles use their own
  `agy:<id>` cache; ambient or missing-folder bindings use `agy`, matching the
  serving login. Missing profile evidence never borrows native usage.
  Structured evidence is turn-local; quota timers still
  add 60 seconds and manual release keeps its override. Missing reset keeps the
  prior fallback. See [freeze recovery](docs/rust-engine/freeze-recovery.md).
  [decided: user 2026-10-17; verified: `runtime/usage_reset.rs`, `runtime/actor.rs`]

- Freeze reset recovery accepts RFC3339 `until` and legacy numeric `until_ts`
  (including a version-matched promised wake); old display labels are not clocks.
  Imports normalize them; existing imported rows need no repair. Limit probes still
  require org auto-resume, pure connection retries do not. Timers compare the exact
  freeze before clearing, retry disabled settings/transient errors, and explain
  blocked wakes even with verbose logging off.
  [verified from source and eight-case scratch timer/restart smoke: 2026-10-07;
  `docs/rust-engine/freeze-recovery.md` records scope and limits]

- End-of-turn mail: pending waking mail follows through ordinary admission on
  every provider, including error exits with new mail. An unemitted Antigravity
  handoff is returned before delivery settlement; confirmed boundary mail is
  not replayed. Merely requeuing a failed opening prompt must not create a retry
  loop. Follow-up IDs are logged only after the next prompt is accepted.
  [verified from source: 2026-10-07, `src/runtime/actor.rs`]

- Attention's Swap panels exchanges the persisted split and visual order together.
  The physical left slot owns the fixed percentage; the right slot takes the remainder
  after the divider, so its six-pixel width does not move the divider during a swap.
  [verified from source: 2026-10-07, renderer `attention/AttentionView.tsx`]

**Where and how to work** [decided: coordinator 2026-10-06, from the rust-engine session's terms;
user, DECISIONS 39]
- `rust-engine` is a **local** branch: it is not on `origin`. **Never push** it or anything
  based on it. Make your own worktree from it, e.g.
  `git worktree add -b <you>/<topic> .worktrees/<you>-<topic> rust-engine`.
  `.worktrees/rust-engine` is the branch's own checkout; since the rust-engine session was retired
  (2026-10-07) it belongs to the coordinator, who merges there. [decided: user, DECISIONS 45]
- **Hand-in:** rebase on the current `rust-engine`, then send the coordinator your branch name and
  commit list; the coordinator reviews and merges it. Where 4.0 stands (open bugs, open user
  decisions, how alphas were built): [`docs/rust-engine/HANDOFF.md`](docs/rust-engine/HANDOFF.md).
  Bugs in 4.0.0 go the same way (agent, action, expected, actual, UTC time); check PLAN §10
  first, since many differences are deliberate.
- **Three kinds of change never share a commit:** the engine (`engine/rs/**`); desktop changes the
  rewrite needs (launcher, packaging, boot task, renderer changes that follow from the feature
  differences); and purely visual UI work, which goes on a separate branch `rust-engine-ui`
  stacked on `rust-engine`. The canvas is not touched. [decided: user, DECISIONS 29–30; PLAN §12]
- **Prototype restarts.** Every prototype install restarts Orgtree, which ends running turns and
  kills every process agents started. Take only work that survives that: small committed steps,
  no long-running jobs. When a build is announced, commit and end your turn. Stop any task that
  restarts keep breaking. [decided: user, DECISIONS 39]
- **Builds and installs are the user's.** Prototype builds are `4.0.0-alpha.N` (N counts
  delivered builds), delivered as local installers. No agent builds, tags, publishes, installs or
  restarts. [decided: user, DECISIONS 37–38]
- **Read-only copies of live data are allowed for rehearsals** (file copies or database dumps):
  they never change anything live, stay in your own scratch folder (they hold secrets), are never
  committed or sent, and are deleted when no longer needed. [decided: user, DECISIONS 40]

**Turn slots and CLI replacement (2026-10-07).** Slots count admitted turns across all orgs,
not parked CLIs. Publish admission before slow CLI startup; release the slot when taking the
finished turn, before fallible cleanup. Stream and exit notifications carry a process incarnation,
so a replaced CLI cannot finish its successor's turn. Exit observations log the incarnation,
PID, reason and OS status (or explicit uncertainty). [verified: `runtime/actor.rs`, `sched.rs`,
`claude.rs`, `codex.rs`, `agy.rs`; details: `docs/rust-engine/turn-slot-lifecycle.md`]

**Typed mail (2026-10-07).** Retained operations mint canonical `ev` at their producer;
never recover an event type by matching prose. Carry it unchanged through inbox/chat and
`prompt::Mail.ev`; passive lifecycle/access/policy notices use `@system` plus `notice=true`.
Keep legacy decoders even for removed operations. In 4.0, review outcomes are statuses and
old sessions are not rehireable bearers, so their agent text must not offer removed actions.
The renderer assignment status now includes `approved`; do not overwrite that extension
with the frozen Python generator. [verified from source / recorded coordinator ruling:
2026-10-07; inventory and remaining parity gaps: `docs/rust-engine/typed-message-parity.md`]

**Mail and artifact parity (2026-10-07).** File reads fold every ancestor's folder
ceiling; user attachments and deliveries copy into a fresh outbox directory. Hub attachments
must start in the sender's scratch and fit 25 MB. Org-inbox delivery uses live holders only;
automatic and explicit grants enforce single-holder mode, and disabling multi-holder with
multiple holders refuses. Manual inbox reads page waiting mail and expose complete UTF-8
chunks without altering automatic delivery. Delivery retry IDs are scoped to the sender.
HTML presentations capture a bounded local asset bundle for ZIP download and an offline
preview; a vanished staged hub attachment is dropped with a durable event, not a blocked
message. [verified from source: `domain/docs.rs`, `domain/orginbox.rs`, `domain/html_bundle.rs`,
`tools/mailtools.rs`, `net.rs`; details and verification limits:
[`docs/rust-engine/mail-artifact-parity.md`](docs/rust-engine/mail-artifact-parity.md)]

**Docket policy parity (2026-10-07).** Keep the retained 3.x link/read rights,
revision-checked progress patches, closed-only archive, deletion pointer cleanup,
upward handoff and attention wording/history. Automatic participant notices use
the actor's mail rights, report refusals and never grant reply audiences. The
signed F2–F5 removals remain. [verified from source: `domain/docket.rs`, `domain/mail.rs`;
details and Python references: `docs/rust-engine/docket-parity-batch5.md`]

**Agent mail requests and fan-out (2026-10-16).** `orgtree_message` accepts
`kind: request` as a separately displayed request; local-agent attachments are
validated and shared as absolute paths; multi-recipient replies are filtered
per recipient conversation. `user` and `@net:` attachment uploads are unchanged.
See [DECISIONS.md](docs/rust-engine/DECISIONS.md).

**Inbox mail styling (2026-10-07).** Rust mail carries passive delivery as
`notice: true`, independently of `kind`; legacy mail uses `kind: notice`.
Mailbox rows must recognize both for the dashed edge and system-notice folding.
Plain message/notice rows have no type badge; typed question/request/decision/status
markings remain. Only consecutive delivered system notices fold (same typed variant
and object kind); pending rows and system decisions remain separate. This is a
mail-list grouping rule. Passive delivery's dashed edge also belongs on transcript,
pending, standalone and read-pane cards, independent of typed family; only the
owning card has the edge (not its pending wrapper). Shared `isNoticeRow` gives an
explicit notice flag precedence over legacy kind. Transcript writes retain the
flag; old missing flags are recovered read-only from recipient-scoped original
mail in bounded batches, without rewriting history. [user follow-up 2026-10-07
11:22Z; verified from source: `runtime/actor.rs::mail_row`, `runtime/convo.rs`,
renderer `events/card.tsx`, `events/segments.tsx`, `events/decode.ts`;
verified from source:
`feed/compute.rs::mail_entry`, renderer `canvas/shared.ts` and `canvas/mail.tsx`;
recorded decision: user inbox styling request 2026-10-07]

**Mail kinds reduced (2026-10-15).** Agent-facing mail tools offer only
`message` and `question`; `request`, `decision` and `status` are retired as
agent-chosen kinds (user ruling 2026-10-15, superseding the 2026-10-07
keep-all-typed-variants parity instruction for these three). Nothing ever
branched on them: wake is `notice`, ask answers link by `answer_mail`. A
send naming a retired kind is stored as `message`, never refused; unknown
kinds still refuse. Engine-generated mail (orgtree_status notices,
ask-answer mail, kickoff default, superior-routed scope requests) is stored
as `message` too. Stored rows are never rewritten: retired kinds display
as `message` (envelope header, inbox lists, renderer cards). Untouched on
purpose: the 2.x import mapping `kind: status|notice` -> passive notice
(`import2x.rs`) and the asks-tab `decision` vocabulary. [decided: user
2026-10-15; verified: `tools/defs.rs`, `tools/mailtools.rs`,
`domain/ops.rs`, `domain/asks.rs`, `domain/mail.rs::shown_kind`,
`runtime/envelope.rs`, renderer `events/project.ts`; docket
`reduce-orgtree-message-kinds-to-message-and-ques`]

**Activity summary strip (2026-10-07).** `ActiveAgentSummary` uses the org list's
`active/live` count and spinning-arrow styles, but keeps counting its own live
tree nodes (`busy` means active); per-tier totals and tooltip use that same tree.
The shared org activity spinner stays visible but static under reduced motion,
and is absent while idle. Its 14px slot remains reserved and centre-aligned,
with a 4px gap before the count. Counts use tabular digits without extra leading
width; the pill's left and right padding match. [user follow-ups 2026-10-07 09:51Z, 09:57Z;
verified from source: `shell/treeinfo.tsx`,
`shell/orgrows.tsx`, `styles.css`; recorded decision: user 2026-10-07 09:44Z]

**Engine code rules** [decided: user, DECISIONS 5, 34–36; verified: `engine/rs/orgtree-logged/src/lib.rs`,
`src/trace.rs`]
- **Tree/scope parity (2026-10-07):** remove host `CLAUDE_CODE_*` before selected-account
  environment injection. Omitted hire account uses a compatible org default, otherwise primary,
  never the parent's binding. Superior insertion authorizes the target (self allowed below top
  level) and inherits its effective capabilities. Retool refuses grants above its caller and
  raises intermediate managers for valid deep grants; report those expansions. State inspection
  reports effective scope and refuses explicitly invisible targets. Its visible set
  is the chart's set plus all own descendants, even at self visibility; archives
  remain opt-in. [recorded decision: user 2026-10-07 08:28Z, DECISIONS 49; verified from source;
  details and measured limits: `docs/rust-engine/tree-scope-parity.md`]
- **Open request cards (2026-10-07):** emit `kind: batch` with typed `tabs`, even for
  question-only or single-tab requests, as 3.x did. That selects the existing renderer's
  next-unanswered-tab navigation; multi-select and typing do not advance. Recompose
  already-open Rust rows on read; keep stored kinds for resolved-card history.
  [verified: `src/domain/asks.rs::compose`, `src/domain/tree.rs::ask_card`, renderer
  `canvas/asks.tsx::BatchAsk`]
- **No global locks of any kind.** State is owned, not shared: each running agent's state belongs
  to its actor and changes only through messages on its channel; each org's feed is one task;
  registries are lock-free maps. Database transactions are short, lock only the rows they change,
  and never contain provider calls, file IO or process control. Every queue is bounded and every
  list read has a `LIMIT`. [PLAN §2.2]
- **`#[logged]` on every engine method.** Put `#[logged]` on each free function and inherent
  `impl` block; it logs every call with its arguments and its return value under one invocation id.
  Do not put it on an individual associated function inside an impl: that expands as a free
  function and fails to resolve its generated helper. [verified 2026-10-07: macro source, cargo check]
  Mark only extremely hot methods (per-token streaming, per-record feed rebuilding, tiny helpers)
  `#[nolog]`. Verbose logging is off by default in packaged builds and on in development builds.
- **Never derive `Serialize` on a struct that holds a secret** (a key, token, password or
  credential). [decided: rust-engine session, relayed by the coordinator 2026-10-06] Why: logged
  arguments and return values are serialized into the log, and the log masks a value only when its
  JSON field name is on the masked list (`token`, `key`, `password`, `api_key`, `authorization`…,
  see `masked()` in `trace.rs`); a value logged through `Debug` is not masked at all. So also never
  give a secret-holding type a `Debug` that prints the secret.
- **Transport:** HTTP for loads and actions, the org and app sockets for pushed updates, with
  rooms so a window receives only what it shows; agents reach the engine over their CLI's own
  pipes, never HTTP. [decided: user, DECISIONS 13–14; PLAN §2, §4]

**Verification during the prototype** [decided: user, DECISIONS 8, 33]
- **No unit-test suites and no review rounds** while the prototype is built; brief smoke tests
  are allowed; the user tests it. Hardening with tests and review comes later.
- **Smoke changes through the real path with the test rig**, so a hand-in can say measured rather
  than inferred: `node tools/rig/rig.mjs up` runs your debug engine on a throwaway data root (rig
  mode: fake home, fake CLI, no provider probes), with scripted CLI turns, any `orgtree_*` tool as
  any agent, SQL on the scratch cluster and an offscreen desktop smoke. Prefer it to a bare
  SAFE_START scratch engine, which still reads the real sign-ins and runs the real usage probes.
  How-to: [`docs/rust-engine/test-rig.md`](docs/rust-engine/test-rig.md). [verified: 2026-10-07,
  proofs under `tools/rig/proofs/`]
- **Electron probes:** pass URLs and options through the environment, not the command line: with
  an `http://` argument `electron.exe` exits −1 before the script runs (measured 2026-10-07).
  Clear `ELECTRON_RUN_AS_NODE` first; tool shells inherit it from VS Code.
- So none of the 3.x test machinery below applies to 4.0.0 work: the P03 run lock,
  `test-baseline.mjs`, Python import provenance, `run-python-verification.py`,
  `source-audits.py`.

**Custom native icon colors (2026-10-07, verified from source and Electron PNG smoke).**
Tray/window custom colors tint the neutral accent layer, preserving the `#18232d` iris
and its mixed edge pixels. Electron's BGRA bitmap is premultiplied by alpha. Keep tint
changes versioned in the generated taskbar icon filename so old cached artwork is not
reused. Preset/loading ICO assets stay unchanged; rainbow cycling is renderer-only CSS
and the native icon retains the selected custom color. [`main/tray-tint.ts`,
`main/index.ts`, `tools/generate-icon.mjs`, renderer `rainbow.ts`]

**Tray list status sizing (2026-10-07, verified from source and Electron smoke).**
Pass zero rows for unavailable/loading/error and empty-list popups: they use a 260 px
width, with one 28 px nowrap message row plus 12 px border/padding. Keep populated
lists at 200 px and allow their usual vertical scroll when long. `Engine.orgActivity`
maps missing endpoint, failed request and malformed responses to the shared unavailable
message. [`main/traylist.ts`, `main/index.ts`, `main/engine.ts`]

**Still valid from the 3.x sections:** [Machine traps](#machine-traps) (shell, CRLF, slow git on
E:), the worktree rules (own worktree, no `node_modules` links, no bare `git stash`), "commit
before you mutate", the evidence rules, and the product rulings except where PLAN §10 or
DECISIONS changes them.

**Desk geometry and ordering (2026-10-06).** Explicit desk pop-outs measure the visible
desk frame, then map its CSS rectangle through the owner's native content origin and browser
zoom. Windows cross-display mapping goes through physical pixels; content bounds exclude
invisible frame allowances. Lifecycle restores still use saved standalone placement.

**Watchdog drag positions (2026-10-07, verified from source).** Canvas drag bases
include watchdog satellites for every dragged owner in the subtree. The same
bases suspend springs during dragging and restore positions on pointercancel;
cards and connectors both read those springs. Keep satellites in that shared
path for row and ring layouts (`canvas/OrgCanvas.tsx`).

**Desk popout navigation (2026-10-07, verified from source and browser smoke).**
Card and agent-list menus request the canonical desk window without recentering.
An unopened desk gets an on-demand launch slot, removed after detach or failure;
registry notifications must not recreate its registration props. Explicit Focus
and redock navigation remain separate. See `canvas/deskhosts.tsx`.

**Temporary desks (2026-10-07, verified from source and browser smoke).** Their jump
cards use normal desk navigation; an explicit jump closes the temporary host. Keep
the host at layer 20, below dialogs (30/31). Canvas-owned dialogs must also escape
the viewport through `ModalOverPins`: z-index alone cannot escape its stacking
context. The temporary host yields keyboard focus to portaled dialogs, menus and
listboxes, including dialogs without `aria-modal`.

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

**Engine priority and agent build caches (2026-10-07).** The boot task requests Normal
CPU priority (Task Scheduler value 5), matching desktop launches. The app has no build-cache
setting or launcher override; a previously saved value is ignored. Rust builders in this org
set their own `CARGO_TARGET_DIR` on E: under the 2026-10-07 team instruction. Superseded
2026-10-15: new build artifacts go under the assigned `C:/orgtree-build/<agent>` scope;
the rig accepts that subtree, rejects other C: paths and continues to refuse E:.
[recorded-decision: user, 2026-10-07 07:56Z; superseded: coordinator 2026-10-15;
verified from source:
`tools/boot-engine-task.ps1`, Rust `settings.rs`, `http/settings.rs`, `runtime/{claude,codex,agy}.rs`,
`tools/rig/lib.mjs`]

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


- Direct user messages/replies to nested agents atomically grant `@user` reply
  access with the mail and canonical access/chain notices; repeat active grants
  are idempotent and revoked grants return on new contact. Successful user commands
  include `/compact` and Muse; automatic/refused commands are excluded. See
  [typed-message parity](docs/rust-engine/typed-message-parity.md).
  [verified 2026-10-13: `domain/runtime_notices.rs`, `domain/mail.rs`, `runtime/actor.rs`]

## Keep this file current

- Agent-hire MCP schemas mirror the no-defaults rule: ordinary new hires require
  explicit folders/visibility and all five tool keys including `mcp`; superior
  insertion omits inherited scope, rehire requires `node` and forbids `index`.
  Hire/staff refusals report missing fields together. [decided: user 2026-10-17;
  verified: `domain/hire_requirements.rs`, `tools/defs.rs`]

- OpenRouter key add/replace and language-server add/configure forms open in
  separate `ProviderDialog` surfaces above App settings; keep their API bindings,
  draft/save semantics and nested model browser intact. The dialog uses
  `ModalOverPins`, so it must not be moved back inside a pinned settings stacking
  context. See [provider dialogs](docs/rust-engine/provider-dialogs.md).
  Each language-server card exposes its existing app-wide `enabled` switch directly.
  Org Accounts keeps `allowed` separate from optional effective `enabled` and
  `disabled_reason`: a globally-off lane may be revoked but not newly allowed;
  provider feed changes refresh availability. Account-list generations discard stale
  replies; saves invalidate reads and defer refresh until completion, protecting
  full allowlist writes from pre-save snapshots. [verified: `canvas/langserver.tsx`,
  `orgaccounts.tsx`; decided: user 2026-10-11]
  Switchboard context actions follow agent menu order/separators, but Open inbox,
  global docket and presentations stay flat. Hire an agent uses the existing tier
  submenu and `spawn(USER, tier)` root draft, never an arbitrary agent parent.
  [verified: `canvas/cards.tsx`, `canvas/OrgCanvas.tsx`; decided: user 2026-10-11]
  See [switchboard menu](docs/rust-engine/switchboard-menu.md).
  [decided: user 2026-10-11; verified: renderer provider dialog tests, 2026-10-11]

**When you find an engine gotcha or a design invariant, or a new decision or ruling is
made, update this file in the same landing as the change it concerns.** If no code
changed, land a small follow-up commit that touches only this file.

- Keep entries short. Date each one (UTC) and tag it **[verified: `<file>`]** (you checked
  the source) or **[decided: `<who>` `<date>`]** (a recorded ruling: "user" is the product
  owner, "design" is [`pg-data-model-design.md`](docs/state-system/pg-data-model-design.md),
  "coordinator" is the team coordinator). Link the detailed doc.
- Describe only what has landed: on `rust-engine` for 4.0.0, on `dev` for the 3.x line. Work
  still in review or on a private branch is not current behaviour: its entry goes in the commit
  that ships it. For 4.0.0, a new user decision goes in
  [`docs/rust-engine/DECISIONS.md`](docs/rust-engine/DECISIONS.md) first; add a one-line pointer
  here only if agents would otherwise get it wrong. (2026-10-06)
- When a rule changes, edit its entry in place and say what it replaced. Dead rules live
  only in [Removed and dead ideas](#removed-and-dead-ideas).
- Reviewers check this: a landing that adds a gotcha, an invariant or a ruling without
  updating this file is not finished.
- Agent sessions load this whole file, so keep it dense; long explanations belong in
  `docs/` with a one-line pointer here.
- `main` is public. Never put secrets, tokens, email addresses, user names, personal paths
  or live data in this file.

This first version was compiled on 2026-10-05 at `6e53697`, before the development branch was renamed.

## Read this first

> **3.x Python engine — legacy.** For 4.0.0 work use [Orgtree 4.0.0: read this first](#orgtree-400-rust-engine-read-this-first); rules 2, 3, 8, 9 and 10 below still apply. (2026-10-06)

These rules prevent the mistakes that have cost the most: lost work, a crashed machine,
wrong test verdicts and re-argued decisions.

1. **What we build.** Orgtree 3 (3.x): an Electron desktop app, a Python engine and a
   bundled PostgreSQL. All work lands on branch `dev`; `main` is moved to it
   at each release. The current project is **3.2.0, the data-model rewrite** (one
   PostgreSQL database per org), designed in
   [`docs/state-system/pg-data-model-design.md`](docs/state-system/pg-data-model-design.md);
   its owner and integrator is drag-opus. [decided: user 2026-10-02; team charter]
2. **Never touch live Orgtree data, and never build an installer, tag, release, publish,
   deploy, install or restart the app.** Those belong to the coordinator and the release
   owner it names. The installed app's data root is `%APPDATA%\Orgtree v2\data`; agents'
   scratch folders live inside it, so touch only your own. [decided: team charter;
   verified: `apps/desktop/main/policy.ts`]
3. **Work in your own git worktree.** `git fetch origin`, then
   `python tools/worktree.py add <name> --base origin/dev` (the tool's default
   base is `main`, and the local branch refs in the shared checkout are stale: always use
   `origin/...`). Never junction or symlink `node_modules` into a worktree (removing it
   deletes through the link: 783 MB was lost this way), and never copy it. Never work in
   another agent's worktree, and never use a bare `git stash` (the stash is shared).
   [verified: [`docs/worktree-operations.md`](docs/worktree-operations.md)]
4. **In agent shells a bare `python` imports the installed app, not your checkout.** Run
   Python tests only through `python tools/run-python-verification.py tests/test_X.py` and
   read `import_provenance` in its output. Count `tests_ran_total`: a module that ran
   nothing is "not executed", not a pass. Scratch scripts start with the
   `tools/assert_repo_import.py` guard. [verified: `tests/import_provenance.py`]
5. **Tests are slow and the machine is short on memory.** Run only the test modules your
   change touches, at the base and at your tip, and compare the failing test names. Never
   run the full baseline (`test-baseline.mjs compare`); only the coordinator or release
   owner runs it, once, before a release. Anything heavy takes the machine lock with
   `tools/p03-run.ps1 -Wait`. Start only with 15 GB of free commit memory; stop below
   10 GB. [decided: user 2026-09-26; team charter] → [Tests](#tests)
6. **Landing:** an independent reviewer approves your exact commit; you rebase, re-run your
   targeted tests, run `python tools/source-audits.py`, fast-forward push and record the
   `git ls-remote` line. [decided: team charter] → [Reviews and landing](#reviews-and-landing)
7. **The storage rules are easy to break without noticing:** no transaction spans two
   databases; every writer takes its locks in one order, with the org's revision row last;
   only the org-lifecycle module holds the admin connection; no read may grow with inactive
   history. → [Design rules and invariants](#design-rules-and-invariants)
8. **Commit before you probe the base or mutate code for a test.** `git checkout --`,
   `git restore`, `git stash` and `git reset` have silently destroyed uncommitted fixes.
   [decided: team charter]
9. **Evidence:** label every claim measured or inferred. Treat a surprising pass like a
   surprising failure and check that your control really ran. After a timed-out call that
   may have applied, re-read the state before repeating a write. [decided: team charter]
10. **This machine has traps** (CRLF, heredocs, PowerShell encodings, MSYS path rewriting,
    slow git on drive E:). Read [Machine traps](#machine-traps) and
    [`docs/machine-traps.md`](docs/machine-traps.md) before your first command.
11. **Before changing behaviour, grep for the ruling behind it.** About 900 source comments
    cite user rulings ("user ruling", "user requirement", "user spec"), most with a date,
    mostly in `ledger.py`, `supervisor.py`, `api.py` and the renderer canvas. A cited ruling
    binds until the user changes it. [verified 2026-10-05]
12. **Do not revive dead ideas** (kiosk mode, the per-org Docker sandbox, the frozen
    profile, v1 import, SQLite as primary storage). → [Removed and dead ideas](#removed-and-dead-ideas)

Record catch-up builds each needed body once per snapshot and shares its tree context
only within that pass. The context covers rebuilt records plus predecessor/ancestor
dependencies; unchanged held runtime bodies are retained using their own cursor, not
the HTTP caller's cursor. Emitted bodies are independent copies. Membership, ordering,
scope expansion and frames stay unchanged. [decided: drag-opus 2026-10-05;
verified: `orgdb/record_pass.py`, `orgdb/record_host.py`, `orgdb/record_tree.py`]

Record HTTP timings use the existing slow-request threshold and numeric allowlist.
`record_worker_ms` includes `record_assembly_ms` (including read-gate wait and
context build) plus forecast; only outer stages reduce unattributed time. Host-lock
and executor-queue waits are separate, and async waits have no thread-CPU reading.
No payload contents are logged. [verified 2026-10-06: `profiling.py`, `record_api.py`,
`orgdb/record_host.py`; decided: coordinator 2026-10-06]

## What Orgtree is, and where it stands

> The product description still holds. The 3.2.0 status below is **legacy**: the user stopped the 3.2.0 Python track on 2026-10-06 18:53Z; current work is 4.0.0 ([PLAN.md](docs/rust-engine/PLAN.md)).

Claude warm reuse rotates the Orgtree MCP child at a quiescent turn boundary:
one child keeps one immutable run claim; the parked CLI carries no turn token.
New-child authentication and an unchanged tool-list digest precede the prompt;
old callbacks retain their origin, and uncertainty falls back cold. Descendant
inventories must be rechecked after drain and across parked reuse/replacement;
new shells must never enter the successor baseline. [decided: review2-sol 2026-10-06] See
[`claude-warm-turns.md`](docs/claude-warm-turns.md). [decided: drag-opus and
coordinator 2026-10-06; verified: `claude_transport.py`, `supervisor.py`]

- **The product.** A Windows desktop app for running a persistent team of coding agents.
  The user sits at the top of an org chart (the canvas); agents work beneath, each with a
  desk (live conversation and tool activity), mail and notices, a shared docket of tickets,
  questions to the user, audiences (extra communication links), watchdogs, presentations
  and file delivery. Agents run through Claude Code, Codex and Antigravity, or OpenRouter,
  on one or more signed-in accounts per provider. **Credits** are a capacity budget, not
  money: each agent occupies a model-priced seat, its grant funds the agents beneath it,
  and retiring it frees the capacity. [verified: `README.md`]
- **Lineage.** claude-orgtree (v1) → Orgtree 2 (Electron around the v1 Python engine, on
  SQLite; last release 2.1.14) → Orgtree 3 (storage on PostgreSQL; 3.0.0 published
  2026-10-01, 3.1.0 on 2026-10-02). [verified: git tags `v3.0.0`, `v3.1.0`]
- **The mission of v3** is performance and memory, not UI: the app must stay responsive
  with hundreds or thousands of active agents. [decided: user 2026-09-26]
- **Scale targets** at 1,000 agents: UI reads p95 under 250 ms; tool calls p95 under
  500 ms and never waiting on unrelated agents; clicks under 100 ms; engine memory flat
  over an hour; screen feed under 1 s with no drops; at 2,000 agents, usable with no stall
  over 2 s. They are best effort, not a release gate, while the engine stays Python, and the
  separate scale-qualification test was dropped. [decided: user 2026-09-26, 2026-09-28,
  2026-09-30]
- **3.2.0** rewrites the data model as if Orgtree were built for PostgreSQL from the ground
  up, and ships it all at once: one database per org, jobs in place of every polling loop,
  a change log that feeds the renderer records instead of refetches, a durable turn queue
  with leases, and a second engine process. [decided: user 2026-10-02, design decisions 7,
  10, 12]

**3.2.0 status on 2026-10-05** (check `git log origin/dev` before relying on it):

- **Landed:** phase A (per-org databases, converter with `unavailable` and Retry,
  compatibility view, native agent and docket readers, accounts in the app database; new
  storage on by default since `4f1ddf0`); durable turn requests and queue (B5, `305c472`);
  schema conformance G1–G11 (`c162ca0`); the O(1) agent move (O1, `3535fb4`); the alpha.1
  startup repairs (`d1c4e8c`); one shared registry connection cache (`ebb2af6`); B4a record-feed backend and tree subscriptions (migration 0018); B4b app feed (app migration 0005).
- **Builds delivered** (local, never published): 3.2.0-alpha.0 on 2026-10-04 and
  3.2.0-alpha.1 on 2026-10-05; the user runs them on live data. alpha.1's startup failures
  are fixed on `dev` by `d1c4e8c`.
- **In flight:** the record feed panels: B4c1 (inbox, events, mail, history), B4c2 (gallery, docket, audiences) and B4d
  (time and retention jobs) follow.
- **Remaining:** B1 mail and watchdog modules with jobs; B2 questions, audiences,
  documents, reservations, events and settings modules, with every remaining polling loop
  a job; B3 the host's job scheduler and sweep; B6 the worker process and deletion of the
  compatibility view; then final rehearsals and the release candidate, including installer
  upgrade rehearsals from 2.1.14, 3.0.9 and 3.1.0 with a rollback. [decided: umbrella
  ticket `v3-storage-keep-indexed-fields-in-real-postgresq`, decisions 23 and 34]

## Architecture

> **3.x Python engine — legacy.** 4.0.0's architecture is [PLAN.md §1–§4](docs/rust-engine/PLAN.md). (2026-10-06)

- **App registry locks and restore boundary:** app migration `0005_app_feed.sql`
  owns the deferred registry revision update; lifecycle writers never acquire that
  singleton themselves. Existing restore tools handle legacy or individual org
  databases; a future app-database restore must change its incarnation with the
  engine stopped and the root owner lock held. See the
  [writer and restore inventory](docs/state-system/app-feed-writer-audit.md).
  [verified: `orgdb/lifecycle.py`, `orgdb/names.py`, `pg-custodian/src/backup.rs`;
  decided: step-6 addendum section 5; 2026-10-05]

As built on `dev` on 2026-10-05; where 3.2.0 will differ, the table at the
end of this section says so.

### Processes and the desktop–engine boundary

- **App feed and native login (2026-10-05).** App registry, org summaries/notices and
  engine-owned values use `/api/app/ws` and `/api/app/records`; app migration 0005
  gates activation. Native provider login remains in Electron under D231: subscribe
  before taking its initial IPC snapshot, ignore delayed responses after newer events,
  and unsubscribe on unmount. OAuth output/codes never go through the engine.
  [verified: `app_api.py`, `packages/contracts/provider-login-feed.ts`;
  decided: drag-opus 2026-10-05, B4b decision 7]
- **Native notices (2026-10-05).** Electron's app socket uses the current desktop
  token on the HTTP copy and WebSocket handshake. Renderer delivery keeps its
  existing category, visibility and persistent-history rules; a failed OS
  delivery retries cached notices, never a network read. An active org missing
  its first notice snapshot is unknown, so it cannot clear delivery history or
  establish the initial document baseline. Completing an empty inventory must wake
  baseline observation before the first new document. Antigravity terminal launch
  publishes done/ok:null through the native login subscription without claiming
  verified authentication. [verified: `main/appfeed.ts`,
  `renderer/src/notifications.ts`; see step-6 §5]

- **Desktop** (`apps/desktop`): Electron 44. `main/` owns windows (one main window per
  org), tray, updater and the engine's lifecycle (`index.ts`, `engine.ts`, `policy.ts`).
  `preload/` exposes `window.orgtreeDesktop` only to the top frame at the exact engine
  origin. `renderer/` is React 18 + MUI 9 + TypeScript, built by Vite into `dist/renderer`
  and served by the engine as `resources/ui`; it has no state library (`App.tsx` state plus
  module-level stores). [verified: `package.json`, `apps/desktop/preload/index.ts`]
- **Engine** (`engine/`): Python 3.13 (embedded runtime, `engine/runtime`, gitignored and
  provisioned by `npm run runtime:provision`). `engine/launch.py` validates the data root,
  sets Windows High priority, arms the guardian, starts PostgreSQL and serves the FastAPI
  app (`engine/backend/orgtree/api.py`) on `127.0.0.1`. [verified: `engine/launch.py`]
- **Guardian** (`engine/process_lifetime.py`): holds the data-root lock
  (`.desktop-engine.lock`) and a Windows kill-on-close job containing the engine and every
  descendant (PostgreSQL, provider CLIs), so a dead engine never leaves orphans. [verified]
- **Boot host** (`engine/service_host.py`): run at Windows boot by the "Orgtree Background
  Engine" scheduled task (all-users installs only; S4U, LeastPrivilege). It starts the
  engine unelevated and writes `engine-attach.json` so the desktop can attach.
  [verified: `tools/boot-engine-task.ps1`, `build/installer.nsh`]
- **PostgreSQL 18.6**, bundled, run by the Rust `pg-custodian` (`engine/native/pg-custodian`)
  through `engine/pg_process.py`; the cluster lives in `<data>\pg\cluster`; roles
  `orgtree_admin` and `orgtree_runtime`; connection strings use a passfile and SCRAM, never
  a password. [verified]
- **Mail hub**: the `engine/mailhub` submodule (orgtree-mailhub) runs as a child process;
  changes land in orgtree-mailhub first and Orgtree moves only the pin.
  [verified: [`docs/mailhub-sync.md`](docs/mailhub-sync.md)]
- **Boundary.** All domain traffic is HTTP and WebSocket from the engine origin; IPC
  (`desktop:*`) is only for native operations. The desktop sends a fresh per-boot token in
  `X-Orgtree-Desktop-Token`; the engine drops it from its environment before importing
  anything that spawns children. The port is preferred from 20000–49151 and kept in
  `engine-port.json`, because moving the origin strands the browser's local storage.
  [verified: `engine/launch.py`; [`docs/engine-contract.md`](docs/engine-contract.md)]
- **Agents** call back through the MCP server `python -m orgtree.mcptool`, which posts to
  `/api/agent` with `X-Orgtree-Agent-Token` (an HMAC over org, node, generation and seat,
  keyed per engine process) and `X-Orgtree-Turn-Token` (binds the call to the running
  turn). [verified: `mcptool.py`, `agentauth.py`]

### Storage

- **Backend choice:** `ORGTREE_STORE`, then `<data>/store-backend.json`, then SQLite.
  Packaged builds set `ORGTREE_PG_BOOTSTRAP=1`: a fresh data root binds to PostgreSQL, and
  an existing 2.x SQLite root is converted at first launch (old files moved to
  `pre-postgres/`). An unpackaged dev run stays on SQLite unless told otherwise.
  [verified: `engine/pg_process.py`, `apps/desktop/main/postgres-runtime.ts`]
- **The layout switch `ORGTREE_STORAGE`:** unset or empty means `orgdb` (one database per
  org) whenever the engine runs on PostgreSQL; `legacy` is the developer escape hatch.
  Agent children never inherit it. [verified: `engine/pg_process.py`, `devguard.py`]
- **Legacy layout** (3.0–3.1): one database `orgtree` with a schema `org_<n>` of key+JSON
  tables per org; migrations `pg_migrations/0001`–`0020`, frozen (published checksums are
  pinned by `tests/test_published_migrations.py`). 3.2.0 never migrates or writes it.
- **Per-org layout** (3.2.0): `orgtree_app` plus `orgtree_org_<n>`, all tables in schema
  `orgtree`. Migrations live in `pg_migrations/app/` and `pg_migrations/org/` and run per
  database, one transaction per file; editing an applied file raises `MigrationDrift`; an
  org database newer than the build is not served. Database names come only from
  `orgdb/names.py`. [verified: `orgdb/migrate.py`]
- **Startup with `orgdb`:** prepare the app database → the one-time converter pass (a child
  process) → resume interrupted lifecycle claims → migrate each active org (a failure makes
  only that org `unavailable`) → retry unavailable orgs once per new build → start the turn
  host. [verified: `orgdb/startup.py`]
- **Compatibility view** (`orgdb/compat`): `store.py` keeps issuing its own SQL against the
  legacy tables, and an org-database connection answers each statement from the new
  tables; an unknown statement raises. It is deleted in B6. [verified]
- **Connections:** one idle cache per process for app and org sessions (at most 4 idle app,
  2 idle per org database, 16 in all; 10-minute expiry; keyed by the full runtime connection
  settings plus the database). Every org checkout re-checks `org_identity`, and a mismatch
  refuses. Only a failed pre-body checkout reconnects: transaction bodies and ambiguous
  commits are never repeated. Dirty or listening sessions are closed, never reused. The turn
  heartbeat has its own thread and connection (5 s connect and statement timeouts). There
  is deliberately no blanket idle-in-transaction timeout (org-exclusive file-move fences
  must survive). An active cap and a FIFO queue arrive with B6. [verified:
  `orgdb/registry.py`, `orgdb/turn_runtime.py`; decided: coordinator 2026-10-05, outage
  ticket decision 3]

- **Prompt-view capture:** a complete JSONL row with invalid JSON or text encoding is skipped
  with a warning containing only a source-identity hash and byte offset. The cursor advances
  in the same transaction as captured rows; valid following rows survive and an incomplete
  last line waits for completion. Catch `UnicodeDecodeError` as well as `JSONDecodeError`:
  otherwise the bad row rolls back cursor progress and retries forever. [verified 2026-10-05:
  `transcript_records.py::ingest_prompt_views`, `tests/test_transcript_records.py`]

### Turns, jobs and the feed: built today vs. 3.2.0

| Part | On dev now | 3.2.0 target |
| --- | --- | --- |
| Turn admission | With `orgdb`: a durable `turn_requests` row in the org database, a `start_turn` job, then a `turn_tickets` row in `orgtree_app` claimed by the turn host. Otherwise the in-memory `turnslots.FairSlots`. Limit: App settings `max_concurrent_turns`, default 16 | the same, shared with the worker |
| Jobs | `orgdb/jobs.py` exists, but only `start_turn` is enqueued. The polling loops (auto-resume, watchdogs, mail drain, keepers) still run as threads started by `api._recover_startup` | every loop that reads org tables becomes a job (B1–B3) |
| Screen feed | With orgdb and migration 0018, `record_changes_v1` enables record snapshots, catch-up and tree subscriptions; the deferred commit flush assigns the sole revision. App migration 0005 adds ordered app snapshots, runtime values and notices; legacy storage keeps changed/refetch | B4c panels reuse the core; B4d moves host time/retention work to jobs |
| Processes | one engine process per data root | an engine host plus one worker (B6) |

### Code map

- `engine/backend/orgtree/`: `supervisor.py` (about 37,600 lines: turns, provider legs,
  polling loops, the managed agent instructions), `ledger.py` (about 20,000: the `Org`
  domain model, credits, hire/move/retire, scope clamps), `api.py` (about 15,400: every
  HTTP and WebSocket route), `store.py` (the storage seam), `orgtx.py` (`org_tx` and lock
  plans), `orgdb/` (per-org storage), `turnslots.py` and `turnqueue.py`, `mcptool.py`,
  `agentauth.py`, `halt.py`, `pgfeed.py`, `warmpool.py`, and the provider modules
  (`codexrun.py`, `antigravityrun.py`, `openrouter*.py`, `providers.py`).
- **Name collisions:** four "lifecycle" modules (`lifecycle.py`, `lifecycle_tx.py`,
  `lifecycle_door.py`, `orgdb/lifecycle.py`); two "registry" modules (accounts
  `registry.py`, orgs `orgdb/registry.py`); Python `store.py` versus the Rust `store` crate.
- **`engine/native/`:** only `pg-custodian` (with its `prototype-guard` library) runs in the
  product. The `store*` crates are a shelved Rust store prototype. `backend-codec`,
  `funding-core`, `op-receipt-codec`, `scope-clamp` and `work-name-codec` are parity models
  checked against vectors generated from the Python sources. `engine/winservice/` is not
  wired. [verified]
- **Generated files:** `apps/desktop/renderer/src/generated/events.ts` says it comes from
  `tools/gen_events.py`, which does not exist; regenerate it with
  `orgtree.events.emit_typescript()`. [verified]

## Design rules and invariants

> **3.x Python engine — legacy** (the 3.2.0 per-org data model, `org_tx` lock order, revision row, jobs). 4.0.0 has its own rules: see the 4.0.0 section and [PLAN.md §2.2](docs/rust-engine/PLAN.md). The history-must-cost-nothing goal and the halt and privilege rules carry over. (2026-10-06)

Break one of these and the damage is usually silent until it reaches real data. "§" refers
to [`pg-data-model-design.md`](docs/state-system/pg-data-model-design.md).

### Data model (3.2.0)

- **PostgreSQL is the only source of truth.** No engine process holds org state; a cache is
  allowed only when keyed by `(org, revision)` and dropped when that org's feed moves past
  it. [decided: user 2026-10-02, design decision 7; §2.9]
- **One database per org, plus one small app database.** An org's database holds everything
  the org owns; `<n>` in `orgtree_org_<n>` is the registry's `org_id`, so a rename never
  renames a database. `orgtree_app` holds only the org registry, machine-wide accounts, the
  turn queue, engine instances and a one-row `app_settings` of cutover markers (the user's
  App settings stay in `app-settings.json`). Creating or importing an org is one database
  plus one registry row; deleting moves it to the trash; purging drops it. [decided: user
  2026-10-02, decisions 10 and 11; §2.10]
- **Normalized design (about 3NF).** A many-to-one link is a foreign-key column on the
  "many" side; a many-to-many link is a link table with one row per link; no embedded
  lists. Every deliberate duplicate is justified in the design (Appendix A.7). [decided:
  user 2026-10-02, decisions 2–3]
- **Keys and names.** Every record has a surrogate `id`; visible names (agent name, ticket
  slug, mail id) stay unique natural keys, so a rename is one `UPDATE`. A deleted agent
  keeps a tombstone row. Ticket slugs are never reused. [decided: §2.2, §3.0]
- **Agent identity is the node, not the lineage.** Each agent and each archived generation
  (`x`, `x@3`) is its own row, mailbox and principal; `lineage_born` is a shared lineage
  token, not an identity. "Current holder" references (ticket owner, mail recipient) point
  at the node's row; "historical" ones (creator, sender, event actor) keep the recorded name
  and generation with no foreign key. [decided: design rev 6, finding f17; §3.0]
- **Exact round trips.** Timestamps are `timestamptz` at microsecond precision, with the
  original text kept beside a non-canonical value; unknown keys go to an `extra` JSON column
  that is expected to be empty; a JSON column holds only a shapeless payload that nothing
  filters inside. PostgreSQL's JSON operators fail on a `\u0000` escape anywhere in a value,
  so such text stays in `extra`. [decided: design Q1, Q2; §3.0]
- **Migration numbers are taken at landing:** the next free number on `dev` when your migration
  lands, never reserved earlier. [decided: drag-opus 2026-10-04, decision 32]

### Transactions and locks

- **One short transaction per action**, on its own org's database, over only its rows, at
  READ COMMITTED. A serialization failure or deadlock re-runs the whole function, so domain
  functions must have no side effects outside the database. Business rules stay in Python.
  [decided: §2.1]
- **No transaction spans two databases.** An action that touches two (cross-org mail,
  starting a turn) records its intent durably in the first, then finishes with an
  idempotent job keyed by a stable id. [decided: §2.1, §2.7]
- **One lock order for every org-database writer** [decided: §2.4, revs 7.4–7.8; verified:
  `tests/test_orgdb_lock_order.py`]:
  1. the running turn's request row (`FOR SHARE` for tools and results; `FOR UPDATE` to
     finish, cancel or reclaim);
  2. advisory locks: the org lock, then the settings fence, then node, key and log-owner
     locks in sorted plan order, then the operation-receipt lock;
  3. rows by tier: agents by physical id, then `agent_subtree_stats`, then docket items,
     then mailboxes, then other planned rows. A structural writer takes every lock before
     its first structural statement; a plan that proves too narrow raises `Widen` (roll
     back, rerun wider). Never lock a row late;
  4. the revision row `orgtree.org_revision` **last**, taken by the deferred record flush
     when migration 0018 is present; retention also locks it last;
  5. after it, only aggregate counters, the current transaction's change/revision rows
     and record detail versions; final graph validation takes no earlier-tier lock.
     [verified-from-source 2026-10-05: `0018_records.sql`, `tests/test_orgdb_lock_order.py`]
- **Triggers.** A statement-time trigger writes only link rows of its own statement's rows
  and takes no row lock; the one allowlisted exception is the `agents` subtree-stats
  triggers. Writers do not force deferred checks (`SET CONSTRAINTS … IMMEDIATE`); the single
  exception is the migration runner checking two named docket-pointer foreign keys for
  migration 0016 (2026-10-05). The source audit matches the entire SQL, module and lexical
  function path; other constraint sets, appended statements and locations remain rejected.
  [verified 2026-10-05: `tests/test_orgdb_lock_order.py`] A value derived from other rows is a generated column, kept
  at statement time under the writer's own locks, kept under the revision row (the two
  counter tables), or computed by the reader. Changing any of this means changing the
  lock-order test, whose negative controls must keep failing. [decided: design revs 7.5,
  7.8; verified: `orgdb/migrate.py`]
- **Every foreign key to `agents` is immediate**, never deferred: a commit-time check would
  wait for an agent row after the revision row. [verified: `tests/test_orgdb_lock_order.py`]
- **Deferred foreign-key checks queued by a backfill block later DDL:** an `ALTER TABLE` in
  the same transaction fails with "pending trigger events". This broke migration 0016 on the
  user's data in alpha.1. [verified: `orgdb/migrate.py`, `61c15ce`, 2026-10-05]
- **The tree.** `agents.parent_id` is the only placement authority (no closure table, no
  stored depth). A move checks cycles and the depth cap under its sorted locks, and a final
  lock-free assertion after the revision row catches any writer, raw SQL and `COPY`
  included. An agent's effective scope is computed from its current ancestors, so moving it
  back restores its configured scope. [decided: design rev 7.8; user 2026-10-04;
  [`pg-o1-move.md`](docs/state-system/pg-o1-move.md)]
- **The admin connection** (create, rename, drop databases) belongs only to
  `orgdb/lifecycle.py` in the engine host; a source-scan test enforces it. [decided: design
  Q10; verified: `tests/test_orgdb_static.py`]

### History must cost nothing

- **Performance tracks active data only:** retired agents, archived tickets and read mail
  must not slow anything down. [decided: user 2026-09-27]
- **Acceptance:** with at least 10× inactive history, p95 at most 5% slower and engine memory
  at most 5% higher; for a lookup that still grows with history, at most 100 ms added at a
  simulated 5,000 agent-hours of history. [decided: user 2026-09-27, 2026-10-03]
- **How:** partial indexes over active rows only (live agents, open tickets, undelivered
  mail, queued jobs, open questions); archived rows are reached only by key or a `LIMIT`ed
  range; tests seed 10× history and require the same statement counts and rows read; the
  hot-path guards fail on a JSON predicate in a hot query or a sequential scan of a large
  table. [decided: §2.3; verified: `tests/test_orgdb_hot_paths_static.py`]
- An agent's docket list totals count non-archived items only; an archived total comes only
  with `include_archived`. The desktop keeps its archived and backlog totals. [decided: user
  2026-10-02, decision 21]

### Background work, the feed and turns

- **Panel records (B4c1):** migration 0019 appends shared inbox/events and subscribed
  mailbox/history windows. Later panel migrations compose all earlier extensions through
  `orgdb/record_panel_sql.py`; never rewrite shipped 0018. Mail recipient-first ties and
  pending-delivery exclusion resolve read-only after the revision lock. Recipient sender
  enumeration uses indexed seeks, not DISTINCT over inactive mail history. [verified
  2026-10-05: `orgdb/record_panels.py`, `record_mail_sql.py`]
- **Mailbox delivery stages** are host-clock overlays, retained only for subscribed
  mailboxes and refreshed from changed snapshot inputs. Late HTTP/join workers trim
  against live subscriptions before publishing; retained drain timestamps schedule grace
  expiry without an org read, and unsubscribe/identity replacement cancel stale deadlines.
  A deadline crossed between projection and scheduling still receives one immediate refresh.
  Subscription readiness is false
  until the current generation's final page; a reset or renewal clears it. Known record
  capability suppresses legacy polling even before the session controller is installed.
  Failed panel name lookups expose Retry and recover on surface focus at the same revision.
  Chat uses
  identity-fenced `after` cursors on agent frames/focus, with assistant revisions separate
  from new messages; direct file delivery emits its invalidation only after commit, while
  attachment helpers do not. In 4.4.0, scratch folders open in the OS file explorer from
  the agent menu or settings header; agent desks have no Files tab, and their History view
  is in agent settings when records exist. The separate `read_scratch` agent tool remains.
  [verified 2026-10-05: `record_host.py`, `chat_after.py`, `api.py`, renderer `recordfeed.ts`,
  `convo.ts`; decided: user 2026-10-17]
- **Every polling loop that reads org tables becomes a job row** in the org database, written
  by the transaction that creates the condition and claimed with `FOR UPDATE SKIP LOCKED`.
  Timers that read outside state (provider usage, update checks, the mail hub) stay timers
  in the engine host. [decided: user 2026-10-02 (Q9); §2.7]
- **The change feed** (B4a implemented, 2026-10-05): each org database records its changes in the committing
  transaction; revisions are handed out in commit order with no gaps; a cursor is
  `(org_uuid, incarnation, rev)`; baselines and catch-ups are single-snapshot reads, and the
  state at the frame's end revision decides. The desktop is the only audience; agents never
  use the websocket. [decided: §2.5;
  [`pg-step6-record-feed.md`](docs/state-system/pg-step6-record-feed.md)]
- **Record-feed activation and commit ownership:** advertise `record_changes_v1` only
  with orgdb enabled and migration 0018 present in the actual org snapshot. Statement
  capture reads OLD/NEW only; deferred SQL flush owns the sole revision increment.
  `on_save_commit` still finishes docket sources but never increments the revision.
  Parent/configured-scope subtree scopes expand in snapshot readers, never during commit.
  [verified-from-source 2026-10-05: `record_api.py`, `orgdb/record_sql.py`,
  `orgdb/record_tree.py`; [`pg-step6-record-feed.md`](docs/state-system/pg-step6-record-feed.md)]
- **Record runtime cache forecasts:** expensive cache/startup-manifest previews run in
  snapshot or coalesced background workers, never in loop-owned transitions. Keep live
  fields and HostClock stamps on the loop; fence forecast results by overlay identity,
  held membership and per-agent generation. Turn edges and expiry mark forecasts;
  stream frames and broad hub notifications do not. A 60-second worker refresh detects
  startup-file changes without org revisions. [verified-from-source 2026-10-05:
  `orgdb/record_host.py`, `orgdb/record_runtime.py`; decided: drag-opus 2026-10-05]
  See [worker ordering and warm-process distinction](docs/state-system/cache-forecast-workers.md).
- **Turn admission is machine-wide:** at most N turns at once (a setting, default 16), first
  come first served within an org, round-robin across orgs; lowering the limit never stops
  a running turn; a queued agent's desk explains the limit. [decided: user 2026-09-26;
  verified: `turnslots.py`]
- **A turn has a durable identity** (a request row, then a ticket keyed by its id), numbered
  claims and process leases. A stale process can change nothing, and a slot is reused only
  after the old run is verified dead. [decided: §2.4]
- **"A turn cannot run while its agent is halted."** Halt is not interrupt: it ends the turn,
  closes every admission and delivery path, and keeps queued mail unread until an explicit
  unhalt. [decided: user 2026-09-12; [`docs/agent-halt.md`](docs/agent-halt.md)]
- **Automatic compaction admission** retries graph `Widen` only after rollback, at most
  three widenings with the complete expanded plan. Successor identity files, transcript
  export and success reporting happen only after commit. A terminal compaction error retires the current mail demand and
  names the engine failure even when turn recording is disabled. [verified 2026-10-05:
  `supervisor.py` `_run_admission_compaction`, `_run_one_turn_recorded`]
- **Turn time limits:** a total ceiling (default 24 h) and a silence limit (default 10 min),
  both configurable and disableable in App settings > Runtime. [decided: user 2026-10-02;
  verified: `appsettings.py`]

### Processes, privileges and startup

- **Unelevated by default.** The engine, PostgreSQL and agents run as the normal user;
  PostgreSQL refuses an administrator token. The only opt-in is "Run Orgtree as
  administrator", stored in HKLM and written through UAC, never in the data folder (agents
  can write there). [decided: user 2026-09-09, 2026-09-30; verified:
  `apps/desktop/main/runasadmin.ts`, `engine/service_host.py`]
- **The engine runs at Windows High priority** so busy apps cannot starve it. [decided: user
  2026-10-04; verified: `engine/launch.py`]
- **Untrusted output never gains privileges.** Agent Markdown, HTML and presentations get no
  desktop bridge; the desktop token never reaches provider or MCP children; each agent's
  credential is bound to its org, node and generation. [decided: user 2026-09-05; engine
  contract]
- **Agent children never inherit the engine's storage variables.** A script an agent runs
  must set its own throwaway `ORGTREE_DATA` before importing `store`, or the import raises.
  Bind it before importing any `orgtree` module (`store.DATA_ROOT` binds at import).
  [verified: `engine/backend/orgtree/devguard.py`]
- **Startup deadlines measure silence:** 60 s for the desktop and 120 s for the boot host
  between structured progress checkpoints; every migration and conversion step runs under a
  `database-convert…` phase with a one-hour window. Long startup work must emit checkpoints:
  alpha.1 died on this. [decided: user 2026-10-05; verified: `apps/desktop/main/policy.ts`,
  [`docs/startup-budget.md`](docs/startup-budget.md)]
- **One failing org never stops the others.** It becomes `unavailable` with its reason and a
  Retry; only a failure of the app database or of the accounts refuses the whole start.
  [decided: user 2026-10-02 (Q12); §2.12, §2.13]

### Desktop and renderer

- **Move previews preserve sibling order:** native moves retain `ui_order`, creation
  time and ordinal. Record projection and pending moves share the comparator in
  `treeorder.ts` (then Python Unicode name order); keep the tie-break fields on the
  projected node so row and circular previews match confirmation. [verified-from-source
  2026-10-06: `orgdb/native_move.py`, `orgdb/agents.py`, renderer `recordprojection.ts`,
  `canvas/shared.ts`]
- **Local move refresh:** after a successful move response is parsed, flush its
  pending livebus bump on the next task and cancel the delayed duplicate. Other mutations
  and later events retain 120 ms coalescing. Initial loading and record/runtime
  ordering are unchanged. [verified-from-source 2026-10-06: renderer `api.ts`,
  `livebus.ts`, `move-refresh.test.ts`; recorded-decision: move-latency item]

- **Circular layout order:** in the circular org chart, siblings (rings, the agents list and
  the floating jump cards) follow tree order counterclockwise; never sort them by x/y
  position. Only the row layout orders siblings by position. Jump-card adjacency uses
  this order, but each card's side uses its neighbour's screen centre relative to the
  focused agent. Placement avoids the measured navigation HUD, including the card's
  expanded hover/focus width. [verified: `apps/desktop/renderer/src/canvas/OrgCanvas.tsx`,
  `canvas/shared.ts`, 2026-10-05]
- **Circular sibling arcs:** parent/arc-centre springs relax all depths together, so
  crowded subordinates push their superiors apart. Ordered collision projection keeps
  the 190 px pitch and wrap clearance without reordering. Existing ring radii still
  limit how closely arcs can align; only the existing capacity rule grows a radius.
  Up to 256 deterministic relaxation steps run per layout change, never per frame;
  unchanged numeric topology reuses one cached rest state, so status-only feeds
  do not restart the solver. Existing card springs animate to that rest state. [recorded-decision: user,
  2026-10-07; verified-from-source: `canvas/shared.ts`, `canvas/ringsprings.ts`,
  `canvas/ringarcs.ts`]
- **Window bounds at fractional DPI:** Windows can add an invisible frame allowance to a
  frameless window's size, even through `setBounds`, and Electron's `did-create-window` does
  not carry the original window features. Temporary desks pass their exact rectangle and
  `setExactPopoutBounds` measures and corrects the real bounds; pinning uses the modal's
  outer rectangle, and pop-out ends the modal only after the window adopts the desk.
  [verified: `apps/desktop/main/windows.ts`, `canvas/tempdesk.tsx`, `6e53697`, 2026-10-05]
- **CSS `app-region` is inherited,** and only `initial` stops it (`unset` and `none` do not):
  scrolled-out no-drag children once punched holes in the header's drag region. [verified:
  `apps/desktop/renderer/src/styles.css`]
- **jsdom does no layout.** Geometry, drag regions and native window behaviour need the
  Electron probes (`tools/test-*.mjs`), not renderer unit tests. [verified:
  [`docs/verification-recipes.md`](docs/verification-recipes.md)]
- **Never hand a jsdom element to an assertion** (`assert.equal(el.querySelector(s), null)`).
  When it fails, node's reporter serialises the element with its whole document and dies
  out of memory (`Array buffer allocation failed`, `Worklist::Segment::Create`) before
  any result, so a red control reports nothing. Reduce it first: `=== null`, `!!`, a
  `textContent` or an attribute. 2026-10-14 [verified: renderer
  `tests/attentionaudit.test.tsx` §5; measured again in batch round 439 on
  `toolclock-turn.test.tsx`]

## Product rulings

> Still binding for 4.0.0 except where [PLAN.md §10](docs/rust-engine/PLAN.md) or [DECISIONS.md](docs/rust-engine/DECISIONS.md) changes them (e.g. no lineage nodes, lean docket without review machinery, `orgtree_send_notice` → `orgtree_message notice:true`). (2026-10-06)

The user's standing rulings about how Orgtree behaves. The older ones (up to 2026-09-15)
are recorded in full in [`docs/v2-user-decisions.md`](docs/v2-user-decisions.md); new
rulings go here and on their ticket.

### Org, agents and topology

- **Scope containment:** a child's folders, tools and visibility always lie within its
  parent's. Moving an agent pauses audiences whose anchor is no longer an ancestor and
  restores them if it moves back; an explicit revoke is permanent; the move result is a
  short summary, and running turns finish. [decided: user 2026-09-12, 2026-10-04]
- `swap`, `subjugate` and `move_batch` stay agent-only, with no operator door.
  `self_subjugate` is a subtree promotion: the target rises with its own team, its team
  charter does not transfer, and grants are untouched. Inserting a superior has one
  implementation (`insert_parent`). [decided: user 2026-09-12, 2026-09-15]
- **Credits:** grants are whole credits (rounded up when a raise saturates a superior);
  seats may be fractional with a 0.10 floor; "a promo never sets a seat"; the user is the
  root with unlimited credit. [decided: user 2026-09-03, 2026-09-04]
- Retiring keeps history, and rehire restores the agent. Retire, dissolve and compaction
  stop an agent's background tasks. [decided: user 2026-09-29]

### Turns, mail and notices

- Delivering a message never interrupts a turn; only an explicit interrupt does. Mid-turn
  mail arrives at the next safe tool boundary or at the turn's result boundary. An accepted
  message is injected once or queued, never neither; "delivered" is final only when the
  provider transcript shows it. [decided: user 2026-09-03, 2026-09-05;
  [`docs/mail-delivery-boundaries.md`](docs/mail-delivery-boundaries.md)]
- Notices never start a turn. Status reports (`orgtree_status`) arrive as passive notices;
  anything that needs action is a question. [decided: user 2026-10-03]
- Unrecorded hook claims are released at startup after transcript reconciliation
  and proof that their engines and children ended. Failed steer-fetch commits
  restore FIFO carriers; pump lock timeouts retry. Inbox fetch reads inflight
  content through a chunk handle without changing its delivery owner.
  [verified 2026-10-05: `mailruntime.py`, `supervisor.py`, `inbox.py`;
  details: `docs/mail-delivery-boundaries.md`]
- A mid-turn model switch is queued for the next turn (an interrupt applies it at once). A
  switch to another provider is a lineage split and asks for confirmation. [decided: user
  2026-08-29, 2026-09-03]
- Warm processes: one parked CLI per live agent, started at boot and on hire; no idle reaper
  or cap; warming is a user setting, on by default. [decided: user 2026-08-30, 2026-09-26]
- After a crash or restart, agents that were mid-turn resume with session continuity, and
  uncertain tool results are reconciled, never repeated. [decided: user 2026-09-07]
- **Live compaction row** (docket show-a-live-compacting-for-xs-event-while-an-age): when a
  harness reports a provider compaction's start (Claude Code `system` status `compacting`,
  Codex `contextCompaction` item, Muse `compaction` item `inProgress`) the actor appends one
  desk row (`kind: compact`, `compact_state: running`, `compact_started_at` = the engine's
  receipt time) and its end closes the same row (`done`/`failed`, `compact_ended_at`); an end
  with no start adds the old finished row with no times. A CLI exit or a turn ending
  mid-compaction closes it `interrupted` with no end time, and `convo::close_open_compactions`
  does the same at engine start for rows a killed engine left `running`. No start or duration
  is ever invented, and harnesses that report no start (Antigravity, OpenCode, OpenRouter,
  language servers) show nothing. Transcript only; cheap compact is a different thing. The
  desk counts up with `CompactingLine` (`toolclock.tsx`). [decided: user 2026-10-15; verified:
  `tools/rig/proofs/compaction-live.mjs`; the CLI events are from the 2.1.292 binary and
  the Codex 0.160 schema, not a live run]

### Docket, questions and attention

- A ticket is identified only by its readable slug. Its description states the problem
  first, then the solution, and is its authoritative scope; decisions are append-only.
  Assignment is ownership. [decided: user 2026-09-05, 2026-09-12]
- `review` means review by agents. The user is reached through an attached question or the
  attention flag, which stays up until the user replies or dismisses it or an agent takes
  it down explicitly; a dismissal moves the ticket to `blocked`. [decided: user 2026-09-05,
  2026-09-19]
- Dropped tickets archive at once; done tickets an hour after their last update. There is
  no `waiting` status; `blocked` states its reason. Over-long fields are refused, never cut.
  An item's earlier holders are readable only while you are listed on it. [decided: user
  2026-09-04 to 2026-09-16]
- These rules are written into the managed agent instructions in `supervisor.py`. Editing
  those strings changes every agent's cached prompt, so batch such changes and say so.

### Providers, accounts and usage

- Provider, model, harness, account and route are separate concepts, and provider
  differences are shown honestly. [decided: user 2026-09-05]
- Accounts are machine-wide and symmetric (any org may use any account), except legacy
  org-key accounts, which keep their origin org. Account ids are immutable; the primary
  account shows as `default`. An account at its limit waits; fallback to another account is
  opt-in per agent (off by default) and keeps the new account; API-key accounts are an
  off-by-default last resort. Agents choose the account on hire, rehire, retool and staff;
  usage readings guide them but are never a server-side admission gate. [decided: user
  2026-09-07 to 2026-09-12; [`docs/v2-user-decisions.md`](docs/v2-user-decisions.md)]
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
- A provider that is not installed is absent from the UI; installed but signed out shows
  greyed hire tokens; a disabled provider refuses new hires while live agents keep running.
  Legacy models (Terra, Gemini Pro) appear only with "Show legacy models". [decided: user
  2026-08-30, 2026-09-30]

### Desktop UI

- Performance comes before UI work; keep and improve the existing layout rather than
  redesigning it. [decided: user 2026-09-07, 2026-09-26]
- Every app-generated time is shown in the user's local time zone; no visible UTC.
  [decided: user 2026-09-04]
- One main window per org; opening an open org focuses it; startup restores the previous
  windows; a saved window whose org is gone opens as an error window. Pinned means pinned.
  [decided: user 2026-09-04, 2026-09-21]
- Notifications default to needs-attention only (questions, urgent mail, ticket attention).
  Clicking a file link reveals the file in Explorer and never opens or runs it. [decided:
  user 2026-09-07, 2026-09-13]

### Installer, updates and data

- PostgreSQL ships inside the installer, with its data under `<data>\pg`. Uninstall keeps
  data and history; history, documents and work records are kept until the user removes
  them. [decided: user 2026-09-07, 2026-09-26]
- Automatic updates (on by default) check in the background and install only at a safe idle
  point (engine idle plus 60 s of user inactivity), never interrupting a turn. [decided: user
  2026-09-07; verified: `README.md`]
- An upgrade never modifies the old data: the legacy database and files are kept for one
  release, so rolling back means running the old build again (from 2.1.14, also move
  `pre-postgres/orgs` back). 3.2.0 never touches the old org markers in `orgs/`. [decided:
  design §3.9, §5.3]

## Development workflow

> **3.x Python engine — legacy** (branch `dev`, P03 lock, test baseline, Python runner, source audits, push and ls-remote). For 4.0.0: local `rust-engine` branch, hand-in through the coordinator, no unit-test suites, never push — see the 4.0.0 section. (2026-10-06)

### Branches and worktrees

- **Development branch changed to `dev`** on 2026-10-05, created from v3.
  `v3/3.0.0-alpha.0` is frozen at `318fc45`; never push new work there.
  [decided: user 2026-10-05; verified: coordinator-confirmed remote refs]

- All work lands on `dev` by fast-forward. `main` is moved to `dev` at each
  release, and releases are cut from it; the user's README-only commits go to `main` first
  and are cherry-picked to `dev`. 2.x maintenance lives on `release/2.x`. [decided: team
  charter; user 2026-09-30; verified: [`docs/windows-release.md`](docs/windows-release.md)]
- Worktrees: `python tools/worktree.py add|verify|remove`; `remove` refuses when it finds a
  link leading out of the worktree. Settle overlapping files with the agent whose ticket
  owns them; never edit another agent's files. [verified:
  [`docs/worktree-operations.md`](docs/worktree-operations.md); decided: team charter]

### Tests

- **Renderer app-feed fixtures:** legacy HTTP mocks must explicitly return 501 for
  /api/app/records via legacyAppBackend; a generic 200 is not an unsupported engine.
  Capable fixtures send an app socket baseline and runtime frames, including values
  arriving after an empty baseline. [verified 2026-10-06: appfeed-fixture.ts,
  appvalues.test.tsx, packages/contracts/app-feed-connection.ts]


- **Python:** `python tools/run-python-verification.py tests/test_X.py [...]` gives each module
  a fresh interpreter in isolated mode and a fresh `ORGTREE_DATA`, with a 300 s default
  timeout per module (`--timeout`). Compare `failed_tests` names between base and tip. A
  worktree has no `engine/runtime`; the runner finds the main checkout's interpreter by
  walking up, and anything else should use that interpreter (or
  `npm run runtime:stage -- --from <checkout>`). PostgreSQL tests skip unless
  `ORGTREE_TEST_PG_ADMIN_URL` is set: a skip is not a pass. Spawn child processes with
  `tests/child_python.argv`. [verified]
- **Node and renderer:** `npm test` (root `tests/*.test.mjs`), `npm run test:renderer`
  (`apps/desktop/renderer/tests/run.mjs`, whose filters are substrings and OR together),
  `npm run typecheck`; keep `ORGTREE_TEST_CONCURRENCY=4`. Also run any renderer count or
  inventory test your change could affect. `run.mjs --output DIR` creates a `node_modules`
  junction inside DIR, so never point it into a worktree; `--prebuilt DIR` creates none.
  [verified: `package.json`, `apps/desktop/renderer/tests/run.mjs`]
- The PostgreSQL subtree renderer test runs only when its Python parent supplies
  `ORGTREE_RECORD_SUBTREE_FIXTURE`; plain renderer runs skip it. [verified 2026-10-05:
  `apps/desktop/renderer/tests/recordpgsubtree.test.ts`, `tests/test_orgdb_record_subtree_pg.py`]
- **The baseline:** `node tools/test-baseline.mjs show` (or `npm run test:known-failures`)
  lists known failures and runs nothing. `compare` and `record`, `npm run test:compare`,
  `npm run test:baseline:record`, `npm run verify:release` and `npm run release:windows`
  all run the full suites: coordinator or release owner only. [decided: user 2026-09-26]
- **Per landing:** run only the modules your change touches, at base and tip, each call under
  20 minutes; land if no new test name fails. After a rebase that only moved the base,
  re-run only tests touching files that changed on `dev` in between. [decided: team charter]
- **The machine lock:** one heavy run at a time on the whole machine (scale runs,
  rehearsals, database batches, and any test stream that creates or drops PostgreSQL
  databases: each `DROP DATABASE` waits for a checkpoint, and two such streams stalled the
  cluster on 2026-10-02; concurrent suite runs crashed the machine on 2026-09-18). Use
  `tools/p03-run.ps1 -Agent <you> -Wait -Run @('python', '<script>', ...)`; `-Status`
  prints JSON; `-Small` allows two small runs; `-Dequeue` drops all of your entries.
  [decided: team charter; verified: `tools/p03-run.ps1`]
- **Memory (this machine):** start a run only with 15 GB of free commit memory and stop below
  10 GB; a single static source-scan module may start at 10 GB (`-MinFreeCommitGB 10`). Wait
  with `-Wait` or a watchdog, not by polling. [decided: team charter]
- **Your own PostgreSQL cluster:** drive E: syncs slowly (about 3 s per fsync, 2026-10-03), so
  set `fsync`, `synchronous_commit` and `full_page_writes` to `off` on your own disposable
  cluster only, never the live one or anyone else's. The live-data copy
  (`artifacts/livecopy-20261002/`) loads only into such a cluster under the lock; drop the
  databases afterwards and never commit or copy it. [decided: team charter]
- **Risky code** (locking, transactions, leases, queues, data import, halt, the killswitch):
  reviewers break the code on purpose and check that a test fails ("mutants"); race fixes
  come with two-session barrier tests; `org_tx` silently retries deadlock victims, so race
  tests run with retries off. [decided: team charter; design §9]

### Reviews and landing

1. An independent reviewer records `approve_stage` on your exact commit; the coordinator
   grants the landing (often pre-granted in the ticket). The reviewer never lands.
2. Rebase onto the current `dev` and check `git range-diff` (all `=`, or explain each `!`).
3. Re-run your targeted tests, then `python tools/source-audits.py` (about a minute, no
   database): the one import-guard line in every test module, hub isolation, the
   child-spawn allowlist, duplicate definitions and BOMs, and the native vector anchors. If
   you changed `ledger.py`, `api.py`, `agentauth.py`, `openrouter.py` or `opreceipts.py`, run
   the affected crate's vector test; regenerate with the main checkout's
   `engine\runtime\python.exe engine/native/<crate>/oracle/generate_vectors.py --write`
   only if it fails on the anchors alone. Any other difference means an encoded rule
   changed: stop and find out why. [verified: `tools/source-audits.py`]
4. Fast-forward push (`git push origin HEAD:refs/heads/dev`), then put the
   `git ls-remote origin refs/heads/dev` output in your claim note. The
   docket's `pushed` claim checks the installed app, not this repo, so it refuses; record
   the ls-remote line as evidence instead. [decided: coordinator 2026-10-03]
5. Update this file if you found a gotcha, an invariant or a ruling.

Never rewrite pushed history or force-push. [decided: team charter; user 2026-10-03]

### Evidence and reporting

- Label every claim measured (you ran it and saw it) or inferred. Quote the module's own
  `Ran N tests … OK` line; treat zero executed tests as "did not run".
- Check that a control can fail: plant the fault, see red, restore. A guard that passes with
  the guard removed is worthless.
- Keep `breadcrumbs.md` in your scratch folder current; it is what a successor reads.
- Crash forensics: the engine logs to `<data>\diagnostics\engine.log` (with
  `engine-stall-stacks.txt` and `engine-liveness.jsonl` beside it); for a silent death,
  check the Windows event log, `update-log.json` (updater and installer) and
  `Crashpad\reports\` (Electron). The hardware has a history of memory faults: consider that
  only after the ordinary causes. [verified: `engine/enginelog.py`, `engine/stall_watch.py`]

## Releases, builds and updates

> **3.x — legacy.** 4.0.0 prototype builds (`4.0.0-alpha.N`) are built and installed by the user only ([DECISIONS 37–38](docs/rust-engine/DECISIONS.md)). (2026-10-06)

- Only the coordinator and the release owner it names build, tag, publish or install.
  [decided: team charter]
- **No build or publish until the whole 3.2.0 rewrite has landed**, apart from local alpha
  builds for the user. [decided: user 2026-10-02]
- **Alphas are local and never published:** no tag, no GitHub release, no updater feed. They
  are built from a side branch and delivered as a file. Release notes never name
  unpublished builds. The alpha number counts delivered builds. [decided: user 2026-09-30,
  2026-10-02]
- **Public releases** are cut from `main` with `npm run release:windows -- <version>
  --publish`, which verifies one exact candidate before any tag or GitHub change, then
  publishes a normal (not prerelease) release with six canonical assets. Without
  `--publish` it is local only. The version lives in `package.json` and both
  `package-lock.json` fields, and needs `docs/release-notes-<version>.md`; `-RCn` labels are
  refused. [verified: [`docs/windows-release.md`](docs/windows-release.md)]
- **Every upgrade path is tested:** 3.2.0 must upgrade from 2.1.14, 3.0.9 and 3.1.0, with
  converter rehearsals on real-data copies before an alpha and installer upgrade rehearsals
  plus a rollback before the publish. [decided: user 2026-10-02, decision 14]
- **Dev builds** (`npm run package:dev`) install beside the published app under their own
  identity and data folder. [verified: [`docs/dev-builds.md`](docs/dev-builds.md)]

## Machine traps

Read the authoritative built-in [machine traps page](docs/skills/orgtree-working/workspace/machine-traps/SKILL.md)
before shell or file-edit work on this Windows machine (orgtree-working > workspace
> machine-traps). It owns escaping, CRLF, Git Bash/WSL paths, encodings, Edit-tool
quirks and rerere/mojibake; `docs/machine-traps.md` is a compatibility pointer.
Current build/worktree workflows are linked there; the old Python/P03 recipes
are explicitly historical. [decided: user/coordinator 2026-10-16; verified:
`.gitattributes`, `docs/skills/orgtree-working/workspace/machine-traps/SKILL.md`]

## Gotchas in Orgtree's own agent tools

> Written against the 3.x engine's tools. Under 4.0.0 the tool set and docket changed ([PLAN.md §6, §10 F and P](docs/rust-engine/PLAN.md)): no reservations, review seats, `approve_stage`, acceptance checks or relaunch tools. (2026-10-06)

Agents that build Orgtree also run on it; these bite repeatedly. [verified: agents' notes
2026-08 to 2026-10]

- **Mail that arrives while a subagent (the Agent tool) runs is injected into the
  subagent's tool result.** The parent never sees it, and `orgtree_inbox fetch` returns
  `already_moved` until the next turn. Check your inbox after subagents finish. [verified
  2026-10-05]
- `orgtree_send_notice` never starts a turn; an idle agent reads it only when something else
  wakes it.
- A timed-out mutating call may have applied ("UNKNOWN"): re-read before repeating, and use
  `expected_rev` on docket writes.
- Docket: field names differ per action; caps of 40 artifacts and 50 evidence rows per item;
  `artifact_read` and `orgtree_read_scratch` stop near 20,000 characters; use `fields=[...]`
  or a projection on large items.
- Watchdog command targets run in `cmd.exe` unless `shell: "bash"`; read the create-time
  smoke output; a dog aimed at a retired agent never fires.
- Never put a headless agent in plan mode: it blocks every orgtree tool.
- Claude agents see tools as `mcp__orgtree__<tool>`; Codex and Gemini register bare names.

## Removed and dead ideas

Do not rebuild, re-propose or "restore" these without a new ruling from the user.

| Idea | Status | Source |
| --- | --- | --- |
| Kiosk mode (public renderer and visitors) | Removed on v3 for 3.2.0 (published 3.0.x and 3.1.0 still contain it); no feed path, tables or columns | [decided: user 2026-10-02, design decision 17] `dba5f5c` |
| Per-org Docker sandbox, org disk, bridge, frozen profile | Removed on v3 for 3.2.0. The converter keeps the org-level `sandbox` key for the credential catch-up. Codex's and Antigravity's own CLI sandboxes are different and stay | [decided: user 2026-10-02] `3f379f4`, `ab95345` |
| Orgtree v1 import | Deprecated: the App settings Import tab is gone; the engine's import routes are still present, pending removal. The 2.x first-launch conversion stays | [decided: user 2026-09-29] `e2a112f` |
| SQLite as primary storage | Replaced by PostgreSQL in 3.0. SQLite remains for side stores (transcript records, chat-window index, the mail hub) and for converting 2.x data | [decided: user 2026-09-25] |
| A Rust port of the engine | **Superseded 2026-10-06:** Orgtree 4.0.0 is a ground-up Rust engine (`engine/rs/`), designed from the renderer's contract, not a port of the Python code or of the shelved `engine/native/store*` prototype | [decided: user 2026-10-06, DECISIONS 1–2; earlier deferral 2026-09-27 to 2026-10-01] |
| The 3.2.0 Python data-model rewrite (per-org databases, `org_tx` lock order, record feed in Python) | Stopped; 4.0.0 replaces it. The 3.x sections of this file describe it as legacy | [decided: user 2026-10-06 18:53Z] |
| Windows service mode | Dropped; boot start stays the scheduled-task host | [decided: user 2026-09-29] |
| A bounded pool of warm processes | Not built; warming is a user setting | [decided: user 2026-09-26] |
| A separate "Orgtree Private Alpha" app identity | Dropped: v3 installs as normal Orgtree over 2.x | [decided: user 2026-09-28] |
| Design rev 5's `org_topology` lock row | Withdrawn in rev 7.8 (it broke the lock order) | [decided: design rev 7.8] |
| A seat table / one "head" per lineage | Withdrawn in rev 6: one `agents` row per node | [decided: design rev 6] |
| A stored "Sent tail" key on mail rows | Withdrawn in rev 7.5: the reader computes it | [decided: design rev 7.5] |
| Archived docket totals in agents' list calls | Removed: only with `include_archived` | [decided: user 2026-10-02, decision 21] |
| A 2.1.13 hotfix for the 2.1.9–2.1.12 lost-save bug | Not made: the fix is v3 only | [decided: user 2026-09-27] |

## Where the detail lives

- **Start here:** [`pg-data-model-design.md`](docs/state-system/pg-data-model-design.md) (the
  3.2.0 design, every finding and decision), [`machine-traps.md`](docs/machine-traps.md),
  [`worktree-operations.md`](docs/worktree-operations.md),
  [`known-failures.md`](docs/known-failures.md) (the baseline and the import-provenance
  trap), [`engine-contract.md`](docs/engine-contract.md) (desktop–engine transport, tokens,
  attach), [`v2-user-decisions.md`](docs/v2-user-decisions.md) (user decisions up to
  2026-09-15; newest entry wins).
- **3.2.0 data model** (`docs/state-system/`): `pg-o1-move.md` (the O(1) move),
  `pg-step6-record-feed.md` (the record feed), `pg-columns-audit.md` (measured costs on the
  live copy), `docket-bounded-readers.md`, `org-enum-inventory.md`,
  `pg-o1-scope-consumers.md`; conversion and runtime in `pypg-cutover-runbook.md`,
  `pypg-cutover-verification.md` and `pypg-packaged-runtime.md`.
- **Engine behaviour:** `agent-halt.md`, `mail-delivery-boundaries.md`,
  `frozen-turn-lifecycle.md`, `mcp-connection-recovery.md`, `assistant-message-identity.md`,
  `foreground-tree-api.md`, `startup-budget.md`, `scope-diagnostics.md`,
  `provider-capability-evidence.md`, `antigravity-provider-parity.md`,
  `copy-title-surfaces.md` (all in `docs/`).
- **Process and release:** `verification-recipes.md`, `windows-release.md`, `dev-builds.md`,
  `update-rehearsal.md`, `mailhub-sync.md`, and the release notes (latest
  `release-notes-3.1.0.md`).
- **History** (v1/v2 era; do not use for current behaviour): `v1-parity-inventory.md`,
  `v2-acceptance.md`, `v2-import*.md`, `v2-original-design-brief.md`,
  `supplied-design-decisions.md`, `alpha-6-handoff.md`, `performance-2026-09-09.md`,
  `private-alpha-packaging.md`, `engine/docs/state-access-rearchitecture.md`.

**Stale statements to ignore** (each superseded as shown):

- `docs/known-failures.md` tells every agent to run `compare`: only the coordinator or
  release owner does (user 2026-09-26).
- `docs/verification-recipes.md` shows a bare `python -m unittest` for backend tests: use
  `tools/run-python-verification.py`.
- `docs/worktree-operations.md`: `--base` defaults to `main`; pass
  `--base origin/dev`.
- `docs/engine-contract.md` predates PostgreSQL and the account system. It is still right
  for transport, tokens and attach, but the app does elevate (through UAC) when the user
  changes the Run-as-administrator setting, and an explicit Quit stops an attached engine.
- `engine/README.md` describes an `ORGTREE_V1_ROOT` launch input that the desktop no longer
  provides.
- `docs/state-system/pypg-packaged-runtime.md` speaks of an "external cutover", and
  `postgresql-qualification.md` of PostgreSQL "not adopted": both are superseded by the
  automatic first-launch conversion.
- `docs/v2-user-decisions.md` and `engine-contract.md` name a GitHub prerelease channel:
  public releases are normal releases.
- `docs/v3-qualification.md` and `synthetic-migration-harness.md` exercise the SQLite-era
  layout, not the per-org databases.

Abandoned-docket recovery processes at most eight predicted items per org per tick,
uses the standard docket lock and bounded recipient locks, and rechecks ownership and the
destination under those locks. Mail uses the standard send declaration; missed writes
widen only after rollback. Failures back off from 60 seconds to 15 minutes per org;
successful passes clear the backoff. No all-node recovery lock is taken.
[verified 2026-10-05: `supervisor._abandoned_docket_recovery_pass`, `worktx.py`]

- Recovery prediction uses the archive projection, including owner and both freshness
  timestamps; reassignment retains full records and rejects prediction mappings.
  Never pass a projected row to a write. [verified: `ledger.py`, `supervisor.py`;
  decided: drag-opus 2026-10-06; `tests/test_orgdb_abandoned_recovery_pg.py`]

Warm-pool eligibility shares one lazy NativeInventory per keeper pass through transcript lookup. It is never retained across passes; per-session path validation and ad-hoc lookup freshness remain unchanged. [decided: drag-opus 2026-10-06; verified: `warmpool._keeper_pass`, `desktop_native.native_path_for_session`]

Cold archived docket projections covered by the existing policy spec use its typed decoder and policy extra, not full item/event reconstruction. The same snapshot retains pending moves/deletions and archive sequence order; uncovered fields use the full compatibility reader. [decided: drag-opus 2026-10-06; verified: `orgdb/compat/sql.py` `_project`]

- 2026-10-07 (verified-from-source): top-level rescind is supported by Rust `domain/ops.rs` and 3.x `ledger.py`: archive the subtree, with no superior grant to reduce. Agent settings shows it for every live agent and explains that case in its confirmation. See `docs/rust-engine/agent-settings-refresh.md`.

- 2026-10-07 (verified-from-source): agent settings MODEL_VERSIONS includes Haiku 5.5/4.5, matching Rust providers/catalog.rs. The current tree payload does not expose version choices; keep the renderer fallback table synchronized. Model/version/effort/account changes remain staged until Save.

- 2026-10-07 (recorded-decision): model choices in settings/hire/rehire share modelChoiceLabel and modelChoiceTitle. Enabled options show only model and seat; known OpenRouter capabilities move to tooltips, unknowns are omitted. Disabled choices retain a visible refusal-reason suffix and tooltip (coordinator clarification18:56Z), without changing provider/login/favorite gates. Shared settings selects cap intrinsic width.

- 2026-10-07 (verified-from-source and mounted renderer): direct children of agent settings (.settings.cfg) must not flex-shrink. Different tab heights otherwise compress the shared Name/Agent actions rows and shift the tab strip; let the panel scroll instead.

- 2026-10-14: Logo cropping uses a pointer/keyboard square over the native preview; x/y remain fractions of available top-left travel. Keep native decoding and original-byte save semantics. Hubchat carries the matching editor. Source-only verification handoff: [crop contract](docs/rust-engine/crop-square.md). [decided: user 2026-10-14; verified from source: canvas/SquareCrop.tsx, cropmath.ts]

### MCP imports from installed harnesses (2026-10-15)

- External MCP discovery reads explicit user configs from Claude Code, Codex,
  Antigravity, Muse and OpenCode; no harness launch, project scan or config write.
  Equal definitions merge provenance; differing names retain both with suffixes,
  Claude first for existing grants [decided: user 2026-10-15]. Settings Refresh
  rereads definitions without touching active processes. Renderer metadata is an
  allowlist (name/source/transport), never definition values. Reference paths,
  normalization and OAuth limits: [MCP imports](docs/rust-engine/mcp-imports.md).
  [verified: `engine/rs/orgtree-engine/src/providers/mcp.rs`]

### Shared skills and installed plugin imports (2026-10-15)

- Shared snapshot cleanup keeps the current global digest, the newest other
  complete snapshot (timestamp ties too), and managed session/launch/grant paths.
  A bounded owner task registers process tokens before materialization; tokens
  live through warm CLIs and cache keepalives. Current-session metadata persists
  across restart; unknown legacy bindings or unreadable references defer cleanup.
  Only owned, link-free direct children of `shared-skills` are removed; abandoned
  owned stages need an age over one hour. No live profile/OS-process scan.
  [verified: `providers/skills/retention.rs`, `runtime/actor.rs`; decided:
  coordinator 2026-10-17; details: `docs/rust-engine/shared-skills.md`]

- Per-harness skill variants are selected only for each agent's export, preserving
  the complete inventory and user source files. Declared harness suffixes and
  native provenance choose the preferred family member; unpaired guides and
  equally preferred same-source resource collisions remain available. Launch,
  idle checks and forecasts share the selected digest. See
  [variant selection](docs/rust-engine/shared-skills.md#per-harness-variants-2026-10-17).
  [decided: user 2026-10-17; verified: `providers/skills.rs`, `runtime/actor.rs`]

- Skill discovery reads installed native roots and recorded Claude plugin installs,
  never marketplace listings or generated copies. Whole bundles deduplicate by
  content; differing names receive suffixes, with built-in names taking priority.
  Native exports are immutable or replaced only at process boundaries; unchanged
  content keeps the startup fingerprint stable. Public metadata excludes contents
  and paths. Built-in category entries alone live in native discovery roots;
  nested SKILL.md guides/resources are embedded and exported outside those roots
  with links preserved. One Settings Refresh covers MCP, skills and global notes.
  [decided: user/coordinator 2026-10-15; verified: `providers/skills.rs`,
  `providers/plugins.rs`, `runtime/actor.rs`; contract and limits:
  `docs/rust-engine/shared-skills.md`]
- Launch, idle recheck and forecast must use the same combined instruction/skill
  startup digest; a raw-vs-combined comparison retires unchanged parked CLIs.
  The idle check retains applicable skill folders, not a frozen skill snapshot.
  [verified: `runtime/actor.rs`; regression: `tools/rig/proofs/skills-idle.mjs`;
  2026-10-15]

- Shared skill export validation covers every existing output ancestor and cached
  resource tree, including Windows junctions/reparse points; marker files never
  authorize following links. See shared-skills.md export guard.
  [verified from source: providers/skills.rs; rig review finding 2026-10-15]

- Waiting mail is bounded before opening/steering/hook delivery: rendered items
  over 64 KiB become inbox fetch/chunk references, and final text is split into
  ordered batches (Codex 1,000,000 UTF-8 bytes; unknown lanes conservatively
  256 KiB). Only already-admitted deferred notices can continue a budget tail;
  unrelated passive notices remain passive. Original mail stays unchanged.
  Length refusals report sizes on each actual attempt without self-retry.
  Generated oversized org/usage context stays in own scratch; handoff history is
  referenced, not copied. Limits and verification: [mail input budgets](docs/rust-engine/mail-input-budgets.md).
  [decided: coordinator 2026-10-15; verified: `engine/rs/orgtree-engine/src/runtime/prompt.rs`]

- Markdown image local paths accept only absolute drive-letter syntax and reject
  reparse-point components before opening; the opened handle must resolve to a
  regular file on a drive-letter path before reading. A local disk writer can
  still race component checks; this is a documented threat-model limit. See
  [Markdown image embeds](docs/rust-engine/markdown-image-embeds.md).
  [verified: `engine/rs/orgtree-engine/src/http/markdown_image.rs`, 2026-10-17]

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

