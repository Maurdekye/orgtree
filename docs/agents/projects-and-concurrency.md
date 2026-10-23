# Projects and concurrency

## Broadcast recipient boundary (2026-10-23)

Both desktop and tool pass through live project children and stop after delivering
to each live agent child. `projects::broadcast_members` owns both server paths;
preserve desktop depth/sibling ordering and its 1000 cap, and tool ID paging with
its upper-ID snapshot. The desktop preview/DnD list follows the same boundary;
header totals and Halt all remain full-subtree operations. Ordinary mail admission,
attachments, replies, urgency and audience behavior stay unchanged. See
[project nodes](../rust-engine/PROJECT-NODES.md#placement-and-runtime-capabilities).
[decided: user 2026-10-23, m7214fddbec4a, m24d383f0fe1b, mcc739e71d42b]

## Slots when agents leave the tree (2026-10-22)

Retire, dissolve and delete capture every affected agent's active lease and
waiting-claim project before pausing/removing its watchdogs. `slots::departing_projects`
uses 64-row keyset pages over active records; that page size is not a lease/project
limit. After commit, `slots::check` ends gone holders' whole leases as `retired`
and runs the existing strict FIFO grant path. This includes a waiting-only head
whose removal makes a smaller tail eligible without releasing any held lease.
History retains each lease's quantity and retirement reason. Halt's existing
reclaim path and user-owned leases are unchanged.
[decided: user 2026-10-22 22:18:24Z, automatic retirement release; coordinator
2026-10-22, dissolve/delete scope; verified: `domain/{ops,slots}.rs`, focused
`tools/rig/proofs/project-retirement-slots.mjs`]

## Full-depth project reporting (2026-10-22)

Migration 0052 replaces the fixed-depth `superior_of` and `live_superior_of`
lookups. Stable-row recursive unions terminate cycles without treating depth
1024 as the end of an organization. Structural reporting stops at the nearest
agent; runtime delivery skips inactive agents. Both stay within the original
organization and never return the subject as its own superior. Project wrappers
remain transparent, including when an agent is separated from its superior by
thousands of projects. Migration numbers may be reconciled at integration.
[verified: `0054_full_depth_superiors.sql`; 2026-10-22]

## Uncapped registrations and durable delivery (2026-10-21)

Queue allocation filters live/reachable canonical listeners and ACK capacity
before selecting a bounded service-ordered window; a query page is never a
registration limit. Sender-only jobs stay pending while later deliverable
jobs remain eligible. Reclaims and reminder changes bind the observed holder
and unique handed-copy id, then recheck custody and reclaim policy under the
project/job locks, including same-holder reassignment and transfers to the user.

Project events persist one history identity and registration high-water mark.
The registration bound uses an org/project/id index over every listener state;
paused registrations remain within the boundary while unrelated retained
watchdog history cannot lengthen its lookup.
Each transaction delivers at most 200 eligible rows and commits its mail,
one-shot changes, history and cursor together. Eligibility is checked when
the page is processed; paused/removed listeners are skipped. New registrations
after the high-water mark wait for the next event. Pending pages recover at
engine startup without synthesizing a second event.
Recovery requires both a current active organization row and an open engine
handle. Trashed or closed organizations retain their pending event/watch work
without allocating mail, spending registrations, claiming actions or waking
actors. Saved post-commit deliveries obey the same checks. Short delivery and
action-claim transactions hold a shared lifecycle row lock against trash;
arbitrary fire actions run after that transaction and recheck current openness.

Listener-watch edges enqueue durable fire obligations with their above marker.
The watch's spent state and notification mail commit atomically, including
user watches. Post-commit fire actions and wakes use a durable outbox; action
attempts are claimed before execution and never automatically repeated after
an interrupted attempt. Notification recovery does not duplicate the fire/mail.
Migration 0050 is additive. [verified: `domain/{projects,listeners}.rs`,
`migrations/0050_project_event_dispatch.sql`; coordinator 2026-10-21 23:10Z
approved processing-time eligibility]

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Project folders, policy, slots, listeners, watchdogs, queues and coordination.

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

## Current project/watchdog reference (2026-10-21)

The [area A source audit](../rust-engine/glossary-area-a-audit.md) records
4.4.0 workflow, team/project and watchdog coverage. It supersedes older
watchdog-count quotas: there is no per-agent/org number cap; eight is a
preview bound, not available capacity. Different actual parents still need
directional mail audiences despite a common reporting superior, and a
project-to-project bridge needs both projects' peer-mail switches ON.
Only live agent descendants block self-retirement. Use project configuration
for project policy; retool/model/account/launch controls target agents.
The glossary distinguishes user-owned holds/registrations from agent-owned
ones and records automatic one-shot completion separately from manual removal.
[verified: `engine/rs/orgtree-engine/src/domain/watchdog_inventory.rs:7`,
`:14`; `domain/peer_mail.rs:27`, `:45`; `domain/ops.rs:1859`, `:3441`;
`domain/ops/user_regs.rs:201`, `:232`, `:309`]

## Current mail-queue and dead-letter rules (2026-10-21)

User inbox deletion refuses an outstanding ACK job's exact handed copy with
HTTP 409 and names the existing ACK actions. The guard reads the current
project claim under project-then-job locks, so a stale copy's delivery metadata
does not block deletion after ACK or an ACK waiver. No delete implicitly ACKs;
the project original and history remain. User jobs have no release/NACK path.
[verified: `engine/rs/orgtree-engine/src/http/mailbox.rs`,
`domain/ops/user_regs.rs`; decided: coordinator 2026-10-21]

The [source audit](../skills/orgtree-workflows/collaboration-patterns/work-queues/source-audit.md) supersedes older
fixed-three-reminder and one-job-per-listener descriptions below; preserved
attributed records remain historical evidence. ACK batch is 1–20, default 1;
Ack reminders is 1–10, default 3, with reclaim at the next eligible checkup.
Max attempts is 1–100, default 3, enforced on reclaim while Runtime working
checkups are on. Project Ack timeout gates idle reclaim, not halt/retire,
listener-loss or manual take-back dead-lettering. The once-per-assignment
turn-end nudge is independent of those timeout switches and budgets.
[verified: `engine/rs/orgtree-engine/src/domain/projects.rs:43`, `:64`, `:90`,
`:651`, `:702`, `:834`, `:1312`; `runtime/actor.rs:7763`]

Dead-letter system mail traverses parent projects to the first real-agent
ancestor if live, else the user; members/senders are not all notified.
Reachable agents can independently observe `project.dead_letter`. Dead Letter
Line lists up to 200 matching armed/paused event watchdogs, not jobs; paused
rows receive no event, and its synthetic pattern preview omits job details.
The Dead letters tab needs a positive open count. Retry preserves history and
resets attempts; drop remains readable but cannot be retried directly. Project
inbox's dead-letter history filter includes dropped records. Purge affects
currently pending mail, including returned jobs, not held/ACKed/dead letters.
User-held jobs stay held until user ACK, including after queue departure.
[verified: `engine/rs/orgtree-engine/src/domain/projects.rs:608`, `:748`, `:810`,
`:875`, `:1462`; `domain/ops.rs:2627`, `:2724`; `domain/dead_letters.rs:170`;
`tools/project_inbox.rs:12`; `apps/desktop/renderer/src/canvas/projectdesk.tsx:87`]

## Slot admission and measured capacity (2026-10-21)

The user changed the old 64-unit limit to the seven-digit card-fit limit,
9,999,999 (migration 0049). Agents may hold multiple whole leases, with one
armed/paused pending claim per project; user pending requests all count.
Shared admission under the project lock refuses requests above capacity minus
the holder's own units and counted requests, including explicit resume.
This supersedes the earlier 1..64 and one-held-lease rules below. Anchor
allocation is lazy; lease rows reveal in batches of 100 and chips/lines
aggregate per agent/project. See [measurement](../rust-engine/slot-capacity-measurement.md)
and [read/write recipe](../skills/orgtree-workflows/collaboration-patterns/concurrency-primitives/SKILL.md).
[decided: user/coordinator 2026-10-21; verified: `domain/slots.rs`,
`runtime/watchdogs.rs`, `domain/ops/user_regs.rs`, renderer `canvas/slots*.ts*`]

## User queue ACKs, compact actions and event mentions (2026-10-20)

- Self-sent ACK jobs (`@user`, or retained data name `user`) acknowledge without
  sending a self-reply. The pane says **Acknowledge job**, explains that no mail
  is sent, and offers no reply text or attachment input. `user_job_ack` can keep
  a sent reply's ID, not a free-text completion note. Agent/external jobs retain
  reply-first behavior and failed sends still acknowledge nothing.
  [decided: user/coordinator 2026-10-20 21:35Z; verified:
  `canvas/{jobacks.ts,jobackpane.tsx}`, `domain/ops/user_regs.rs`]
- User queue rows keep **open mail** and **leave queue** as accessible names and
  help tooltips on icon buttons. The Working row groups them without wrapping;
  opening the user's mail copy and leaving while retaining held jobs are unchanged.
  [decided: user 2026-10-20 21:35:49Z; verified:
  `canvas/maillisteners.tsx`, `styles.css`, `tests/usermailqueue.test.tsx`]
- Project-event listener fire mail and event lines mention the project and firer
  as `@<name>`, retaining an existing `@user` or agent mention without doubling
  the prefix. The supplied payload, fire count, one-shot wording and delivery
  rules stay unchanged. [decided: user 2026-10-20 21:37:38Z; verified:
  `domain/listeners.rs`]

<a id="e-b19f3263632f4d67"></a>

## Per-target modals are one window per target: Mail, Docket, Team, Slots,

Original section: Unsectioned integration notes. Source lines 20–33.

<!-- preserved:e-b19f3263632f4d67 -->
- Per-target modals are one window per target: Mail, Docket, Team, Slots,
  Listeners, the settings gear, Watchdog detail, the project desk window and
  the readers key every store (pins, open markers, window rows, pin/pop
  requests) as `kind:target` (`modalkinds.ts`); the canvas keeps a list per
  kind (`canvas/modalinstances.ts`). The same target reveals its window; a new
  one never moves a pinned or popped-out sibling, replaces a centred one, and
  opens at its own placement, else the kind's template (last pin or move; an
  unpin clears it) cascaded 28 px, else centred. 20 closed placements kept.
  Readers: App's global one, one per agent/project, one per team; a document
  goes to an open reader that can show it in a fixed order
  (`canvas/readers.ts`), else to its own agent's. Single-instance records
  migrate on first read. [decided: user 2026-10-20 17:24:20Z, 19:03:28Z,
  19:05:36Z, coordinator 18:58:51Z; verified: `tests/modalinstances*.test.tsx`,
  `tests/readers*.test.ts*`]
<!-- /preserved:e-b19f3263632f4d67 -->

<a id="e-986f9b7d10b5b675"></a>

## Project canvas cards and desk-header chips show only their own documents,

Original section: Unsectioned integration notes. Source lines 35–40.

<!-- preserved:e-986f9b7d10b5b675 -->
- Project canvas cards and desk-header chips show only their own documents,
  matching the Presented tab. Team presentations still includes descendants;
  agent cards are unchanged. This replaces the 2026-10-17 subtree-chip rule.
  See [project presentation scope](../../docs/rust-engine/PROJECT-NODES.md).
  [decided: user 2026-10-20 18:58:05Z; verified: `canvas/{projectcard,projectdesk}.tsx`,
  `tests/teampresent.test.tsx`]
<!-- /preserved:e-986f9b7d10b5b675 -->

<a id="e-765289ad334e5812"></a>

## Retired pile rows use project folder badges and label complete project-only

Original section: Unsectioned integration notes. Source lines 42–45.

<!-- preserved:e-765289ad334e5812 -->
- Retired pile rows use project folder badges and label complete project-only
  cohorts as projects. Mixed or incomplete cohorts use "retirees"; search/page
  results never imply the kind of the whole pile or trigger extra history reads.
  [verified: `canvas/modals.tsx`, `tests/retiredpages.test.tsx`; 2026-10-20]
<!-- /preserved:e-765289ad334e5812 -->

<a id="e-e2c9a7b23d402832"></a>

## Project desk reopening uses the agent desk's camera/pin/window reveal routes.

Original section: Unsectioned integration notes. Source lines 54–59.

<!-- preserved:e-e2c9a7b23d402832 -->
- Project desk reopening uses the agent desk's camera/pin/window reveal routes.
  Its inline canvas desk needs stationary-release arbitration because viewport
  pointer capture retargets the click; drags/cancels/controls/selections stay
  untouched. Match project popouts by org and node; keep modal tabs and drafts.
  [decided: user 2026-10-20 18:35Z; verified: `canvas/OrgCanvas.tsx`,
  `canvas/deskhosts.tsx`, `tests/project-refocus.test.tsx`]
<!-- /preserved:e-e2c9a7b23d402832 -->

<a id="e-615f7e44b1b427ba"></a>

## Project Mail queue leave actions live on the user's rows, never a separate

Original section: Unsectioned integration notes. Source lines 61–65.

<!-- preserved:e-615f7e44b1b427ba -->
- Project Mail queue leave actions live on the user's rows, never a separate
  top toolbar. Full ACK batches leave from Working rows while still joined;
  leaving keeps held jobs. The header's join/count control stays unchanged.
  [decided: user 2026-10-20 18:22Z; verified: `canvas/maillisteners.tsx`,
  `tests/usermailqueue.test.tsx`]
<!-- /preserved:e-615f7e44b1b427ba -->

<a id="e-523c0c9ff8c80693"></a>

## Mail-list monitor senders use the matching typed watchdog reference's name,

Original section: Unsectioned integration notes. Source lines 67–71.

<!-- preserved:e-523c0c9ff8c80693 -->
- Mail-list monitor senders use the matching typed watchdog reference's name,
  as the opened event card does, with the full handle in the hover title.
  Sender search includes both name and stable ID; raw mail routing is unchanged.
  Keep recorded names for spent monitors; missing names fall back to IDs.
  [verified: `canvas/mail.tsx`, `tests/monitor-sender.test.tsx`; 2026-10-20]
<!-- /preserved:e-523c0c9ff8c80693 -->

<a id="e-3f0d4920f320f0ce"></a>

## Selected team/project dockets retain requested retired-owner selections after

Original section: Unsectioned integration notes. Source lines 117–123.

<!-- preserved:e-3f0d4920f320f0ce -->
- Selected team/project dockets retain requested retired-owner selections after
  found/missing answers, until those owners leave the loaded groups or the
  org/root/team scope changes. Releasing a fulfilled selection removes its
  answer and causes a request/render loop. Selection updates are atomic, not
  release-then-add; membership still follows fresh tree ancestry. The pending
  hint is outside list flow. [verified: `canvas/agentdocket.tsx`,
  `tests/docketmembership.test.tsx`; user report 2026-10-20]
<!-- /preserved:e-3f0d4920f320f0ce -->

<a id="e-0a943dac6941b095"></a>

## Node placement accepts projects for descendant promotion and explicit restore

Original section: Unsectioned integration notes. Source lines 145–151.

<!-- preserved:e-0a943dac6941b095 -->
- Node placement accepts projects for descendant promotion and explicit restore
  placement; project policy/resources stay bound to identity and seat cost stays
  zero. Runtime/turn controls refuse containers before actor/state changes.
  `swap` remains agent-only by user ruling 2026-10-20 07:23Z. See
  [project placement](../../docs/rust-engine/PROJECT-NODES.md#placement-and-runtime-capabilities).
  [decided: user 2026-10-20; verified: `domain/{ops,node_kind}.rs`,
  `http/nodes.rs`, `tools/{control,compaction}.rs`]
<!-- /preserved:e-0a943dac6941b095 -->

<a id="e-a689d2737bbf045c"></a>

## WebSocket notify_on_connect defaults false, including absent legacy memo

Original section: Unsectioned integration notes. Source lines 153–161.

<!-- preserved:e-a689d2737bbf045c -->
- WebSocket `notify_on_connect` defaults false, including absent legacy memo
  fields: ordinary connects previously emitted no fire. Opt-in Orgtree connection
  events bypass server filters/gaps and use normal once/notice/fire actions;
  server payloads remain filtered EXTERNAL data. A successful-session counter
  prevents coalesced state-watch updates losing short connections. The desktop
  detail switch saves only this flag, without reconnecting; runners read it at
  a new session. Existing outage/refusal/stable-recovery health alerts stay on.
  [decided: user/coordinator 2026-10-20; verified: `runtime/watchdogs/websocket.rs`,
  `ws/{mod,conn}.rs`, `http/dogs.rs`, `canvas/modals.tsx`]
<!-- /preserved:e-a689d2737bbf045c -->

<a id="e-15a421795b235b62"></a>

## Project desks reuse the agent desk's pieces, never copies: the up row (its own

Original section: Unsectioned integration notes. Source lines 216–224.

<!-- preserved:e-15a421795b235b62 -->
- Project desks reuse the agent desk's pieces, never copies: the up row (its own
  `.desk-nav` right after `DeskHead`, never among the header cards; user
  2026-10-19 21:05:53Z, 21:06:08Z "same as agent desk headers"), `DeskReportRow`,
  `HeldAudienceChips`, `AgentName`, `ReplyPreview`, the notice store and draft
  attachments. Change one desk's header, jump rows or composer and check the
  other; `tests/projectdeskparity.test.tsx` holds the parity. Signed
  differences: no chat/turns, no model/effort/account/credit controls, no
  presented-tab Team checkbox. See [project nodes](../../docs/rust-engine/PROJECT-NODES.md).
  [decided: user 2026-10-19 19:59Z; verified: `canvas/{desk,projectdesk}.tsx`]
<!-- /preserved:e-15a421795b235b62 -->

<a id="e-144729bec131b982"></a>

## Every desk reopens on the tab last picked on it, and a project desk's Mail tab

Original section: Unsectioned integration notes. Source lines 226–239.

<!-- preserved:e-144729bec131b982 -->
- Every desk reopens on the tab last picked on it, and a project desk's Mail tab
  on the folder last picked in its folder strip (a folder the mail card or a
  jump opened is not a pick): `canvas/desktabs.ts` (`useDeskMemory`),
  localStorage `orgtree-desk-tabs:<org>` by node id, read when a desk mounts or
  its host switches nodes, never live, so an open desk keeps its tab. A tab the
  desk does not offer, on opening or while open, gives way to Chat or Summary,
  which it keeps when the tab comes back. The mailbox tab is labelled "mail"
  (`deskTabLabel`; the route stays `inbox`), its window "X · mail", the agent
  menu's entry Open → Mail; folders stay inbox / sent / listeners and the
  app-level Inbox is unchanged. Tests: find a desk tab by `data-tab`, never by
  its label. A test file that remounts a desk shares localStorage between its
  tests: `localStorage.clear()` per fixture. [decided: user 2026-10-20 06:22Z,
  coordinator 06:33Z; verified: `canvas/{desktabs.ts,desk,projectdesk,mail,
  deskshell,panelcorner,agentmenu}.tsx`, `tests/desktabmemory.test.tsx`]
<!-- /preserved:e-144729bec131b982 -->

<a id="e-068a98ce034aef18"></a>

## Card shortcuts (Show agent card shortcuts) are never drawn over a desk: a

Original section: Unsectioned integration notes. Source lines 241–250.

<!-- preserved:e-068a98ce034aef18 -->
- Card shortcuts (Show agent card shortcuts) are never drawn over a desk: a
  project card drops its row while its desk is open or its pinned placeholder
  shows, as an agent card does. The hire strips stay on both desks (user spec:
  the desk keeps its hire chips). The project row is docket, mail, presented
  (always, as its tab), team, slots, listeners; the last three follow
  `projectDeskTabs()`, the desk's own tab rule, so card and desk cannot
  disagree. Listeners has no window: it opens the temporary desk on that tab
  (`rememberDesk` first). An agent card adds Team, last, while
  `liveTeamCount > 0`. [decided: user 2026-10-20 09:23Z–09:25Z; verified:
  `canvas/{projectcard,projectdesk,cards}.tsx`, `tests/cardshortcuts.test.tsx`]
<!-- /preserved:e-068a98ce034aef18 -->

<a id="e-b675df184c1c2a98"></a>

## Renderer supervisory controls use agentSuperior, effectiveReports and

Original section: Unsectioned integration notes. Source lines 252–260.

<!-- preserved:e-b675df184c1c2a98 -->
- Renderer supervisory controls use `agentSuperior`, `effectiveReports` and
  `isTopLevel` to cross project containers: credits follow agent funding, root
  project hires use top-level defaults, user lines belong to agents, and
  retire-all targets the next agents without retiring placement projects.
  Team badges and peer-mail sibling policy still use physical children.
  Default agent selection skips project rows and finds top-level agents through
  projects; floating coworker cards omit project siblings. [verified:
  `attention/AgentDeskPanel.tsx`, `canvas/OrgCanvas.tsx`; 2026-10-19]
  [decided: user/coordinator 2026-10-19; verified: `canvas/{shared,creditgrant,cards,agentmenu,modals}.ts*`]
<!-- /preserved:e-b675df184c1c2a98 -->

<a id="e-1bb79030bc5f41cd"></a>

## Watchdog creation has no per-agent or per-org number cap. More than eight

Original section: AGENTS.md — working on Orgtree. Source lines 273–283.

<!-- preserved:e-1bb79030bc5f41cd -->
- Watchdog creation has no per-agent or per-org number cap. More than eight
  owner cards collapse into an `X watchdogs` card on canvas/desk; expansion
  reads cursor pages, and any handle has an exact detail read. The tree feed
  is a preview (first eight per owner): its owner counts are authoritative.
  Project operational metadata remains complete under the existing unique
  owner/project/kind rules; never use generic preview length as a count.
  Bare handles still prefer the caller's own dog before the bounded
  ambiguity lookup, even when hundreds of other owners reuse that slug.
  See [watchdog grouping](../../docs/rust-engine/project-watchdog-menus.md).
  [decided: user/coordinator 2026-10-20; verified: `runtime/watchdogs.rs`,
  `feed/groups.rs`, renderer `canvas/watchdoggroup.tsx`]
<!-- /preserved:e-1bb79030bc5f41cd -->

<a id="e-ba915ec30cf32da4"></a>

## Project bunches are a display projection of maximal direct project-only runs:

Original section: AGENTS.md — working on Orgtree. Source lines 299–319.

<!-- preserved:e-ba915ec30cf32da4 -->
- Project bunches are a display projection of maximal direct project-only runs:
  visible splits/agents end a run and siblings never bunch. With retirees hidden,
  pruned archived children and archive counts do not split a bunch; shown
  retirees/bearers/live-descendant branches still do. Each bunched project's
  retired pill stays inside its card. Identity rotation still requires a complete
  physical run; visual bunches across hidden branches keep ordinary subtree drag.
  Loaded archived columns (including partly restored runs) follow the same rule;
  retired pile fronts keep the shared picker layers/count and per-project restore
  targets. No extra archive reads are made to find bunches. Archived runs keep
  ordinary dragging: identity rotation requires every project in the run live.
  The 08:05 sketch refinement packs staggered circle-chord rows with 8px gaps;
  short curves share ordinary hierarchy-edge styling and insertion follows the
  serpentine order, including reversed rows.
  The default-on Display switch restores ordinary columns when off. The separate
  "rearrange projects in a bunch" setting defaults OFF (user 2026-10-20 09:15Z):
  ordinary subtree dragging/reparenting applies until enabled. Its live profile
  preference gates insertion markers and atomic move/reorder gestures, preserving
  project identities and the bottom member group; swap stays agent-only. See
  [project bunches](../../docs/rust-engine/project-bunches.md).
  [decided: user 2026-10-20; verified: `canvas/projectbunch.ts`,
  `canvas/projectbunchmove.ts`, `canvas/OrgCanvas.tsx`]
<!-- /preserved:e-ba915ec30cf32da4 -->

<a id="e-ccfb0bacdb242c53"></a>

## Circular rings size each card's arc slot by its own footprint: a project bunch,

Original section: AGENTS.md — working on Orgtree. Source lines 321–328.

<!-- preserved:e-ccfb0bacdb242c53 -->
- Circular rings size each card's arc slot by its own footprint: a project bunch,
  whole or split, widens only its own slot, so its ring neighbours keep the dense
  190px pitch and arcs never spread evenly round the circle because of it. Radii
  still clear the ring's widest card; a full mixed ring grows until its slots just
  close. One-size rings keep the exact equal-step arithmetic. See
  [project bunches](../../docs/rust-engine/project-bunches.md).
  [decided: user 2026-10-20 09:08Z; verified: `canvas/shared.ts` `layoutCircular`,
  `canvas/ringsprings.ts`, `tests/bunchring.test.ts`]
<!-- /preserved:e-ccfb0bacdb242c53 -->

<a id="e-b321854727deec05"></a>

## Agent and project desk composers share resizeComposer: their base rows

Original section: AGENTS.md — working on Orgtree. Source lines 330–335.

<!-- preserved:e-b321854727deec05 -->
- Agent and project desk composers share `resizeComposer`: their base rows
  plus up to 30 rendered text lines (32 rows at the current two-row base),
  measured from CSS line height. Longer drafts scroll inside; deleting/sending
  and width changes remeasure and shrink them. Quick chat's separate single-line
  input is unchanged. [decided: user 2026-10-20 06:22Z; verified:
  `composerautosize.ts`, `canvas/{desk,projectdesk}.tsx`]
<!-- /preserved:e-b321854727deec05 -->

<a id="e-97db5312c46eb7d7"></a>

## Slot watchdogs accept slots: 1..64 (default 1, at most project capacity).

Original section: AGENTS.md — working on Orgtree. Source lines 342–350.

<!-- preserved:e-97db5312c46eb7d7 -->
- Slot watchdogs accept `slots: 1..64` (default 1, at most project capacity).
  A single lease reserves all requested units atomically. Strict FIFO blocks
  smaller claims behind a head that cannot fit; release/reclaim frees the whole
  lease. Counts sum units, while history, reminders and controls stay per lease.
  Migration 0039 defaults existing leases to one. [decided: user/coordinator
  2026-10-19; verified: `domain/slots.rs`, `runtime/watchdogs.rs`]
  Slot-table tests retain eight columns, with the requested quantity under
  `Slots` before `Action`, alongside the row's menu and time checks. [verified:
  `tests/project-dog-menu.test.tsx`; 2026-10-20]
<!-- /preserved:e-97db5312c46eb7d7 -->

<a id="e-b68adb62729bf24c"></a>

## Fair-queue listeners accept batch: 1..20 (default 1). Each bounded

Original section: AGENTS.md — working on Orgtree. Source lines 352–358.

<!-- preserved:e-b68adb62729bf24c -->
- Fair-queue listeners accept `batch: 1..20` (default 1). Each bounded
  assignment round commits before one wake per recipient; messages still
  go to the least recently served listener with capacity. One-shots take
  one available batch. ACK mode caps unacked mails at the batch size,
  acknowledges each separately, and returns only unacked mail on abandonment.
  `fired` stays a message count. [decided: user/coordinator 2026-10-19;
  verified: `domain/projects.rs`, `runtime/watchdogs.rs`]
<!-- /preserved:e-b68adb62729bf24c -->

<a id="e-4fee614cf778a263"></a>

## Project lifecycle notices use project wording and remain passive, with the

Original section: AGENTS.md — working on Orgtree. Source lines 378–381.

<!-- preserved:e-4fee614cf778a263 -->
- Project lifecycle notices use project wording and remain passive, with the
  same agent recipients; they never call the container a report or peer.
  Undo-hire still refuses live child nodes, including empty projects. [verified:
  `domain/lifecycle.rs`, `domain/undo.rs`, rig `project-label-notices.mjs`; 2026-10-19]
<!-- /preserved:e-4fee614cf778a263 -->

<a id="e-641b71c07a944055"></a>

## The user /nodes/&lt;project&gt;/scope route accepts only peer_mail; all other

Original section: AGENTS.md — working on Orgtree. Source lines 383–385.

<!-- preserved:e-641b71c07a944055 -->
- The user `/nodes/<project>/scope` route accepts only `peer_mail`; all other
  fields (including mixed patches) refuse before writes/cascades. Project policy
  uses project settings. [verified: `http/nodes.rs`; 2026-10-19]
<!-- /preserved:e-641b71c07a944055 -->

<a id="e-1800a0070d494588"></a>

## Team state inspection includes the caller's physical parent/sibling projects,

Original section: AGENTS.md — working on Orgtree. Source lines 387–389.

<!-- preserved:e-1800a0070d494588 -->
- Team state inspection includes the caller's physical parent/sibling projects,
  matching chart context without granting project policy authority. [verified:
  `tools/orgview.rs`; 2026-10-19]
<!-- /preserved:e-1800a0070d494588 -->

<a id="e-acc446c136c60014"></a>

## ORG STATE charts retain project rows and physical placement; report rosters

Original section: AGENTS.md — working on Orgtree. Source lines 391–395.

<!-- preserved:e-acc446c136c60014 -->
- ORG STATE charts retain project rows and physical placement; report rosters
  use the agent frontier. Coworker rosters use physical siblings, matching the
  mail boundary. Project keys remain in semantic deltas rather than becoming
  spurious removals. [decided: coordinator 2026-10-19 20:31Z; verified:
  `runtime/envelope.rs`; 2026-10-19]
<!-- /preserved:e-acc446c136c60014 -->

<a id="e-24e0c637ef59e0a7"></a>

## Move notices dedupe recipients. Same-superior placement changes notify only

Original section: AGENTS.md — working on Orgtree. Source lines 397–401.

<!-- preserved:e-24e0c637ef59e0a7 -->
- Move notices dedupe recipients. Same-superior placement changes notify only
  the moved agents; project moves aggregate their first agent frontier once per
  recipient, with self/superior roles before peers. Placement and group names
  stay in the existing event tail. [verified: `domain/lifecycle.rs`,
  `runtime/event_text.rs`, rig `project-move-notices.mjs`; 2026-10-19]
<!-- /preserved:e-24e0c637ef59e0a7 -->

<a id="e-9ff3f95424852e56"></a>

## Project policy (settings, Summary, name, order and queue purge) changes require

Original section: AGENTS.md — working on Orgtree. Source lines 403–412.

<!-- preserved:e-9ff3f95424852e56 -->
- Project policy (settings, Summary, name, order and queue purge) changes require
  the user or a strict agent ancestor. Members retain project reads, mail/inbox,
  queue/slot/listener use, their own lease, events, documents, folders and dead
  letters. `authorize_project_policy` is separate from operational project reach.
  The reporting guard (named entry points plus whole-source raw-parent deny-list)
  and its mutant checks run through `python tools/source-audits.py --rust-only`
  without loading the retired Python engine. Direct user contact uses the agent
  superior, so root-project agents get no redundant persistent user grant. See
  [project invariants](../../docs/rust-engine/PROJECT-NODES.md).
  [decided: user 2026-10-19 18:27Z; verified: `domain/ops.rs`; 2026-10-19]
<!-- /preserved:e-9ff3f95424852e56 -->

<a id="e-1648155fbe6fd07a"></a>

## Project credit mirrors sum the first live agent frontier in one statement,

Original section: AGENTS.md — working on Orgtree. Source lines 414–421.

<!-- preserved:e-1648155fbe6fd07a -->
- Project credit mirrors sum the first live agent frontier in one statement,
  including beyond 64 nested projects. All live descendant project folders are
  paged into launch/presentation grants. Live-agent watchdog baselines exclude
  projects; empty projects and archived reports do not block self-retirement.
  Retire-all preserves root project wrappers. See
  [project invariants](../../docs/rust-engine/PROJECT-NODES.md).
  [verified: `domain/{projects,ops}.rs`, `runtime/watchdogs/events.rs`,
  `http/orgops.rs`; 2026-10-19]
<!-- /preserved:e-1648155fbe6fd07a -->

<a id="e-b976f5013fbad9d0"></a>

## MQTT watchdogs (kind=mqtt) subscribe to a topic filter on an mqtt(s) broker.

Original section: AGENTS.md — working on Orgtree. Source lines 423–437.

<!-- preserved:e-b976f5013fbad9d0 -->
- MQTT watchdogs (`kind=mqtt`) subscribe to a topic filter on an mqtt(s) broker.
  The owner needs the web tool, rechecked every minute. Credentials are a file in
  the owner's folders (re-read on each connect) or inline, sealed in
  `ot.watchdog_secrets` (migration 0036; AES-256-GCM under a DPAPI machine key,
  which protects off-machine copies only). Never print or log them: lists and
  cards show only the path or "inline credentials"; `convo::redact_tool_input`
  blanks saved inputs, arg lines and previews; `credentials`/`pass`/`passwd` are
  masked log keys and URL user info is masked. `rumqttc` logging stays off (its
  Debug prints passwords and payloads), and `MqttOptions` lives only in `#[nolog]`
  code. Payloads are untrusted: fire mail, event rendering and `list` tag them.
  One connection per org + broker + credentials + client id (`src/mqtt` hub).
  A safe-start rehearsal re-arms only event dogs, so it never connects to a
  broker. See [mqtt watchdogs](../../docs/rust-engine/mqtt-watchdogs.md).
  [decided: user 2026-10-19 17:40Z/17:43Z, coordinator 18:04Z; verified:
  `src/mqtt/*`, `runtime/watchdogs/mqtt.rs`, `runtime/convo.rs`, `trace.rs`]
<!-- /preserved:e-b976f5013fbad9d0 -->

<a id="e-f6fad7771f1f4727"></a>

## MQTT and websocket dogs never give up while armed: every engine start re-arms

Original section: AGENTS.md — working on Orgtree. Source lines 449–458.

<!-- preserved:e-f6fad7771f1f4727 -->
- MQTT and websocket dogs never give up while armed: every engine start re-arms
  them (`watchdogs::start` logs and retries a failed read), no connection loop
  counts attempts, outages back off 2 s doubling to 5 min, and refusals retry
  after 1 min, then every 5 min. Jitter and a server's `Retry-After` never pass
  5 min (`mqtt/backoff.rs`). The one pause is a refused MQTT subscription.
  Gotcha: tungstenite reports a stream that ends before the upgrade's answer as
  `Protocol(HandshakeIncomplete)`, which is an outage, not a refusal
  (`ws/conn.rs` `classify`). [decided: user 2026-10-20 09:13Z, coordinator
  09:24Z; verified: `mqtt/backoff.rs`, `mqtt/conn.rs`, `ws/conn.rs`,
  `runtime/watchdogs.rs`]
<!-- /preserved:e-f6fad7771f1f4727 -->

<a id="e-2500178bdbeb0b3b"></a>

## Slot chips and all current-project-targeted watchdog menus offer Project…

Original section: AGENTS.md — working on Orgtree. Source lines 460–470.

<!-- preserved:e-2500178bdbeb0b3b -->
- Slot chips and all current-project-targeted watchdog menus offer Project…
  through the shared project-link menu; primary slot clicks still open Slots.
  Listener/slot-line rows and mobile dog lists use the shared object host.
  Dog outlines are cyan for event listeners, magenta for fair queues, yellow
  for slot claims; one-shots are dashed and ordinary one-shots stay grey.
  Listener-count watches have a double cyan outline; one-shot watches combine
  a dashed outer border with a solid inner cyan line on canvas, desk and mobile.
  [decided: user 2026-10-19 19:35:54Z; verified: `canvas/watchdogchip.tsx`, `styles.css`]
  See [project watchdog menus](../../docs/rust-engine/project-watchdog-menus.md).
  [decided: user 2026-10-19 19:06–19:07Z; verified: renderer
  `canvas/{objectnavhost,slotchips,watchdogchip,deskdogs,listenersdesk,slotsdesk}.tsx`]
<!-- /preserved:e-2500178bdbeb0b3b -->

<a id="e-745a7869091502ec"></a>

## Watchdog links share WatchdogLink: current-org tree metadata supplies kind,

Original section: AGENTS.md — working on Orgtree. Source lines 472–479.

<!-- preserved:e-745a7869091502ec -->
- Watchdog links share `WatchdogLink`: current-org tree metadata supplies kind,
  mode, state and the same glyph/outline as cards; missing metadata stays neutral.
  Known one-shots retain dashes and listener watches the double cyan perimeter.
  Tool/event/mail/mobile/detail/slot-line callers preserve their existing routes.
  [decided: user 2026-10-19 21:10Z; verified: `canvas/watchdoglink.tsx`]
  Their kind perimeter also sets `--button-accent`: the shared high-specificity
  button hover rule otherwise repaints it neutral grey. [verified: `styles.css`;
  native hover capture 2026-10-19]
<!-- /preserved:e-745a7869091502ec -->

<a id="e-60b089e35a88b0b8"></a>

## Slot watchdog projections omit private slot numbers intentionally: a lease,

Original section: AGENTS.md — working on Orgtree. Source lines 481–486.

<!-- preserved:e-60b089e35a88b0b8 -->
- Slot watchdog projections omit private slot numbers intentionally: a lease,
  fired/spent state or timestamp identifies a grant. Description panels use the
  bounded per-project slot-status read for held/ended lease details; missing
  history stays unknown. Never infer lease ending from absence in the org's
  capped active-lease feed. [verified: `domain/watchdogs.rs`, `domain/slots.rs`,
  renderer `canvas/{slotclaim.ts,modals.tsx}`; user 2026-10-19 21:22Z]
<!-- /preserved:e-60b089e35a88b0b8 -->

<a id="e-7548c02bba84e876"></a>

## Project edges do not cap agent visibility, tools or folder authority. Chart,

Original section: AGENTS.md — working on Orgtree. Source lines 488–495.

<!-- preserved:e-7548c02bba84e876 -->
- Project edges do not cap agent visibility, tools or folder authority. Chart,
  state inspection and watchdog access use agent reporting relations; top-level
  rights, credit caps/payers, org-inbox routing and org-folder revocation skip
  projects. Audience grants with a caller's own peer/superior use this graph;
  delegation between reports still requires the same physical parent. See
  [project invariants](../../docs/rust-engine/PROJECT-NODES.md).
  [verified: `tools/{mod,orgview}.rs`, `domain/{ops,asks,audiences,orginbox}.rs`,
  `http/settings.rs`; 2026-10-19]
<!-- /preserved:e-7548c02bba84e876 -->

<a id="e-d36c81c575341dc0"></a>

## Project near-card activity count and Active/Idle age share one nowrap row.

Original section: AGENTS.md — working on Orgtree. Source lines 497–502.

<!-- preserved:e-d36c81c575341dc0 -->
- Project near-card activity count and Active/Idle age share one nowrap row.
  Count inherits its compact 10px font; the state word yields before the clock
  so the normal 124px card does not wrap or overflow. This replaces the old
  wrapping fallback. Slots, merged mail queue/listeners and event listeners
  remain independent status groups. [decided: user 2026-10-19 18:47Z;
  verified: renderer `styles.css`, `canvas/{projectcard,projectdesk}.tsx`]
<!-- /preserved:e-d36c81c575341dc0 -->

<a id="e-0638b8ea6f4c6a3f"></a>

## The merged project mail card fills magenta while any fair-queue listener

Original section: AGENTS.md — working on Orgtree. Source lines 503–507.

<!-- preserved:e-0638b8ea6f4c6a3f -->
- The merged project mail card fills magenta while any fair-queue listener
  is armed or ack mail is in flight; queued-only mail remains outlined.
  Near-card text wraps within the card, including large counts; the tooltip
  retains complete wording. [decided: user 2026-10-19 18:57Z; verified:
  `canvas/{listeners,projectcard,projectdesk}.tsx`, `styles.css`]
<!-- /preserved:e-0638b8ea6f4c6a3f -->

<a id="e-ea53550dd21060db"></a>

## Near-card status badges use compact bounded wrapping so max-capacity slots,

Original section: AGENTS.md — working on Orgtree. Source lines 508–511.

<!-- preserved:e-ea53550dd21060db -->
- Near-card status badges use compact bounded wrapping so max-capacity slots,
  event listeners and long mail counts fit the fixed 124px card together.
  Inactive desk mail cards explicitly override generic button backgrounds.
  [verified: `styles.css`, `tests/project-mail-state-capture.cjs`; 2026-10-19]
<!-- /preserved:e-ea53550dd21060db -->

<a id="e-9fd0879366599ee2"></a>

## Agent lifecycle recipients, requests, turn rosters/labels, fresh-session recall

Original section: AGENTS.md — working on Orgtree. Source lines 528–534.

<!-- preserved:e-9fd0879366599ee2 -->
- Agent lifecycle recipients, requests, turn rosters/labels, fresh-session recall
  and docket deployers use `ot.superior_of` / `ot.agent_reporting` / `ot.reports_of`.
  Snapshot former agent superiors before moves/swaps; physical parent links remain
  for placement and the signed peer-mail exception. Project `describe` without a
  description reads; only an explicit empty string clears its Summary. See
  [project reporting](../../docs/rust-engine/PROJECT-NODES.md).
  [verified: `domain/{lifecycle,asks,docket,ops}.rs`, `runtime/{envelope,convo,reminders}.rs`; 2026-10-19]
<!-- /preserved:e-9fd0879366599ee2 -->

<a id="e-ca0aef700416d054"></a>

## Composer urgency precedes speed. Agent/project composer controls share

Original section: AGENTS.md — working on Orgtree. Source lines 543–548.

<!-- preserved:e-ca0aef700416d054 -->
- Composer urgency precedes speed. Agent/project composer controls share
  a 24px height. Effort grows wide enough for its complete chosen/queued
  label, without ellipsis; other controls stay 24px square, including armed
  urgency. This replaces square/truncated effort. [decided: user
  2026-10-19 18:43–18:55Z; verified:
  `canvas/desk.tsx`, `styles.css`, `tests/composerbuttons-layout.cjs`]
<!-- /preserved:e-ca0aef700416d054 -->

<a id="e-63915eb060b2f02e"></a>

## Empty composer padding and rows focus their text field without scrolling,

Original section: AGENTS.md — working on Orgtree. Source lines 550–555.

<!-- preserved:e-63915eb060b2f02e -->
- Empty composer padding and rows focus their text field without scrolling,
  across agent/project desks, Quick chat and replies; nested controls and
  portaled pickers retain focus behavior. Right-side desk controls restore
  the original 24px matching the left controls (30px introduced by 6bc9325).
  [decided: user 2026-10-19 18:31–18:32Z; verified: `composerfocus.ts`,
  `canvas/{desk,projectdesk,mail}.tsx`, `QuickChatBox.tsx`, `styles.css`]
<!-- /preserved:e-63915eb060b2f02e -->

<a id="e-ebc377c6fc40e9ad"></a>

## Project concurrency recipes compose existing slots, queues and events; an

Original section: AGENTS.md — working on Orgtree. Source lines 566–569.

<!-- preserved:e-ebc377c6fc40e9ad -->
- Project concurrency recipes compose existing slots, queues and events; an
  event has no late-subscriber replay, readiness counts registrations, and
  forced/reclaimed leases do not stop old work. See [recipes](../../docs/skills/orgtree-workflows/collaboration-patterns/concurrency-primitives/SKILL.md).
  [verified: `domain/{slots,projects,listeners,ops}.rs`, `runtime/watchdogs.rs`; 2026-10-19]
<!-- /preserved:e-ebc377c6fc40e9ad -->

<a id="e-fdb4002e12df5771"></a>

## Credit-bar segments and org pixel-per-credit scale flatten projects recursively

Original section: AGENTS.md — working on Orgtree. Source lines 587–592.

<!-- preserved:e-fdb4002e12df5771 -->
- Credit-bar segments and org pixel-per-credit scale flatten projects recursively
  to the next agents; projects never get a slab, while each agent's grant keeps
  its subtree grouped. Canvas, settings, desk and inbox request bars share the
  projection and retain their existing live/held filters and totals.
  [decided: user 2026-10-19 17:07Z; verified: `canvas/creditsegments.ts`,
  `canvas/{cards,creditgrant,desk,asks,shared}.ts*`]
<!-- /preserved:e-fdb4002e12df5771 -->

<a id="e-2b3068b59bcc2eaf"></a>

## Project desk cards and slot surfaces (user 2026-10-19 17:11Z-17:24Z): a

Original section: AGENTS.md — working on Orgtree. Source lines 693–723.

<!-- preserved:e-2b3068b59bcc2eaf -->
- Project desk cards and slot surfaces (user 2026-10-19 17:11Z-17:24Z): a
  magenta `mail listeners N` card (armed fair_queue dogs) sits beside the
  mail-queue card on desk header + near card and opens the Mail tab; the
  desk header's slots chip carries no holder links (tooltip names holders);
  an agent's slot chip opens its project's slots surface and reads
  "held since HH:MM from project X" / "waiting since … for project X"; the
  project card's active count is plain bold text (no chip box) beside
  "Active …". Slot leases record `queued_at` (migration 0034) so Holding /
  Line / Recently Held share one semantic table (Position | Agent | Waited |
  Held | Ended | Lease | Slots | Watchdog | Action; "Recent holds", "Claim /
  lease" and no Watchdog column until user 2026-10-20 06:22Z, coordinator
  06:36Z), with value-only time cells and blank inapplicable cells. Narrow surfaces scroll horizontally with the action column pinned.
  Time text shares exported `slottime.ts` helper: linear white-to-#e6ffe0 at 0-3s, then five equal
  logarithmic intervals through green/yellow/orange/red to bright red #ff4040 at24h, clamped;
  a mirrored dark-green-to-red light palette ends #d60000; `light-dark()` switches
  with the surface color scheme (optional explicit theme is available in tests).
  plain text only, without pill backgrounds (user 19:24Z). Line order has its own
  Position column, blank for holders/history (user 19:25Z). Recently Held labels only unusual endings.
  Ended ages use exported `slotEndedTimeStyle`: white through3s, logarithmic fade
  to readable mid grey #999999 at24h (light: #1a1a1a to #717171). Both exports return plain coloured text;
  no glow, dot, underline or outline (user 2026-10-19 20:13Z, replacing the
  comparison treatments). Reuse these helpers for other time tables.
  Recently Held uses 30-row `(ended_at,id)` keyset pages (one lookahead row), backed
  by partial index `slot_leases_ended_page`; `slot_status` includes the first page
  and `history_next`, while `slot_history` seeks older rows with the same project
  reach check. Shared SlotsView loads near the scroll bottom, keeps rows during
  reads/errors, dedupes leases, and rejects stale responses. [decided: user
  2026-10-19 19:37Z; verified: `domain/slot_history.rs`, `canvas/slotsdesk.tsx`]
  [decided: user/coordinator 2026-10-19 19:16-19:24Z; verified: `canvas/listeners.ts`,
  `canvas/slotchips.tsx`, `canvas/slotsdesk.tsx`, `domain/slots.rs`,
  `projectlisteners/projectslots.test.tsx`, rig `project-slots.mjs`; 2026-10-19]
<!-- /preserved:e-2b3068b59bcc2eaf -->

<a id="e-1921ec1a7fb7e5dc"></a>

## Project event listeners (user 2026-10-19 07:40Z): project_listener dogs

Original section: AGENTS.md — working on Orgtree. Source lines 724–741.

<!-- preserved:e-1921ec1a7fb7e5dc -->
- Project event listeners (user 2026-10-19 07:40Z): `project_listener` dogs
  receive a project's fired events (`orgtree_project action=fire_event`, one
  delivery transaction, in dog order) and `listener_watch` dogs fire at an
  armed-listener `count` (edge persisted under the project row lock; fires
  at once when already satisfied, re-fires only on a re-cross). Watchdogs
  may carry `fire_actions` (max 4 orgtree_* calls run as the owner at fire
  time through ordinary dispatch, 30s each, results in the fire mail,
  task-local depth limit 4; refused on `fair_queue`, skipped under
  SAFE_START). Cyan listener/watch lines and header cards (`x/y` per armed
  watch), a magenta mail-queue card (feed `mail_held` = ack in-flight) and
  a desk Listeners tab with the fire control (shown exactly while the
  project's event-listeners setting is on; user 2026-10-20 10:50Z replaced
  "from the first registered listener, for good": next entry). Engine
  event `project.event`.
  A rename now also moves `slot` watchdog targets (was activity/fair_queue
  only). [verified: `domain/listeners.rs`, `runtime/watchdogs.rs`,
  `canvas/listeners{,desk}.{ts,tsx}`, rig `project-listeners.mjs`,
  `projectlisteners.test.tsx`; 2026-10-19]
<!-- /preserved:e-1921ec1a7fb7e5dc -->

<a id="e-53043d84993d5911"></a>

## Project event-listeners setting (migration 0043, see

Original section: AGENTS.md — working on Orgtree. Source lines 742–764.

<!-- preserved:e-53043d84993d5911 -->
- Project event-listeners setting (migration 0043, see
  [PROJECT-NODES](../../docs/rust-engine/PROJECT-NODES.md)): `scope.event_listeners`,
  OFF by default, decides the desk's Listeners tab, `fire_event` (refused
  while off, also inside `listeners::fire` under the project row lock) and
  whether the project's listener and watch dogs work. Agents only switch it
  on, by arming a project_listener/listener_watch (the create's insert
  transaction or a resume: `listeners::switch_on`); `orgtree_project
  configure settings.event_listeners`, op `set_event_listeners` and the gear
  switch it either way (the user or a strict ancestor). Off pauses every
  armed listener/watch on the project with `memo.listeners_off` and the
  reason; on (by anyone) re-arms exactly the marked dogs, watch edges kept.
  Invariant: off means no armed listener/watch on the project, on means no
  marked dog; a new path that arms one takes the project row first and
  calls `switch_on` in its transaction, or relies on the runner's
  `listeners::guard` (rehire, engine start). Owners get one passive system
  notice per switch. The tree's watchdog view carries `disabled`: no canvas
  line, a dimmer ⊘ chip, the reason in the tooltip and detail.
  `listeners_seen` is retired. [decided: user 2026-10-20 10:50Z,
  coordinator 10:58Z; verified: `domain/{listeners,ops,watchdogs}.rs`,
  `runtime/watchdogs.rs`, `migrations/0043_event_listeners_setting.sql`,
  `canvas/{listeners,projectdesk,watchdogchip,watchdoglink}.ts*`,
  `canvas/modals.tsx`, rig `project-listener-setting.mjs`,
  `listenersetting.test.tsx`; 2026-10-20]
<!-- /preserved:e-53043d84993d5911 -->

<a id="e-6fc02399a07ff81a"></a>

## User-side project primitives (docket

Original section: AGENTS.md — working on Orgtree. Source lines 765–813.

<!-- preserved:e-6fc02399a07ff81a -->
- User-side project primitives (docket
  let-the-user-manually-hold-a-number-of-a-project; migration 0046): the
  user holds concurrency slots, registers an event listener and a listener
  watch, and joins a project's mail queue from the project desk. A user
  registration is an ordinary `ot.watchdogs` row or `ot.slot_leases` row
  with NO agent owner: `owner_agent_id` / `holder_agent_id` are nullable and
  `owner_kind` / `holder_kind` ('agent' | 'user') agree with them by CHECK.
  The user's data name is `"user"` (`domain/user_regs.rs` `USER`; reserved by
  `valid_name`, so no agent has it); agents see these rows named "user" in
  `action=slots`, `action=listeners` and handed-mail holders. The desk
  draws the name as the standard @user mention chip (`canvas/usermention.tsx`,
  a `RefChip` of the user's inbox ref), never "you". Ops, all `Actor::User`
  only and refused to every agent, project ancestors included
  (`domain/ops/user_regs.rs`): `user_slot_hold`, `user_slot_cancel`,
  `user_listener_register`, `user_watch_register`, `user_registration_remove`,
  `user_queue_join`, `user_queue_leave`, `user_job_ack`; no `orgtree_*` tool or
  Hubchat equivalent. Existing ops accept the user's rows: `slot_release`
  (the user's own lease is a plain `released`; an agent's attempt is refused),
  `slot_unqueue agent=user`, `set_event_listeners` (OFF pauses and ON restores
  the user's dogs; their rows are never armed in the watchdog runtime, so
  `listener_evals` re-evaluates the watches after commit), `fire_project_event`
  (a listener hears it). FAIL-CLOSED RULE: a query that inner-joins `ot.agents`
  on the owner or holder does not see user rows, which is right for the runtime
  (arm, pause, reclaim, halt, idle checkup never touch them: a user hold lasts
  until released, across a restart) and WRONG for anything that counts or
  orders: the slot capacity and grant (`slots::grant`, a user dog is spent by
  its own grant), the FIFO line, `listeners::armed_count`/`evaluate`/`fire`,
  `projects::hand_batch` round-robin (`Watcher.owner: Option<i64>`),
  `watched`/`queue_state` (the no-listener warning and the wake) all LEFT JOIN
  and read `owner_kind`. A new count or listener-presence query must do the
  same. Fires and jobs reach the user as normal mail (`recipient_kind
  'user'`, `domain::user_regs::fire_dog`, `hand_batch`); a job the user holds
  has `claimed.by_user` true and `by_id` null, is never released by
  `release_stale` or taken back, and stays held after `user_queue_leave` until
  `user_job_ack` (which keeps the user's reply mail as the completion record);
  `queue.job` on a mail entry (`feed/compute.rs`) drives the inbox's
  acknowledge pane (`canvas/jobackpane.tsx`, `jobacks.ts`). Migration 0048's holder-first
  indexes (`slot_leases_active_holder`, `mail_active_claim_holder`) are not unique and
  their predicates ignore the holder: a user row (NULL holder / `by_id`) is indexed,
  never matched by an agent's recheck. The Listeners tab
  still exists only while the project's event-listeners setting is on
  (coordinator 2026-10-20 14:11Z), so registering starts from the settings
  toggle. [decided: user 2026-10-20 13:03Z-13:22Z + 13:50Z, coordinator
  13:30Z; verified: `domain/{user_regs,slots,listeners,projects}.rs`,
  `domain/ops/user_regs.rs`, `migrations/0046_user_primitives.sql`,
  `canvas/{usermention,deskcount,registermenu,mailqueuejoin,listenerspanel,
  slotsdesk,listenersdesk,maillisteners,mail,jobackpane,jobacks}.tsx`, rig
  `project-user-{slots,listeners,queue}.mjs`,
  `user{mention,slots,listeners,mailqueue,jobs,links}.test.tsx`; 2026-10-20]
<!-- /preserved:e-6fc02399a07ff81a -->

<a id="e-2d03829c2d345c95"></a>

## Desk header controls (USER 2026-10-20 16:35Z-16:58Z; "restyle it to its

Original section: AGENTS.md — working on Orgtree. Source lines 814–839.

<!-- preserved:e-2d03829c2d345c95 -->
- Desk header controls (USER 2026-10-20 16:35Z-16:58Z; "restyle it to its
  liking" 16:51Z): each project desk tab's header row ends with its controls,
  left of the pin / pop-out / modal corner, and they act at once (no dialog;
  the old dialogs' help text is in the tooltips). Slots: "Hold 1 slot / Hold N
  slots", N from 1 to the total less what the user holds or waits for. Mail,
  on every folder: "Join mail queue / twice / N times", N the batch, 1 to
  `MAX_QUEUE_BATCH` (20). Listeners: one "Register…" panel (one-time,
  continuous, watcher for N). Registering again CHANGES the user's dog in place
  (`domain/ops/user_regs.rs` `existing_dog`): the other `once` switches the
  listener, another watch count resets `run.above` and re-evaluates, another
  batch updates `memo.batch` and re-runs the queue; the same value changes
  nothing (`updated: false`). Number and button are one `DeskCount`
  (`canvas/deskcount.tsx`). The Mail folder strip ends with host controls
  (`InboxView` `folderTools`): the folders are `.mail-folders > button`, so a
  test or style meaning the folders needs the child selector. The Register
  panel portals into the surface's overlay root (`useOverlayRoot`,
  `useSurfaceDocument`, as the context menu does), so it works in pinned and
  popped-out windows. Listeners has its own panel kind `project-listeners`
  (`canvas/listenerspanel.tsx`, OrgCanvas `projectListenersId`); "Open ›
  Listeners" (while the setting is on) and the card's Listeners shortcut open
  it, like Slots (coordinator 17:03Z). [decided: user 2026-10-20
  16:35Z-16:58Z, coordinator 16:36Z-17:03Z; verified:
  `canvas/{deskcount,registermenu,mailqueuejoin,listenerspanel,slotsdesk,
  listenersdesk,panelcorner,projectdesk,agentmenu,projectcard}.tsx`,
  `domain/ops/user_regs.rs`, rig `project-user-{listeners,queue}.mjs`,
  `{userslots,usermailheader,registermenu,listenerspanel}.test.tsx`; 2026-10-20]
<!-- /preserved:e-2d03829c2d345c95 -->

<a id="e-49d0cd76c2a04217"></a>

## Project desk history (migration 0040, see

Original section: AGENTS.md — working on Orgtree. Source lines 851–880.

<!-- preserved:e-49d0cd76c2a04217 -->
- Project desk history (migration 0040, see
  [PROJECT-NODES](../../docs/rust-engine/PROJECT-NODES.md)): `ot.project_fires`
  (fired events and listener watches reaching their count, with who
  listened, since when and their fire mail) and `ot.project_mail_endings`
  (acked / failed / taken_back / dead_letter) are written INSIDE the
  transaction of the fire or ending they record, never after commit. A new
  job-ending path must call `projects::record_ending` and `free_listener`
  (`memo.run.freed_at`, a listener's wait start) in its own transaction.
  Reads are 30-row pages keyed by id (`history_before`; ops
  `listener_history`, `mail_queue_history`), never scans of `ot.events` or
  mail. Op `mail_take_back` (the user or a project ancestor, confirmed on
  the desk, event `mail_take_back`) ends a held job `taken_back` and
  re-queues it for another listener first (`extra.taken_from`), or
  dead-letters it at the last counted attempt; the holder is told and its
  later ack is refused. The Dead Letter Line comes from that read's first
  page (`dead_letter_listeners`), never from the tree's eight-per-owner
  watchdog preview. The slot claim dog on holders and history rows is
  for the desk only: `orgtree_project action=slots` strips it. CSS trap:
  the global `.working` rule is a flex layout, so a table row with class
  `working` stops being a row (held jobs use `held-job`). The three tables'
  header row and section headings take ONE style on `.slots-table`; no
  host rule may style them. The tables fit the desk at normal widths
  (size-container column widths; a shortened cell ends in an ellipsis and
  keeps its whole text in a tooltip; sideways scroll only below a table's
  floor). [decided: user 2026-10-20 06:22Z-06:42Z, 08:59Z, 09:00Z,
  coordinator A1-A9 06:36Z-06:42Z; verified:
  `migrations/0040_project_history.sql`, `domain/{listeners,projects,ops}.rs`,
  `tools/treetools.rs`, `canvas/{maillisteners,listenersdesk,slotsdesk}.tsx`,
  rig `project-history.mjs`, `projecthistory.test.tsx`,
  `desktablelayout.test.tsx`; 2026-10-20]
<!-- /preserved:e-49d0cd76c2a04217 -->

<a id="e-14b1dd971a118d4c"></a>

## Project Open → Slots is one modal entry, offered only with positive slot

Original section: AGENTS.md — working on Orgtree. Source lines 888–894.

<!-- preserved:e-14b1dd971a118d4c -->
- Project Open → Slots is one modal entry, offered only with positive slot
  capacity. Its standard `project-slots` PinFrame supports pin, pop-out and
  remembered org/project-generation placement; the slots tab shares the three
  PanelCorner shortcuts. It reuses SlotsView and shows a safe empty state if
  capacity becomes zero. Data/tool actions remain `orgtree_project slots` and
  existing release/unqueue. [decided: user 2026-10-18 19:31–19:33Z; verified:
  `canvas/{agentmenu,OrgCanvas,panelcorner,slotspanel,projectdesk}.tsx`]
<!-- /preserved:e-14b1dd971a118d4c -->

<a id="e-982b09aa47310838"></a>

## Usage watchdogs consume sanitized cache observations and scoped usage refusals;

Original section: AGENTS.md — working on Orgtree. Source lines 895–900.

<!-- preserved:e-982b09aa47310838 -->
- Usage watchdogs consume sanitized cache observations and scoped usage refusals;
  no provider refresh or credential read. Per-account/window edges and pending
  delivery persist in memo. Unknown/stale never means zero; current conditions
  seed without firing, reset clocks carry unknown new values. Tool creation only;
  desktop list/detail retains normal management. See [usage watchdogs](../../docs/rust-engine/usage-watchdogs.md).
  [decided: user/coordinator 2026-10-18 19:44Z/19:49Z; verified: `runtime/watchdogs/{usage,usage_eval}.rs`]
<!-- /preserved:e-982b09aa47310838 -->

<a id="e-2485a7f6f17f1e23"></a>

## Project tools expose read-only Inbox/Sent history with filter-bound cursor pages

Original section: AGENTS.md — working on Orgtree. Source lines 901–908.

<!-- preserved:e-2485a7f6f17f1e23 -->
- Project tools expose read-only Inbox/Sent history with filter-bound cursor pages
  and historical fetch/chunk; presentation bodies have bounded Unicode chunk
  continuation. Project create above uses canonical atomic insertion authority;
  broadcast forwards urgent/reason and mail reply IDs through ordinary per-recipient
  checks. Reads never claim/ack project mail or consume user document state. See
  [inbox](../../docs/skills/orgtree-working/mail/tool-inbox/SKILL.md) and
  [project](../../docs/skills/orgtree-working/team/tool-project/SKILL.md).
  [decided: user/coordinator 2026-10-18; verified: `tools/{project_inbox,treetools,defs}.rs`, `domain/{ops,presentation_chunks}.rs`]
<!-- /preserved:e-2485a7f6f17f1e23 -->

<a id="e-229fb0c9e594cfb5"></a>

## Tree tools heap-pin the canonical operation future before awaiting it. The

Original section: AGENTS.md — working on Orgtree. Source lines 915–918.

<!-- preserved:e-229fb0c9e594cfb5 -->
- Tree tools heap-pin the canonical operation future before awaiting it. The
  nested tool path overflowed the default Windows debug engine stack during
  project creation; preserve normal stack limits and verify real rig calls.
  [verified: `tools/treetools.rs`; 2026-10-18]
<!-- /preserved:e-229fb0c9e594cfb5 -->

<a id="e-a771e265dceb226f"></a>

## Project settings explain round-robin as a load balancer, ACK as a FIFO work

Original section: AGENTS.md — working on Orgtree. Source lines 920–924.

<!-- preserved:e-a771e265dceb226f -->
- Project settings explain round-robin as a load balancer, ACK as a FIFO work
  queue, one slot as a shared lock (mutex), and multiple slots as a counting
  semaphore. These are descriptions of existing cooperative behavior; FIFO is
  handout order, not completion order. See [projects](../../docs/skills/orgtree-working/team/projects/SKILL.md).
  [decided: user 2026-10-18 17:59Z; verified: `canvas/modals.tsx`]
<!-- /preserved:e-a771e265dceb226f -->

<a id="e-47f6c4ec16d783c5"></a>

## Read a project Summary with orgtree_project action=settings and no

Original section: AGENTS.md — working on Orgtree. Source lines 926–930.

<!-- preserved:e-47f6c4ec16d783c5 -->
- Read a project Summary with `orgtree_project action=settings` and no
  `settings` argument (`settings.description` in the result). In
  4.4.0-alpha.12 and earlier, omitted-description `action=describe` clears it.
  See the [project tool warning](../../docs/skills/orgtree-working/team/tool-project/SKILL.md#read-the-summary-without-changing-it).
  [verified: `tools/treetools.rs`, `domain/ops.rs`; 2026-10-19]
<!-- /preserved:e-47f6c4ec16d783c5 -->

<a id="e-ce0098e92c17ea63"></a>

## Heavy development work uses only @build-slot concurrency grants. Read its

Original section: AGENTS.md — working on Orgtree. Source lines 932–938.

<!-- preserved:e-ce0098e92c17ea63 -->
- Heavy development work uses only @build-slot concurrency grants. Read its
  current project Summary and coordinator assignment for capacity, Cargo jobs,
  RAM floors, containment and low-RAM waiting deadlines; historical numeric
  examples are not current policy. Prepare before claiming; release immediately
  after the assigned foreground batch. The filesystem build.lock/queue protocol
  is retired. See [build permits](../../docs/skills/orgtree-working/workspace/builds-under-the-lock/SKILL.md).
  [decided: user/coordinator 2026-10-19 17:10Z/18:02Z]
<!-- /preserved:e-ce0098e92c17ea63 -->

<a id="e-2971c40fc828cba4"></a>

## Audience revocation removes the explicit grant only. Passive notices name

Original section: AGENTS.md — working on Orgtree. Source lines 948–954.

<!-- preserved:e-2971c40fc828cba4 -->
- Audience revocation removes the explicit grant only. Passive notices name
  remaining project sources and announce inherited route starts/ends once per
  committed change. Every agent's ORG STATE lists its own effective audiences
  and sources, without inspection permission. Historical revoke events do not
  assert that inherited access is gone. See [project audiences](../../docs/rust-engine/project-audiences.md).
  [decided: user 2026-10-18 16:53Z; verified: `domain/{audiences,audience_notices,ops}.rs`,
  `runtime/{envelope,event_text}.rs`]
<!-- /preserved:e-2971c40fc828cba4 -->

<a id="e-edb2b80c725c86af"></a>

## Projects call their standing charter Summary in desks, settings, drafts

Original section: AGENTS.md — working on Orgtree. Source lines 956–963.

<!-- preserved:e-edb2b80c725c86af -->
- Projects call their standing charter **Summary** in desks, settings, drafts
  and help. The project desk's internal `desk` tab displays lowercase `summary`
  (user 2026-10-18 18:11Z); headings/settings retain Summary. Agent desk
  labels stay desk. `description` / `set_description` wire fields stay compatible.
  Project actions read `dissolve`; the project `slots` tab omits redundant counts.
  Summary read/edit padding matches on top and left, with no first-block top
  margin. [decided: user/coordinator 2026-10-18 17:05–17:24Z;
  verified: `canvas/{projectdesk,modals,newproject}.tsx`, `shortcuts.ts`, `styles.css`]
<!-- /preserved:e-edb2b80c725c86af -->

<a id="e-bcba00ddb0d9815f"></a>

## DND is a header token beside effort on agent cards/desks, outside status.

Original section: AGENTS.md — working on Orgtree. Source lines 965–969.

<!-- preserved:e-bcba00ddb0d9815f -->
- DND is a header token beside effort on agent cards/desks, outside status.
  Urgent agent mail uses the notice-shaped round `!`, orange when armed;
  it sits beside composer Fast and is offered for project broadcast only with
  a current DND recipient. [decided: user 2026-10-18 17:42–17:43Z;
  verified: `canvas/{cards,desk,dnd,projectdesk}.tsx`, `styles.css`]
<!-- /preserved:e-bcba00ddb0d9815f -->

<a id="e-5df9503ab20f8452"></a>

## Concurrency slots are unnumbered in presentation: counts and queue ordinals

Original section: AGENTS.md — working on Orgtree. Source lines 1002–1010.

<!-- preserved:e-5df9503ab20f8452 -->
- Concurrency slots are unnumbered in presentation: counts and queue ordinals
  remain, leases identify holds. Project header row two contains the yellow
  count card and shared model-icon holder links, without a redundant spelled-out
  held count (user 2026-10-19 08:23Z); Holding, Line and
  Recently Held use those links too. Visible slot ages subscribe to the shared
  one-second age clock without status refetches. [decided: user
  2026-10-18 17:02–17:21Z;
  verified: `canvas/{projectdesk,slotsdesk,slotchips}.tsx`,
  `domain/{slots,watchdogs}.rs`, `runtime/{watchdogs,reminders}.rs`]
<!-- /preserved:e-5df9503ab20f8452 -->

<a id="e-0bd65f6fdd92c0a0"></a>

## Push-driven slot, fair-queue and event dogs do not report missing polling

Original section: AGENTS.md — working on Orgtree. Source lines 1012–1016.

<!-- preserved:e-0bd65f6fdd92c0a0 -->
- Push-driven slot, fair-queue and event dogs do not report missing polling
  checks. Watchdog list resolves each slot project's canonical live line once
  and reports its claim position; real runner/storage health remains visible.
  [decided: coordinator 2026-10-18 17:29Z;
  verified: `runtime/watchdogs.rs`]
<!-- /preserved:e-0bd65f6fdd92c0a0 -->

<a id="e-af268de658e81fd1"></a>

## Agents/Team trays omit an empty project status-summary line, retaining real

Original section: AGENTS.md — working on Orgtree. Source lines 1018–1023.

<!-- preserved:e-af268de658e81fd1 -->
- Agents/Team trays omit an empty project status-summary line, retaining real
  summaries and ordinary agent placeholders. Keep shared name font, icon cells
  and hierarchy indentation. Inline Team groups Active with its right-hand
  pin/pop-out/modal controls; pinned/detached Team uses header actions. See
  [Team chrome](../../docs/rust-engine/team-panel-chrome.md).
  [decided: user 2026-10-18 16:44–16:45Z; verified: `canvas/agenttray.tsx`, `styles.css`]
<!-- /preserved:e-af268de658e81fd1 -->

<a id="e-8a0a592004577f78"></a>

## Desk Team tabs show/count live direct children from the current map, including

Original section: AGENTS.md — working on Orgtree. Source lines 1029–1033.

<!-- preserved:e-8a0a592004577f78 -->
- Desk Team tabs show/count live direct children from the current map, including
  child projects, with the shared tab-count badge. Zero children hides Team and
  clears its selection to agent Chat/project Desk; a later hire does not reopen
  it. The Team panel still lists the full subtree. [decided: user 2026-10-18
  17:08Z; verified: `canvas/{team,desk,projectdesk}.tsx`]
<!-- /preserved:e-8a0a592004577f78 -->

<a id="e-57a6d9bcda446186"></a>

## Mail admission uses the shared hard byte budget without separate row caps;

Original section: AGENTS.md — working on Orgtree. Source lines 1034–1042.

<!-- preserved:e-57a6d9bcda446186 -->
- Mail admission uses the shared hard byte budget without separate row caps;
  deferred notices retain ordered follow-up eligibility and the input announces
  remaining mail. Explicit fetch/chunk consumes returned pending received mail
  outside DND too. Received/project content reads append ordinary mail after
  their tool completes, deduplicated against indexed transcript mail receipts;
  project queues stay unclaimed, sent history and previews add nothing. See
  [inbox](../../docs/skills/orgtree-working/mail/tool-inbox/SKILL.md).
  [decided: user/coordinator 2026-10-18 15:52–16:01Z; verified:
  `runtime/{actor,manual_mail,prompt}.rs`, `tools/mailtools.rs`]
<!-- /preserved:e-57a6d9bcda446186 -->

<a id="e-c32bdfc35e2525c4"></a>

## Project and agent desk member/report rows share DeskJumpCards: more than

Original section: AGENTS.md — working on Orgtree. Source lines 1052–1057.

<!-- preserved:e-c32bdfc35e2525c4 -->
- Project and agent desk member/report rows share `DeskJumpCards`: more than
  16 cards collapse behind the same counted disclosure, using the existing
  Display preference. Project canvas, pin, pop-out and Attention hosts all
  render `ProjectDesk`; parent navigation stays separate. Agent retired
  controls and watchdog ordering are retained. [decided: user 2026-10-18 14:45Z;
  verified: `canvas/{deskjumpcards,desk,projectdesk}.tsx`]
<!-- /preserved:e-c32bdfc35e2525c4 -->

<a id="e-1c67f962a8014fd2"></a>

## Agent/project Open menu parents click/Enter the existing temporary-desk

Original section: AGENTS.md — working on Orgtree. Source lines 1066–1072.

<!-- preserved:e-1c67f962a8014fd2 -->
- Agent/project Open menu parents click/Enter the existing temporary-desk
  action; hover/Right still expand. Hire a subordinate, Hire under this project
  and the switchboard's Hire an agent use the org's current
  remembered/template Quick chat tier only if that exact tier is offered,
  otherwise expands without substituting. Read the choice at menu-open time.
  See [menu parent actions](../../docs/rust-engine/menu-parent-actions.md).
  [decided: user 2026-10-18 14:25Z/14:34Z/17:14Z; verified: `canvas/{agentmenu,cards,OrgCanvas}.tsx`]
<!-- /preserved:e-1c67f962a8014fd2 -->

<a id="e-399a9f610452d566"></a>

## Right-clicking an agent or project link inside an agent or project desk

Original section: AGENTS.md — working on Orgtree. Source lines 1110–1119.

<!-- preserved:e-399a9f610452d566 -->
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
<!-- /preserved:e-399a9f610452d566 -->

<a id="e-b1503787cea59e8f"></a>

## Project mail's plain delivery marker uses → @recipient through shared

Original section: AGENTS.md — working on Orgtree. Source lines 1129–1148.

<!-- preserved:e-b1503787cea59e8f -->
- Project mail's plain delivery marker uses `→ @recipient` through shared
  `AgentName`, in list rows and reading panes (including pop-outs). Every agent
  a queue state names (that marker, `· awaiting ack`, `acked by`, `released`)
  wears its model card through `tierOf`, as the sender does: line 1's 14px card
  on the meta line, the sender's 16px card in the reading pane (where the
  marker takes the header's type), a 12px card inside an outline chip so chip
  and meta line keep their height; no resolver, no card. A list row
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
  meaning. [decided: user/coordinator 2026-10-18 12:46–12:49Z, user 14:24Z,
  user 17:01Z; verified: `canvas/mail.tsx`, `styles.css`, `feed/compute.rs`]
<!-- /preserved:e-b1503787cea59e8f -->

<a id="e-489f58ddbf6542b0"></a>

## Project release_slot and own slots status are available with either team

Original section: AGENTS.md — working on Orgtree. Source lines 1149–1154.

<!-- preserved:e-489f58ddbf6542b0 -->
- Project `release_slot` and own `slots` status are available with either team
  or watchdogs. Watchdog-only cards expose just those actions; dispatch refuses
  other project actions and force release. Status shows all holders and the line, hiding foreign lease IDs. Full
  project control still needs team. Scope denial is checked on each call.
  [decided: user 2026-10-18 12:55Z; verified: `domain/tool_groups.rs`,
  `tools/{defs,mod,treetools}.rs`]
<!-- /preserved:e-489f58ddbf6542b0 -->

<a id="e-98d904ff68aa8dce"></a>

## User mail to projects shares the agent context.deep_reach ancestor-notice

Original section: AGENTS.md — working on Orgtree. Source lines 1156–1162.

<!-- preserved:e-98d904ff68aa8dce -->
- User mail to projects shares the agent `context.deep_reach` ancestor-notice
  transaction. User fan-out shares `ForwardedUserNotices` for one logical send:
  each live real-agent ancestor receives one passive notice, and only a committed
  admission consumes it. Project fair-queue copies do not forward again. Agent
  reply grants and the post-delivery project audience grant retain their paths.
  [decided: user 2026-10-18 12:47Z; verified: `domain/{mail,runtime_notices}.rs`,
  `http/nodes.rs`]
<!-- /preserved:e-98d904ff68aa8dce -->

<a id="e-a243d950ff6c2297"></a>

## Project acknowledgement timeout uses scope.mail_queue_ack_reminders (1–10,

Original section: AGENTS.md — working on Orgtree. Source lines 1171–1178.

<!-- preserved:e-a243d950ff6c2297 -->
- Project acknowledgement timeout uses `scope.mail_queue_ack_reminders` (1–10,
  default 3) for BOTH held mail and idle concurrency slots. It sends that many
  20-minute reminders, then reclaims at the next checkup; timeout/checkup gates
  and default timing stay unchanged. Tool `settings.ack_reminders` shares the
  canonical queue op. Project settings puts timeout, max attempts and reminders
  in a bottom Acknowledgement section shown only for ack mode or slots >=1.
  [decided: user 2026-10-18 12:21Z; verified: `domain/{projects,slots,ops}.rs`,
  `tools/defs.rs`, `canvas/modals.tsx`]
<!-- /preserved:e-a243d950ff6c2297 -->

<a id="e-15ef87db8aa08922"></a>

## ACK work queue (user 2026-10-18 18:00Z-18:09Z): a post that waits says why

Original section: AGENTS.md — working on Orgtree. Source lines 1180–1192.

<!-- preserved:e-15ef87db8aa08922 -->
- ACK work queue (user 2026-10-18 18:00Z-18:09Z): a post that waits says why
  (`projects::wait_note`/`queue_state`: no listener / all N listeners holding an
  un-acked job with its position / halted / paused; same text in the user's send
  reply and `orgtree_inbox project`); one fair_queue dog per agent per project
  (create refused, naming the existing one; ack hand-out is already per agent);
  `scope.mail_queue_turn_end_reminder` (default on, tool `settings.turn_end_reminder`,
  UI "Remind an agent that ends its turn with an un-acked job") makes
  `projects::remind_unfinished` start ONE reminder turn when a listener's turn
  ends holding an un-acked job (once per job, `claimed.reminded_at`; not when
  blocked with a reason, halted, interrupted, failed, limited or frozen).
  [decided: user 2026-10-18 18:05Z-18:06Z; verified: `domain/{projects,mail,ops}.rs`,
  `runtime/{actor,watchdogs}.rs`, `tools/defs.rs`, `canvas/modals.tsx`,
  `tools/rig/proofs/project-queue-busy.mjs`]
<!-- /preserved:e-15ef87db8aa08922 -->

<a id="e-b68ab3bee8cb56e4"></a>

## Project inbox with no listener (user 2026-10-20 11:04Z): mail to it is still

Original section: AGENTS.md — working on Orgtree. Source lines 1194–1212.

<!-- preserved:e-b68ab3bee8cb56e4 -->
- Project inbox with no listener (user 2026-10-20 11:04Z): mail to it is still
  queued, but the send's note leads with `projects::no_listener_warning` ("may
  not be read by anyone or delivered anywhere until one attaches"), per
  recipient: an agent's via `sent_note` (+ how to attach one, where to read it),
  the user's via `unwatched_note` (+ what the listener wake did, no tool
  syntax). "No listener" = `queue_state` listeners 0 AND paused 0: a paused
  fair_queue dog is attached and keeps `wait_note`'s paused note.
  `orgtree_inbox project`'s `queue` line stays `wait_note` (the warning is per
  send). The project composer shows `canvas/inboxwarning.tsx` above the box
  while the tree has no fair_queue dog (armed or paused) on the project and the
  megaphone is off, and its placeholder then drops "one agent under it takes
  it"; `styles.css` keeps the note in the box's foot group. The note reuses
  `.cache-send-warning.compact` and WarnIcon, says mail may not be received,
  and suggests broadcast (megaphone) to reach all project participants.
  [decided: user 2026-10-20 12:23Z/12:23:59Z; verified:
  `canvas/inboxwarning.tsx`, `tests/projectinboxwarning.test.tsx`]
  [decided: user 2026-10-20 11:04Z; paused counts as attached: mqtt-watchdog-opus,
  delegated by the coordinator; verified: `domain/{projects,mail}.rs`,
  `canvas/{projectdesk,inboxwarning}.tsx`, `tools/rig/proofs/project-inbox-warning.mjs`]
<!-- /preserved:e-b68ab3bee8cb56e4 -->

<a id="e-9398dccfcf1043a8"></a>

## Project dead-letter queue (user 2026-10-18 19:38Z-19:40Z): a job that runs out

Original section: AGENTS.md — working on Orgtree. Source lines 1214–1232.

<!-- preserved:e-9398dccfcf1043a8 -->
- Project dead-letter queue (user 2026-10-18 19:38Z-19:40Z): a job that runs out
  of `max_attempts` (`projects::reclaim`) stays in the project's own mail row
  (`state='read'`, `extra.dead_letter` {by,by_id,why,how,attempts,at}) with
  `extra.attempt_log` (one entry per hand-out: n,by,copy,at, `ended` {how
  acked|released|timed_out, why, at}). `domain/dead_letters.rs`: ops
  `dead_letters` (list / read with `id`), `dead_letter_retry` (state back to
  pending, attempts 0, `extra.retried` appended, history kept, queue run after
  commit via `Effects.queue_runs`), `dead_letter_drop` (reason required,
  `extra.dead_letter_dropped`; leaves the open count). Reach is
  `projects::reaches` (above or below the project, or the user), not org
  visibility; tool `orgtree_project` actions `dead_letters`/`retry_dead_letter`/
  `drop_dead_letter` are open to watchdogs-only callers like the slot actions.
  Event `project.dead_letter` (scope Agent(org, project)) is checked against
  `reaches` in `events::Access`. The tree node carries `dead_letters` (open
  count, `x_dead_letters` in `feed/compute.rs`) and the project desk shows a
  Dead letters tab (`canvas/deaddesk.tsx`). No forward-to-agent action yet.
  [decided: user 2026-10-18 19:38Z-19:40Z; verified: `domain/{dead_letters,projects,ops}.rs`,
  `runtime/watchdogs/events.rs`, `tools/{defs,treetools}.rs`, `canvas/deaddesk.tsx`,
  `tools/rig/proofs/project-dead-letters.mjs`, `tests/deadletters.test.tsx`]
<!-- /preserved:e-9398dccfcf1043a8 -->

<a id="e-b558facbec92bafd"></a>

## User, agent and project Inbox/Sent history pages seek strictly before a

Original section: AGENTS.md — working on Orgtree. Source lines 1267–1278.

<!-- preserved:e-b558facbec92bafd -->
- User, agent and project Inbox/Sent history pages seek strictly before a
  numeric mail id (200 user rows, 150 node rows plus one lookahead), separately
  from the unchanged bounded live-feed windows. Keep admitted org/node scope,
  external-inbox visibility, read/delivery states and project queue metadata.
  Loaded older rows merge with the live head without rewinding the cursor or
  changing selection; replies, reads and deletion keep their original routes.
  Normalize omitted/null live folders before indexing them; validate pages
  before React state updates so malformed 2xx bodies retain rows/cursor and
  offer Retry. Null/undefined live windows keep their loading meaning.
  See [mail history paging](../../docs/rust-engine/mail-history-paging.md).
  [decided: user/coordinator 2026-10-18; verified: `domain/mail_history.rs`,
  `http/{mailbox,nodes}.rs`, `usemailhistory.ts`, `App.tsx`, `canvas/mail.tsx`]
<!-- /preserved:e-b558facbec92bafd -->

<a id="e-84ab79bda82d00b6"></a>

## Presentation list rows use plain, single-line owner text and a muted inline

Original section: AGENTS.md — working on Orgtree. Source lines 1279–1286.

<!-- preserved:e-84ab79bda82d00b6 -->
- Presentation list rows use plain, single-line owner text and a muted inline
  `by` attribution, clipped with a title; clicking the name selects the document.
  Keep navigable identities in the details pane and the shared `Presenter…` /
  `Project…` menus, which reuse `nodeMenuAction` like ticket `Owner…`. Feed/body
  reads carry recorded attribution; legacy chips resolve it at menu open with
  the context-menu opening guard. [decided: user 2026-10-18 11:25–11:27Z;
  verified: `canvas/{gallery,docs}.tsx`, `canvas/objectactions.ts`,
  `feed/compute.rs`, `http/docs.rs`]
<!-- /preserved:e-84ab79bda82d00b6 -->

<a id="e-7cce353856f0c1c1"></a>

## orgtree_project settings/configure exposes all Project settings as an

Original section: AGENTS.md — working on Orgtree. Source lines 1288–1295.

<!-- preserved:e-7cce353856f0c1c1 -->
- orgtree_project settings/configure exposes all Project settings as an
  atomic explicit patch. It reuses canonical ops/reach, preserves false/zero/
  empty values and renames last. Ancestor agents can force-release/unqueue slots;
  broadcast retains per-recipient messaging/attachment authority. Gallery list/read
  and project scratch reads use project reach. Permanent deletion stays user-only.
  Running CLIs retain startup tool schemas: verify claim AND release before taking
  a slot. [decided: user/coordinator 2026-10-18 10:51Z–10:57Z; verified:
  `domain/ops.rs`, `tools/{treetools,orgview,defs}.rs`]
<!-- /preserved:e-7cce353856f0c1c1 -->

<a id="e-3300b22809d274db"></a>

## A successful agent-desk composer send selects that desk's Chat tab after

Original section: AGENTS.md — working on Orgtree. Source lines 1296–1300.

<!-- preserved:e-3300b22809d274db -->
- A successful agent-desk composer send selects that desk's Chat tab after
  acknowledgement. Pending/refused sends retain the selected tab; desk hosts,
  pins, pop-outs and other desks are retained. Project desks have no Chat tab.
  [decided: user 2026-10-18 10:57Z; verified: `canvas/desk.tsx`,
  `tests/desksendtab.test.tsx`]
<!-- /preserved:e-3300b22809d274db -->

<a id="e-96f6ef9e7fd2ea6b"></a>

## The project composer keeps its unsent text by project identity and shares the

Original section: AGENTS.md — working on Orgtree. Source lines 1301–1306.

<!-- preserved:e-96f6ef9e7fd2ea6b -->
- The project composer keeps its unsent text by project identity and shares the
  bounded per-node sent history; unmodified Up/Down recall only at the first/
  last line with no selection, preserving the pre-recall draft. Alt+B toggles
  broadcast alongside Alt+N for notice; a successful broadcast disarms, while
  a failed request leaves it armed. [decided: user 2026-10-18 13:56–13:59Z;
  verified: `canvas/projectdesk.tsx`, `tests/projectdesk.test.tsx`]
<!-- /preserved:e-96f6ef9e7fd2ea6b -->

<a id="e-ba015728fee48b44"></a>

## Agent/project desks offer Team via the existing Agents List, restricted to

Original section: AGENTS.md — working on Orgtree. Source lines 1318–1326.

<!-- preserved:e-ba015728fee48b44 -->
- Agent/project desks offer Team via the existing Agents List, restricted to
  self plus descendants from the shared feed map. Keep filter/Active, ordering,
  navigation and canonical menus shared. `agent-team` uses PanelCorner/PinFrame
  and generation-checked window restoration. The switchboard menu opens the
  global Agents list. See [Team tab](../../docs/rust-engine/team-tab.md).
  The skills tree assigns `AgentTeamView` to `canvas/agents-list` and `TeamModal`
  to `desk/agent-desk`; keep both homes with exported Team screens.
  [verified: `docs/skills/tree.json`, `canvas/team.tsx`; 2026-10-18]
  [decided: user 2026-10-18 10:53–10:56Z; verified: `canvas/{team,desk,projectdesk,OrgCanvas,agentmenu,cards}.tsx`]
<!-- /preserved:e-ba015728fee48b44 -->

<a id="e-cf1e815d4e3e49c6"></a>

## In an agent's desk context, presentation context menus on both the desk-header

Original section: AGENTS.md — working on Orgtree. Source lines 1335–1341.

<!-- preserved:e-cf1e815d4e3e49c6 -->
- In an agent's desk context, presentation context menus on both the desk-header
  presentation chips (`.desk-docs .doc-badge`) and rows in the Presented tab
  (`AgentGalleryView`) offer `Reply` (matching project desks; user 2026-10-19 11:46Z) when the desk accepts mail (`canMail` and
  not evicted). Choosing it stages a `kind: 'document'` reply target in the desk
  composer using the same reply-target mechanism as replying to mail. [decided:
  user 2026-10-18 08:54Z; verified: `canvas/docs.tsx`, `canvas/gallery.tsx`,
  `canvas/desk.tsx`, `eventReply.ts`, `tests/contextmenu.test.tsx`]
<!-- /preserved:e-cf1e815d4e3e49c6 -->

<a id="e-65d896d228121af3"></a>

## Projects pass active audiences to live direct members as their own; no nested

Original section: AGENTS.md — working on Orgtree. Source lines 1351–1360.

<!-- preserved:e-65d896d228121af3 -->
- Projects pass active audiences to live direct members as their own; no nested
  relay. Migration 0032 also expands project grantors to their direct live agents:
  A->B reaches B's members; reverse access needs B->A. User project mail/broadcast
  grants only the project, never personal member rows. Direct user contact grants
  only without effective user access; manual Acquire still creates an explicit
  grant while inherited. Keep ancestor forwarding separate from contact grants.
  Operational checks use the effective view; explicit grant administration does
  not. Org-inbox remains agent-only. See [project audiences](../../docs/rust-engine/project-audiences.md).
  [decided: user/coordinator 2026-10-18 14:09–14:12Z; verified:
  `domain/{mail,runtime_notices,audiences}.rs`, `http/nodes.rs`, `0032_project_member_audiences.sql`]
<!-- /preserved:e-65d896d228121af3 -->

<a id="e-f8e62b7678dd25bc"></a>

## orgtree_present project=P needs no user audience for agents strictly below

Original section: AGENTS.md — working on Orgtree. Source lines 1363–1368.

<!-- preserved:e-f8e62b7678dd25bc -->
- `orgtree_present project=P` needs no user audience for agents strictly below
  P, including nested-project members. Ancestors still need the user audience;
  unrelated projects still fail reach, and no-project calls keep the audience
  requirement. This recursive presentation exception is separate from direct-only
  project audience inheritance. [decided: user 2026-10-18 07:38Z; verified:
  `domain/docs.rs`, `tools/rig/proofs/project-present.mjs`]
<!-- /preserved:e-f8e62b7678dd25bc -->

<a id="e-91d0170d965e30c8"></a>

## EPIC whole-window shakes stop during pointer movement or a held press,

Original section: AGENTS.md — working on Orgtree. Source lines 1369–1375.

<!-- preserved:e-91d0170d965e30c8 -->
- EPIC whole-window shakes stop during pointer movement or a held press,
  settle for 250ms, and stay off while hovering clickable controls (including
  watchdog chips, links, fields and the org inbox). Each stage owns and removes
  its document's capture listeners; adopted pop-out targets are duck-typed.
  Camera transforms and other EPIC effects are untouched. See
  [pointer stability](../../docs/rust-engine/epic-mode-final.md#pointer-stability-2026-10-18).
  [decided: user 2026-10-18 07:49Z; verified: `epic/stage.ts`]
<!-- /preserved:e-91d0170d965e30c8 -->

<a id="e-2565a34a475406f4"></a>

## Watchdog detail cards name every listener type and explain its actual trigger.

Original section: AGENTS.md — working on Orgtree. Source lines 1377–1385.

<!-- preserved:e-2565a34a475406f4 -->
- Watchdog detail cards name every listener type and explain its actual trigger.
  Slot claims show their current queue ordinal or their granted slot/lease and
  spent state, using the slots projection and shared current watchdog snapshot.
  Silence is separate; only file/command/process use polling cadences, while
  project mail is pushed and event-mode stream/activity/event use minimum gaps.
  Keep desktop `notice` projection from `memo.notice` so passive alerts are not
  described as wakes. See [watchdog card](../../docs/rust-engine/watchdog-detail-card.md).
  [decided: user 2026-10-18; verified: `canvas/watchdogdescription.ts`,
  `canvas/modals.tsx`, `domain/watchdogs.rs`]
<!-- /preserved:e-2565a34a475406f4 -->

<a id="e-1a374702e1e4a01d"></a>

## Committees without a dedicated manager use a project under their supervisor;

Original section: AGENTS.md — working on Orgtree. Source lines 1445–1451.

<!-- preserved:e-1a374702e1e4a01d -->
- Committees without a dedicated manager use a project under their supervisor;
  large/complex committees may instead put members directly under a dedicated
  non-voting manager, with no committee project. Set the actual host's Subordinates
  may message each other OFF to preserve independence. The full workflow lives
  in `orgtree-committee-mode` (orgtree-workflows > collaboration-patterns).
  [decided: user 2026-10-17 22:00Z/22:10Z/22:12Z; coordinator 22:12Z applies
  the existing peer-mail rule to the manager]
<!-- /preserved:e-1a374702e1e4a01d -->

<a id="e-cb5dc74daa517a54"></a>

## Idle ages on the desk, card and tray use the completed turn's ended_at;

Original section: AGENTS.md — working on Orgtree. Source lines 1472–1476.

<!-- preserved:e-cb5dc74daa517a54 -->
- Idle ages on the desk, card and tray use the completed turn's `ended_at`;
  open/legacy rows without it retain the `started_at` fallback. Active time
  remains on `inflight_at`, including ordinary Antigravity hook mail delivery.
  All harnesses share this projection. See [turn clocks](../../docs/rust-engine/turn-completion-clock.md).
  [decided: coordinator 2026-10-17; verified: `domain/tree.rs`, `runtime/actor.rs`, `canvas/desk.tsx`]
<!-- /preserved:e-cb5dc74daa517a54 -->

<a id="e-3d3161b1c816920f"></a>

## State inspection memoizes effective ancestry only within its immutable

Original section: AGENTS.md — working on Orgtree. Source lines 1564–1570.

<!-- preserved:e-3d3161b1c816920f -->
- State inspection memoizes effective ancestry only within its immutable
  request snapshot, retaining the total 1024-node ancestry cap and visibility
  refusals. Folder clamps normalize each list entry once; pure path helpers
  are unlogged. Snapshot projection runs on a blocking worker after releasing
  the read-only database client, with its request tracing span and outer
  scope/count logs preserved. See [scope follow-up](../../docs/rust-engine/session-placement-blips.md#scope-inspection-follow-up).
  [decided: coordinator 2026-10-17; verified: `tools/orgview.rs`, `domain/scope.rs`]
<!-- /preserved:e-3d3161b1c816920f -->

<a id="e-d11f079ad56565f0"></a>

## Watchdog recurrence survives restart: persisted next poll/quiet slots skip

Original section: AGENTS.md — working on Orgtree. Source lines 1627–1632.

<!-- preserved:e-d11f079ad56565f0 -->
- Watchdog recurrence survives restart: persisted next poll/quiet slots skip
  missed periods with at most one catch-up and keep the original phase. Actual
  last-check/fire timestamps remain evidence. Polling silence checks the target
  first; a fresh match suppresses overdue quiet mail. Explicit resume begins a
  new recurrence; process DOWN remains edge-only. See [watchdog recurrence](../../docs/rust-engine/watchdog-recurrence.md).
  [decided: user/coordinator 2026-10-17; verified: `runtime/watchdogs.rs`, migration0027]
<!-- /preserved:e-d11f079ad56565f0 -->

<a id="e-448981fddd332d51"></a>

## Per-node Subordinates may message each other defaults ON. OFF gates

Original section: AGENTS.md — working on Orgtree. Source lines 1732–1745.

<!-- preserved:e-448981fddd332d51 -->
- Per-node **Subordinates may message each other** defaults ON. OFF gates
  all agent mail between the same actual parent's direct children unless the
  sender holds an active directional audience. Projects remain transparent for
  reporting; separate physical groups need audiences for coworker mail. A
  project-to-project audience connects direct live members in its granted
  direction while both projects' peer-mail switches are ON; ordinary agent
  audiences remain overrides. Nested members do not inherit that route. Their shared
  nearest agent superior may grant between direct siblings. Stored `scope.peer_mail`
  is node-local, never inherited; peer-only user saves retain project transparency,
  support undo and do not restart CLIs. The live envelope reports current policy;
  the shared wire list hides lateral links for both GL/SVG at every zoom.
  See [peer mail](../../docs/rust-engine/peer-mail.md). [decided: user/coordinator
  2026-10-19 20:35–20:38Z, replacing cross-project default reach; verified:
  `domain/peer_mail.rs`, `domain/mail.rs`, `canvas/OrgCanvas.tsx`]
<!-- /preserved:e-448981fddd332d51 -->

<a id="e-6617f189114f0831"></a>

## EPIC 4.4.0 activity audio uses the existing busy/activity tree state: six

Original section: AGENTS.md — working on Orgtree. Source lines 1755–1769.

<!-- preserved:e-6617f189114f0831 -->
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
  [EPIC activity sound](../../docs/rust-engine/epic-activity-sound.md).
  [decided: user 2026-10-17 09:18–09:41Z, 19:33Z, 21:25Z; 2026-10-18 13:24Z; verified: `epic/{activity,ambience,audio,heatfield,heatmap,toolvoice}.ts`]
<!-- /preserved:e-6617f189114f0831 -->

<a id="e-3ce227b9a30eba55"></a>

## Project nodes (4.4.0) are ot.agents rows with kind = 'project': free tree nodes that run

Original section: AGENTS.md — working on Orgtree. Source lines 1771–1795.

<!-- preserved:e-3ce227b9a30eba55 -->
- Project nodes (4.4.0) are `ot.agents` rows with `kind = 'project'`: free tree nodes that run
  no turns, with a folder (`_teams/<id>`), a mailbox and presentations. Invariants:
  - Every query that picks agents to run, warm, notify, remind or count filters
    `kind = 'agent'`.
  - An agent's superior is `ot.superior_of(id)`, its nearest agent ancestor, not `parent_id`.
  - Runtime freeze/error, launch, exhausted-retry and parked cards use
    `ot.live_superior_of(id)` (nearest live agent, otherwise user). Retool and desktop
    scope cascades pass through project rows without writing their policy. Migration
    0035 repairs damaged transparency once while retaining surviving settings.
    [verified: `domain/runtime_notices.rs`, `runtime/recovery.rs`, `domain/ops.rs`,
    `http/nodes.rs`, migration 0035; 2026-10-19]
  - A project's scope is transparent: `scope::clamp` passes its parent's scope through.
  - Its `grant_credits` mirrors its live children's stake and is re-settled by
    `projects::settle_credits` at the end of every `run_in_tx`, so costs go to the nearest
    agent above (user 2026-10-16 20:40Z).
  - Project mail reaches agents only through `fair_queue` dogs: one watcher per mail, the
    least recently woken first.
  - New awaits on the actor's turn path go through `boxed` (see the actor stack entry at the
    top; it replaced call-site `Box::pin`). Inline, they overflowed the debug engine thread's
    stack at turn start.
  - A project's description (`charter`) is the team charter of its subtree: `load_ctx`'s
    cascade takes it in place of `team_charter` for a project ancestor (user 2026-10-17 19:14Z).
  Design and rulings: [project nodes](../../docs/rust-engine/PROJECT-NODES.md).
  [decided: user 2026-10-16 16:11Z–2026-10-17 19:14Z; verified: `domain/projects.rs`, `domain/ops.rs`,
  `runtime/actor.rs`, migration 0025]
<!-- /preserved:e-3ce227b9a30eba55 -->

<a id="e-7bee0260a375be92"></a>

## Names typed into manual hire UI and project-name UI trim leading/trailing spaces and replace

Original section: AGENTS.md — working on Orgtree. Source lines 1797–1800.

<!-- preserved:e-7bee0260a375be92 -->
- Names typed into manual hire UI and project-name UI trim leading/trailing spaces and replace
  each run of spaces with one hyphen before validation. Other invalid characters keep their
  existing errors; agent hire/staff tools do not normalize. [decided: user 2026-10-17 19:22Z;
  verified: `canvas/nameinput.ts`, `canvas/cards.tsx`, `canvas/OrgCanvas.tsx`]
<!-- /preserved:e-7bee0260a375be92 -->

<a id="e-b196a8ced5f93439"></a>

## Far-zoom agent and project cards share a floating hover/focus name above the

Original section: AGENTS.md — working on Orgtree. Source lines 1818–1825.

<!-- preserved:e-b196a8ced5f93439 -->
- Far-zoom agent and project cards share a floating hover/focus name above the
  card layer; their native tooltips contain details without a repeated name.
  The shared floating name reveals its full text up to the same 600px ceiling
  as the in-card agent reveal. [decided: user/coordinator 2026-10-20;
  verified: `styles.css`, `tests/farzoomproject.test.tsx`]
  Other zoom levels and identity-less links keep their existing name rules.
  [decided: user 2026-10-19 17:21Z; verified: `canvas/farzoomname.tsx`,
  `canvas/cards.tsx`, `canvas/projectcard.tsx`]
<!-- /preserved:e-b196a8ced5f93439 -->

<a id="e-a65c0802c9cd7ba4"></a>

## Normal-zoom agent and project card names share CardName: hovering a card

Original section: AGENTS.md — working on Orgtree. Source lines 1827–1832.

<!-- preserved:e-a65c0802c9cd7ba4 -->
- Normal-zoom agent and project card names share `CardName`: hovering a card
  reveals the full name in place on the existing `.name-full` backdrop only
  when its name is actually clipped. The overlay ignores pointer input and
  stays below hire controls; far-zoom floating labels are separate.
  [decided: user 2026-10-20 10:52Z; verified: `canvas/cardname.tsx`,
  `canvas/{cards,projectcard}.tsx`, `tests/namehover.test.tsx`]
<!-- /preserved:e-a65c0802c9cd7ba4 -->

<a id="e-c2e06dea7a68d4fb"></a>

## When a shared agent/project link's visible label omits its identity, its

Original section: AGENTS.md — working on Orgtree. Source lines 1834–1840.

<!-- preserved:e-c2e06dea7a68d4fb -->
- When a shared agent/project link's visible label omits its identity, its
  native tooltip starts with that name; visible-name labels are not duplicated.
  Shared context-menu identity entries and icon-only model/project marks opt
  into the same behavior. Near-zoom agent/project card names use the rich
  tooltip without a competing plain `title`. [decided: user 2026-10-18 18:16Z;
  verified: `canvas/agentnav.tsx`, `canvas/identity.tsx`, `canvas/contextmenu.tsx`,
  `canvas/cards.tsx`, `canvas/projectcard.tsx`]
<!-- /preserved:e-c2e06dea7a68d4fb -->

<a id="e-eda15f799a6fe9f3"></a>

## Muse last-good usage is durable per account in ot.kv (muse_usage:&lt;id&gt;),

Original section: AGENTS.md — working on Orgtree. Source lines 1979–1987.

<!-- preserved:e-eda15f799a6fe9f3 -->
- Muse last-good usage is durable per account in `ot.kv` (`muse_usage:<id>`),
  restored before discovery with original observation age and no new auth
  evidence. Removal deletes its key in the account transaction; writers take
  KEY SHARE on the account row to prevent late durable resurrection. Read
  projection makes passed-reset Muse windows unknown (never zero), with no
  bar and `reset; awaiting reading`; other providers are unchanged.
  [decided: coordinator 2026-10-15 11:47Z; verified from source:
  `usage/muse_cache.rs`, `usage.rs`, `domain/account_removal.rs`; contract and
  measured limits: `docs/rust-engine/muse-usage-cache.md`]
<!-- /preserved:e-eda15f799a6fe9f3 -->

<a id="e-8578146eecc18998"></a>

## A wheel over the canvas is not a zoom by where it lands: OrgCanvas's wheel listener

Original section: AGENTS.md — working on Orgtree. Source lines 2121–2129.

<!-- preserved:e-8578146eecc18998 -->
- A wheel over the canvas is not a zoom by where it lands: OrgCanvas's wheel listener
  leaves `.pinwin`, `.tray`, `.desk-over` and `.overlay` to the browser's own scrolling
  and zooms everywhere else, clamped to [min zoom, `Z_MAX`]. EPIC Mode's hands therefore
  judge a wheel by what it moved over the next frames: a zoom only for a wheel the canvas
  took (`defaultPrevented`) that changed the `scale()` on `.space`, a scroll for any
  scroll offset from the target up, nothing otherwise
  ([EPIC Mode final](../../docs/rust-engine/epic-mode-final.md)). [verified: `epic/director.ts`,
  `canvas/OrgCanvas.tsx`; measured: `tools/rig/epic-mode-visual.mjs` wheel scene,
  2026-10-15]
<!-- /preserved:e-8578146eecc18998 -->

<a id="e-58176f39c2f37395"></a>

## EPIC Mode's progression (epic/progress.ts: momentum, per-agent charge, the session's

Original section: AGENTS.md — working on Orgtree. Source lines 2165–2173.

<!-- preserved:e-58176f39c2f37395 -->
- EPIC Mode's progression (`epic/progress.ts`: momentum, per-agent charge, the session's
  level, chains) is plain numbers decayed from timestamps when read: never a timer, frame
  or listener for it, so a quiet org costs nothing, and chains happen only inside an
  event. It lives in memory for the app session (it survives EPIC off/on and starts fresh
  on restart); saving it is the user's call (asked 2026-10-15) and would touch only that
  module. An event's lift scales its effects only within the stage's caps and the comfort
  bounds ([EPIC Mode final](../../docs/rust-engine/epic-mode-final.md)). [decided: user
  2026-10-15 (part 3), plan approved by the coordinator 2026-10-15; verified:
  `epic/progress.ts`, `epic/director.ts`; measured: `epicmode-progress`, 2026-10-16]
<!-- /preserved:e-58176f39c2f37395 -->

<a id="e-be06b81e0f8b72ea"></a>

## Desk-slot removal resolves the eligible remaining owner after the React

Original section: AGENTS.md — working on Orgtree. Source lines 2255–2260.

<!-- preserved:e-be06b81e0f8b72ea -->
- Desk-slot removal resolves the eligible remaining owner after the React
  commit and before publishing the registry revision. Publishing first lets
  a slot draw a stale elsewhere placeholder beside the returned live desk.
  Ordinary re-renders still do not claim ownership; borrow and detached rules
  remain in `pick`. See [desk owner close](../../docs/rust-engine/desk-owner-close.md).
  [decided: user 2026-10-14 18:36UTC; verified from source: `canvas/deskhosts.tsx`]
<!-- /preserved:e-be06b81e0f8b72ea -->

<a id="e-2a9b7ed4515392a4"></a>

## Live tool writing/execution clocks floor actual elapsed seconds and schedule

Original section: AGENTS.md — working on Orgtree. Source lines 2301–2308.

<!-- preserved:e-2a9b7ed4515392a4 -->
- Live tool writing/execution clocks floor actual elapsed seconds and schedule
  at boundaries relative to the observed start; completed formatting remains
  precise. Omit an unobserved writing-time slot entirely; measured zero remains
  visible, and executing tool status uses the same right arrow as execution time.
  Codex tool generation requires a genuine pre-execution observation,
  never the execution span or unrelated preceding/turn time. See
  [live clocks and probe status](../../docs/rust-engine/live-tool-clock.md).
  [decided: user/coordinator 2026-10-14; verified from source: `toolclock.tsx`, `desk.tsx`]
<!-- /preserved:e-2a9b7ed4515392a4 -->

<a id="e-c52d108713c0da38"></a>

## Reparent drag ghosts use the same display projection and final targets as

Original section: AGENTS.md — working on Orgtree. Source lines 2566–2569.

<!-- preserved:e-c52d108713c0da38 -->
- Reparent drag ghosts use the same display projection and final targets as
  the move animation, including piles and inbox clearance. Keep sibling drags
  as separators and inbox drops as audience actions. See [landing ghost](../../docs/rust-engine/reparent-ghost.md).
  [decided: user 2026-10-13 18:58UTC; verified: `canvas/moveghost.tsx`, `canvas/canvaslayout.ts`, `OrgCanvas.tsx`]
<!-- /preserved:e-c52d108713c0da38 -->

<a id="e-cc332da26c1927c5"></a>

## Usage history cards export the former table's measured points as CSV/JSONL,

Original section: AGENTS.md — working on Orgtree. Source lines 2625–2630.

<!-- preserved:e-cc332da26c1927c5 -->
- Usage history cards export the former table's measured points as CSV/JSONL,
  with raw UTC/value and series identity; never export projected points or
  invent missing observations. Downloads use the clicked document so adopted
  popouts retain native download custody. Remove only the current-time rule;
  reset/crosshair/end/future markers remain. See [export contract and proof](../../docs/rust-engine/usage-history-export.md).
  [decided: user 2026-10-13; verified: `usagehistory.tsx`, `usagehistoryexport.ts`, 2026-10-13]
<!-- /preserved:e-cc332da26c1927c5 -->

<a id="e-832693868628f9c0"></a>

## New-org presets with no offered slot (including fallbacks) are dimmed and

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2785–2792.

<!-- preserved:e-832693868628f9c0 -->
- New-org presets with no offered slot (including fallbacks) are dimmed and
  collapsed after the first sign-in check, but remain selectable. Selection
  opens model choices and warns; edits follow the current plan, partial layouts
  retain per-slot blocking. Invalid files remain disabled, checking/unknown
  stays normal, and template filename order is preserved. See
  [preset availability](../../docs/rust-engine/preset-availability.md).
  [decided: user 2026-10-14 17:56:42Z; verified from source: `domain/templates.rs`,
  `http/templates.rs`, `shell/templatepicker.tsx`; batch checks pending]
<!-- /preserved:e-832693868628f9c0 -->

<a id="e-30b559b6dadeed35"></a>

## Far overview (z &lt; Z_MINI) hides watchdog satellites/wires, presentation

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2870–2877.

<!-- preserved:e-30b559b6dadeed35 -->
- Far overview (`z < Z_MINI`) hides watchdog satellites/wires, presentation
  side chips, the switchboard's infinite credit bar, and hidden-retired list
  tokens when Hide Retired is on. The org-inbox mailbox becomes one globe
  (`PublicIcon`), matching its normal tile and modal header; preserve far sizing
  and accessibility text. [decided: user 2026-10-14 18:41UTC]
  agent left-edge accents use tier colour with provider fallback. Zooming in
  restores retained content. See [far overview](../../docs/rust-engine/far-overview.md).
  [decided: user/coordinator 2026-10-13 19:00?19:05Z]
<!-- /preserved:e-30b559b6dadeed35 -->

<a id="e-64ef5ae2c0e92db3"></a>

## Event watchdogs (kind:event) receive pushed, allow-listed post-commit events.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3459–3477.

<!-- preserved:e-64ef5ae2c0e92db3 -->
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
<!-- /preserved:e-64ef5ae2c0e92db3 -->

<a id="e-53516c53f799bf06"></a>

## Periodic watchdog countdowns roll forward from the last persisted check and

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3479–3486.

<!-- preserved:e-53516c53f799bf06 -->
- Periodic watchdog countdowns roll forward from the last persisted check and
  effective interval in the renderer, using one shared clock. Under one hour
  they show m:ss, then h/m below a day and d/h from a day; subscribers update
  only when their displayed value changes. Ordinary polls do not refresh the
  watchdog feed; a matching silence-mode poll does when it
  resets the real silence deadline. [verified: 2026-10-17;
  `engine/rs/orgtree-engine/src/runtime/watchdogs.rs`,
  `apps/desktop/renderer/src/canvas/watchdogcountdown.tsx`]
<!-- /preserved:e-53516c53f799bf06 -->

<a id="e-f2a1c85f9890556e"></a>

## Recovery attachment uses an empty local slot while retaining boot topology

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3523–3528.

<!-- preserved:e-f2a1c85f9890556e -->
- Recovery attachment uses an empty local slot while retaining boot topology
  separately; failure restores task ownership, never a managed fallback. Manual
  Restart uses configured recovery only after stamped native death; healthy
  restart still authenticates its transition, and Quit cancels both paths.
  [verified: 2026-10-12 `engine.ts`, `core-lifecycle.ts`; regression
  `tests/core-recovery-review.test.mjs`]
<!-- /preserved:e-f2a1c85f9890556e -->

<a id="e-1ab5981d268dd801"></a>

## Agent log context must cross spawned tasks and channel messages: use agent:&lt;id&gt;/&lt;name&gt;

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3737–3742.

<!-- preserved:e-1ab5981d268dd801 -->
- Agent log context must cross spawned tasks and channel messages: use `agent:<id>/<name>`
  for actor work and `dog:<uid>/<owner name>` for watchdog work. Keep actual UI requests as
  `user`/`desktop`; HTTP has no agent credential path. Reuse identity rows already loaded,
  and instrument async futures instead of holding an entered span across an await.
  [verified from source: 2026-10-07, `src/runtime/`; measured log audit and limits:
  `docs/rust-engine/agent-log-context.md`; user clarification of DECISIONS 34]
<!-- /preserved:e-1ab5981d268dd801 -->

<a id="e-e8d05c22ccfb2742"></a>

## Attention's Swap panels exchanges the persisted split and visual order together.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3822–3825.

<!-- preserved:e-e8d05c22ccfb2742 -->
- Attention's Swap panels exchanges the persisted split and visual order together.
  The physical left slot owns the fixed percentage; the right slot takes the remainder
  after the divider, so its six-pixel width does not move the divider during a swap.
  [verified from source: 2026-10-07, renderer `attention/AttentionView.tsx`]
<!-- /preserved:e-e8d05c22ccfb2742 -->

<a id="e-ba47bc1ed54a6376"></a>

## Watchdog drag positions (2026-10-07, verified from source). Canvas drag bases

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4037–4041.

<!-- preserved:e-ba47bc1ed54a6376 -->
**Watchdog drag positions (2026-10-07, verified from source).** Canvas drag bases
include watchdog satellites for every dragged owner in the subtree. The same
bases suspend springs during dragging and restore positions on pointercancel;
cards and connectors both read those springs. Keep satellites in that shared
path for row and ring layouts (`canvas/OrgCanvas.tsx`).
<!-- /preserved:e-ba47bc1ed54a6376 -->

<a id="e-ffa0610eebeb40eb"></a>

## .chip repaints whatever wears it: it sits late in styles.css at one-class

Original section: Desktop and renderer. Source lines 4655–4659.

<!-- preserved:e-ffa0610eebeb40eb -->
- **`.chip` repaints whatever wears it:** it sits late in `styles.css` at one-class
  specificity, so a `chip x-card` element loses `.x-card`'s border, background and text
  colour (only a two-class state like `.x-card.full` survives). A coloured card does not
  wear `.chip`; the project desk's header cards lost their colours this way. [verified:
  `styles.css`, `tests/projectdeskhead.test.tsx` (computed colours), 2026-10-19]
<!-- /preserved:e-ffa0610eebeb40eb -->

<a id="e-a9a829a04631f264"></a>

## useMailboxHistory takes only 'inbox' or 'sent': it adopts a folder when it

Original section: Desktop and renderer. Source lines 4660–4664.

<!-- preserved:e-a9a829a04631f264 -->
- **`useMailboxHistory` takes only `'inbox'` or `'sent'`:** it adopts a folder when it
  reads that folder's pages, so any other folder (a host folder such as the project
  inbox's listeners) never settles and remakes the box on every render, an endless
  update loop through InboxView's retract sweep. Pass the mail folder underneath.
  [verified: `usemailhistory.ts`, `canvas/mail.tsx`, 2026-10-19]
<!-- /preserved:e-a9a829a04631f264 -->

<a id="e-4726425a8be7d03b"></a>

## Circular sibling arcs: parent/arc-centre springs relax all depths together, so

Original section: Desktop and renderer. Source lines 4692–4704.

<!-- preserved:e-4726425a8be7d03b -->
- **Circular sibling arcs:** parent/arc-centre springs relax all depths together, so
  crowded subordinates push their superiors apart. Ordered collision projection keeps
  the 190 px pitch and wrap clearance without reordering. Each end's half of a team's
  pull moves the run of leaf siblings (no visible reports) at that end as one block,
  so a leaf never drifts away from its leaf neighbours and a team of leaves settles
  rigidly. This replaced pulling the two end cards alone, which left end agents set
  apart from their team (user report 2026-10-20 10:46Z). Existing ring radii still
  limit how closely arcs can align; only the existing capacity rule grows a radius.
  Up to 256 deterministic relaxation steps run per layout change, never per frame;
  unchanged numeric topology reuses one cached rest state, so status-only feeds
  do not restart the solver. Existing card springs animate to that rest state. [recorded-decision: user,
  2026-10-07; verified-from-source: `canvas/shared.ts`, `canvas/ringsprings.ts`,
  `canvas/ringarcs.ts`, `tests/ringteams.test.ts`, 2026-10-20]
<!-- /preserved:e-4726425a8be7d03b -->

<a id="e-259dd595a4c75786"></a>

## External MCP discovery reads explicit user configs from Claude Code, Codex,

Original section: MCP imports from installed harnesses (2026-10-15). Source lines 5152–5159.

<!-- preserved:e-259dd595a4c75786 -->
- External MCP discovery reads explicit user configs from Claude Code, Codex,
  Antigravity, Muse and OpenCode; no harness launch, project scan or config write.
  Equal definitions merge provenance; differing names retain both with suffixes,
  Claude first for existing grants [decided: user 2026-10-15]. Settings Refresh
  rereads definitions without touching active processes. Renderer metadata is an
  allowlist (name/source/transport), never definition values. Reference paths,
  normalization and OAuth limits: [MCP imports](../../docs/rust-engine/mcp-imports.md).
  [verified: `engine/rs/orgtree-engine/src/providers/mcp.rs`]
<!-- /preserved:e-259dd595a4c75786 -->

<a id="e-74697db6067c093d"></a>

## Hierarchical shared memory is documented in orgtree-shared-folders

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5259–5263.

<!-- preserved:e-74697db6067c093d -->
- Hierarchical shared memory is documented in `orgtree-shared-folders`
  (orgtree-working > workspace): own scratch, ancestor team/project workspaces,
  org shared notes, and session-start inheritance. The trimmed folder paragraph
  points there; supervisors reach project folders below without inheriting their
  notes. [verified: `runtime/identity.rs`, `runtime/actor.rs`, `domain/teams.rs`; 2026-10-20]
<!-- /preserved:e-74697db6067c093d -->

## Network watchdog connection mail

MQTT/WebSocket connection_messages defaults to notice for new and legacy
watchers; wake and off are explicit alternatives. Administrative connection
mail never consumes once or runs actions, including WebSocket connects which
previously fired. Configuration reads/writes only this dog and does not redial;
data delivery is independent. See [WebSocket contract](../rust-engine/websocket-watchdogs.md#connection-notifications).
[decided: user 2026-10-22 13:01Z/13:02:30Z; coordinator 13:03:54Z; verified: runtime/watchdogs.rs]

Project setting **Project Events** and desk tab **events** replace the former
Event listeners / Listeners labels (user 2026-10-22 15:10:20Z). Menus, shortcut
tooltips and standalone window controls use events too. The `event_listeners`
field, `listeners` tab id, `project-listeners` panel kind, watchdog kinds and
tool parameters remain unchanged; the Mail tab’s listeners folder is separate.
[verified: `canvas/modals.tsx`, `deskshell.tsx`, `agentmenu.tsx`, `panelcorner.tsx`; 2026-10-22]
