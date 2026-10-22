# Instructions and skills

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Identity prefixes, tool cards, notes, globals, shared skills and glossary delivery.

## Chat wire-log privacy (2026-10-21)

Agent /api/orgs/{slug}/nodes/{nid}/chat bodies are omitted by the same
outer HTTP quiet-body guard as templates, before authentication/extraction.
Query-based paging and request/status diagnostics remain; private text and
thinking still reach the client. A nolog handler alone cannot establish
this boundary.
[verified: http/mod.rs, http/nodes.rs; real-engine fake-CLI proof
chat-wire-privacy.mjs in both logging modes]

## Template wire-log privacy (2026-10-21)

The HTTP guard omits entire request/response bodies for /api/templates and
its descendants, and /api/orgs/{slug}/template and its descendants, before
authentication or extraction. Saved template JSON embeds private AGENTS.md
inside a content string, so key masking and inner nolog handlers are not
a wire boundary. Keep paths/status diagnostics and the returned download
unchanged. List/resolve project note counts; create reads a stored template
and returns note-copy counts/warnings, not the text.
[verified: http/mod.rs, http/templates.rs, domain/templates.rs; synthetic
real-engine proof template-wire-privacy.mjs in both logging modes]

## Template projects and standing-note snapshots (2026-10-21)

Template slots with tier=project create real free containers through canonical
create_project/configure_project operations; model availability and funding
skip the container while retaining physical placement. Explicit user/extern
agent audiences use the existing composite-hire authority path. Save preserves
project structure and transparent spare-credit calculations, but does not
capture audiences. Optional shared_agents_md/team_agents_md/scratch_agents_md
carry text only, 16,000 UTF-8 bytes each and 128,000 combined. AGENTS.md capture
is opt-in, scoped to fixed current-org files and rejects links, invalid bytes
and recognizable credentials. Text debug output is redacted; raw template
parsing/writing and notes I/O are unlogged. Unknown free-text secrets still
require human review. Creation seeds create-new notes after commit, before
warm/kickoff effects; failures are reported as warnings on the committed org.
Heavy dev shop has fifteen agents and one three-slot project, with operational
practice in inherited notes and short role-focused charters. Shared policy is
not restated in team/project/personal notes; lower layers add only reader-specific
procedures or refer upward. The Developer preset summarizes its combined role;
implementation and review mechanics live once in development-team notes. Its eleven developer
seats resolve the bundled Developer preset, combining assigned author and
reviewer roles; the author retains fixes and operational policy stays in notes.
Leadership and five developers use medium; the three Sol developers and Argon
use high; exactly one Opus and one Astra developer use max, with Sol/high
support seats unchanged. This explicit user
choice overrides general placement defaults for these named seats. Seat cost
64 plus spare20 totals84, fitting16nodes/fourlevels within existing limits.
[decided: user 2026-10-21 19:40:55Z, updated 19:52:37Z; verified: heavy-dev-shop.json]
See
[templates](../skills/orgtree-app/org-settings/org-templates/SKILL.md).
[decided: user 2026-10-21 18:40–18:45Z; verified: domain/templates.rs,
domain/template_notes.rs, http/templates.rs, http/orgops.rs]

## Charter preset content and Liaison (2026-10-21)

The hire form joins each selected preset's full content before manual text;
headings, introductory paragraphs and separators remain in the agent charter.
Keep all preset prose suitable for that agent; do not add manual-copy setup
instructions or silently strip content at a separator. The six bundled roles
include Liaison, inserted above an existing coordinator for large orgs. It owns
user conversation and decision records; its single coordinator report owns
execution and staffing. User-local copies shadow bundled files and Populate
preserves them, so source updates do not rewrite those copies or live charters.
See [charters](../skills/orgtree-working/team/charters/SKILL.md).
[decided: user 2026-10-21 18:33:44Z and 18:36:18Z; verified:
engine/rs/orgtree-engine/src/http/settings.rs BUNDLED/charters/charters_populate,
apps/desktop/renderer/src/canvas/cards.tsx finalCharter]

## Plain mention guidance (2026-10-20)

All standing-instruction variants show @name and @item:<org>/<slug> as plain
text and explicitly forbid backticks/code spans. The user-mention passage
explains that @user in replies, mail, presented documents or docket updates
notifies the user; requests needing an answer still use mail or a question.
This replaces the old backticked, reply-only examples on both skill-enabled
and legacy lanes. The existing capability gates and notification preferences
are unchanged. Exact prompt fixtures and the old legacy fingerprints (with
only these replacements normalized) guard the change. See
[instruction wording and measurements](../skills/INSTRUCTIONS-TRIM.md#15-plain-mention-guidance-2026-10-20).
[decided: user 2026-10-20 21:43:54Z, 21:44:36Z; verified:
`engine/rs/orgtree-engine/src/runtime/identity.rs`,
`engine/rs/orgtree-engine/src/runtime/identity/compression_tests.rs`]

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

<a id="e-de4e633eb38398d7"></a>

## Skill-enabled standing instructions use the user-approved 26 wording cuts;

Original section: Unsectioned integration notes. Source lines 12–18.

<!-- preserved:e-de4e633eb38398d7 -->
- Skill-enabled standing instructions use the user-approved 26 wording cuts;
  full/no-skills prompts remain byte-identical, with lane/tool scoping intact.
  Credit requests define TOTAL grant in their card. Description budgets remain
  900 UTF-8 bytes per card and 12,000 combined (Guide included, schemas excluded).
  See [instruction compression](../../docs/skills/INSTRUCTIONS-TRIM.md#14-approved-wording-compression-2026-10-20).
  [decided: user 2026-10-20 20:03Z; verified: `runtime/identity.rs`,
  `runtime/identity/compression_tests.rs`, `tools/defs.rs`]
<!-- /preserved:e-de4e633eb38398d7 -->

<a id="e-fffd11379d05a58b"></a>

## Every instruction lane, full and trimmed, always names the concurrency

Original section: Unsectioned integration notes. Source lines 104–108.

<!-- preserved:e-fffd11379d05a58b -->
- Every instruction lane, full and trimmed, always names the concurrency
  recipes and exact glossary breadcrumb, independent of project ancestry and
  tool switches. Its byte-budget allowance is exactly the new sentence plus
  newline; do not cut other rules. See [instruction template](../../docs/skills/INSTRUCTIONS-TRIM.md).
  [decided: user 2026-10-20 10:51Z; verified: `runtime/identity.rs`]
<!-- /preserved:e-fffd11379d05a58b -->

<a id="e-e3f3b62e2d64e16c"></a>

## The project desk glossary reference owns its tabs, queue/event/slot history

Original section: Unsectioned integration notes. Source lines 133–136.

<!-- preserved:e-e3f3b62e2d64e16c -->
- The project desk glossary reference owns its tabs, queue/event/slot history
  and navigation memory; keep screen/settings coverage in `docs/skills/tree.json`
  aligned with source when these change. See [project desk](../../docs/skills/orgtree-app/desk/project-desk/SKILL.md).
  [verified: `canvas/{projectdesk,maillisteners,slotsdesk,listenersdesk,deaddesk,desktabs}.ts*`; 2026-10-20]
<!-- /preserved:e-e3f3b62e2d64e16c -->

<a id="e-5108a0a027766e46"></a>

## The harness parity reference inventories all five

Original section: Unsectioned integration notes. Source lines 138–143.

<!-- preserved:e-5108a0a027766e46 -->
- The [harness parity reference](../../docs/harness-parity.md) inventories all five
  adapters and custom-provider routes, with source anchors and explicit unknowns.
  Keep its glossary summary current when adapters change; distinguish native
  message steering from effort controls, account quota from turn tokens, and
  cache receipts from provider-expiry promises. [verified: `src/harnesses.rs`,
  `src/runtime/{actor,claude,codex,agy,muse,opencode}.rs`; 2026-10-20]
<!-- /preserved:e-5108a0a027766e46 -->

<a id="e-edc771538215dbc9"></a>

## AGENTS.md — working on Orgtree

Original section: AGENTS.md — working on Orgtree. Source lines 271–271.

<!-- preserved:e-edc771538215dbc9 -->
### AGENTS.md — working on Orgtree
<!-- /preserved:e-edc771538215dbc9 -->

<a id="e-dda3355b4c2b9e64"></a>

## Outside input names its rule, never repeats it: the standing EXTERNAL MAIL

Original section: AGENTS.md — working on Orgtree. Source lines 439–447.

<!-- preserved:e-dda3355b4c2b9e64 -->
- Outside input names its rule, never repeats it: the standing EXTERNAL MAIL
  AUTHORITY passage (`runtime/identity.rs` `EXTERNAL_AUTHORITY`) holds the rule for
  @net:/@org: mail and for mqtt/websocket fires, and each message carries only a
  short tag: `(outside party · see EXTERNAL)` in external mail's FROM line
  (`runtime/envelope.rs` `relationship`, sender address kept, no bare "untrusted"
  because the user's authorized phone writes from @net: too) and
  `(untrusted · see EXTERNAL)` on fires and `list` (`mqtt/render.rs` `TAG`). A new
  kind of outside input gets a tag, not a warning sentence. [decided: user
  2026-10-20 09:20Z-09:21Z, coordinator 09:35Z; verified: those files]
<!-- /preserved:e-dda3355b4c2b9e64 -->

<a id="e-c26ee15685faa383"></a>

## Folder context-menu parents open directly on click/Enter; hover/Right shows

Original section: AGENTS.md — working on Orgtree. Source lines 557–564.

<!-- preserved:e-c26ee15685faa383 -->
- Folder context-menu parents open directly on click/Enter; hover/Right shows
  Edit AGENTS.md, without an Open folder child. Agent Scratch folder nests its
  own Edit plus Team scratch folder/Edit; project Team scratch folder and org
  Shared scratch folder use their scoped roots. Edit creates an empty missing
  note exclusively, preserving existing contents and refusing linked notes or
  junction/symlink root paths. Switchboard Open click focuses the switchboard.
  [decided: user/coordinator 2026-10-19 18:34–18:39Z; verified:
  `canvas/{cards,contextmenu,agentmenu}.tsx`, `main/scratch-folder.ts`]
<!-- /preserved:e-c26ee15685faa383 -->

<a id="e-e4cf84ea4eaf76c2"></a>

## Runtime's default-on "Suggest agents to give feedback to Orgtree" persists

Original section: AGENTS.md — working on Orgtree. Source lines 610–616.

<!-- preserved:e-e4cf84ea4eaf76c2 -->
- Runtime's default-on "Suggest agents to give feedback to Orgtree" persists
  "suggest_agent_feedback_enabled" app-wide. It adds a short conditional
  pointer on every instruction lane; saves reconfigure for the next turn.
  Agents verify usable GitHub access, redact evidence and show the full draft
  to the user, waiting for explicit OK before any issue/comment submission.
  The canonical procedure is [feedback](../../docs/skills/orgtree-working/workspace/feedback/SKILL.md).
  [decided: user 2026-10-19 13:59Z/14:00Z; verified: "settings.rs", "runtime/{identity,actor}.rs", "http/settings.rs", "canvas/accounts.tsx"]
<!-- /preserved:e-e4cf84ea4eaf76c2 -->

<a id="e-b4d8622ab4805ea5"></a>

## Agent replies, mail, docket descriptions and presentations must name agents,

Original section: AGENTS.md — working on Orgtree. Source lines 1313–1317.

<!-- preserved:e-b4d8622ab4805ea5 -->
- Agent replies, mail, docket descriptions and presentations must name agents,
  projects and docket items as mentions, outside code spans. The unconditional
  MENTIONS paragraph reaches full/trimmed profiles even without messaging tools;
  @user keeps its attention-only meaning. See `orgtree-mail-basics` in the
  working glossary. [decided: user 2026-10-18 11:03Z; verified: `runtime/identity.rs`]
<!-- /preserved:e-b4d8622ab4805ea5 -->

<a id="e-a9d1276c8085a254"></a>

## Tool-card JSON literals stay in separate #[inline(never)] pure builders:

Original section: AGENTS.md — working on Orgtree. Source lines 1428–1434.

<!-- preserved:e-a9d1276c8085a254 -->
- Tool-card JSON literals stay in separate `#[inline(never)]` pure builders:
  a monolithic debug `defs::all()` frame overflows during default-stack actor
  admission. Keep the outer logging boundary and serialized tool order/contracts;
  the captured c89111b byte fixture guards them. Verify actual default-stack
  fake-CLI admission rather than increasing stack sizes. See
  [tool-card stack safety](../../docs/rust-engine/tool-cards.md#stack-safety).
  [verified: `tools/defs.rs`, `main.rs`; 2026-10-17]
<!-- /preserved:e-a9d1276c8085a254 -->

<a id="e-042b9842a466de52"></a>

## Shared/team scratch initialization creates a header-only AGENTS.md if missing,

Original section: AGENTS.md — working on Orgtree. Source lines 1477–1483.

<!-- preserved:e-042b9842a466de52 -->
- Shared/team scratch initialization creates a header-only `AGENTS.md` if missing,
  using checked managed components and exclusive creation; existing files, even
  empty ones, are untouched. Org opening backfills shared notes, launch snapshots
  initialize held team/project folders before reading notes, and folder serving
  retries on first use. Agent fallback creation stays limited to writable scope.
  [decided: user 2026-10-17 17:26Z; verified: `shared_notes.rs`, `orgs.rs`,
  `runtime/{actor,identity}.rs`, `http/nodes.rs`]
<!-- /preserved:e-042b9842a466de52 -->

<a id="e-9b47067026684df6"></a>

## Orgtree tool cards keep call contracts and glossary pointers; procedures live

Original section: AGENTS.md — working on Orgtree. Source lines 1634–1640.

<!-- preserved:e-9b47067026684df6 -->
- Orgtree tool cards keep call contracts and glossary pointers; procedures live
  in the named guides. Input schemas and mail shapes are unchanged. Twenty-three
  rare cards permit native Claude search, 22 common cards stay eager; the SDK
  server must not override that policy. Scope denial still omits groups. Native
  deferral and provider-token savings require client evidence, not metadata alone.
  See [tool cards](../../docs/rust-engine/tool-cards.md). [decided: user/coordinator
  2026-10-17; verified: `tools/defs.rs`, `runtime/actor.rs`]
<!-- /preserved:e-9b47067026684df6 -->

<a id="e-9293631594e170c6"></a>

## Claude shared-skill exports account for native discovery: exact launch-profile

Original section: AGENTS.md — working on Orgtree. Source lines 1656–1662.

<!-- preserved:e-9293631594e170c6 -->
- Claude shared-skill exports account for native discovery: exact launch-profile
  org metadata selects the personal synced bucket; enabled installed plugins
  use that profile's settings plus cwd overrides. Identical native bundles omit
  the bare export, while unknown/disabled sources retain fallback and distinct
  resources stay distinct. Claude omits the three Codex-only skill families.
  Launch, idle and forecast share this selection. See [shared skills](../../docs/rust-engine/shared-skills.md).
  [decided: coordinator/user 2026-10-17; verified: `providers/skills/native.rs`, `runtime/actor.rs`]
<!-- /preserved:e-9293631594e170c6 -->

<a id="e-a90addc142370734"></a>

## The built-in Orgtree skill library is also called the glossary or Orgtree

Original section: AGENTS.md — working on Orgtree. Source lines 1911–1917.

<!-- preserved:e-a90addc142370734 -->
- The built-in Orgtree skill library is also called the glossary or Orgtree
  Encyclopaedia (encyclopedia). These are equivalent terms; keep the library
  name and `orgtree-working`/`orgtree-app` category IDs; `orgtree-workflows`
  adds suggested workflows (user 2026-10-17). Root descriptions,
  the tree manifest, agent introduction and Refresh tooltip carry the aliases.
  [decided: user 2026-10-16; verified: `runtime/identity.rs`, `docs/skills/tree.json`,
  `canvas/modals.tsx`]
<!-- /preserved:e-a90addc142370734 -->

<a id="e-436fe9ad6937adc4"></a>

## : Antigravity identity is delivered as bounded, numbered always-on rules,

Original section: AGENTS.md — working on Orgtree. Source lines 2006–2016.

<!-- preserved:e-436fe9ad6937adc4 -->
- 2026-10-15: Antigravity identity is delivered as bounded, numbered always-on rules,
  never by writing scratch AGENTS.md. Own AGENTS.md is native and excluded from the
  identity mirror. Exact legacy generated envelopes move to unique byte-preserving
  backups at process replacement; other notes stay untouched. Interior edits in an
  envelope are recoverable from backup, not automatically active. See
  [AGY standing notes](../../docs/agy-standing-notes.md) for the approved migration and
  native budget limits. Identity output and migration canonicalize the trusted
  scratch parent (allowing macOS system aliases), then reject links/reparse points
  at scratch itself and below before writes or stale-part removal. Migration
  skips native AGENTS.md leaf symlinks untouched. [verified: `runtime/agy.rs`, `runtime/startup.rs`;
  decided: coordinator 2026-10-15]
<!-- /preserved:e-436fe9ad6937adc4 -->

<a id="e-a5feebda07d69b40"></a>

## : identity_parts returns (engine rules, standing notes). On Antigravity

Original section: AGENTS.md — working on Orgtree. Source lines 2018–2031.

<!-- preserved:e-a5feebda07d69b40 -->
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
<!-- /preserved:e-a5feebda07d69b40 -->

<a id="e-c6e34437fd5bca3d"></a>

## Personal global instruction files are shared read-only across harnesses, with

Original section: AGENTS.md — working on Orgtree. Source lines 2175–2184.

<!-- preserved:e-c6e34437fd5bca3d -->
- Personal global instruction files are shared read-only across harnesses, with
  canonical dedup against the CLI's actual account/profile native files. Use
  `startup::snapshot` for launch text and digest together; edits belong to the
  existing `startup` boundary, never a running turn. Refresh returns counts only
  and fails explicitly for unreadable sources. Rig discovery stays inside
  `rig-home`. Muse foreign-rule fallback is disabled only for Orgtree launches;
  its own rules and separate skills setting stay native. Preserve the skills
  digest in plan, idle checks and forecast during composition. [decided: user
  2026-10-15 10:21Z; verified: `runtime/global_instructions.rs`, `startup.rs`,
  `actor.rs`; [sources and limits](../../docs/rust-engine/global-instructions.md)]
<!-- /preserved:e-c6e34437fd5bca3d -->

<a id="e-6bf546fa0515155b"></a>

## Generated prompt text never names a tool the agent's Orgtree tool groups switch

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2832–2839.

<!-- preserved:e-6bf546fa0515155b -->
- Generated prompt text never names a tool the agent's Orgtree tool groups switch
  off (since `aa2d7db`). Text inside one group's branch of `identity.rs` that names
  another group's tool also needs that group on: `2f8ebae`'s team sentence named the
  inspection tool `orgtree_state_inspect` until 2026-10-13. Charters, org.md and
  folder notes stay verbatim. `group_tests::prompt_follows_every_combination_of_group_switches`
  covers all 128 combinations, so a failure there is a prompt bug. Tool descriptions
  (`tools/defs.rs`) are not group-scoped. [verified: `runtime/identity.rs`,
  `domain/tool_groups.rs`, 2026-10-13]
<!-- /preserved:e-6bf546fa0515155b -->

<a id="e-db4eec525c8a1035"></a>

## Every org has ONE shared AGENTS.md, &lt;data&gt;\scratch\&lt;slug&gt;\_shared\AGENTS.md. Every

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2884–2902.

<!-- preserved:e-db4eec525c8a1035 -->
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
  same digest. See [team workspaces](../../docs/rust-engine/team-workspaces.md). [user 2026-10-14] The prompt carries a rule sentence
  and, last, the file's text (12,000-char cap). The copy is read when a CLI starts: another
  agent's edit never respawns a warm CLI. The fingerprint keeps the copy's digest outside
  `system_prompt` and equality, and the forecast counts `org_notes` only when a CLI would
  start, so refresh the forecast wherever an idle CLI closes. The cache keeper reads the warm
  CLI's copy (`proc_notes`), not the file. Antigravity reaches it by path like every grant.
  See [the org's shared AGENTS.md](../../docs/rust-engine/org-shared-notes.md).
  [decided: user 2026-10-13 18:10-18:12Z, coordinator 18:19Z (session-start copy);
  verified: `runtime/actor.rs`, `runtime/identity.rs`, `domain/scope.rs`, 2026-10-13]
<!-- /preserved:e-db4eec525c8a1035 -->

<a id="e-696c902e76e39caa"></a>

## MCP imports from installed harnesses (2026-10-15)

Original section: MCP imports from installed harnesses (2026-10-15). Source lines 5150–5150.

<!-- preserved:e-696c902e76e39caa -->
##### MCP imports from installed harnesses (2026-10-15)
<!-- /preserved:e-696c902e76e39caa -->

<a id="e-87e9373ea83fb86f"></a>

## Shared skills and installed plugin imports (2026-10-15)

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5161–5161.

<!-- preserved:e-87e9373ea83fb86f -->
##### Shared skills and installed plugin imports (2026-10-15)
<!-- /preserved:e-87e9373ea83fb86f -->

<a id="e-9f84bd4d9bf2d9a3"></a>

## Per-harness skill variants are selected only for each agent's export, preserving

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5173–5179.

<!-- preserved:e-9f84bd4d9bf2d9a3 -->
- Per-harness skill variants are selected only for each agent's export, preserving
  the complete inventory and user source files. Declared harness suffixes and
  native provenance choose the preferred family member; unpaired guides and
  equally preferred same-source resource collisions remain available. Launch,
  idle checks and forecasts share the selected digest. See
  [variant selection](../../docs/rust-engine/shared-skills.md#per-harness-variants-2026-10-17).
  [decided: user 2026-10-17; verified: `providers/skills.rs`, `runtime/actor.rs`]
<!-- /preserved:e-9f84bd4d9bf2d9a3 -->

<a id="e-c90bd5ba966d4f59"></a>

## Skill discovery reads installed native roots and recorded Claude plugin installs,

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5181–5191.

<!-- preserved:e-c90bd5ba966d4f59 -->
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
<!-- /preserved:e-c90bd5ba966d4f59 -->

<a id="e-535f71202df6c4ee"></a>

## Shared skill export validation covers every existing output ancestor and cached

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5198–5201.

<!-- preserved:e-535f71202df6c4ee -->
- Shared skill export validation covers every existing output ancestor and cached
  resource tree, including Windows junctions/reparse points; marker files never
  authorize following links. See shared-skills.md export guard.
  [verified from source: providers/skills.rs; rig review finding 2026-10-15]
<!-- /preserved:e-535f71202df6c4ee -->

## inbox reader diagnostic boundary (2026-10-21)

Private inbox reader bodies use the HTTP quiet-body guard before auth/extraction,
with exact family matching. Body-returning handlers/projections are nolog so
verbose function instrumentation cannot bypass the wire boundary. Client JSON
and path/status metadata are unchanged.
[verified: http/mod.rs; feed/compute.rs;
real-engine proof private-read-wire-privacy.mjs in both logging modes]

## mail reader diagnostic boundary (2026-10-21)

Private mail reader bodies use the HTTP quiet-body guard before auth/extraction,
with exact family matching. Body-returning handlers/projections are nolog so
verbose function instrumentation cannot bypass the wire boundary. Client JSON
and path/status metadata are unchanged.
[verified: http/mod.rs; http/mailbox.rs;
real-engine proof private-read-wire-privacy.mjs in both logging modes]

## document reader diagnostic boundary (2026-10-21)

Private document reader bodies use the HTTP quiet-body guard before auth/extraction,
with exact family matching. Body-returning handlers/projections are nolog so
verbose function instrumentation cannot bypass the wire boundary. Client JSON
and path/status metadata are unchanged.
[verified: http/mod.rs; http/docs.rs;
real-engine proof private-read-wire-privacy.mjs in both logging modes]

## Private notification projection logging (2026-10-22)

Quiet HTTP bodies do not protect a background producer. Notification event
classification accepts private event prose; per-org notice and app-feed
projections return private previews. Those three pure helpers, the feed-window
replacement and the app snapshot handler are nolog.
Retain metadata-only frame counts and normal client data. The reader proof
forces a fresh notification projection and observes its client value before
asserting the engine log contains no old private-mail canary.
[verified: domain/notices.rs::mail_kind/for_org, appfeed.rs::read_org,
feed/mod.rs::Actor::replace_window, http/orgs.rs::app_records;
real-engine synthetic regression private-read-wire-privacy.mjs]

## Node inbox diagnostic boundary (2026-10-22)

Node mailbox live/history bodies use the outer quiet-body family guard before
authentication and extraction; numeric ids and names have the same boundary.
The agent_mailbox projection is nolog because it returns private rows.
Client content and path/status metadata remain unchanged.
[verified: http/mod.rs, feed/compute.rs::agent_mailbox;
real-engine synthetic regression remaining-inbox-wire-privacy.mjs]

## Org inbox diagnostic boundary (2026-10-22)

Retained outside correspondence uses the outer org_inbox quiet-body family,
including rejected child routes. The list handler is nolog; its pure entry
projection is already uninstrumented. The reader retains full entries/counts
and wire logs retain route/status metadata.
[verified: http/mod.rs, http/orginbox.rs::list, domain/orginbox.rs::entry;
real-engine synthetic regression remaining-inbox-wire-privacy.mjs]

## Filtered inbox handler logging (2026-10-22)

POST inbox/filter already shares the outer quiet-body family; its handler must
also be nolog because window_many returns complete private mail pages. The
existing tag projection is nolog. Synthetic tag-filtered mail proves unchanged
client body/labels and absent wire/handler canaries in both logging modes.
[verified: http/mailbox.rs::filter_inbox, domain/mail_tags.rs::window_many;
real-engine regression remaining-inbox-wire-privacy.mjs]
