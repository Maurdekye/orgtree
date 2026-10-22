# Repository instruction topics

[Startup guide](../../AGENTS.md)

The root guide contains only before-work constraints. These topic references retain every earlier content block and its ruling/verification tags. The index uses stable content IDs and original source sections so a fact can be found without loading the whole former guide. Current signed decisions and source govern; the preserved text includes old states, evidence limits and explicit supersessions.

## Topics

| Topic | Read before changing |
| --- | --- |
| [Engine and storage](engine-and-storage.md) | Actors, bounded reads, transactions, migrations, logging and data contracts. |
| [Agent runtime](agent-runtime.md) | Turns, context, compaction, warm processes, sessions, interrupts and transcript recovery. |
| [Providers and accounts](providers-and-accounts.md) | Harnesses, model/effort offers, account binding, credentials, usage and inference routes. |
| [Instructions and skills](instructions-and-skills.md) | Identity prefixes, tool cards, notes, globals, shared skills and glossary delivery. |
| [Organization tree and tools](org-tree-and-tools.md) | Scope, authority, topology, credits, hiring, lifecycle and typed tool contracts. |
| [Projects and concurrency](projects-and-concurrency.md) | Project folders, policy, slots, listeners, watchdogs, queues and coordination. |
| [Mail and hub](mail-and-hub.md) | Delivery, mentions, inboxes, outside authority, files, Hubchat and hub transport. |
| [Docket and presentations](docket-and-presentations.md) | Work records, questions, documents, attachments, viewers and attention. |
| [Desktop and renderer](desktop-and-renderer.md) | Canvas, desks, links, menus, windows, geometry, rendering and visual behavior. |
| [Startup and release](startup-and-release.md) | Boot, shutdown, placement, installers, native integration, updates and release evidence. |
| [Development and verification](development-and-verification.md) | Worktrees, build/resource rules, tests, evidence, platform traps and maintenance. |
| [Legacy and superseded records](legacy-and-superseded.md) | 3.x implementation/procedures, stopped work, historical states and earlier guidance. |

## Preservation check

Run `node docs/agents/check-coverage.mjs --self-test` from the repository root. It reads the committed source baseline named in [coverage.json](coverage.json), checks every original nonblank line occurs in exactly one mapped range, and compares every moved body after line-ending/entry-separator normalization, relative-link rebasing and heading demotion. Literal inline and fenced code is retained; two positive controls guard it. All original `[decided…]` and `[verified…]` tags remain in those bodies. Stable IDs point to their exact destinations. The four in-memory negative controls remove a range, remove a body, change an attribution and break a navigation link; all must be rejected without changing files. The checker starts no engine/build/database/provider.

Before integration, compare against the latest untrimmed integration tip with `node docs/agents/check-coverage.mjs --source-ref <tip>`. If the source digest changed, do not waive the failure: preserve the newly added entries too, update the baseline/ranges/destinations, and rerun. Rebase with `git -c rerere.enabled=false`; resolve the root guide and incoming topic records deliberately. After the restructure is integrated, the baseline remains the pre-restructure source: new details belong directly in topic docs, and must not be appended to the root. Keep preserved records and their attribution when superseding them; a record can move to history if its coverage destination and incoming links move with it.

The token figure is an explicitly labeled characters/4 heuristic; byte and line counts are measured. No provider tokenizer or cache-hit claim is implied. A normal clone needs the source commit to run the historical comparison; fetch sufficient history rather than treating a missing object as a pass.

## Original entry index

| Entry | Original section | Content |
| --- | --- | --- |
| [e-afee43810f9d96a8](mail-and-hub.md#e-afee43810f9d96a8) | Unsectioned integration notes | @user mentions in agent transcripts, mail, presentations and docket items |
| [e-de4e633eb38398d7](instructions-and-skills.md#e-de4e633eb38398d7) | Unsectioned integration notes | Skill-enabled standing instructions use the user-approved 26 wording cuts; |
| [e-b19f3263632f4d67](projects-and-concurrency.md#e-b19f3263632f4d67) | Unsectioned integration notes | Per-target modals are one window per target: Mail, Docket, Team, Slots, |
| [e-986f9b7d10b5b675](projects-and-concurrency.md#e-986f9b7d10b5b675) | Unsectioned integration notes | Project canvas cards and desk-header chips show only their own documents, |
| [e-765289ad334e5812](projects-and-concurrency.md#e-765289ad334e5812) | Unsectioned integration notes | Retired pile rows use project folder badges and label complete project-only |
| [e-5af536d67d272161](docket-and-presentations.md#e-5af536d67d272161) | Unsectioned integration notes | Presentations reveal the opening unread selection once inside their list, |
| [e-e2c9a7b23d402832](projects-and-concurrency.md#e-e2c9a7b23d402832) | Unsectioned integration notes | Project desk reopening uses the agent desk's camera/pin/window reveal routes. |
| [e-615f7e44b1b427ba](projects-and-concurrency.md#e-615f7e44b1b427ba) | Unsectioned integration notes | Project Mail queue leave actions live on the user's rows, never a separate |
| [e-523c0c9ff8c80693](projects-and-concurrency.md#e-523c0c9ff8c80693) | Unsectioned integration notes | Mail-list monitor senders use the matching typed watchdog reference's name, |
| [e-1d016b2bf8978b98](docket-and-presentations.md#e-1d016b2bf8978b98) | Unsectioned integration notes | Docket rows and every ticket-link menu use canvas/ticketmenu.ts for all |
| [e-64f1421f316d793b](docket-and-presentations.md#e-64f1421f316d793b) | Unsectioned integration notes | HTML capture failures for missing/unreadable local assets name the source |
| [e-b010624f7405c185](mail-and-hub.md#e-b010624f7405c185) | Unsectioned integration notes | The shared context-menu renderer puts an Open submenu second at every menu |
| [e-e71373a072b7b615](agent-runtime.md#e-e71373a072b7b615) | Unsectioned integration notes | Automatic known-cold cheap compaction defaults ON/25% for new orgs and |
| [e-fffd11379d05a58b](instructions-and-skills.md#e-fffd11379d05a58b) | Unsectioned integration notes | Every instruction lane, full and trimmed, always names the concurrency |
| [e-4ceb1e01984483a6](agent-runtime.md#e-4ceb1e01984483a6) | Unsectioned integration notes | Transcript live tool and thought clocks use whole seconds below 60s, then |
| [e-3f0d4920f320f0ce](projects-and-concurrency.md#e-3f0d4920f320f0ce) | Unsectioned integration notes | Selected team/project dockets retain requested retired-owner selections after |
| [e-43f61695c2e13155](development-and-verification.md#e-43f61695c2e13155) | Unsectioned integration notes | Engine tests that require a synthetic PostgreSQL cluster are explicitly |
| [e-e3f3b62e2d64e16c](instructions-and-skills.md#e-e3f3b62e2d64e16c) | Unsectioned integration notes | The project desk glossary reference owns its tabs, queue/event/slot history |
| [e-5108a0a027766e46](instructions-and-skills.md#e-5108a0a027766e46) | Unsectioned integration notes | The harness parity reference inventories all five |
| [e-0a943dac6941b095](projects-and-concurrency.md#e-0a943dac6941b095) | Unsectioned integration notes | Node placement accepts projects for descendant promotion and explicit restore |
| [e-a689d2737bbf045c](projects-and-concurrency.md#e-a689d2737bbf045c) | Unsectioned integration notes | WebSocket notify_on_connect defaults false, including absent legacy memo |
| [e-05e939b10aafe580](agent-runtime.md#e-05e939b10aafe580) | Unsectioned integration notes | WebSocket watchdogs (kind=websocket, orgtree_watchdog action=send) keep a |
| [e-a3b847c6b17a8585](development-and-verification.md#e-a3b847c6b17a8585) | Unsectioned integration notes | Log canary tests use crate::trace::LogCapture (start, then finish() for |
| [e-5ae942752b1afc0d](development-and-verification.md#e-5ae942752b1afc0d) | Unsectioned integration notes | Large futures on deep paths are awaited through util::boxed( …), which |
| [e-15a421795b235b62](projects-and-concurrency.md#e-15a421795b235b62) | Unsectioned integration notes | Project desks reuse the agent desk's pieces, never copies: the up row (its own |
| [e-144729bec131b982](projects-and-concurrency.md#e-144729bec131b982) | Unsectioned integration notes | Every desk reopens on the tab last picked on it, and a project desk's Mail tab |
| [e-068a98ce034aef18](projects-and-concurrency.md#e-068a98ce034aef18) | Unsectioned integration notes | Card shortcuts (Show agent card shortcuts) are never drawn over a desk: a |
| [e-b675df184c1c2a98](projects-and-concurrency.md#e-b675df184c1c2a98) | Unsectioned integration notes | Renderer supervisory controls use agentSuperior, effectiveReports and |
| [e-5ef50fb6f47c902d](providers-and-accounts.md#e-5ef50fb6f47c902d) | Unsectioned integration notes | Fast-mode hire/rehire/staff/retool fields share exact-model validation; |
| [e-edc771538215dbc9](instructions-and-skills.md#e-edc771538215dbc9) | AGENTS.md — working on Orgtree | AGENTS.md — working on Orgtree |
| [e-1bb79030bc5f41cd](projects-and-concurrency.md#e-1bb79030bc5f41cd) | AGENTS.md — working on Orgtree | Watchdog creation has no per-agent or per-org number cap. More than eight |
| [e-95d2138b00155eed](docket-and-presentations.md#e-95d2138b00155eed) | AGENTS.md — working on Orgtree | Presentation galleries select the oldest unread/changed card on each fresh |
| [e-ba915ec30cf32da4](projects-and-concurrency.md#e-ba915ec30cf32da4) | AGENTS.md — working on Orgtree | Project bunches are a display projection of maximal direct project-only runs: |
| [e-ccfb0bacdb242c53](projects-and-concurrency.md#e-ccfb0bacdb242c53) | AGENTS.md — working on Orgtree | Circular rings size each card's arc slot by its own footprint: a project bunch, |
| [e-b321854727deec05](projects-and-concurrency.md#e-b321854727deec05) | AGENTS.md — working on Orgtree | Agent and project desk composers share resizeComposer: their base rows |
| [e-4b012b48dd3defab](docket-and-presentations.md#e-4b012b48dd3defab) | AGENTS.md — working on Orgtree | Docket palette tests read the shared --docket-status-color mapping. The |
| [e-97db5312c46eb7d7](projects-and-concurrency.md#e-97db5312c46eb7d7) | AGENTS.md — working on Orgtree | Slot watchdogs accept slots: 1..64 (default 1, at most project capacity). |
| [e-b68adb62729bf24c](projects-and-concurrency.md#e-b68adb62729bf24c) | AGENTS.md — working on Orgtree | Fair-queue listeners accept batch: 1..20 (default 1). Each bounded |
| [e-ce6c8f6006d5c62b](desktop-and-renderer.md#e-ce6c8f6006d5c62b) | AGENTS.md — working on Orgtree | Tray org lists reserve a scrollbar gutter only above ten orgs. Short lists |
| [e-8258982acbfa9d46](agent-runtime.md#e-8258982acbfa9d46) | AGENTS.md — working on Orgtree | Inline ticket links in transcript tool calls use a thin inset left edge from |
| [e-062352c49c6ccc08](providers-and-accounts.md#e-062352c49c6ccc08) | AGENTS.md — working on Orgtree | User-facing local inference providers are Language model servers (compact |
| [e-4fee614cf778a263](projects-and-concurrency.md#e-4fee614cf778a263) | AGENTS.md — working on Orgtree | Project lifecycle notices use project wording and remain passive, with the |
| [e-641b71c07a944055](projects-and-concurrency.md#e-641b71c07a944055) | AGENTS.md — working on Orgtree | The user /nodes/&lt;project&gt;/scope route accepts only peer_mail; all other |
| [e-1800a0070d494588](projects-and-concurrency.md#e-1800a0070d494588) | AGENTS.md — working on Orgtree | Team state inspection includes the caller's physical parent/sibling projects, |
| [e-acc446c136c60014](projects-and-concurrency.md#e-acc446c136c60014) | AGENTS.md — working on Orgtree | ORG STATE charts retain project rows and physical placement; report rosters |
| [e-24e0c637ef59e0a7](projects-and-concurrency.md#e-24e0c637ef59e0a7) | AGENTS.md — working on Orgtree | Move notices dedupe recipients. Same-superior placement changes notify only |
| [e-9ff3f95424852e56](projects-and-concurrency.md#e-9ff3f95424852e56) | AGENTS.md — working on Orgtree | Project policy (settings, Summary, name, order and queue purge) changes require |
| [e-1648155fbe6fd07a](projects-and-concurrency.md#e-1648155fbe6fd07a) | AGENTS.md — working on Orgtree | Project credit mirrors sum the first live agent frontier in one statement, |
| [e-b976f5013fbad9d0](projects-and-concurrency.md#e-b976f5013fbad9d0) | AGENTS.md — working on Orgtree | MQTT watchdogs (kind=mqtt) subscribe to a topic filter on an mqtt(s) broker. |
| [e-dda3355b4c2b9e64](instructions-and-skills.md#e-dda3355b4c2b9e64) | AGENTS.md — working on Orgtree | Outside input names its rule, never repeats it: the standing EXTERNAL MAIL |
| [e-f6fad7771f1f4727](projects-and-concurrency.md#e-f6fad7771f1f4727) | AGENTS.md — working on Orgtree | MQTT and websocket dogs never give up while armed: every engine start re-arms |
| [e-2500178bdbeb0b3b](projects-and-concurrency.md#e-2500178bdbeb0b3b) | AGENTS.md — working on Orgtree | Slot chips and all current-project-targeted watchdog menus offer Project… |
| [e-745a7869091502ec](projects-and-concurrency.md#e-745a7869091502ec) | AGENTS.md — working on Orgtree | Watchdog links share WatchdogLink: current-org tree metadata supplies kind, |
| [e-60b089e35a88b0b8](projects-and-concurrency.md#e-60b089e35a88b0b8) | AGENTS.md — working on Orgtree | Slot watchdog projections omit private slot numbers intentionally: a lease, |
| [e-7548c02bba84e876](projects-and-concurrency.md#e-7548c02bba84e876) | AGENTS.md — working on Orgtree | Project edges do not cap agent visibility, tools or folder authority. Chart, |
| [e-d36c81c575341dc0](projects-and-concurrency.md#e-d36c81c575341dc0) | AGENTS.md — working on Orgtree | Project near-card activity count and Active/Idle age share one nowrap row. |
| [e-0638b8ea6f4c6a3f](projects-and-concurrency.md#e-0638b8ea6f4c6a3f) | AGENTS.md — working on Orgtree | The merged project mail card fills magenta while any fair-queue listener |
| [e-ea53550dd21060db](projects-and-concurrency.md#e-ea53550dd21060db) | AGENTS.md — working on Orgtree | Near-card status badges use compact bounded wrapping so max-capacity slots, |
| [e-fba388a03959e3d4](mail-and-hub.md#e-fba388a03959e3d4) | AGENTS.md — working on Orgtree | Collapsed mail-row tag previews show every matching active filter tag in |
| [e-94ed8ea77a882f19](mail-and-hub.md#e-94ed8ea77a882f19) | AGENTS.md — working on Orgtree | Enabling a mail-row tag filter opens that row's mail when the previously |
| [e-9fd0879366599ee2](projects-and-concurrency.md#e-9fd0879366599ee2) | AGENTS.md — working on Orgtree | Agent lifecycle recipients, requests, turn rosters/labels, fresh-session recall |
| [e-97eb329227553714](docket-and-presentations.md#e-97eb329227553714) | AGENTS.md — working on Orgtree | Attention list rows toggle off on a second click; Escape clears when the |
| [e-ca0aef700416d054](projects-and-concurrency.md#e-ca0aef700416d054) | AGENTS.md — working on Orgtree | Composer urgency precedes speed. Agent/project composer controls share |
| [e-63915eb060b2f02e](projects-and-concurrency.md#e-63915eb060b2f02e) | AGENTS.md — working on Orgtree | Empty composer padding and rows focus their text field without scrolling, |
| [e-c26ee15685faa383](instructions-and-skills.md#e-c26ee15685faa383) | AGENTS.md — working on Orgtree | Folder context-menu parents open directly on click/Enter; hover/Right shows |
| [e-ebc377c6fc40e9ad](projects-and-concurrency.md#e-ebc377c6fc40e9ad) | AGENTS.md — working on Orgtree | Project concurrency recipes compose existing slots, queues and events; an |
| [e-1df71884f6ecc434](startup-and-release.md#e-1df71884f6ecc434) | AGENTS.md — working on Orgtree | The tray left-click popup shows at most ten whole org rows, with native |
| [e-304ae6410d9739c1](agent-runtime.md#e-304ae6410d9739c1) | AGENTS.md — working on Orgtree | Expanded shell rows can show ephemeral Codex/Muse output and genuine ACP |
| [e-fdb4002e12df5771](projects-and-concurrency.md#e-fdb4002e12df5771) | AGENTS.md — working on Orgtree | Credit-bar segments and org pixel-per-credit scale flatten projects recursively |
| [e-69b4cf77157eb8e2](providers-and-accounts.md#e-69b4cf77157eb8e2) | AGENTS.md — working on Orgtree | Enabled, installed harnesses explicitly classified hire_reason=signed_out |
| [e-cbac513f45e879be](desktop-and-renderer.md#e-cbac513f45e879be) | AGENTS.md — working on Orgtree | Desk-tab pin/pop-out requests snapshot the owning .desk-tabpanel before |
| [e-e4cf84ea4eaf76c2](instructions-and-skills.md#e-e4cf84ea4eaf76c2) | AGENTS.md — working on Orgtree | Runtime's default-on "Suggest agents to give feedback to Orgtree" persists |
| [e-fc5adcb239ef98b4](providers-and-accounts.md#e-fc5adcb239ef98b4) | AGENTS.md — working on Orgtree | A live desk's model letter opens the existing hire tokens with warm shared |
| [e-3eaff86aad07edbe](providers-and-accounts.md#e-3eaff86aad07edbe) | AGENTS.md — working on Orgtree | Queued model/account selectors show the queued target. Explicitly choosing |
| [e-286431a269ca55ff](docket-and-presentations.md#e-286431a269ca55ff) | AGENTS.md — working on Orgtree | Presentation lists share unread mail's bold/accent title and brighter metadata |
| [e-016ef838c2ea1489](docket-and-presentations.md#e-016ef838c2ea1489) | AGENTS.md — working on Orgtree | Inbox read-on-leave follows committed reading-pane bodies, not selection |
| [e-d347372a2be259dc](agent-runtime.md#e-d347372a2be259dc) | AGENTS.md — working on Orgtree | Urgent mail cards use the explicit urgent mail flag for an orange-red |
| [e-5707ea246383c7ce](docket-and-presentations.md#e-5707ea246383c7ce) | AGENTS.md — working on Orgtree | The persistent app-wide taskbar badge reads existing native app-feed attention |
| [e-af823d06ad14a3c4](desktop-and-renderer.md#e-af823d06ad14a3c4) | AGENTS.md — working on Orgtree | Centered Quick chat side minima must be measured with each side temporarily |
| [e-2b3068b59bcc2eaf](projects-and-concurrency.md#e-2b3068b59bcc2eaf) | AGENTS.md — working on Orgtree | Project desk cards and slot surfaces (user 2026-10-19 17:11Z-17:24Z): a |
| [e-1921ec1a7fb7e5dc](projects-and-concurrency.md#e-1921ec1a7fb7e5dc) | AGENTS.md — working on Orgtree | Project event listeners (user 2026-10-19 07:40Z): project_listener dogs |
| [e-53043d84993d5911](projects-and-concurrency.md#e-53043d84993d5911) | AGENTS.md — working on Orgtree | Project event-listeners setting (migration 0043, see |
| [e-6fc02399a07ff81a](projects-and-concurrency.md#e-6fc02399a07ff81a) | AGENTS.md — working on Orgtree | User-side project primitives (docket |
| [e-2d03829c2d345c95](projects-and-concurrency.md#e-2d03829c2d345c95) | AGENTS.md — working on Orgtree | Desk header controls (USER 2026-10-20 16:35Z-16:58Z; "restyle it to its |
| [e-117fab1de7ec2e64](desktop-and-renderer.md#e-117fab1de7ec2e64) | AGENTS.md — working on Orgtree | A canvas hire keeps its draft until the card arrives (USER 2026-10-20 |
| [e-49d0cd76c2a04217](projects-and-concurrency.md#e-49d0cd76c2a04217) | AGENTS.md — working on Orgtree | Project desk history (migration 0040, see |
| [e-605ed2872e1627cc](mail-and-hub.md#e-605ed2872e1627cc) | AGENTS.md — working on Orgtree | Startup tool descriptions retain the 12,000-byte aggregate and 900-byte/card |
| [e-14b1dd971a118d4c](projects-and-concurrency.md#e-14b1dd971a118d4c) | AGENTS.md — working on Orgtree | Project Open → Slots is one modal entry, offered only with positive slot |
| [e-982b09aa47310838](projects-and-concurrency.md#e-982b09aa47310838) | AGENTS.md — working on Orgtree | Usage watchdogs consume sanitized cache observations and scoped usage refusals; |
| [e-2485a7f6f17f1e23](projects-and-concurrency.md#e-2485a7f6f17f1e23) | AGENTS.md — working on Orgtree | Project tools expose read-only Inbox/Sent history with filter-bound cursor pages |
| [e-c6640a20d790d4a1](agent-runtime.md#e-c6640a20d790d4a1) | AGENTS.md — working on Orgtree | Project history keeps ACK queue-state notes and explicit-open transcript |
| [e-229fb0c9e594cfb5](projects-and-concurrency.md#e-229fb0c9e594cfb5) | AGENTS.md — working on Orgtree | Tree tools heap-pin the canonical operation future before awaiting it. The |
| [e-a771e265dceb226f](projects-and-concurrency.md#e-a771e265dceb226f) | AGENTS.md — working on Orgtree | Project settings explain round-robin as a load balancer, ACK as a FIFO work |
| [e-47f6c4ec16d783c5](projects-and-concurrency.md#e-47f6c4ec16d783c5) | AGENTS.md — working on Orgtree | Read a project Summary with orgtree_project action=settings and no |
| [e-ce0098e92c17ea63](projects-and-concurrency.md#e-ce0098e92c17ea63) | AGENTS.md — working on Orgtree | Heavy development work uses only @build-slot concurrency grants. Read its |
| [e-175d9a7c8a253f9e](desktop-and-renderer.md#e-175d9a7c8a253f9e) | AGENTS.md — working on Orgtree | Org window headers show the canonical cropped org logo immediately before |
| [e-2971c40fc828cba4](projects-and-concurrency.md#e-2971c40fc828cba4) | AGENTS.md — working on Orgtree | Audience revocation removes the explicit grant only. Passive notices name |
| [e-edb2b80c725c86af](projects-and-concurrency.md#e-edb2b80c725c86af) | AGENTS.md — working on Orgtree | Projects call their standing charter Summary in desks, settings, drafts |
| [e-bcba00ddb0d9815f](projects-and-concurrency.md#e-bcba00ddb0d9815f) | AGENTS.md — working on Orgtree | DND is a header badge beside effort on agent cards/desks, outside status. |
| [e-bb01cec316dad2ab](desktop-and-renderer.md#e-bb01cec316dad2ab) | AGENTS.md — working on Orgtree | Quick chat's empty Files paperclip keeps the compact hire-options dropdown |
| [e-ff8b88dacd68cab6](providers-and-accounts.md#e-ff8b88dacd68cab6) | AGENTS.md — working on Orgtree | Quick chat shares the Agents-list switchboard mark for the selected top-level |
| [e-208aaf23923f2257](providers-and-accounts.md#e-208aaf23923f2257) | AGENTS.md — working on Orgtree | Quick chat treats missing/non-array staffing tiers and malformed tier/account |
| [e-8862a2e7893cee77](desktop-and-renderer.md#e-8862a2e7893cee77) | AGENTS.md — working on Orgtree | Shared Markdown renders offline LaTeX ($...$, \(...\), $$...$$, |
| [e-5df9503ab20f8452](projects-and-concurrency.md#e-5df9503ab20f8452) | AGENTS.md — working on Orgtree | Concurrency slots are unnumbered in presentation: counts and queue ordinals |
| [e-0bd65f6fdd92c0a0](projects-and-concurrency.md#e-0bd65f6fdd92c0a0) | AGENTS.md — working on Orgtree | Push-driven slot, fair-queue and event dogs do not report missing polling |
| [e-af268de658e81fd1](projects-and-concurrency.md#e-af268de658e81fd1) | AGENTS.md — working on Orgtree | Agents/Team trays omit an empty project status-summary line, retaining real |
| [e-6195f01a4608a74f](desktop-and-renderer.md#e-6195f01a4608a74f) | AGENTS.md — working on Orgtree | Team's centered, pinned and detached panel uses one shared title/action row: |
| [e-8a0a592004577f78](projects-and-concurrency.md#e-8a0a592004577f78) | AGENTS.md — working on Orgtree | Desk Team tabs show/count live direct children from the current map, including |
| [e-57a6d9bcda446186](projects-and-concurrency.md#e-57a6d9bcda446186) | AGENTS.md — working on Orgtree | Mail admission uses the shared hard byte budget without separate row caps; |
| [e-9cd29e6d5c5db841](agent-runtime.md#e-9cd29e6d5c5db841) | AGENTS.md — working on Orgtree | The shared Canvas/Attention header shows a glowing @ button before the |
| [e-c32bdfc35e2525c4](projects-and-concurrency.md#e-c32bdfc35e2525c4) | AGENTS.md — working on Orgtree | Project and agent desk member/report rows share DeskJumpCards: more than |
| [e-13aa796da9dc2578](desktop-and-renderer.md#e-13aa796da9dc2578) | AGENTS.md — working on Orgtree | Every jump row (.desk-nav) caps at 8 chip rows and scrolls, CSS only: |
| [e-1c67f962a8014fd2](projects-and-concurrency.md#e-1c67f962a8014fd2) | AGENTS.md — working on Orgtree | Agent/project Open menu parents click/Enter the existing temporary-desk |
| [e-fd45696b160e1ef3](agent-runtime.md#e-fd45696b160e1ef3) | AGENTS.md — working on Orgtree | Unread user mail with a standalone @user in visible prose/quotes shares |
| [e-1e91df39f182ab07](agent-runtime.md#e-1e91df39f182ab07) | AGENTS.md — working on Orgtree | The Attention list's transcript @user mention row (MentionRowView) is the |
| [e-8c72fbf922e19b8e](agent-runtime.md#e-8c72fbf922e19b8e) | AGENTS.md — working on Orgtree | Do Not Disturb is a durable per-turn flag controlled by self status.dnd. |
| [e-5cf18b78bd667358](desktop-and-renderer.md#e-5cf18b78bd667358) | AGENTS.md — working on Orgtree | Team panels reuse the canvas Agents tray-panel frame and direct AgentTray, |
| [e-399a9f610452d566](projects-and-concurrency.md#e-399a9f610452d566) | AGENTS.md — working on Orgtree | Right-clicking an agent or project link inside an agent or project desk |
| [e-88be5b07d34995c5](agent-runtime.md#e-88be5b07d34995c5) | AGENTS.md — working on Orgtree | Org outbox reading headers group the sender's shared AgentLink (badge |
| [e-b1503787cea59e8f](projects-and-concurrency.md#e-b1503787cea59e8f) | AGENTS.md — working on Orgtree | Project mail's plain delivery marker uses → @recipient through shared |
| [e-489f58ddbf6542b0](projects-and-concurrency.md#e-489f58ddbf6542b0) | AGENTS.md — working on Orgtree | Project release_slot and own slots status are available with either team |
| [e-98d904ff68aa8dce](projects-and-concurrency.md#e-98d904ff68aa8dce) | AGENTS.md — working on Orgtree | User mail to projects shares the agent context.deep_reach ancestor-notice |
| [e-2abde9bbc264452a](mail-and-hub.md#e-2abde9bbc264452a) | AGENTS.md — working on Orgtree | Hub-contact chip consumers discover hubchat_pc through one shared full |
| [e-a243d950ff6c2297](projects-and-concurrency.md#e-a243d950ff6c2297) | AGENTS.md — working on Orgtree | Project acknowledgement timeout uses scope.mail_queue_ack_reminders (1–10, |
| [e-15ef87db8aa08922](projects-and-concurrency.md#e-15ef87db8aa08922) | AGENTS.md — working on Orgtree | ACK work queue (user 2026-10-18 18:00Z-18:09Z): a post that waits says why |
| [e-b68ab3bee8cb56e4](projects-and-concurrency.md#e-b68ab3bee8cb56e4) | AGENTS.md — working on Orgtree | Project inbox with no listener (user 2026-10-20 11:04Z): mail to it is still |
| [e-9398dccfcf1043a8](projects-and-concurrency.md#e-9398dccfcf1043a8) | AGENTS.md — working on Orgtree | Project dead-letter queue (user 2026-10-18 19:38Z-19:40Z): a job that runs out |
| [e-d2403b89c380c6ce](desktop-and-renderer.md#e-d2403b89c380c6ce) | AGENTS.md — working on Orgtree | Panel buttons hide an already open local pin, even behind another panel, |
| [e-91f8ee65e63000af](mail-and-hub.md#e-91f8ee65e63000af) | AGENTS.md — working on Orgtree | Inbox tag popovers close 250ms after the pointer leaves a 100px margin around |
| [e-c95ee994be48b89b](docket-and-presentations.md#e-c95ee994be48b89b) | AGENTS.md — working on Orgtree | Shared reply quotes activate their original target from the whole block or |
| [e-dfcad01d6f6abf09](agent-runtime.md#e-dfcad01d6f6abf09) | AGENTS.md — working on Orgtree | Desk mention/reply jumps use centerTranscriptTarget on the owning transcript |
| [e-b558facbec92bafd](projects-and-concurrency.md#e-b558facbec92bafd) | AGENTS.md — working on Orgtree | User, agent and project Inbox/Sent history pages seek strictly before a |
| [e-84ab79bda82d00b6](projects-and-concurrency.md#e-84ab79bda82d00b6) | AGENTS.md — working on Orgtree | Presentation list rows use plain, single-line owner text and a muted inline |
| [e-7cce353856f0c1c1](projects-and-concurrency.md#e-7cce353856f0c1c1) | AGENTS.md — working on Orgtree | orgtree_project settings/configure exposes all Project settings as an |
| [e-3300b22809d274db](projects-and-concurrency.md#e-3300b22809d274db) | AGENTS.md — working on Orgtree | A successful agent-desk composer send selects that desk's Chat tab after |
| [e-96f6ef9e7fd2ea6b](projects-and-concurrency.md#e-96f6ef9e7fd2ea6b) | AGENTS.md — working on Orgtree | The project composer keeps its unsent text by project identity and shares the |
| [e-d70208b1cf3476ae](agent-runtime.md#e-d70208b1cf3476ae) | AGENTS.md — working on Orgtree | On a project desk, presentation-card Reply stages a typed document target in |
| [e-b4d8622ab4805ea5](instructions-and-skills.md#e-b4d8622ab4805ea5) | AGENTS.md — working on Orgtree | Agent replies, mail, docket descriptions and presentations must name agents, |
| [e-ba015728fee48b44](projects-and-concurrency.md#e-ba015728fee48b44) | AGENTS.md — working on Orgtree | Agent/project desks offer Team via the existing Agents List, restricted to |
| [e-a50407a75a21655d](agent-runtime.md#e-a50407a75a21655d) | AGENTS.md — working on Orgtree | Transcript @user highlights come from each assistant message's own text, |
| [e-cf1e815d4e3e49c6](projects-and-concurrency.md#e-cf1e815d4e3e49c6) | AGENTS.md — working on Orgtree | In an agent's desk context, presentation context menus on both the desk-header |
| [e-b72d800b0848076a](providers-and-accounts.md#e-b72d800b0848076a) | AGENTS.md — working on Orgtree | Agent-facing Orgtree tool results append engine-measured execution time: 0.432ms |
| [e-65d896d228121af3](projects-and-concurrency.md#e-65d896d228121af3) | AGENTS.md — working on Orgtree | Projects pass active audiences to live direct members as their own; no nested |
| [e-f8e62b7678dd25bc](projects-and-concurrency.md#e-f8e62b7678dd25bc) | AGENTS.md — working on Orgtree | orgtree_present project=P needs no user audience for agents strictly below |
| [e-91d0170d965e30c8](projects-and-concurrency.md#e-91d0170d965e30c8) | AGENTS.md — working on Orgtree | EPIC whole-window shakes stop during pointer movement or a held press, |
| [e-2565a34a475406f4](projects-and-concurrency.md#e-2565a34a475406f4) | AGENTS.md — working on Orgtree | Watchdog detail cards name every listener type and explain its actual trigger. |
| [e-280cb9c0e06f1123](development-and-verification.md#e-280cb9c0e06f1123) | AGENTS.md — working on Orgtree | Exact tracing-event-count tests must isolate process-global callsite caches |
| [e-315f95088080e970](agent-runtime.md#e-315f95088080e970) | AGENTS.md — working on Orgtree | Agent, project and hub contact mentions (4.4.0): typing @ in Quick chat, the |
| [e-a9d1276c8085a254](instructions-and-skills.md#e-a9d1276c8085a254) | AGENTS.md — working on Orgtree | Tool-card JSON literals stay in separate #[inline(never)] pure builders: |
| [e-c1a0700754d29d77](providers-and-accounts.md#e-c1a0700754d29d77) | AGENTS.md — working on Orgtree | Model-change tool chips retain the locked applied before/after tiers in |
| [e-1a374702e1e4a01d](projects-and-concurrency.md#e-1a374702e1e4a01d) | AGENTS.md — working on Orgtree | Committees without a dedicated manager use a project under their supervisor; |
| [e-a26110be196d3160](agent-runtime.md#e-a26110be196d3160) | AGENTS.md — working on Orgtree | Inline helper transcripts reuse the desk's Msg/ToolChip/input disclosures, |
| [e-fbc155fff7a65fd6](desktop-and-renderer.md#e-fbc155fff7a65fd6) | AGENTS.md — working on Orgtree | Markdown links to local Windows files may use file:///C:/... or another |
| [e-760313f9ff3352c2](org-tree-and-tools.md#e-760313f9ff3352c2) | AGENTS.md — working on Orgtree | A file link rendered from an agent tool row keeps the same reveal-only click, |
| [e-cb5dc74daa517a54](projects-and-concurrency.md#e-cb5dc74daa517a54) | AGENTS.md — working on Orgtree | Idle ages on the desk, card and tray use the completed turn's ended_at; |
| [e-042b9842a466de52](instructions-and-skills.md#e-042b9842a466de52) | AGENTS.md — working on Orgtree | Shared/team scratch initialization creates a header-only AGENTS.md if missing, |
| [e-03969cce47110e8f](agent-runtime.md#e-03969cce47110e8f) | AGENTS.md — working on Orgtree | Antigravity completed-step thinking uses the launched login home and exact |
| [e-5ee771eaca732224](agent-runtime.md#e-5ee771eaca732224) | AGENTS.md — working on Orgtree | Agent Compact… opens one normal/cheap choice shared with the desk context |
| [e-178a632520192efd](agent-runtime.md#e-178a632520192efd) | AGENTS.md — working on Orgtree | Per-agent fast mode is node-local and applies next turn without changing |
| [e-3d3161b1c816920f](projects-and-concurrency.md#e-3d3161b1c816920f) | AGENTS.md — working on Orgtree | State inspection memoizes effective ancestry only within its immutable |
| [e-377fed72a36aa810](providers-and-accounts.md#e-377fed72a36aa810) | AGENTS.md — working on Orgtree | The startup no-harness warning prefers the engine's bounded harness registry |
| [e-b52bd7f16fe9c2fd](startup-and-release.md#e-b52bd7f16fe9c2fd) | AGENTS.md — working on Orgtree | Finish-page launch uses native Exec only when Setup's actual token is |
| [e-13ae742faf34fc1d](mail-and-hub.md#e-13ae742faf34fc1d) | AGENTS.md — working on Orgtree | Mail hub tests and real registration/poll/file requests try direct transport, |
| [e-069864513234d854](development-and-verification.md#e-069864513234d854) | AGENTS.md — working on Orgtree | New hub settings receive stable per-hub IDs on save; the network pass repairs |
| [e-64713a95e5f11ce8](agent-runtime.md#e-64713a95e5f11ce8) | AGENTS.md — working on Orgtree | Session-placement loss requires three two-second misses; recovery is immediate. |
| [e-e55bd78701f666eb](docket-and-presentations.md#e-e55bd78701f666eb) | AGENTS.md — working on Orgtree | Renderer document-level event handlers (native agent tooltip, Markdown image |
| [e-d11f079ad56565f0](projects-and-concurrency.md#e-d11f079ad56565f0) | AGENTS.md — working on Orgtree | Watchdog recurrence survives restart: persisted next poll/quiet slots skip |
| [e-9b47067026684df6](instructions-and-skills.md#e-9b47067026684df6) | AGENTS.md — working on Orgtree | Orgtree tool cards keep call contracts and glossary pointers; procedures live |
| [e-5c5412144ccf6b64](docket-and-presentations.md#e-5c5412144ccf6b64) | AGENTS.md — working on Orgtree | The generic specification/feedback and hardening release pattern has its home |
| [e-bfc26c8383df59ce](agent-runtime.md#e-bfc26c8383df59ce) | AGENTS.md — working on Orgtree | Turn-body ORG STATE and PROVIDER USAGE headers use a full snapshot for a new |
| [e-9293631594e170c6](instructions-and-skills.md#e-9293631594e170c6) | AGENTS.md — working on Orgtree | Claude shared-skill exports account for native discovery: exact launch-profile |
| [e-073e6f624d2a73b3](desktop-and-renderer.md#e-073e6f624d2a73b3) | AGENTS.md — working on Orgtree | EPIC heat's world grid bounds use the complete borrowed canvas layout, |
| [e-20e9660ea3a2f836](mail-and-hub.md#e-20e9660ea3a2f836) | AGENTS.md — working on Orgtree | User-mail custom tags (4.4.0): at most eight trimmed 1-32-character tags, |
| [e-26e9bb995adba344](mail-and-hub.md#e-26e9bb995adba344) | AGENTS.md — working on Orgtree | User inbox deletion (4.4.0) is available only from a received-message row |
| [e-46b46bbac1e4ded8](agent-runtime.md#e-46b46bbac1e4ded8) | AGENTS.md — working on Orgtree | Live token updates retain unchanged settled transcript row identities and |
| [e-fb8637c898f64232](mail-and-hub.md#e-fb8637c898f64232) | AGENTS.md — working on Orgtree | The user inbox remembers the last opened received mail per org for the current |
| [e-fe2d66c6dc8c0d6f](agent-runtime.md#e-fe2d66c6dc8c0d6f) | AGENTS.md — working on Orgtree | Transcript tool counts (4.4.0) are always ~ estimates from one lazy |
| [e-448981fddd332d51](projects-and-concurrency.md#e-448981fddd332d51) | AGENTS.md — working on Orgtree | Per-node Subordinates may message each other defaults ON. OFF gates |
| [e-296151e6186b3f35](startup-and-release.md#e-296151e6186b3f35) | AGENTS.md — working on Orgtree | EPIC tray mute (4.4.0) is the optional native boolean epicMuted, persisted |
| [e-6617f189114f0831](projects-and-concurrency.md#e-6617f189114f0831) | AGENTS.md — working on Orgtree | EPIC 4.4.0 activity audio uses the existing busy/activity tree state: six |
| [e-3ce227b9a30eba55](projects-and-concurrency.md#e-3ce227b9a30eba55) | AGENTS.md — working on Orgtree | Project nodes (4.4.0) are ot.agents rows with kind = 'project': free tree nodes that run |
| [e-7bee0260a375be92](projects-and-concurrency.md#e-7bee0260a375be92) | AGENTS.md — working on Orgtree | Names typed into manual hire UI and project-name UI trim leading/trailing spaces and replace |
| [e-ff3db6aeec73beca](providers-and-accounts.md#e-ff3db6aeec73beca) | AGENTS.md — working on Orgtree | Renderer agent links use the native title tooltip with catalog model/version, |
| [e-a564bc8b1fddeaa8](providers-and-accounts.md#e-a564bc8b1fddeaa8) | AGENTS.md — working on Orgtree | Static catalog tiers with numbered model IDs include the default model in |
| [e-b196a8ced5f93439](projects-and-concurrency.md#e-b196a8ced5f93439) | AGENTS.md — working on Orgtree | Far-zoom agent and project cards share a floating hover/focus name above the |
| [e-a65c0802c9cd7ba4](projects-and-concurrency.md#e-a65c0802c9cd7ba4) | AGENTS.md — working on Orgtree | Normal-zoom agent and project card names share CardName: hovering a card |
| [e-c2e06dea7a68d4fb](projects-and-concurrency.md#e-c2e06dea7a68d4fb) | AGENTS.md — working on Orgtree | When a shared agent/project link's visible label omits its identity, its |
| [e-b7f9dbece8eb87d6](providers-and-accounts.md#e-b7f9dbece8eb87d6) | AGENTS.md — working on Orgtree | A known empty effort offer (Some([])) means the model accepts no effort |
| [e-894640a508e743c1](startup-and-release.md#e-894640a508e743c1) | AGENTS.md — working on Orgtree | Standalone engine (4.4.0): orgtree-engine standalone runs the engine with |
| [e-4abd59b8db2da07a](providers-and-accounts.md#e-4abd59b8db2da07a) | AGENTS.md — working on Orgtree | A halted agent's status duration is measured from halt.at (falling back to |
| [e-fe5ffe2a1ca10141](docket-and-presentations.md#e-fe5ffe2a1ca10141) | AGENTS.md — working on Orgtree | Fresh-session recovery leads with current docket scope/blockers/dependencies, |
| [e-9fd820a2479bbb12](desktop-and-renderer.md#e-9fd820a2479bbb12) | AGENTS.md — working on Orgtree | Windows taskbar lists active orgs in a custom Recent category above fixed |
| [e-ba6e78946ef37539](providers-and-accounts.md#e-ba6e78946ef37539) | AGENTS.md — working on Orgtree | An uninitialized manual hire's model icon opens the same SpawnChips token |
| [e-acd6869f16605c72](agent-runtime.md#e-acd6869f16605c72) | AGENTS.md — working on Orgtree | New Claude Agent/Task calls retain bounded helper transcripts privately per |
| [e-013a31e734ef85cd](desktop-and-renderer.md#e-013a31e734ef85cd) | AGENTS.md — working on Orgtree | The canvas Agents list, Quick chat superior picker and dynamic Attention desk |
| [e-a90addc142370734](instructions-and-skills.md#e-a90addc142370734) | AGENTS.md — working on Orgtree | The built-in Orgtree skill library is also called the glossary or Orgtree |
| [e-8ba1f4bbeec50f02](agent-runtime.md#e-8ba1f4bbeec50f02) | AGENTS.md — working on Orgtree | orgtree_next_turn {} is always-available, self-only and read-only. Dirty |
| [e-191b70a4cdba3784](docket-and-presentations.md#e-191b70a4cdba3784) | AGENTS.md — working on Orgtree | Working checkups depend on current working status and more than 20 minutes |
| [e-c7bded2fa1f899ba](org-tree-and-tools.md#e-c7bded2fa1f899ba) | AGENTS.md — working on Orgtree | Autonomous org Logo edits use orgtree_org_logo, gated only by inherited |
| [e-95eeb3d49bece625](desktop-and-renderer.md#e-95eeb3d49bece625) | AGENTS.md — working on Orgtree | Canvas background themes (App settings &gt; Display): optional |
| [e-eda15f799a6fe9f3](projects-and-concurrency.md#e-eda15f799a6fe9f3) | AGENTS.md — working on Orgtree | Muse last-good usage is durable per account in ot.kv (muse_usage:&lt;id&gt;), |
| [e-aee6090276bf3143](mail-and-hub.md#e-aee6090276bf3143) | AGENTS.md — working on Orgtree | Native Muse metadata refreshes cached display identity even when quota is |
| [e-0f41db9a3158601f](docket-and-presentations.md#e-0f41db9a3158601f) | AGENTS.md — working on Orgtree | Presentations and docket panels share panel-level Alt+Up/Down navigation |
| [e-436fe9ad6937adc4](instructions-and-skills.md#e-436fe9ad6937adc4) | AGENTS.md — working on Orgtree | : Antigravity identity is delivered as bounded, numbered always-on rules, |
| [e-a5feebda07d69b40](instructions-and-skills.md#e-a5feebda07d69b40) | AGENTS.md — working on Orgtree | : identity_parts returns (engine rules, standing notes). On Antigravity |
| [e-0722cab2be6d37b5](agent-runtime.md#e-0722cab2be6d37b5) | AGENTS.md — working on Orgtree | Live thought bodies must not flex-shrink inside the transcript: the |
| [e-118ee031d668ac37](desktop-and-renderer.md#e-118ee031d668ac37) | AGENTS.md — working on Orgtree | EPIC Mode, the final version (branch epic/final): the Opus take's architecture |
| [e-de9536d0894c40bc](providers-and-accounts.md#e-de9536d0894c40bc) | AGENTS.md — working on Orgtree | Claude usage 429s retain quiet last-good bars only while younger than 900 s |
| [e-3c25e0bc01504ede](startup-and-release.md#e-3c25e0bc01504ede) | AGENTS.md — working on Orgtree | Startup reveals every restored main window, including org-bound error windows; |
| [e-cd0d893ad30efaeb](docket-and-presentations.md#e-cd0d893ad30efaeb) | AGENTS.md — working on Orgtree | When an Orgtree system, tool, screen, panel or setting changes, update its |
| [e-ffd4085d82d91d2b](desktop-and-renderer.md#e-ffd4085d82d91d2b) | AGENTS.md — working on Orgtree | Measuring inside a desk on the canvas: .space carries the camera's scale(view.z) |
| [e-2a730b86cf3911f1](desktop-and-renderer.md#e-2a730b86cf3911f1) | AGENTS.md — working on Orgtree | A textarea has no API for its caret's position on screen. EPIC Mode's |
| [e-89dec1f0b67138ab](desktop-and-renderer.md#e-89dec1f0b67138ab) | AGENTS.md — working on Orgtree | Photographing a popped-out window in the offscreen capture: a child opened by |
| [e-8578146eecc18998](projects-and-concurrency.md#e-8578146eecc18998) | AGENTS.md — working on Orgtree | A wheel over the canvas is not a zoom by where it lands: OrgCanvas's wheel listener |
| [e-6d144ff6c2cca614](desktop-and-renderer.md#e-6d144ff6c2cca614) | AGENTS.md — working on Orgtree | EPIC Mode must not strobe, and its shakes and blurs stay within comfort bounds |
| [e-e06a5b8145fc0fa6](providers-and-accounts.md#e-e06a5b8145fc0fa6) | AGENTS.md — working on Orgtree | EPIC usage effects compare a finite, fresh reading with the last valid |
| [e-34c90713a8b9c9b0](desktop-and-renderer.md#e-34c90713a8b9c9b0) | AGENTS.md — working on Orgtree | EPIC Mode has no combo meter, ranks, milestones or rank fanfare. Keep the |
| [e-58176f39c2f37395](projects-and-concurrency.md#e-58176f39c2f37395) | AGENTS.md — working on Orgtree | EPIC Mode's progression (epic/progress.ts: momentum, per-agent charge, the session's |
| [e-c6e34437fd5bca3d](instructions-and-skills.md#e-c6e34437fd5bca3d) | AGENTS.md — working on Orgtree | Personal global instruction files are shared read-only across harnesses, with |
| [e-a2234c2e98328da4](desktop-and-renderer.md#e-a2234c2e98328da4) | AGENTS.md — working on Orgtree | The revealed Rainbow mode row appears only for Custom themes. Selecting a |
| [e-48e7cad0e0ef4520](agent-runtime.md#e-48e7cad0e0ef4520) | AGENTS.md — working on Orgtree | Docket ticket menus match transcript ticket menus through shared |
| [e-affff87e1e66e667](providers-and-accounts.md#e-affff87e1e66e667) | AGENTS.md — working on Orgtree | Muse usage Refresh stays visible, disabled and dimmed in host/registered |
| [e-b2c58c562c706ba0](providers-and-accounts.md#e-b2c58c562c706ba0) | AGENTS.md — working on Orgtree | Appearance presets are LMS Gold, Muse Eggshell and Antigravity Navy. Shared |
| [e-00c835aac320ed06](desktop-and-renderer.md#e-00c835aac320ed06) | AGENTS.md — working on Orgtree | On the light surfaces (contrast-light, contrast-solarized-light) every |
| [e-709649bded862bbe](agent-runtime.md#e-709649bded862bbe) | AGENTS.md — working on Orgtree | Antigravity committed mid-turn mail clears only the next-tool row pointer |
| [e-cb5d699ca9d2d35d](docket-and-presentations.md#e-cb5d699ca9d2d35d) | AGENTS.md — working on Orgtree | User-history undo/redo and transient toast Undo share undokeys.ts chord |
| [e-be06b81e0f8b72ea](projects-and-concurrency.md#e-be06b81e0f8b72ea) | AGENTS.md — working on Orgtree | Desk-slot removal resolves the eligible remaining owner after the React |
| [e-151563aeff92b242](desktop-and-renderer.md#e-151563aeff92b242) | AGENTS.md — working on Orgtree | App settings uses a 791px modal width (formerly660/726/783px), retaining the94vw |
| [e-b35efdeec6f0ab66](providers-and-accounts.md#e-b35efdeec6f0ab66) | AGENTS.md — working on Orgtree | Providers headers use family names Claude/ChatGPT/Gemini/Muse with dim |
| [e-818e8f955ec02fb6](docket-and-presentations.md#e-818e8f955ec02fb6) | AGENTS.md — working on Orgtree | Inbox and presented-document modals collapse their list at &lt;=896 CSS px of |
| [e-83b1b844b2e77cea](providers-and-accounts.md#e-83b1b844b2e77cea) | AGENTS.md — working on Orgtree | Org settings Accounts uses a short explanation (32 words), preserving the |
| [e-2a9b7ed4515392a4](projects-and-concurrency.md#e-2a9b7ed4515392a4) | AGENTS.md — working on Orgtree | Live tool writing/execution clocks floor actual elapsed seconds and schedule |
| [e-4be0ac29ab948d67](agent-runtime.md#e-4be0ac29ab948d67) | AGENTS.md — working on Orgtree | : Multi-replies retain every authorized immutable snapshot beside |
| [e-80d4344789d0c858](agent-runtime.md#e-80d4344789d0c858) | AGENTS.md — working on Orgtree | Successful presented documents and sent files in transcripts render the ordinary |
| [e-e63d63c5ff5e6463](agent-runtime.md#e-e63d63c5ff5e6463) | AGENTS.md — working on Orgtree | Completed tool-input fixtures use input_seq and the on-demand toolinput |
| [e-610bbe11d6ea29f1](agent-runtime.md#e-610bbe11d6ea29f1) | AGENTS.md — working on Orgtree | Transcript orgtree_work ticket refs carry status_change only from a |
| [e-cce160a6ecaa7998](providers-and-accounts.md#e-cce160a6ecaa7998) | AGENTS.md — working on Orgtree | Background work keeps an agent's process open (user 2026-10-14, "keep open", |
| [e-a88669ac8447f816](providers-and-accounts.md#e-a88669ac8447f816) | AGENTS.md — working on Orgtree | Antigravity background launches share providers::agy_auth: Windows exact |
| [e-e4b5ac735f1b4290](mail-and-hub.md#e-e4b5ac735f1b4290) | AGENTS.md — working on Orgtree | Antigravity admission/launch repeats an inconclusive silent check once after |
| [e-9b5a9e6395aa4974](providers-and-accounts.md#e-9b5a9e6395aa4974) | AGENTS.md — working on Orgtree | Antigravity keeps ONE sign-in per Windows user (Credential Manager target |
| [e-6fab4fc503a41d49](providers-and-accounts.md#e-6fab4fc503a41d49) | AGENTS.md — working on Orgtree | Antigravity admission, balancing and fallback capacity read a registered |
| [e-a4c44404ece5e210](docket-and-presentations.md#e-a4c44404ece5e210) | AGENTS.md — working on Orgtree | Main app menu orders App settings / Usage / Usage history; main ShellHeader |
| [e-369825f5ce9d8407](providers-and-accounts.md#e-369825f5ce9d8407) | AGENTS.md — working on Orgtree | App settings Harnesses is a compact registry list: installed state, cached |
| [e-988db85a8654dd9b](providers-and-accounts.md#e-988db85a8654dd9b) | AGENTS.md — working on Orgtree | Halted list rows reuse canvas StopIcon and var(--bad), keep the halt clock |
| [e-f9750e44713295b9](mail-and-hub.md#e-f9750e44713295b9) | AGENTS.md — working on Orgtree | Transfers starts collapsed in every new mail view. Keep expansion while that |
| [e-f6eba311ade9ca38](agent-runtime.md#e-f6eba311ade9ca38) | AGENTS.md — working on Orgtree | Codex and Antigravity tools following reply text use a separate transcript |
| [e-5e375afe25817588](providers-and-accounts.md#e-5e375afe25817588) | AGENTS.md — working on Orgtree | Codex thread/resume IGNORES dynamicTools (codex-cli 0.160.0): a resumed |
| [e-2be2b5793b619ee6](providers-and-accounts.md#e-2be2b5793b619ee6) | AGENTS.md — working on Orgtree | A shell command Muse moves to the background (after ~10 s) can finish after |
| [e-fa93e652c29f0711](agent-runtime.md#e-fa93e652c29f0711) | AGENTS.md — working on Orgtree | Transcript bundles include unsent, delivering and recorded passive system |
| [e-52a21908c0d028fa](agent-runtime.md#e-52a21908c0d028fa) | AGENTS.md — working on Orgtree | Transcript bundles are display-only runs of passive system notices (the |
| [e-c67c4829b224d495](desktop-and-renderer.md#e-c67c4829b224d495) | AGENTS.md — working on Orgtree | Middle-button pan uses native DOM capture on each visible canvas viewport, |
| [e-c43eaad8eab50f77](desktop-and-renderer.md#e-c43eaad8eab50f77) | AGENTS.md — working on Orgtree | Tray Harness setup reads the engine registry, with a five-harness shell fallback; |
| [e-ab2beaa8e32e0f5d](providers-and-accounts.md#e-ab2beaa8e32e0f5d) | AGENTS.md — working on Orgtree | Registered usage Refresh forwards force=true to the existing boolean query; |
| [e-a2189e6bb35b52a5](providers-and-accounts.md#e-a2189e6bb35b52a5) | AGENTS.md — working on Orgtree | Every secondary OpenRouter usage card uses the shared Refresh header with |
| [e-d2f868fd15c76927](desktop-and-renderer.md#e-d2f868fd15c76927) | AGENTS.md — working on Orgtree | Failed shell errors show a compact indicator; expansion reads retained output |
| [e-b343415b45ac8060](providers-and-accounts.md#e-b343415b45ac8060) | AGENTS.md — working on Orgtree | Muse in Windows Session 0 (the installed app's boot-task engine): Muse's |
| [e-9a2af120e6eef670](providers-and-accounts.md#e-9a2af120e6eef670) | AGENTS.md — working on Orgtree | Muse approvals: Orgtree refuses with MSP's denied choice when offered, else |
| [e-c52d108713c0da38](projects-and-concurrency.md#e-c52d108713c0da38) | AGENTS.md — working on Orgtree | Reparent drag ghosts use the same display projection and final targets as |
| [e-6cea9fae253bb4b7](desktop-and-renderer.md#e-6cea9fae253bb4b7) | AGENTS.md — working on Orgtree | Sibling drag preview is a node-height accent separator: vertical in tree rows, |
| [e-42d44ca9ad024672](desktop-and-renderer.md#e-42d44ca9ad024672) | AGENTS.md — working on Orgtree | Tray primary clicks toggle pending or visible org lists; dismissal invalidates |
| [e-3ecc088fe9333b00](docket-and-presentations.md#e-3ecc088fe9333b00) | AGENTS.md — working on Orgtree | The org Docket selects its first visible unarchived, non-backlogged row once |
| [e-edb7589e1f1d8305](providers-and-accounts.md#e-edb7589e1f1d8305) | AGENTS.md — working on Orgtree | A Muse tool call that produces nothing for the turn's silence limit |
| [e-e387190e2e84ac8f](mail-and-hub.md#e-e387190e2e84ac8f) | AGENTS.md — working on Orgtree | Organization settings calls its Hubchat account image Logo. The avatar |
| [e-d41fba9d3b8742ae](desktop-and-renderer.md#e-d41fba9d3b8742ae) | AGENTS.md — working on Orgtree | Ctrl/Cmd+Z runs the newest visible toast Undo in its own window; keep text |
| [e-d5a8bff01373edd4](providers-and-accounts.md#e-d5a8bff01373edd4) | AGENTS.md — working on Orgtree | OpenRouter has one header Add action beside its provider switch for first |
| [e-cc332da26c1927c5](projects-and-concurrency.md#e-cc332da26c1927c5) | AGENTS.md — working on Orgtree | Usage history cards export the former table's measured points as CSV/JSONL, |
| [e-44970aeb1c6988fe](providers-and-accounts.md#e-44970aeb1c6988fe) | AGENTS.md — working on Orgtree | Muse Wonder Full uses shared tier blue #80b8ff, replacing dusty rose; |
| [e-8a5ae3fc6391a396](agent-runtime.md#e-8a5ae3fc6391a396) | AGENTS.md — working on Orgtree | Tool writing is an observed per-call stream phase, separate from execution. |
| [e-c22d820b1c2774eb](providers-and-accounts.md#e-c22d820b1c2774eb) | AGENTS.md — working on Orgtree | Provider/category/collection labels use Language model servers, including tier |
| [e-2d8de8e49415576f](docket-and-presentations.md#e-2d8de8e49415576f) | AGENTS.md — working on Orgtree | Providers presentation keeps provider enablement in each header and account |
| [e-a2a8e8e316dcba04](desktop-and-renderer.md#e-a2a8e8e316dcba04) | AGENTS.md — working on Orgtree | Native popout Close dismisses PinFrame through its existing close callback; |
| [e-f79cd7d648b48a3a](docket-and-presentations.md#e-f79cd7d648b48a3a) | AGENTS.md — working on Orgtree | Language model servers setup is documented in README. |
| [e-21addef93d80e64c](mail-and-hub.md#e-21addef93d80e64c) | AGENTS.md — working on Orgtree | Recommend each developer installs Orgtree and Hubchat, both connected to a shared standalone mailhub on a company-access |
| [e-8c61a2eb68eabebb](mail-and-hub.md#e-8c61a2eb68eabebb) | AGENTS.md — working on Orgtree | Human hub mail is composed in Hubchat. The Orgtree org-inbox window is a viewer: no compose/reply/upload controls or ded |
| [e-c2f741691526d825](mail-and-hub.md#e-c2f741691526d825) | AGENTS.md — working on Orgtree | Org inbox isolation is an org-local, default-on boundary: org_inbox_enabled=false rejects new external sends before queu |
| [e-a12504529fb2c73c](development-and-verification.md#e-a12504529fb2c73c) | AGENTS.md — working on Orgtree | This is the one file every agent working in this repository reads first. It collects the |
| [e-de9dba5c10b37700](legacy-and-superseded.md#e-de9dba5c10b37700) | AGENTS.md — working on Orgtree | Since 2026-10-06 the app runs Orgtree 4.0.0, a Rust engine, built on the local branch |
| [e-f76fd81794788f25](development-and-verification.md#e-f76fd81794788f25) | Orgtree 4.0.0 (Rust engine): read this first | Orgtree 4.0.0 (Rust engine): read this first |
| [e-c824b3c327871cc1](mail-and-hub.md#e-c824b3c327871cc1) | Orgtree 4.0.0 (Rust engine): read this first | Lifecycle invalidations read mailbox/history bodies only for ready matching |
| [e-88ad49b77a7c3f85](org-tree-and-tools.md#e-88ad49b77a7c3f85) | Orgtree 4.0.0 (Rust engine): read this first | Retired pile pickers own lightweight 50-row cursor pages, with server-side |
| [e-8e3ffb71b7e07772](desktop-and-renderer.md#e-8e3ffb71b7e07772) | Orgtree 4.0.0 (Rust engine): read this first | With "hide retired agents" off the canvas draws a retired pile only from |
| [e-0507dbafa88eea64](agent-runtime.md#e-0507dbafa88eea64) | Orgtree 4.0.0 (Rust engine): read this first | Native Claude/Codex context overflow gets one durable cheap-reset retry; |
| [e-832693868628f9c0](projects-and-concurrency.md#e-832693868628f9c0) | Orgtree 4.0.0 (Rust engine): read this first | New-org presets with no offered slot (including fallbacks) are dimmed and |
| [e-3060dce792c23ed5](desktop-and-renderer.md#e-3060dce792c23ed5) | Orgtree 4.0.0 (Rust engine): read this first | Quick chat's superior picker puts its selectable top level eye row |
| [e-d7fb75f5e03bf14b](mail-and-hub.md#e-d7fb75f5e03bf14b) | Orgtree 4.0.0 (Rust engine): read this first | orgtree_message/orgtree_send_notice take {metadata, body}. Metadata |
| [e-33538510be2bba5f](providers-and-accounts.md#e-33538510be2bba5f) | Orgtree 4.0.0 (Rust engine): read this first | Provider model-chip panels align with their key/server cards at both edges. |
| [e-6bf546fa0515155b](instructions-and-skills.md#e-6bf546fa0515155b) | Orgtree 4.0.0 (Rust engine): read this first | Generated prompt text never names a tool the agent's Orgtree tool groups switch |
| [e-a008e2b6781a9be1](providers-and-accounts.md#e-a008e2b6781a9be1) | Orgtree 4.0.0 (Rust engine): read this first | OpenCode is an optional OpenRouter/language model server harness over the reusable |
| [e-376a429c8255b045](agent-runtime.md#e-376a429c8255b045) | Orgtree 4.0.0 (Rust engine): read this first | OpenCode 2.0.28 uses only the bundled plugin for mail between tool calls, |
| [e-30b559b6dadeed35](projects-and-concurrency.md#e-30b559b6dadeed35) | Orgtree 4.0.0 (Rust engine): read this first | Far overview (z &lt; Z_MINI) hides watchdog satellites/wires, presentation |
| [e-0fb555a747840725](providers-and-accounts.md#e-0fb555a747840725) | Orgtree 4.0.0 (Rust engine): read this first | Model browser list children must not flex-shrink: OpenRouter and Language |
| [e-db4eec525c8a1035](instructions-and-skills.md#e-db4eec525c8a1035) | Orgtree 4.0.0 (Rust engine): read this first | Every org has ONE shared AGENTS.md, &lt;data&gt;\scratch\&lt;slug&gt;\_shared\AGENTS.md. Every |
| [e-69fa8324222c1ccc](mail-and-hub.md#e-69fa8324222c1ccc) | Orgtree 4.0.0 (Rust engine): read this first | External mail is untrusted by default, but generated instructions honor an |
| [e-a0c44cb1ee4f6cf3](org-tree-and-tools.md#e-a0c44cb1ee4f6cf3) | Orgtree 4.0.0 (Rust engine): read this first | User-approved folder additions/upgrades through HTTP scope and request |
| [e-64a6f5dcb156fa8b](providers-and-accounts.md#e-64a6f5dcb156fa8b) | Orgtree 4.0.0 (Rust engine): read this first | Secondary account removal keeps exclusive account-reference protection and |
| [e-4f3f4a8a7c023e3c](docket-and-presentations.md#e-4f3f4a8a7c023e3c) | Orgtree 4.0.0 (Rust engine): read this first | orgtree_message with kind question to @net: addresses may carry |
| [e-8044942de6457651](providers-and-accounts.md#e-8044942de6457651) | Orgtree 4.0.0 (Rust engine): read this first | Muse Code runs as muse serve (MSP v1), one warm host per agent, always |
| [e-8353c4a324717ba5](providers-and-accounts.md#e-8353c4a324717ba5) | Orgtree 4.0.0 (Rust engine): read this first | Built-in organization templates are the files in engine/docs/templates/, listed in |
| [e-f0f3830753f2e4b7](providers-and-accounts.md#e-f0f3830753f2e4b7) | Orgtree 4.0.0 (Rust engine): read this first | Models are LISTED most expensive (highest seat) first within each provider, every provider (Claude fable, |
| [e-38577ea23e4ca107](providers-and-accounts.md#e-38577ea23e4ca107) | Orgtree 4.0.0 (Rust engine): read this first | Hire tokens sort cheapest seat first WITHIN each provider row/column, with |
| [e-83cd4b7f38d03e8d](mail-and-hub.md#e-83cd4b7f38d03e8d) | Orgtree 4.0.0 (Rust engine): read this first | Organization profile pictures use a dedicated bounded ot.meta record, |
| [e-b85669a82f77be89](mail-and-hub.md#e-b85669a82f77be89) | Orgtree 4.0.0 (Rust engine): read this first | Continue-on resolves primary, default and matching native |
| [e-165dfeb46f8f045e](org-tree-and-tools.md#e-165dfeb46f8f045e) | Orgtree 4.0.0 (Rust engine): read this first | Agent orgtree_reorder accepts a live strict descendant and zero-based |
| [e-58a5f2bb9f9e273e](desktop-and-renderer.md#e-58a5f2bb9f9e273e) | Orgtree 4.0.0 (Rust engine): read this first | Canvas sibling drags and their Undo preview before the reorder endpoint answers. |
| [e-67e64bd3b6d62117](providers-and-accounts.md#e-67e64bd3b6d62117) | Orgtree 4.0.0 (Rust engine): read this first | The user's undo history (migration 0023, domain/undo.rs): the user's own move, |
| [e-7f5ec26488919e76](providers-and-accounts.md#e-7f5ec26488919e76) | Orgtree 4.0.0 (Rust engine): read this first | Several OpenRouter keys at once, every key alike. Each key is its own hidden registry |
| [e-d48651cd0dfa30c9](providers-and-accounts.md#e-d48651cd0dfa30c9) | Orgtree 4.0.0 (Rust engine): read this first |  |
| [e-80925030192802f7](mail-and-hub.md#e-80925030192802f7) | Orgtree 4.0.0 (Rust engine): read this first | Desk pending mail folds at six rendered rows per run, after event deduplication. |
| [e-ee5d1f5a03f607f1](desktop-and-renderer.md#e-ee5d1f5a03f607f1) | Orgtree 4.0.0 (Rust engine): read this first | Agent Open &gt; Open scratch folder is a native directory-only action. Resolve |
| [e-5aace97a5f530d6a](providers-and-accounts.md#e-5aace97a5f530d6a) | Orgtree 4.0.0 (Rust engine): read this first | On-demand orgtree_usage reads the saved cache under inspection permission. |
| [e-7ebcd951310b08b9](docket-and-presentations.md#e-7ebcd951310b08b9) | Orgtree 4.0.0 (Rust engine): read this first | OpenRouter query IDs are its canonical lanes (openrouter for the original, |
| [e-145699ad0736bb60](docket-and-presentations.md#e-145699ad0736bb60) | Orgtree 4.0.0 (Rust engine): read this first | The local 4.3 alpha bundles hub 2.2.0-alpha.0 at 959ed37 (2026-10-14: |
| [e-3a7085d66f9ee1d1](providers-and-accounts.md#e-3a7085d66f9ee1d1) | Orgtree 4.0.0 (Rust engine): read this first | Agent settings calls the built-in harness permissions Native Tools, explains |
| [e-127fddd0e286e0b6](org-tree-and-tools.md#e-127fddd0e286e0b6) | Orgtree 4.0.0 (Rust engine): read this first | Hiring a superior above self, including at the root, preserves the caller's |
| [e-c066b3d6611c6a43](providers-and-accounts.md#e-c066b3d6611c6a43) | Orgtree 4.0.0 (Rust engine): read this first | Native tray refresh must resynchronize the Run on boot checkbox (it was |
| [e-1092df48f25d5191](startup-and-release.md#e-1092df48f25d5191) | Orgtree 4.0.0 (Rust engine): read this first | Run on boot changes one at a time (changeRunOnStartup, tray and |
| [e-08d3c761dc9c8bd2](providers-and-accounts.md#e-08d3c761dc9c8bd2) | Orgtree 4.0.0 (Rust engine): read this first | The engine always starts at boot; agents run in the signed-in session while |
| [e-ee741abd6133f57e](startup-and-release.md#e-ee741abd6133f57e) | Orgtree 4.0.0 (Rust engine): read this first | Ending an engine's task does not stop a boot engine. Since the |
| [e-5f926d7012b68418](startup-and-release.md#e-5f926d7012b68418) | Orgtree 4.0.0 (Rust engine): read this first | Nothing on an engine's startup path may depend on powershell.exe. A |
| [e-53c25f4cba8ddf82](providers-and-accounts.md#e-53c25f4cba8ddf82) | Orgtree 4.0.0 (Rust engine): read this first | Antigravity Claude 5.5 uses separate agy-sonnet / agy-opus tiers (seats |
| [e-f012586feb53f988](docket-and-presentations.md#e-f012586feb53f988) | Orgtree 4.0.0 (Rust engine): read this first | Desk document metadata is newest presentation/update first (at DESC, id |
| [e-9381f6226f165ba7](desktop-and-renderer.md#e-9381f6226f165ba7) | Orgtree 4.0.0 (Rust engine): read this first | Size and rect state fed by observers is set as a VALUE, and layout effects |
| [e-690e872468fd31c7](desktop-and-renderer.md#e-690e872468fd31c7) | Orgtree 4.0.0 (Rust engine): read this first | App and Org settings checkboxes use SetToggle: checkbox left, label/hint, |
| [e-7985d55df47f12a0](mail-and-hub.md#e-7985d55df47f12a0) | Orgtree 4.0.0 (Rust engine): read this first | Bare mail recipients preserve 3.x precedence: internal agent, exact local |
| [e-32cff994d6fcc51d](agent-runtime.md#e-32cff994d6fcc51d) | Orgtree 4.0.0 (Rust engine): read this first | orgtree_read_transcript returns structured node/access, busy, occupancy and |
| [e-ae31661e4802c5e6](docket-and-presentations.md#e-ae31661e4802c5e6) | Orgtree 4.0.0 (Rust engine): read this first | Desktop notifications retain the complete pending inventory (keyset batches, |
| [e-c94c95b5e3e5e18b](agent-runtime.md#e-c94c95b5e3e5e18b) | Orgtree 4.0.0 (Rust engine): read this first | Transcript and mail content must remove actual U+0000 before PostgreSQL |
| [e-00a33b65c082e5f6](providers-and-accounts.md#e-00a33b65c082e5f6) | Orgtree 4.0.0 (Rust engine): read this first | No credential banners, annotations, tray/menu warnings or success notices. |
| [e-12cb0f7343c9dd07](startup-and-release.md#e-12cb0f7343c9dd07) | Orgtree 4.0.0 (Rust engine): read this first | Agent settings has a horizontal grant bar (canvas/creditgrant.tsx). Grants |
| [e-eba844c285fa8054](desktop-and-renderer.md#e-eba844c285fa8054) | Orgtree 4.0.0 (Rust engine): read this first | Agent settings shares the canvas credit paint and stats in creditbarpaint.tsx; |
| [e-0ea27d15e8d36432](docket-and-presentations.md#e-0ea27d15e8d36432) | Orgtree 4.0.0 (Rust engine): read this first | Opening a settings panel AT a control (docket cheap-compact-warning-turn-off-in-settings-link-o, |
| [e-2f169982bef62e30](docket-and-presentations.md#e-2f169982bef62e30) | Orgtree 4.0.0 (Rust engine): read this first | App settings pins and pops out like every other modal (docket |
| [e-64ef5ae2c0e92db3](projects-and-concurrency.md#e-64ef5ae2c0e92db3) | Orgtree 4.0.0 (Rust engine): read this first | Event watchdogs (kind:event) receive pushed, allow-listed post-commit events. |
| [e-53516c53f799bf06](projects-and-concurrency.md#e-53516c53f799bf06) | Orgtree 4.0.0 (Rust engine): read this first | Periodic watchdog countdowns roll forward from the last persisted check and |
| [e-65ffec1175101e7f](providers-and-accounts.md#e-65ffec1175101e7f) | Orgtree 4.0.0 (Rust engine): read this first | The Windows credential bridge serves git HTTPS and PATH-resolved gh from |
| [e-148227f00377e674](providers-and-accounts.md#e-148227f00377e674) | Orgtree 4.0.0 (Rust engine): read this first | Windows Codex hosting has a separate leased host slot: the sign-in helper can |
| [e-4e128ee2bb097321](startup-and-release.md#e-4e128ee2bb097321) | Orgtree 4.0.0 (Rust engine): read this first | Windows core recovery preserves healthy peers: unexpected engine/desktop |
| [e-178f4b36d69d3fb6](startup-and-release.md#e-178f4b36d69d3fb6) | Orgtree 4.0.0 (Rust engine): read this first | A refused launch says why: core-control begin prints one fixed-shape JSON |
| [e-f2a1c85f9890556e](projects-and-concurrency.md#e-f2a1c85f9890556e) | Orgtree 4.0.0 (Rust engine): read this first | Recovery attachment uses an empty local slot while retaining boot topology |
| [e-f5f320a50f70c397](startup-and-release.md#e-f5f320a50f70c397) | Orgtree 4.0.0 (Rust engine): read this first | Desktop startup waits for stdio closure before classifying child exit: a |
| [e-963073abf5afa506](startup-and-release.md#e-963073abf5afa506) | Orgtree 4.0.0 (Rust engine): read this first | Anything running from the installation folder blocks an upgrade, including |
| [e-68d64074e99ca5d8](agent-runtime.md#e-68d64074e99ca5d8) | Orgtree 4.0.0 (Rust engine): read this first | Cold-turn admission and forecasts share the measured-context threshold gate. |
| [e-7e6960f131c464dc](providers-and-accounts.md#e-7e6960f131c464dc) | Orgtree 4.0.0 (Rust engine): read this first | Windows boot credential detection is advisory: the boot task remains S4U. |
| [e-82a3415cba4cfd8c](docket-and-presentations.md#e-82a3415cba4cfd8c) | Orgtree 4.0.0 (Rust engine): read this first | Attached ask cards are grouped by request ID and ticket, never tab text. |
| [e-1a647c7f2dfbfa7b](desktop-and-renderer.md#e-1a647c7f2dfbfa7b) | Orgtree 4.0.0 (Rust engine): read this first | Cost labels show only $X.XX, including partial nonzero totals; unknown zero |
| [e-155442c22ed0880c](docket-and-presentations.md#e-155442c22ed0880c) | Orgtree 4.0.0 (Rust engine): read this first | Verbose UI-open timings use opentiming.ts and /api/diagnostics/ui-open. |
| [e-5654d6e0baa7183e](mail-and-hub.md#e-5654d6e0baa7183e) | Orgtree 4.0.0 (Rust engine): read this first | Agent unread mail is pending plus unacknowledged delivering, shared by |
| [e-d16a71914ecb3e0e](org-tree-and-tools.md#e-d16a71914ecb3e0e) | Orgtree 4.0.0 (Rust engine): read this first | Credit cascades plan before writing and stop at the acting agent's allocation. |
| [e-fe604f14bf3b4282](desktop-and-renderer.md#e-fe604f14bf3b4282) | Orgtree 4.0.0 (Rust engine): read this first | Draft hire cancellation saves the camera intent (org fit or focused target) |
| [e-3ff988a1ae3577cb](agent-runtime.md#e-3ff988a1ae3577cb) | Orgtree 4.0.0 (Rust engine): read this first | Tool arguments live in ot.convo.tool_inputs, apart from the normal body |
| [e-44927a3e634880bd](docket-and-presentations.md#e-44927a3e634880bd) | Orgtree 4.0.0 (Rust engine): read this first | Docket UI lists use 100-row server pages with full counts and bounded named |
| [e-0d6ee75e14f389d6](docket-and-presentations.md#e-0d6ee75e14f389d6) | Orgtree 4.0.0 (Rust engine): read this first | The Work docket and every agent/team docket tab share one DocketControlBar |
| [e-21c837a0d728a6dd](desktop-and-renderer.md#e-21c837a0d728a6dd) | Orgtree 4.0.0 (Rust engine): read this first | Passive notices repaint an event card's left edge (.event-notice, after the |
| [e-e5c8ba491ae56395](providers-and-accounts.md#e-e5c8ba491ae56395) | Orgtree 4.0.0 (Rust engine): read this first | Escape cancels a desk's prepared reply exactly as its × (DeskChat root |
| [e-e31eec2ea2cef16b](desktop-and-renderer.md#e-e31eec2ea2cef16b) | Orgtree 4.0.0 (Rust engine): read this first | Every keyboard shortcut is listed in renderer/src/shortcuts.ts, which App |
| [e-5f7ddb74229ad300](providers-and-accounts.md#e-5f7ddb74229ad300) | Orgtree 4.0.0 (Rust engine): read this first | Staffing effort choices describe launch-time model capabilities, not the |
| [e-e771f47a14224118](desktop-and-renderer.md#e-e771f47a14224118) | Orgtree 4.0.0 (Rust engine): read this first | Agent card and Agents List menus share canvas/agentmenu.tsx. The hire-tier |
| [e-9f7d75431386cefd](desktop-and-renderer.md#e-9f7d75431386cefd) | Orgtree 4.0.0 (Rust engine): read this first | The canvas Agents panel's active checkbox is in the shared PinFrame title |
| [e-4e05ddb51d643308](mail-and-hub.md#e-4e05ddb51d643308) | Orgtree 4.0.0 (Rust engine): read this first | Staffing composites use ops::run_in_tx and publish deferred Effects only |
| [e-4ab1b5bc2121915b](development-and-verification.md#e-4ab1b5bc2121915b) | Orgtree 4.0.0 (Rust engine): read this first | The plan is docs/rust-engine/PLAN.md (§10 lists every user-facing |
| [e-de18dabbab8e1f0f](engine-and-storage.md#e-de18dabbab8e1f0f) | Orgtree 4.0.0 (Rust engine): read this first | What it is |
| [e-e25bcf73e4bb3e12](desktop-and-renderer.md#e-e25bcf73e4bb3e12) | Orgtree 4.0.0 (Rust engine): read this first | One executable, orgtree-engine.exe, in the Cargo workspace engine/rs/ (crates |
| [e-18c06ea7902046e9](desktop-and-renderer.md#e-18c06ea7902046e9) | Orgtree 4.0.0 (Rust engine): read this first | The desktop starts it from resources/engine/orgtree-engine.exe when packaged, or from |
| [e-8dce3c42844fb6c8](engine-and-storage.md#e-8dce3c42844fb6c8) | Orgtree 4.0.0 (Rust engine): read this first | Storage: one database orgtree_engine, schema ot, in the bundled PostgreSQL cluster; |
| [e-8f4eeafe9fbf4c03](desktop-and-renderer.md#e-8f4eeafe9fbf4c03) | Orgtree 4.0.0 (Rust engine): read this first | Stopping: the engine's callers kill its whole tree (PostgreSQL with it) soon after asking it to |
| [e-aad7fd24eb2bb4c0](engine-and-storage.md#e-aad7fd24eb2bb4c0) | Orgtree 4.0.0 (Rust engine): read this first | Engine log: one file per start, &lt;data&gt;\diagnostics\logs\&lt;start time&gt;.log, kept 30 days. |
| [e-1ab5981d268dd801](projects-and-concurrency.md#e-1ab5981d268dd801) | Orgtree 4.0.0 (Rust engine): read this first | Agent log context must cross spawned tasks and channel messages: use agent:&lt;id&gt;/&lt;name&gt; |
| [e-9faaa6dbd5055d95](docket-and-presentations.md#e-9faaa6dbd5055d95) | Orgtree 4.0.0 (Rust engine): read this first | Request parity: questions allow 4 per call and 8 accumulated; overflow refuses without |
| [e-0500b134b88d286e](mail-and-hub.md#e-0500b134b88d286e) | Orgtree 4.0.0 (Rust engine): read this first | Accounts: every account has its own active checkbox in App settings › Providers, the |
| [e-10cf45fc2552cf56](docket-and-presentations.md#e-10cf45fc2552cf56) | Orgtree 4.0.0 (Rust engine): read this first | Composer Enter behavior is app-wide: App settings › Display › Typing › Enter key defaults to |
| [e-e8cac0647fdc7168](agent-runtime.md#e-e8cac0647fdc7168) | Orgtree 4.0.0 (Rust engine): read this first | Transcript auto-follow releases only on user scroll intent: upward wheel/keys, |
| [e-2281a9f876bf101b](agent-runtime.md#e-2281a9f876bf101b) | Orgtree 4.0.0 (Rust engine): read this first | Failed transcript first loads and earlier pages retry every five seconds through |
| [e-a26be1ca50afb8ed](desktop-and-renderer.md#e-a26be1ca50afb8ed) | Orgtree 4.0.0 (Rust engine): read this first | Viewport history fill uses before cursor pages, not a larger moving tail: |
| [e-2c0466923e044a00](providers-and-accounts.md#e-2c0466923e044a00) | Orgtree 4.0.0 (Rust engine): read this first | Limit marks: fresh successful provider probes may clear an older mark for the |
| [e-13305338e5d822f2](providers-and-accounts.md#e-13305338e5d822f2) | Orgtree 4.0.0 (Rust engine): read this first | A refused turn's parsed reset is never shortened to the five-minute probe |
| [e-3840538deeb43edf](providers-and-accounts.md#e-3840538deeb43edf) | Orgtree 4.0.0 (Rust engine): read this first | Freeze reset recovery accepts RFC3339 until and legacy numeric until_ts |
| [e-13b6405a255a9f2d](mail-and-hub.md#e-13b6405a255a9f2d) | Orgtree 4.0.0 (Rust engine): read this first | End-of-turn mail: pending waking mail follows through ordinary admission on |
| [e-e8d05c22ccfb2742](projects-and-concurrency.md#e-e8d05c22ccfb2742) | Orgtree 4.0.0 (Rust engine): read this first | Attention's Swap panels exchanges the persisted split and visual order together. |
| [e-29d2ba53942932f8](development-and-verification.md#e-29d2ba53942932f8) | Orgtree 4.0.0 (Rust engine): read this first | Where and how to work |
| [e-9522900dfe5708ae](development-and-verification.md#e-9522900dfe5708ae) | Orgtree 4.0.0 (Rust engine): read this first | rust-engine is a local branch: it is not on origin. Never push it or anything |
| [e-53dd75a0fc1e48e5](development-and-verification.md#e-53dd75a0fc1e48e5) | Orgtree 4.0.0 (Rust engine): read this first | Hand-in: rebase on the current rust-engine, then send the coordinator your branch name and |
| [e-c61bfdb1caeb6a53](startup-and-release.md#e-c61bfdb1caeb6a53) | Orgtree 4.0.0 (Rust engine): read this first | Three kinds of change never share a commit: the engine (engine/rs/); desktop changes the |
| [e-7b670aa6ae107e6a](startup-and-release.md#e-7b670aa6ae107e6a) | Orgtree 4.0.0 (Rust engine): read this first | Prototype restarts. Every prototype install restarts Orgtree, which ends running turns and |
| [e-df3cdea727e6f716](startup-and-release.md#e-df3cdea727e6f716) | Orgtree 4.0.0 (Rust engine): read this first | Builds and installs are the user's. Prototype builds are 4.0.0-alpha.N (N counts |
| [e-f3cf2d11de4165b7](startup-and-release.md#e-f3cf2d11de4165b7) | Orgtree 4.0.0 (Rust engine): read this first | Read-only copies of live data are allowed for rehearsals (file copies or database dumps): |
| [e-1531f06ab072cae7](agent-runtime.md#e-1531f06ab072cae7) | Orgtree 4.0.0 (Rust engine): read this first | Turn slots and CLI replacement (2026-10-07). Slots count admitted turns across all orgs, |
| [e-e4231286a204e361](mail-and-hub.md#e-e4231286a204e361) | Orgtree 4.0.0 (Rust engine): read this first | Typed mail (2026-10-07). Retained operations mint canonical ev at their producer; |
| [e-406c46dd5d4dfcd4](agent-runtime.md#e-406c46dd5d4dfcd4) | Orgtree 4.0.0 (Rust engine): read this first | An ev member the schema lacks hides the card (2026-10-20). The renderer decodes ev |
| [e-7ae4c9739e416232](mail-and-hub.md#e-7ae4c9739e416232) | Orgtree 4.0.0 (Rust engine): read this first | Mail and artifact parity (2026-10-07). File reads fold every ancestor's folder |
| [e-35f25c5413b34ad5](docket-and-presentations.md#e-35f25c5413b34ad5) | Orgtree 4.0.0 (Rust engine): read this first | Docket policy parity (2026-10-07). Keep the retained 3.x link/read rights, |
| [e-2eab11bd027a9f20](mail-and-hub.md#e-2eab11bd027a9f20) | Orgtree 4.0.0 (Rust engine): read this first | Agent mail requests and fan-out (2026-10-16). orgtree_message accepts |
| [e-f7ded7d01c3c769b](docket-and-presentations.md#e-f7ded7d01c3c769b) | Orgtree 4.0.0 (Rust engine): read this first | Inbox mail styling (2026-10-07). Rust mail carries passive delivery as |
| [e-93b42fabe2c24bc4](legacy-and-superseded.md#e-93b42fabe2c24bc4) | Orgtree 4.0.0 (Rust engine): read this first | Mail kinds reduced (2026-10-15). Agent-facing mail tools offer only |
| [e-50bb1f59fa68fdf3](desktop-and-renderer.md#e-50bb1f59fa68fdf3) | Orgtree 4.0.0 (Rust engine): read this first | Activity summary strip (2026-10-07). ActiveAgentSummary uses the org list's |
| [e-8a2c86f559551e4f](engine-and-storage.md#e-8a2c86f559551e4f) | Orgtree 4.0.0 (Rust engine): read this first | Engine code rules |
| [e-2cd87d5c566b2f94](providers-and-accounts.md#e-2cd87d5c566b2f94) | Orgtree 4.0.0 (Rust engine): read this first | Tree/scope parity (2026-10-07): remove host CLAUDE_CODE_ before selected-account |
| [e-70ddc1ec4c782ba2](docket-and-presentations.md#e-70ddc1ec4c782ba2) | Orgtree 4.0.0 (Rust engine): read this first | Open request cards (2026-10-07): emit kind: batch with typed tabs, even for |
| [e-a10c94d726187564](providers-and-accounts.md#e-a10c94d726187564) | Orgtree 4.0.0 (Rust engine): read this first | No global locks of any kind. State is owned, not shared: each running agent's state belongs |
| [e-8192a6f3da6dff13](engine-and-storage.md#e-8192a6f3da6dff13) | Orgtree 4.0.0 (Rust engine): read this first | #[logged] on every engine method. Put #[logged] on each free function and inherent |
| [e-fad546a496e8a0a9](providers-and-accounts.md#e-fad546a496e8a0a9) | Orgtree 4.0.0 (Rust engine): read this first | Never derive Serialize on a struct that holds a secret (a key, token, password or |
| [e-07d44cfe835e7ad2](desktop-and-renderer.md#e-07d44cfe835e7ad2) | Orgtree 4.0.0 (Rust engine): read this first | Transport: HTTP for loads and actions, the org and app sockets for pushed updates, with |
| [e-5bd036aebe5b2d70](legacy-and-superseded.md#e-5bd036aebe5b2d70) | Orgtree 4.0.0 (Rust engine): read this first | Verification during the prototype |
| [e-d950a8c4cc76e04f](legacy-and-superseded.md#e-d950a8c4cc76e04f) | Orgtree 4.0.0 (Rust engine): read this first | No unit-test suites and no review rounds while the prototype is built; brief smoke tests |
| [e-ca02d79ca0ee8a7d](development-and-verification.md#e-ca02d79ca0ee8a7d) | Orgtree 4.0.0 (Rust engine): read this first | Smoke changes through the real path with the test rig, so a hand-in can say measured rather |
| [e-cd70dd295fff4d67](development-and-verification.md#e-cd70dd295fff4d67) | Orgtree 4.0.0 (Rust engine): read this first | Electron probes: pass URLs and options through the environment, not the command line: with |
| [e-837c7011305e3f2e](development-and-verification.md#e-837c7011305e3f2e) | Orgtree 4.0.0 (Rust engine): read this first | So none of the 3.x test machinery below applies to 4.0.0 work: the P03 run lock, |
| [e-79c3d6f6ce1ca992](startup-and-release.md#e-79c3d6f6ce1ca992) | Orgtree 4.0.0 (Rust engine): read this first | Custom native icon colors (2026-10-07, verified from source and Electron PNG smoke). |
| [e-663e86618b46e12d](startup-and-release.md#e-663e86618b46e12d) | Orgtree 4.0.0 (Rust engine): read this first | Tray list status sizing (2026-10-07, verified from source and Electron smoke). |
| [e-df30bae43ef1d6bb](development-and-verification.md#e-df30bae43ef1d6bb) | Orgtree 4.0.0 (Rust engine): read this first | Still valid from the 3.x sections: Machine traps (shell, CRLF, slow git on |
| [e-6cf2c5e91d40fa7b](desktop-and-renderer.md#e-6cf2c5e91d40fa7b) | Orgtree 4.0.0 (Rust engine): read this first | Desk geometry and ordering (2026-10-06). Explicit desk pop-outs measure the visible |
| [e-ba47bc1ed54a6376](projects-and-concurrency.md#e-ba47bc1ed54a6376) | Orgtree 4.0.0 (Rust engine): read this first | Watchdog drag positions (2026-10-07, verified from source). Canvas drag bases |
| [e-8e30d186ebc6058a](desktop-and-renderer.md#e-8e30d186ebc6058a) | Orgtree 4.0.0 (Rust engine): read this first | Desk popout navigation (2026-10-07, verified from source and browser smoke). |
| [e-60b5e834a51616ee](desktop-and-renderer.md#e-60b5e834a51616ee) | Orgtree 4.0.0 (Rust engine): read this first | Temporary desks (2026-10-07, verified from source and browser smoke). Their jump |
| [e-030ac4cb5f62b3e5](providers-and-accounts.md#e-030ac4cb5f62b3e5) | Orgtree 4.0.0 (Rust engine): read this first | Tab highlight colors (2026-10-07, verified from source). Generic button |
| [e-62c8a770c86413f3](legacy-and-superseded.md#e-62c8a770c86413f3) | Orgtree 4.0.0 (Rust engine): read this first | Engine priority and agent build caches (2026-10-07). The boot task requests Normal |
| [e-e5fe37876cb27595](providers-and-accounts.md#e-e5fe37876cb27595) | Orgtree 4.0.0 (Rust engine): read this first | Codex Windows runner timeouts (2026-10-07). A workspace-write seat can fail |
| [e-69f83b10921dd414](providers-and-accounts.md#e-69f83b10921dd414) | Orgtree 4.0.0 (Rust engine): read this first | Secondary account removal (2026-10-07, P37). Rebind live/archived bindings, |
| [e-568c26a256dcaf98](mail-and-hub.md#e-568c26a256dcaf98) | Orgtree 4.0.0 (Rust engine): read this first | Direct user messages/replies to nested agents atomically grant @user reply |
| [e-997232eb4582e84a](development-and-verification.md#e-997232eb4582e84a) | Keep this file current | Keep this file current |
| [e-5d6d121b8db7164c](org-tree-and-tools.md#e-5d6d121b8db7164c) | Keep this file current | Agent-hire MCP schemas mirror the no-defaults rule: ordinary new hires require |
| [e-af121f7a862c018c](providers-and-accounts.md#e-af121f7a862c018c) | Keep this file current | OpenRouter key add/replace and language model server add/configure forms open in |
| [e-b6c16e1f1ec841ea](providers-and-accounts.md#e-b6c16e1f1ec841ea) | Keep this file current | When you find an engine gotcha or a design invariant, or a new decision or ruling is |
| [e-2f58d475705f7a24](development-and-verification.md#e-2f58d475705f7a24) | Keep this file current | Keep entries short. Date each one (UTC) and tag it |
| [e-6be65c0ba1936e55](development-and-verification.md#e-6be65c0ba1936e55) | Keep this file current | Describe only what has landed: on rust-engine for 4.0.0, on dev for the 3.x line. Work |
| [e-7cc5529b5c6b06bf](development-and-verification.md#e-7cc5529b5c6b06bf) | Keep this file current | When a rule changes, edit its entry in place and say what it replaced. Dead rules live |
| [e-998c7e96381cb84e](development-and-verification.md#e-998c7e96381cb84e) | Keep this file current | Reviewers check this: a landing that adds a gotcha, an invariant or a ruling without |
| [e-2b6fb1f21c689754](development-and-verification.md#e-2b6fb1f21c689754) | Keep this file current | Agent sessions load this whole file, so keep it dense; long explanations belong in |
| [e-3405212ec38e4ef6](mail-and-hub.md#e-3405212ec38e4ef6) | Keep this file current | main is public. Never put secrets, tokens, email addresses, user names, personal paths |
| [e-8ca06a30dfe8e866](legacy-and-superseded.md#e-8ca06a30dfe8e866) | Keep this file current | This first version was compiled on 2026-10-05 at 6e53697, before the development branch was renamed. |
| [e-3d5d469686fbccda](legacy-and-superseded.md#e-3d5d469686fbccda) | Read this first | Read this first |
| [e-692d3321fe4ed9ba](providers-and-accounts.md#e-692d3321fe4ed9ba) | Read this first | Model palettes share the transparent .quickchat-pop-model wrapper across |
| [e-8985bba70cb79107](legacy-and-superseded.md#e-8985bba70cb79107) | Read this first | x Python engine — legacy. For 4.0.0 work use Orgtree 4.0.0: read this first; rules 2, 3, 8, 9 and 10 below still apply. |
| [e-142bfa8565134e1b](legacy-and-superseded.md#e-142bfa8565134e1b) | Read this first | These rules prevent the mistakes that have cost the most: lost work, a crashed machine, |
| [e-be2958e3484916bd](legacy-and-superseded.md#e-be2958e3484916bd) | Read this first | What we build. Orgtree 3 (3.x): an Electron desktop app, a Python engine and a |
| [e-25dc30e17769be58](legacy-and-superseded.md#e-25dc30e17769be58) | Read this first | Never touch live Orgtree data, and never build an installer, tag, release, publish, |
| [e-1d2bea471a476f07](legacy-and-superseded.md#e-1d2bea471a476f07) | Read this first | Work in your own git worktree. git fetch origin, then |
| [e-85d4ccab0710db03](legacy-and-superseded.md#e-85d4ccab0710db03) | Read this first | In agent shells a bare python imports the installed app, not your checkout. Run |
| [e-8fba03b9c0763f09](legacy-and-superseded.md#e-8fba03b9c0763f09) | Read this first | Tests are slow and the machine is short on memory. Run only the test modules your |
| [e-111838bc4f10b080](legacy-and-superseded.md#e-111838bc4f10b080) | Read this first | Landing: an independent reviewer approves your exact commit; you rebase, re-run your |
| [e-55dd205244b33716](legacy-and-superseded.md#e-55dd205244b33716) | Read this first | The storage rules are easy to break without noticing: no transaction spans two |
| [e-9e52279facf85d0d](legacy-and-superseded.md#e-9e52279facf85d0d) | Read this first | Commit before you probe the base or mutate code for a test. git checkout --, |
| [e-60aa58c79706228d](legacy-and-superseded.md#e-60aa58c79706228d) | Read this first | Evidence: label every claim measured or inferred. Treat a surprising pass like a |
| [e-a579b9842efd5854](legacy-and-superseded.md#e-a579b9842efd5854) | Read this first | This machine has traps (CRLF, heredocs, PowerShell encodings, MSYS path rewriting, |
| [e-c2c15d8033bc95bc](legacy-and-superseded.md#e-c2c15d8033bc95bc) | Read this first | Before changing behaviour, grep for the ruling behind it. About 900 source comments |
| [e-529b1d4fb08f2bdc](legacy-and-superseded.md#e-529b1d4fb08f2bdc) | Read this first | Do not revive dead ideas (kiosk mode, the per-org Docker sandbox, the frozen |
| [e-8af78421feca70c8](legacy-and-superseded.md#e-8af78421feca70c8) | Read this first | Record catch-up builds each needed body once per snapshot and shares its tree context |
| [e-f18cfe911c749baa](legacy-and-superseded.md#e-f18cfe911c749baa) | Read this first | Record HTTP timings use the existing slow-request threshold and numeric allowlist. |
| [e-208587af261f95e0](legacy-and-superseded.md#e-208587af261f95e0) | What Orgtree is, and where it stands | What Orgtree is, and where it stands |
| [e-e469792c5ec321cb](legacy-and-superseded.md#e-e469792c5ec321cb) | What Orgtree is, and where it stands | The product description still holds. The 3.2.0 status below is legacy: the user stopped the 3.2.0 Python track on 2026-1 |
| [e-7df6cf178edd3612](legacy-and-superseded.md#e-7df6cf178edd3612) | What Orgtree is, and where it stands | Claude warm reuse rotates the Orgtree MCP child at a quiescent turn boundary: |
| [e-54fabbc6d0b78c04](legacy-and-superseded.md#e-54fabbc6d0b78c04) | What Orgtree is, and where it stands | The product. A Windows desktop app for running a persistent team of coding agents. |
| [e-93fd1037ed013216](legacy-and-superseded.md#e-93fd1037ed013216) | What Orgtree is, and where it stands | Lineage. claude-orgtree (v1) → Orgtree 2 (Electron around the v1 Python engine, on |
| [e-fd803721f4f6abad](legacy-and-superseded.md#e-fd803721f4f6abad) | What Orgtree is, and where it stands | The mission of v3 is performance and memory, not UI: the app must stay responsive |
| [e-bccd9c99ba982c97](legacy-and-superseded.md#e-bccd9c99ba982c97) | What Orgtree is, and where it stands | Scale targets at 1,000 agents: UI reads p95 under 250 ms; tool calls p95 under |
| [e-ecc79eb53749808d](legacy-and-superseded.md#e-ecc79eb53749808d) | What Orgtree is, and where it stands | rewrites the data model as if Orgtree were built for PostgreSQL from the ground |
| [e-f4d3208a2c64ba89](legacy-and-superseded.md#e-f4d3208a2c64ba89) | What Orgtree is, and where it stands | status on 2026-10-05 (check git log origin/dev before relying on it): |
| [e-66d8264631bd0ff3](legacy-and-superseded.md#e-66d8264631bd0ff3) | What Orgtree is, and where it stands | Landed: phase A (per-org databases, converter with unavailable and Retry, |
| [e-115e489dabd97c38](legacy-and-superseded.md#e-115e489dabd97c38) | What Orgtree is, and where it stands | Builds delivered (local, never published): 3.2.0-alpha.0 on 2026-10-04 and |
| [e-48cdf74c2bc916d5](legacy-and-superseded.md#e-48cdf74c2bc916d5) | What Orgtree is, and where it stands | In flight: the record feed panels: B4c1 (inbox, events, mail, history), B4c2 (gallery, docket, audiences) and B4d |
| [e-a70a381f45e72701](legacy-and-superseded.md#e-a70a381f45e72701) | What Orgtree is, and where it stands | Remaining: B1 mail and watchdog modules with jobs; B2 questions, audiences, |
| [e-a7e56472b11bd3c8](legacy-and-superseded.md#e-a7e56472b11bd3c8) | Architecture | Architecture |
| [e-45a30d854fa73009](legacy-and-superseded.md#e-45a30d854fa73009) | Architecture | x Python engine — legacy. 4.0.0's architecture is PLAN.md §1–§4. (2026-10-06) |
| [e-50cc1d4e5597f3d3](engine-and-storage.md#e-50cc1d4e5597f3d3) | Architecture | App registry locks and restore boundary: app migration 0005_app_feed.sql |
| [e-9bfac29b98fa3f35](legacy-and-superseded.md#e-9bfac29b98fa3f35) | Architecture | As built on dev on 2026-10-05; where 3.2.0 will differ, the table at the |
| [e-c56984b7084f1ccc](legacy-and-superseded.md#e-c56984b7084f1ccc) | Processes and the desktop–engine boundary | Processes and the desktop–engine boundary |
| [e-dbd0f31f9ab1a2d8](legacy-and-superseded.md#e-dbd0f31f9ab1a2d8) | Processes and the desktop–engine boundary | App feed and native login (2026-10-05). App registry, org summaries/notices and |
| [e-504a24f67b4783a8](legacy-and-superseded.md#e-504a24f67b4783a8) | Processes and the desktop–engine boundary | Native notices (2026-10-05). Electron's app socket uses the current desktop |
| [e-8463df1bd7fe0ce0](legacy-and-superseded.md#e-8463df1bd7fe0ce0) | Processes and the desktop–engine boundary | Desktop (apps/desktop): Electron 44. main/ owns windows (one main window per |
| [e-e291fe5e0000ccc9](legacy-and-superseded.md#e-e291fe5e0000ccc9) | Processes and the desktop–engine boundary | Engine (engine/): Python 3.13 (embedded runtime, engine/runtime, gitignored and |
| [e-b5f3af009ae6238d](legacy-and-superseded.md#e-b5f3af009ae6238d) | Processes and the desktop–engine boundary | Guardian (engine/process_lifetime.py): holds the data-root lock |
| [e-7725d52964a5bdd4](legacy-and-superseded.md#e-7725d52964a5bdd4) | Processes and the desktop–engine boundary | Boot host (engine/service_host.py): run at Windows boot by the "Orgtree Background |
| [e-bd3cb4a943e3fe6b](legacy-and-superseded.md#e-bd3cb4a943e3fe6b) | Processes and the desktop–engine boundary | PostgreSQL 18.6, bundled, run by the Rust pg-custodian (engine/native/pg-custodian) |
| [e-608280dc136ece96](legacy-and-superseded.md#e-608280dc136ece96) | Processes and the desktop–engine boundary | Mail hub: the engine/mailhub submodule (orgtree-mailhub) runs as a child process; |
| [e-d445ff365e730f9e](legacy-and-superseded.md#e-d445ff365e730f9e) | Processes and the desktop–engine boundary | Boundary. All domain traffic is HTTP and WebSocket from the engine origin; IPC |
| [e-e638c1a855d2a9af](legacy-and-superseded.md#e-e638c1a855d2a9af) | Processes and the desktop–engine boundary | Agents call back through the MCP server python -m orgtree.mcptool, which posts to |
| [e-569b3623b1f9d2fd](legacy-and-superseded.md#e-569b3623b1f9d2fd) | Storage | Storage |
| [e-6a015bca0d18fb06](legacy-and-superseded.md#e-6a015bca0d18fb06) | Storage | Backend choice: ORGTREE_STORE, then &lt;data&gt;/store-backend.json, then SQLite. |
| [e-b4fd2ac0a5a27772](legacy-and-superseded.md#e-b4fd2ac0a5a27772) | Storage | The layout switch ORGTREE_STORAGE: unset or empty means orgdb (one database per |
| [e-6ef10c9baab41cc5](legacy-and-superseded.md#e-6ef10c9baab41cc5) | Storage | Legacy layout (3.0–3.1): one database orgtree with a schema org_&lt;n&gt; of key+JSON |
| [e-d9e6214873b52c47](legacy-and-superseded.md#e-d9e6214873b52c47) | Storage | Per-org layout (3.2.0): orgtree_app plus orgtree_org_&lt;n&gt;, all tables in schema |
| [e-e3324920c5d150e9](legacy-and-superseded.md#e-e3324920c5d150e9) | Storage | Startup with orgdb: prepare the app database → the one-time converter pass (a child |
| [e-7d7e91230770161f](legacy-and-superseded.md#e-7d7e91230770161f) | Storage | Compatibility view (orgdb/compat): store.py keeps issuing its own SQL against the |
| [e-d9fe662ec671a943](legacy-and-superseded.md#e-d9fe662ec671a943) | Storage | Connections: one idle cache per process for app and org sessions (at most 4 idle app, |
| [e-05456033c264f5ec](legacy-and-superseded.md#e-05456033c264f5ec) | Storage | Prompt-view capture: a complete JSONL row with invalid JSON or text encoding is skipped |
| [e-1eb7e758aa691fb2](legacy-and-superseded.md#e-1eb7e758aa691fb2) | Turns, jobs and the feed: built today vs. 3.2.0 | Turns, jobs and the feed: built today vs. 3.2.0 |
| [e-fe6ca940df88a757](legacy-and-superseded.md#e-fe6ca940df88a757) | Turns, jobs and the feed: built today vs. 3.2.0 | Part On dev now 3.2.0 target |
| [e-99bfbdbace3575da](legacy-and-superseded.md#e-99bfbdbace3575da) | Code map | Code map |
| [e-923a2eb470e7d64d](legacy-and-superseded.md#e-923a2eb470e7d64d) | Code map | engine/backend/orgtree/: supervisor.py (about 37,600 lines: turns, provider legs, |
| [e-0586b1bb36f5c37e](legacy-and-superseded.md#e-0586b1bb36f5c37e) | Code map | Name collisions: four "lifecycle" modules (lifecycle.py, lifecycle_tx.py, |
| [e-557270fe75846468](legacy-and-superseded.md#e-557270fe75846468) | Code map | engine/native/: only pg-custodian (with its prototype-guard library) runs in the |
| [e-53288d2d34dc321f](legacy-and-superseded.md#e-53288d2d34dc321f) | Code map | Generated files: apps/desktop/renderer/src/generated/events.ts says it comes from |
| [e-0507d142fa252ea1](legacy-and-superseded.md#e-0507d142fa252ea1) | Design rules and invariants | Design rules and invariants |
| [e-aaee5785159ec887](legacy-and-superseded.md#e-aaee5785159ec887) | Design rules and invariants | x Python engine — legacy (the 3.2.0 per-org data model, org_tx lock order, revision row, jobs). 4.0.0 has its own rules: |
| [e-e194a167983105ef](legacy-and-superseded.md#e-e194a167983105ef) | Design rules and invariants | Break one of these and the damage is usually silent until it reaches real data. "§" refers |
| [e-76435f20db8b6fff](legacy-and-superseded.md#e-76435f20db8b6fff) | Data model (3.2.0) | Data model (3.2.0) |
| [e-502840766f26713e](legacy-and-superseded.md#e-502840766f26713e) | Data model (3.2.0) | PostgreSQL is the only source of truth. No engine process holds org state; a cache is |
| [e-7b9281047a34d23c](legacy-and-superseded.md#e-7b9281047a34d23c) | Data model (3.2.0) | One database per org, plus one small app database. An org's database holds everything |
| [e-b3ac9df0e59fd00c](legacy-and-superseded.md#e-b3ac9df0e59fd00c) | Data model (3.2.0) | Normalized design (about 3NF). A many-to-one link is a foreign-key column on the |
| [e-721fdb7b22d1ff51](legacy-and-superseded.md#e-721fdb7b22d1ff51) | Data model (3.2.0) | Keys and names. Every record has a surrogate id; visible names (agent name, ticket |
| [e-dfcefd709bfb4616](legacy-and-superseded.md#e-dfcefd709bfb4616) | Data model (3.2.0) | Agent identity is the node, not the lineage. Each agent and each archived generation |
| [e-7ff4cf85b47180dd](legacy-and-superseded.md#e-7ff4cf85b47180dd) | Data model (3.2.0) | Exact round trips. Timestamps are timestamptz at microsecond precision, with the |
| [e-e488219ebc7ba51d](legacy-and-superseded.md#e-e488219ebc7ba51d) | Data model (3.2.0) | Migration numbers are taken at landing: the next free number on dev when your migration |
| [e-6b8ad861528d902e](legacy-and-superseded.md#e-6b8ad861528d902e) | Transactions and locks | Transactions and locks |
| [e-bede9e03c4a0d94e](legacy-and-superseded.md#e-bede9e03c4a0d94e) | Transactions and locks | One short transaction per action, on its own org's database, over only its rows, at |
| [e-012f61633c21eabf](legacy-and-superseded.md#e-012f61633c21eabf) | Transactions and locks | No transaction spans two databases. An action that touches two (cross-org mail, |
| [e-3584dc22a5bb61f5](legacy-and-superseded.md#e-3584dc22a5bb61f5) | Transactions and locks | One lock order for every org-database writer |
| [e-57b307e6045f55b9](legacy-and-superseded.md#e-57b307e6045f55b9) | Transactions and locks | Triggers. A statement-time trigger writes only link rows of its own statement's rows |
| [e-62e92f1b5827761b](legacy-and-superseded.md#e-62e92f1b5827761b) | Transactions and locks | Every foreign key to agents is immediate, never deferred: a commit-time check would |
| [e-2053402522e64f38](legacy-and-superseded.md#e-2053402522e64f38) | Transactions and locks | Deferred foreign-key checks queued by a backfill block later DDL: an ALTER TABLE in |
| [e-9aa62b10d0b1d5e4](legacy-and-superseded.md#e-9aa62b10d0b1d5e4) | Transactions and locks | The tree. agents.parent_id is the only placement authority (no closure table, no |
| [e-be13c585119ca3fe](legacy-and-superseded.md#e-be13c585119ca3fe) | Transactions and locks | The admin connection (create, rename, drop databases) belongs only to |
| [e-15606c8a09b30a5f](legacy-and-superseded.md#e-15606c8a09b30a5f) | History must cost nothing | History must cost nothing |
| [e-c356ca25553037e2](legacy-and-superseded.md#e-c356ca25553037e2) | History must cost nothing | Performance tracks active data only: retired agents, archived tickets and read mail |
| [e-2d53f92a0b615905](legacy-and-superseded.md#e-2d53f92a0b615905) | History must cost nothing | Acceptance: with at least 10× inactive history, p95 at most 5% slower and engine memory |
| [e-6d2587ee713472a6](legacy-and-superseded.md#e-6d2587ee713472a6) | History must cost nothing | How: partial indexes over active rows only (live agents, open tickets, undelivered |
| [e-1389c6e1bed3364c](legacy-and-superseded.md#e-1389c6e1bed3364c) | History must cost nothing | An agent's docket list totals count non-archived items only; an archived total comes only |
| [e-060e49d7c8167ba6](legacy-and-superseded.md#e-060e49d7c8167ba6) | Background work, the feed and turns | Background work, the feed and turns |
| [e-eee60aa44be75269](legacy-and-superseded.md#e-eee60aa44be75269) | Background work, the feed and turns | Panel records (B4c1): migration 0019 appends shared inbox/events and subscribed |
| [e-7a054db8ea0afafe](mail-and-hub.md#e-7a054db8ea0afafe) | Background work, the feed and turns | Mailbox delivery stages are host-clock overlays, retained only for subscribed |
| [e-b7279ece311be6b9](legacy-and-superseded.md#e-b7279ece311be6b9) | Background work, the feed and turns | Every polling loop that reads org tables becomes a job row in the org database, written |
| [e-447469b3cc1dbb63](legacy-and-superseded.md#e-447469b3cc1dbb63) | Background work, the feed and turns | The change feed (B4a implemented, 2026-10-05): each org database records its changes in the committing |
| [e-bceaa8dee93f8417](legacy-and-superseded.md#e-bceaa8dee93f8417) | Background work, the feed and turns | Record-feed activation and commit ownership: advertise record_changes_v1 only |
| [e-4b56b3cb109acdf1](legacy-and-superseded.md#e-4b56b3cb109acdf1) | Background work, the feed and turns | Record runtime cache forecasts: expensive cache/startup-manifest previews run in |
| [e-f2df1e7b6b0a8a6f](legacy-and-superseded.md#e-f2df1e7b6b0a8a6f) | Background work, the feed and turns | Turn admission is machine-wide: at most N turns at once (a setting, default 16), first |
| [e-ca996a5a4a4362b3](legacy-and-superseded.md#e-ca996a5a4a4362b3) | Background work, the feed and turns | A turn has a durable identity (a request row, then a ticket keyed by its id), numbered |
| [e-ca09cd0e24385f11](legacy-and-superseded.md#e-ca09cd0e24385f11) | Background work, the feed and turns | "A turn cannot run while its agent is halted." Halt is not interrupt: it ends the turn, |
| [e-d3524af0d427fb29](legacy-and-superseded.md#e-d3524af0d427fb29) | Background work, the feed and turns | Automatic compaction admission retries graph Widen only after rollback, at most |
| [e-0c900a33a0b1c9d2](legacy-and-superseded.md#e-0c900a33a0b1c9d2) | Background work, the feed and turns | Turn time limits: a total ceiling (default 24 h) and a silence limit (default 10 min), |
| [e-f238eaa6f9df1847](legacy-and-superseded.md#e-f238eaa6f9df1847) | Processes, privileges and startup | Processes, privileges and startup |
| [e-3e1a0ad6cddf94d2](legacy-and-superseded.md#e-3e1a0ad6cddf94d2) | Processes, privileges and startup | Unelevated by default. The engine, PostgreSQL and agents run as the normal user; |
| [e-c161e8869e9a26a3](legacy-and-superseded.md#e-c161e8869e9a26a3) | Processes, privileges and startup | The engine runs at Windows High priority so busy apps cannot starve it. |
| [e-9d955a0c1f890a25](legacy-and-superseded.md#e-9d955a0c1f890a25) | Processes, privileges and startup | Untrusted output never gains privileges. Agent Markdown, HTML and presentations get no |
| [e-358528565e3bb1da](legacy-and-superseded.md#e-358528565e3bb1da) | Processes, privileges and startup | Agent children never inherit the engine's storage variables. A script an agent runs |
| [e-22157c966cc3a684](legacy-and-superseded.md#e-22157c966cc3a684) | Processes, privileges and startup | Startup deadlines measure silence: 60 s for the desktop and 120 s for the boot host |
| [e-357f14d55c77f487](legacy-and-superseded.md#e-357f14d55c77f487) | Processes, privileges and startup | One failing org never stops the others. It becomes unavailable with its reason and a |
| [e-efef587deabb5245](legacy-and-superseded.md#e-efef587deabb5245) | Desktop and renderer | Desktop and renderer |
| [e-ffa0610eebeb40eb](projects-and-concurrency.md#e-ffa0610eebeb40eb) | Desktop and renderer | .chip repaints whatever wears it: it sits late in styles.css at one-class |
| [e-a9a829a04631f264](projects-and-concurrency.md#e-a9a829a04631f264) | Desktop and renderer | useMailboxHistory takes only 'inbox' or 'sent': it adopts a folder when it |
| [e-5dacbbbd6bbcd5d8](desktop-and-renderer.md#e-5dacbbbd6bbcd5d8) | Desktop and renderer | An agent link hands its handler the click event too: NodeLink/AgentName call |
| [e-1fdf4b7f89581e89](legacy-and-superseded.md#e-1fdf4b7f89581e89) | Desktop and renderer | Move previews preserve sibling order: native moves retain ui_order, creation |
| [e-dd74013de10da9cf](legacy-and-superseded.md#e-dd74013de10da9cf) | Desktop and renderer | Local move refresh: after a successful move response is parsed, flush its |
| [e-b17ce1feb69ca774](legacy-and-superseded.md#e-b17ce1feb69ca774) | Desktop and renderer | Circular layout order: in the circular org chart, siblings (rings, the agents list and |
| [e-4726425a8be7d03b](projects-and-concurrency.md#e-4726425a8be7d03b) | Desktop and renderer | Circular sibling arcs: parent/arc-centre springs relax all depths together, so |
| [e-fabb28e553218b52](legacy-and-superseded.md#e-fabb28e553218b52) | Desktop and renderer | Window bounds at fractional DPI: Windows can add an invisible frame allowance to a |
| [e-4c8b5b4b573dd7f1](legacy-and-superseded.md#e-4c8b5b4b573dd7f1) | Desktop and renderer | CSS app-region is inherited, and only initial stops it (unset and none do not): |
| [e-334be6d41c4e6d21](legacy-and-superseded.md#e-334be6d41c4e6d21) | Desktop and renderer | jsdom does no layout. Geometry, drag regions and native window behaviour need the |
| [e-73f802e8ab8d258b](docket-and-presentations.md#e-73f802e8ab8d258b) | Desktop and renderer | Never hand a jsdom element to an assertion (assert.equal(el.querySelector(s), null)). |
| [e-e10014dd52fcebe9](legacy-and-superseded.md#e-e10014dd52fcebe9) | Product rulings | Product rulings |
| [e-b1b3e7a9c44f9298](docket-and-presentations.md#e-b1b3e7a9c44f9298) | Product rulings | Still binding for 4.0.0 except where PLAN.md §10 or DECISIONS.md changes them (e.g. no lineage nodes, lean docket withou |
| [e-686453bbc559f38a](legacy-and-superseded.md#e-686453bbc559f38a) | Product rulings | The user's standing rulings about how Orgtree behaves. The older ones (up to 2026-09-15) |
| [e-3f4a1233215d38db](legacy-and-superseded.md#e-3f4a1233215d38db) | Org, agents and topology | Org, agents and topology |
| [e-cf8f05012f74aca6](legacy-and-superseded.md#e-cf8f05012f74aca6) | Org, agents and topology | Scope containment: a child's folders, tools and visibility always lie within its |
| [e-b51a68da1adb841d](legacy-and-superseded.md#e-b51a68da1adb841d) | Org, agents and topology | swap, subjugate and move_batch stay agent-only, with no operator door. |
| [e-9c9e4b0dee8fbe96](legacy-and-superseded.md#e-9c9e4b0dee8fbe96) | Org, agents and topology | Credits: grants are whole credits (rounded up when a raise saturates a superior); |
| [e-12c262ac1e5a27f6](legacy-and-superseded.md#e-12c262ac1e5a27f6) | Org, agents and topology | Retiring keeps history, and rehire restores the agent. Retire, dissolve and compaction |
| [e-2e8c3efa8f0b52f7](legacy-and-superseded.md#e-2e8c3efa8f0b52f7) | Turns, mail and notices | Turns, mail and notices |
| [e-d2db0cf073478e44](legacy-and-superseded.md#e-d2db0cf073478e44) | Turns, mail and notices | Delivering a message never interrupts a turn; only an explicit interrupt does. Mid-turn |
| [e-ab4d0a862afed035](legacy-and-superseded.md#e-ab4d0a862afed035) | Turns, mail and notices | Notices never start a turn. Status reports (orgtree_status) arrive as passive notices; |
| [e-23a54ad81a0a8312](legacy-and-superseded.md#e-23a54ad81a0a8312) | Turns, mail and notices | Unrecorded hook claims are released at startup after transcript reconciliation |
| [e-ebef170cabe09157](legacy-and-superseded.md#e-ebef170cabe09157) | Turns, mail and notices | A mid-turn model switch is queued for the next turn (an interrupt applies it at once). A |
| [e-f4ddc5b78b8ea114](legacy-and-superseded.md#e-f4ddc5b78b8ea114) | Turns, mail and notices | Warm processes: one parked CLI per live agent, started at boot and on hire; no idle reaper |
| [e-57b22e79f6fd55a5](legacy-and-superseded.md#e-57b22e79f6fd55a5) | Turns, mail and notices | After a crash or restart, agents that were mid-turn resume with session continuity, and |
| [e-0cf17758e3d509a8](agent-runtime.md#e-0cf17758e3d509a8) | Turns, mail and notices | Live compaction row (docket show-a-live-compacting-for-xs-event-while-an-age): when a |
| [e-85049c25eb1366bf](legacy-and-superseded.md#e-85049c25eb1366bf) | Docket, questions and attention | Docket, questions and attention |
| [e-b851648f02c40f26](legacy-and-superseded.md#e-b851648f02c40f26) | Docket, questions and attention | A ticket is identified only by its readable slug. Its description states the problem |
| [e-fb5d8c5a61cfbd75](legacy-and-superseded.md#e-fb5d8c5a61cfbd75) | Docket, questions and attention | review means review by agents. The user is reached through an attached question or the |
| [e-31677f6c1c895295](legacy-and-superseded.md#e-31677f6c1c895295) | Docket, questions and attention | Dropped tickets archive at once; done tickets an hour after their last update. There is |
| [e-f4968e51da200f5e](legacy-and-superseded.md#e-f4968e51da200f5e) | Docket, questions and attention | These rules are written into the managed agent instructions in supervisor.py. Editing |
| [e-9914c59ebc94e1f5](legacy-and-superseded.md#e-9914c59ebc94e1f5) | Providers, accounts and usage | Providers, accounts and usage |
| [e-089b72951ff77ea8](legacy-and-superseded.md#e-089b72951ff77ea8) | Providers, accounts and usage | Provider, model, harness, account and route are separate concepts, and provider |
| [e-f35911d33eb20e25](legacy-and-superseded.md#e-f35911d33eb20e25) | Providers, accounts and usage | Accounts are machine-wide and symmetric (any org may use any account), except legacy |
| [e-f9bfc5ac5f086eb7](providers-and-accounts.md#e-f9bfc5ac5f086eb7) | Providers, accounts and usage | Conditional Gemini tiers: Argon (gemini-4-argon) and speculative Barium |
| [e-7e963ca25fff4917](providers-and-accounts.md#e-7e963ca25fff4917) | Providers, accounts and usage | Hire tokens treat a missing Claude/Codex/Antigravity row as absent only after |
| [e-19adbaa90daa849b](legacy-and-superseded.md#e-19adbaa90daa849b) | Providers, accounts and usage | A provider that is not installed is absent from the UI; installed but signed out shows |
| [e-0c4327cbc9ba6c01](providers-and-accounts.md#e-0c4327cbc9ba6c01) | Providers, accounts and usage | Hire chips additionally require an enabled account allowed for the current org. |
| [e-481dc2499ef81d25](providers-and-accounts.md#e-481dc2499ef81d25) | Providers, accounts and usage | Model-switch menus use the same org-aware hire states as canvas chips; |
| [e-3898c44fbc17f6fb](legacy-and-superseded.md#e-3898c44fbc17f6fb) | Desktop UI | Desktop UI |
| [e-9c8b1fc1649dc4b1](legacy-and-superseded.md#e-9c8b1fc1649dc4b1) | Desktop UI | Performance comes before UI work; keep and improve the existing layout rather than |
| [e-938dbdf0ad826b39](legacy-and-superseded.md#e-938dbdf0ad826b39) | Desktop UI | Every app-generated time is shown in the user's local time zone; no visible UTC. |
| [e-0d45f90df4eca5a5](legacy-and-superseded.md#e-0d45f90df4eca5a5) | Desktop UI | One main window per org; opening an open org focuses it; startup restores the previous |
| [e-e3f18d7647d64c36](docket-and-presentations.md#e-e3f18d7647d64c36) | Desktop UI | Notifications default to needs-attention only (questions, urgent mail, ticket attention). |
| [e-7ccf4b6a79900f27](legacy-and-superseded.md#e-7ccf4b6a79900f27) | Installer, updates and data | Installer, updates and data |
| [e-468e519ea39c01ec](legacy-and-superseded.md#e-468e519ea39c01ec) | Installer, updates and data | PostgreSQL ships inside the installer, with its data under &lt;data&gt;\pg. Uninstall keeps |
| [e-a65c5774f2b97b9b](legacy-and-superseded.md#e-a65c5774f2b97b9b) | Installer, updates and data | Automatic updates (on by default) check in the background and install only at a safe idle |
| [e-f495232d8cb87e45](legacy-and-superseded.md#e-f495232d8cb87e45) | Installer, updates and data | An upgrade never modifies the old data: the legacy database and files are kept for one |
| [e-633ee0e230c60afb](legacy-and-superseded.md#e-633ee0e230c60afb) | Development workflow | Development workflow |
| [e-e4e46229e3276147](legacy-and-superseded.md#e-e4e46229e3276147) | Development workflow | x Python engine — legacy (branch dev, P03 lock, test baseline, Python runner, source audits, push and ls-remote). For 4. |
| [e-169809c0b4e4aaf5](legacy-and-superseded.md#e-169809c0b4e4aaf5) | Branches and worktrees | Branches and worktrees |
| [e-b7eceb4a810f7abf](legacy-and-superseded.md#e-b7eceb4a810f7abf) | Branches and worktrees | Development branch changed to dev on 2026-10-05, created from v3. |
| [e-701fedad4cbd4ea2](legacy-and-superseded.md#e-701fedad4cbd4ea2) | Branches and worktrees | All work lands on dev by fast-forward. main is moved to dev at each |
| [e-6191464dbd2c499c](legacy-and-superseded.md#e-6191464dbd2c499c) | Branches and worktrees | Worktrees: python tools/worktree.py addverifyremove; remove refuses when it finds a |
| [e-c38f86e06d76d7c3](legacy-and-superseded.md#e-c38f86e06d76d7c3) | Tests | Tests |
| [e-84f2133727d0852f](legacy-and-superseded.md#e-84f2133727d0852f) | Tests | Renderer app-feed fixtures: legacy HTTP mocks must explicitly return 501 for |
| [e-3faa34277ad919be](legacy-and-superseded.md#e-3faa34277ad919be) | Tests | Python: python tools/run-python-verification.py tests/test_X.py [...] gives each module |
| [e-ed91b2bebcd52625](legacy-and-superseded.md#e-ed91b2bebcd52625) | Tests | Node and renderer: npm test (root tests/.test.mjs), npm run test:renderer |
| [e-3f0aac84fb01f899](legacy-and-superseded.md#e-3f0aac84fb01f899) | Tests | The PostgreSQL subtree renderer test runs only when its Python parent supplies |
| [e-1408999218a12d6a](legacy-and-superseded.md#e-1408999218a12d6a) | Tests | The baseline: node tools/test-baseline.mjs show (or npm run test:known-failures) |
| [e-1174a32d265dec62](legacy-and-superseded.md#e-1174a32d265dec62) | Tests | Per landing: run only the modules your change touches, at base and tip, each call under |
| [e-6b335a716b0c22e9](legacy-and-superseded.md#e-6b335a716b0c22e9) | Tests | The machine lock: one heavy run at a time on the whole machine (scale runs, |
| [e-94d90ce067585c9f](legacy-and-superseded.md#e-94d90ce067585c9f) | Tests | Memory (this machine): start a run only with 15 GB of free commit memory and stop below |
| [e-eb5b3096c9203b67](legacy-and-superseded.md#e-eb5b3096c9203b67) | Tests | Your own PostgreSQL cluster: drive E: syncs slowly (about 3 s per fsync, 2026-10-03), so |
| [e-53fe61d0eff94eb0](legacy-and-superseded.md#e-53fe61d0eff94eb0) | Tests | Risky code (locking, transactions, leases, queues, data import, halt, the killswitch): |
| [e-9a8992eb8974885d](legacy-and-superseded.md#e-9a8992eb8974885d) | Reviews and landing | Reviews and landing |
| [e-3dd68e9b5d33c15a](legacy-and-superseded.md#e-3dd68e9b5d33c15a) | Reviews and landing | An independent reviewer records approve_stage on your exact commit; the coordinator |
| [e-180003e8c7ca96e3](legacy-and-superseded.md#e-180003e8c7ca96e3) | Reviews and landing | Rebase onto the current dev and check git range-diff (all =, or explain each !). |
| [e-be2798b46eea91d7](legacy-and-superseded.md#e-be2798b46eea91d7) | Reviews and landing | Re-run your targeted tests, then python tools/source-audits.py (about a minute, no |
| [e-e391799dacd73fcb](legacy-and-superseded.md#e-e391799dacd73fcb) | Reviews and landing | Fast-forward push (git push origin HEAD:refs/heads/dev), then put the |
| [e-ce97f1fdd6f64f72](legacy-and-superseded.md#e-ce97f1fdd6f64f72) | Reviews and landing | Update this file if you found a gotcha, an invariant or a ruling. |
| [e-bce4b476bff50a3d](legacy-and-superseded.md#e-bce4b476bff50a3d) | Reviews and landing | Never rewrite pushed history or force-push. |
| [e-4fdd08ec9b1019e1](legacy-and-superseded.md#e-4fdd08ec9b1019e1) | Evidence and reporting | Evidence and reporting |
| [e-131427ac7ed45ab4](legacy-and-superseded.md#e-131427ac7ed45ab4) | Evidence and reporting | Label every claim measured (you ran it and saw it) or inferred. Quote the module's own |
| [e-d6420b69da372727](legacy-and-superseded.md#e-d6420b69da372727) | Evidence and reporting | Check that a control can fail: plant the fault, see red, restore. A guard that passes with |
| [e-e57287c1ef0c4d54](legacy-and-superseded.md#e-e57287c1ef0c4d54) | Evidence and reporting | Keep breadcrumbs.md in your scratch folder current; it is what a successor reads. |
| [e-6ccb779c85bc3c53](legacy-and-superseded.md#e-6ccb779c85bc3c53) | Evidence and reporting | Crash forensics: the engine logs to &lt;data&gt;\diagnostics\engine.log (with |
| [e-09f5223553b01ead](legacy-and-superseded.md#e-09f5223553b01ead) | Releases, builds and updates | Releases, builds and updates |
| [e-d73be7b363cb7b63](legacy-and-superseded.md#e-d73be7b363cb7b63) | Releases, builds and updates | x — legacy. 4.0.0 prototype builds (4.0.0-alpha.N) are built and installed by the user only (DECISIONS 37–38). (2026-10- |
| [e-0c3036a38ac7d2b8](legacy-and-superseded.md#e-0c3036a38ac7d2b8) | Releases, builds and updates | Only the coordinator and the release owner it names build, tag, publish or install. |
| [e-1589781cb2e60267](legacy-and-superseded.md#e-1589781cb2e60267) | Releases, builds and updates | No build or publish until the whole 3.2.0 rewrite has landed, apart from local alpha |
| [e-6dbff5c4b979ba41](legacy-and-superseded.md#e-6dbff5c4b979ba41) | Releases, builds and updates | Alphas are local and never published: no tag, no GitHub release, no updater feed. They |
| [e-a49486cb0256eac8](legacy-and-superseded.md#e-a49486cb0256eac8) | Releases, builds and updates | Public releases are cut from main with npm run release:windows -- &lt;version&gt; |
| [e-f542b3bf8b8860b2](legacy-and-superseded.md#e-f542b3bf8b8860b2) | Releases, builds and updates | Every upgrade path is tested: 3.2.0 must upgrade from 2.1.14, 3.0.9 and 3.1.0, with |
| [e-10dac646654eef2b](legacy-and-superseded.md#e-10dac646654eef2b) | Releases, builds and updates | Dev builds (npm run package:dev) install beside the published app under their own |
| [e-802759bf35d36260](development-and-verification.md#e-802759bf35d36260) | Machine traps | Machine traps |
| [e-e446fc17ae10e2a6](development-and-verification.md#e-e446fc17ae10e2a6) | Machine traps | Read the authoritative built-in machine traps page |
| [e-02a966787cf8cf65](legacy-and-superseded.md#e-02a966787cf8cf65) | Gotchas in Orgtree's own agent tools | Gotchas in Orgtree's own agent tools |
| [e-2e51d308b9ab4825](docket-and-presentations.md#e-2e51d308b9ab4825) | Gotchas in Orgtree's own agent tools | Written against the 3.x engine's tools. Under 4.0.0 the tool set and docket changed (PLAN.md §6, §10 F and P): no reserv |
| [e-149550dbaaa72b93](legacy-and-superseded.md#e-149550dbaaa72b93) | Gotchas in Orgtree's own agent tools | Agents that build Orgtree also run on it; these bite repeatedly. |
| [e-56d1a28d2228b6db](legacy-and-superseded.md#e-56d1a28d2228b6db) | Gotchas in Orgtree's own agent tools | Mail that arrives while a subagent (the Agent tool) runs is injected into the |
| [e-257a0e876810659a](legacy-and-superseded.md#e-257a0e876810659a) | Gotchas in Orgtree's own agent tools | orgtree_send_notice never starts a turn; an idle agent reads it only when something else |
| [e-243ecf1ec6617bda](legacy-and-superseded.md#e-243ecf1ec6617bda) | Gotchas in Orgtree's own agent tools | A timed-out mutating call may have applied ("UNKNOWN"): re-read before repeating, and use |
| [e-ddc2174ab06dc896](legacy-and-superseded.md#e-ddc2174ab06dc896) | Gotchas in Orgtree's own agent tools | Docket: field names differ per action; caps of 40 artifacts and 50 evidence rows per item; |
| [e-1e1957300ae8ac7a](legacy-and-superseded.md#e-1e1957300ae8ac7a) | Gotchas in Orgtree's own agent tools | Watchdog command targets run in cmd.exe unless shell: "bash"; read the create-time |
| [e-8144ed9e3cadfbc9](legacy-and-superseded.md#e-8144ed9e3cadfbc9) | Gotchas in Orgtree's own agent tools | Never put a headless agent in plan mode: it blocks every orgtree tool. |
| [e-dd980c189c0ad177](legacy-and-superseded.md#e-dd980c189c0ad177) | Gotchas in Orgtree's own agent tools | Claude agents see tools as mcp__orgtree__&lt;tool&gt;; Codex and Gemini register bare names. |
| [e-962161abcd765385](legacy-and-superseded.md#e-962161abcd765385) | Removed and dead ideas | Removed and dead ideas |
| [e-c77e8683f70b9d23](legacy-and-superseded.md#e-c77e8683f70b9d23) | Removed and dead ideas | Do not rebuild, re-propose or "restore" these without a new ruling from the user. |
| [e-355f20a16348a36c](legacy-and-superseded.md#e-355f20a16348a36c) | Removed and dead ideas | Idea Status Source |
| [e-8d3b3b0a9bb77e9d](legacy-and-superseded.md#e-8d3b3b0a9bb77e9d) | Where the detail lives | Where the detail lives |
| [e-de5c5b2452589996](legacy-and-superseded.md#e-de5c5b2452589996) | Where the detail lives | Start here: pg-data-model-design.md (the |
| [e-187e8fa7719d846a](legacy-and-superseded.md#e-187e8fa7719d846a) | Where the detail lives | data model (docs/state-system/): pg-o1-move.md (the O(1) move), |
| [e-622cd8fd2a56c3c6](legacy-and-superseded.md#e-622cd8fd2a56c3c6) | Where the detail lives | Engine behaviour: agent-halt.md, mail-delivery-boundaries.md, |
| [e-db2349941c6a3748](legacy-and-superseded.md#e-db2349941c6a3748) | Where the detail lives | Process and release: verification-recipes.md, windows-release.md, dev-builds.md, |
| [e-e43f7a8bb06cd5f6](legacy-and-superseded.md#e-e43f7a8bb06cd5f6) | Where the detail lives | History (v1/v2 era; do not use for current behaviour): v1-parity-inventory.md, |
| [e-865845b012a1bc13](legacy-and-superseded.md#e-865845b012a1bc13) | Where the detail lives | Stale statements to ignore (each superseded as shown): |
| [e-1ed3fd48701251ff](legacy-and-superseded.md#e-1ed3fd48701251ff) | Where the detail lives | docs/known-failures.md tells every agent to run compare: only the coordinator or |
| [e-46e149c151fc7105](legacy-and-superseded.md#e-46e149c151fc7105) | Where the detail lives | docs/verification-recipes.md shows a bare python -m unittest for backend tests: use |
| [e-8d6c4adf214bbc82](legacy-and-superseded.md#e-8d6c4adf214bbc82) | Where the detail lives | docs/worktree-operations.md: --base defaults to main; pass |
| [e-93099de9f4ac4527](legacy-and-superseded.md#e-93099de9f4ac4527) | Where the detail lives | docs/engine-contract.md predates PostgreSQL and the account system. It is still right |
| [e-fbf008fa8815d332](legacy-and-superseded.md#e-fbf008fa8815d332) | Where the detail lives | engine/README.md describes an ORGTREE_V1_ROOT launch input that the desktop no longer |
| [e-c0288d7629dc8e37](legacy-and-superseded.md#e-c0288d7629dc8e37) | Where the detail lives | docs/state-system/pypg-packaged-runtime.md speaks of an "external cutover", and |
| [e-f5bd27c31080a2f1](legacy-and-superseded.md#e-f5bd27c31080a2f1) | Where the detail lives | docs/v2-user-decisions.md and engine-contract.md name a GitHub prerelease channel: |
| [e-d5bd76d1e0c8fe2c](legacy-and-superseded.md#e-d5bd76d1e0c8fe2c) | Where the detail lives | docs/v3-qualification.md and synthetic-migration-harness.md exercise the SQLite-era |
| [e-3498b9d054560946](legacy-and-superseded.md#e-3498b9d054560946) | Where the detail lives | Abandoned-docket recovery processes at most eight predicted items per org per tick, |
| [e-b4812fa45d04c477](legacy-and-superseded.md#e-b4812fa45d04c477) | Where the detail lives | Recovery prediction uses the archive projection, including owner and both freshness |
| [e-225978c48bb53dca](legacy-and-superseded.md#e-225978c48bb53dca) | Where the detail lives | Warm-pool eligibility shares one lazy NativeInventory per keeper pass through transcript lookup. It is never retained ac |
| [e-3e5f717aeccea6b1](legacy-and-superseded.md#e-3e5f717aeccea6b1) | Where the detail lives | Cold archived docket projections covered by the existing policy spec use its typed decoder and policy extra, not full it |
| [e-ffe209ade318d2f8](org-tree-and-tools.md#e-ffe209ade318d2f8) | Where the detail lives | (verified-from-source): top-level rescind is supported by Rust domain/ops.rs and 3.x ledger.py: archive the subtree, wit |
| [e-16bf3fdb3b7bdf49](providers-and-accounts.md#e-16bf3fdb3b7bdf49) | Where the detail lives | (verified-from-source): agent settings MODEL_VERSIONS includes Haiku 5.5/4.5, matching Rust providers/catalog.rs. The cu |
| [e-8c6d69a4de7da02b](legacy-and-superseded.md#e-8c6d69a4de7da02b) | Where the detail lives | (recorded-decision): model choices in settings/hire/rehire share modelChoiceLabel and modelChoiceTitle. Enabled options |
| [e-68ad2d4511525f46](legacy-and-superseded.md#e-68ad2d4511525f46) | Where the detail lives | (verified-from-source and mounted renderer): direct children of agent settings (.settings.cfg) must not flex-shrink. Dif |
| [e-b0bd19a8c2de0ac5](mail-and-hub.md#e-b0bd19a8c2de0ac5) | Where the detail lives | : Logo cropping uses a pointer/keyboard square over the native preview; x/y remain fractions of available top-left trave |
| [e-696c902e76e39caa](instructions-and-skills.md#e-696c902e76e39caa) | MCP imports from installed harnesses (2026-10-15) | MCP imports from installed harnesses (2026-10-15) |
| [e-259dd595a4c75786](projects-and-concurrency.md#e-259dd595a4c75786) | MCP imports from installed harnesses (2026-10-15) | External MCP discovery reads explicit user configs from Claude Code, Codex, |
| [e-87e9373ea83fb86f](instructions-and-skills.md#e-87e9373ea83fb86f) | Shared skills and installed plugin imports (2026-10-15) | Shared skills and installed plugin imports (2026-10-15) |
| [e-f6529802f7441855](agent-runtime.md#e-f6529802f7441855) | Shared skills and installed plugin imports (2026-10-15) | Shared snapshot cleanup keeps the current global digest, the newest other |
| [e-9f84bd4d9bf2d9a3](instructions-and-skills.md#e-9f84bd4d9bf2d9a3) | Shared skills and installed plugin imports (2026-10-15) | Per-harness skill variants are selected only for each agent's export, preserving |
| [e-c90bd5ba966d4f59](instructions-and-skills.md#e-c90bd5ba966d4f59) | Shared skills and installed plugin imports (2026-10-15) | Skill discovery reads installed native roots and recorded Claude plugin installs, |
| [e-2a08a4d882f0c3b9](startup-and-release.md#e-2a08a4d882f0c3b9) | Shared skills and installed plugin imports (2026-10-15) | Launch, idle recheck and forecast must use the same combined instruction/skill |
| [e-535f71202df6c4ee](instructions-and-skills.md#e-535f71202df6c4ee) | Shared skills and installed plugin imports (2026-10-15) | Shared skill export validation covers every existing output ancestor and cached |
| [e-29cf67edb8ef554b](mail-and-hub.md#e-29cf67edb8ef554b) | Shared skills and installed plugin imports (2026-10-15) | Waiting mail is bounded before opening/steering/hook delivery: rendered items |
| [e-9534fe084290c8b2](docket-and-presentations.md#e-9534fe084290c8b2) | Shared skills and installed plugin imports (2026-10-15) | Markdown image local paths accept only absolute drive-letter syntax and reject |
| [e-45523cd2be941642](agent-runtime.md#e-45523cd2be941642) | Shared skills and installed plugin imports (2026-10-15) | Agent and project links share one renderer base (NodeLink, AgentLink, |
| [e-9446b240e55c6b00](desktop-and-renderer.md#e-9446b240e55c6b00) | Shared skills and installed plugin imports (2026-10-15) | Centered modal surfaces dismiss on Escape or backdrop click and do not need a |
| [e-2df3546f707ac625](mail-and-hub.md#e-2df3546f707ac625) | Shared skills and installed plugin imports (2026-10-15) | Codex MCP elicitation uses independent human-only AskInfo cards and the |
| [e-9f38bed72023c79e](agent-runtime.md#e-9f38bed72023c79e) | Shared skills and installed plugin imports (2026-10-15) | Interrupt/restart (2026-10-20): orgtree_interrupt accepts restart:true |
| [e-74697db6067c093d](projects-and-concurrency.md#e-74697db6067c093d) | Shared skills and installed plugin imports (2026-10-15) | Hierarchical shared memory is documented in orgtree-shared-folders |
