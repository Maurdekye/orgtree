# The built-in Orgtree skill tree

This is the design of the built-in Orgtree skill library: which skills exist, where each
one lives, what it covers, what its ground truth is, and who writes it.
The library is also called the **glossary** or **Orgtree Encyclopaedia**
(also spelled **encyclopedia**). These are equivalent terms; the library and its
registered skill names remain unchanged.
`tree.json` beside this file is the machine-readable manifest of the same tree, and the
coverage guard reads it. The tables at the end of this file are generated from
`tree.json`. If the two ever disagree, `tree.json` is right and this file gets fixed.

Revision **v1.5** moves agent event History to agent settings and removes the desk Files page in 4.4.0 (user 2026-10-17). Revision v1.4 added the two-phase iterative-development workflow; v1.3 added `orgtree-workflows`; v1.2 added the `orgtree-app › harnesses` section; v1.1 added `mcp-servers` and `skills-and-instructions` and fixed earlier tree entries. Everything was enumerated from source at `296deb0` and updated for the 4.4.0 agent-desk change.
(rust-engine local tip): tools from `engine/rs/orgtree-engine/src/tools/defs.rs`
`implemented()`, screens from `apps/desktop/renderer/src` and `apps/desktop/main`, and
settings from the App settings, Org settings and Agent settings sources. The release
reconciliation checks that inventory and the current behavior against integrated
source `de6d356`, including Muse retained usage, personal globals and shared skills.

| | Count |
|---|---|
| Categories (level 1, registered) | 3 |
| Sections (level 2) | 19 |
| Leaves (level 3) | 173: 45 tool, 51 concept, 33 screen, 44 setting |
| SKILL.md files in total | 195 |
| Bytes of registered `name` + `description` lines | 548 |

## 1. Shape and conventions

- **Three levels.** A category (level 1) holds sections (level 2), and a section holds
  leaves (level 3). There is no level 4. Every node is its own folder with one `SKILL.md`:
  `docs/skills/<category>/<section>/<leaf>/SKILL.md`.
- **Only the three categories are registered** for automatic discovery:
  - `orgtree-working`: how to work inside an org, meaning every orgtree_* tool and every
    rule and workflow.
  - `orgtree-app`: the desktop app, meaning every screen, every setting, providers,
    accounts and the mail hub.
  - `orgtree-workflows`: suggested team patterns, including committee decisions and the
    development-team system used by the bundled templates.

  The split is by question. "How do I do X as an agent?" goes to working. "What is this
  screen or setting, and what should the user change?" goes to app. "How should we
  organise this team or decision?" goes to workflows.
- **Folder names.** A category folder is named after the skill (`orgtree-working`).
  Section and leaf folders use short kebab-case slugs that are unique across the whole
  tree (`team`, `tool-hire`). The `name` of a section or leaf skill is `orgtree-<slug>`.
  The engine cuts names at 45 characters, and every name here fits.
- **Frontmatter** holds `name` and `description` only. The engine silently drops a
  bundle with no column-0 `description:` line. A description is one sentence saying
  what the page answers. Section and leaf descriptions are never registered; agents only
  see them through the parent's child list.
- **The first body line points to the parent:** `Up: [orgtree-team](../SKILL.md)`.
  Category pages have no Up line.
- **Links** follow the delivery rules in `docs/rust-engine/shared-skills.md` on the
  `agy-astra/skills-share` branch:
  - Links within a category are bundle-relative (`../tool-message/SKILL.md`).
  - A category's entry `SKILL.md` links only downward (`team/SKILL.md`), never with
    `../`, and has no `](...)` inside code spans.
  - **Cross-category references are never links.** Write them as
    ``see `orgtree-tool-usage` (orgtree-working › accounts)``: the skill name plus its
    breadcrumb.
- **One home per fact.** Each fact is written in exactly one leaf; every other page
  links to that leaf. Parents hold orientation only: what the section is for, its child
  list, and the see-also rules. `covers` keys in `tree.json` are unique across the tree,
  and the generator checks this.
- **Ground truth.** Each node lists its source files in `sources` (file:line at
  `296deb0`). Writers read those files, not memory and not older docs. A page states
  current behavior only. When a writer finds that the source disagrees with a doc, the
  page follows the source and the writer notes the disagreement in their
  suggestion-box.
- **The hidden switch at the bottom of the Developer tab has no node, heading,
  description, child-list line or cover key, and its name appears nowhere in this file
  or in `tree.json`.** It is mentioned exactly once, as an offhand, secret-feeling note
  inside the `app-developer` leaf. The generator rejects its name anywhere in
  `tree.json`. (Ruling recorded in the docket item.)

## 2. Navigation: any fact in at most 3 hops

1. **Hop 1, the category page.** The agent picks a category from the three registered
   descriptions. The category page has:
   - a table of its sections, one line each;
   - a short question index ("I need to wait for a build" → `watchdogs`, "the user asks
     what a badge means" → `canvas`) with about 15 to 25 entries, each pointing to a
     section;
   - the cross-category rule: tools and operating rules are in working, screens and
     settings in app, suggested team workflows in workflows.
2. **Hop 2, the section page.** It lists every child, one line each, grouped as
   "Workflows and rules" (concept leaves) first, then "Tools", "Screens" or "Settings".
   Each line is `[orgtree-<slug>](<slug>/SKILL.md): <purpose>`, using the purpose from
   `tree.json`.
3. **Hop 3, the leaf.** It has the facts. It ends with a **See also** list built from
   `see_also` in `tree.json`. Targets in the same category are links; targets in the
   other category are written as name plus breadcrumb.

**See-also rules** (the generator fills these lists in; writers may add to them but not
remove from them):
- Every tool leaf links to the workflow leaves in its own section. Every workflow leaf
  links to the tools it uses.
- A setting leaf links to the screen or workflow it changes, and the reverse holds too.
  For example, `app-turn-limits` ↔ `turns-and-wakes`, and `org-policies-inbox` ↔
  `org-inbox`.
- A screen leaf links to the tool that does the same thing from an agent's side. For
  example, `draft-hires` ↔ `tool-hire`, and `docket-screens` ↔ `tool-work`.
- When a page needs a fact whose home is elsewhere, it writes one clause and links to
  that home. It never restates the fact.

## 3. Placement rulings

- **Suggested workflows** are a third top-level category, `orgtree-workflows` (user
  2026-10-17 11:29Z), replacing the initial proposal for a section under working.
  `collaboration-patterns` holds the committee and dev-team leaves; tool mechanics
  and template UI keep their existing homes. The publication request supersedes
  the committee procedure's earlier org-notes-only restriction.

These rulings explain choices a reader might otherwise question.

- **Tool leaves sit by topic, not by tool group.** Three tools sit outside the section
  their group suggests, and each of their leaves names its group:
  - `orgtree_cheap_compact` (group `team`) is in `runtime`, beside the other session
    lifecycle tools.
  - `orgtree_continue_on` and `orgtree_account_mark` (group `runtime`) are in
    `accounts`.
  - `orgtree_list_tiers` (group `inspection`) is in `team`, and `orgtree_list_orgs`
    (group `inspection`) is in `mail`.
- **Desk tabs that have their own modal** (Inbox, Docket, Presented) are covered by that
  modal's leaf (`inbox-screens`, `docket-screens`, `presentations`), so each surface has
  one home. `agent-desk` lists the tabs and links to them.
- **Settings dialogs that are really screens**, such as Add account, Clear account mark,
  and the OpenRouter and language-server dialogs, belong to the setting leaf that opens
  them.
- **These get no leaf:**
  - `ConnectionsPanel` (`canvas/connections.tsx:23`) and `AccountUsagePanel`
    (`accountusage.tsx:36`), because nothing mounts them;
  - the Lineage panel (`desk.tsx:4390`), which is never mounted;
  - the `orgtype` Org settings tab, which is in the tab union but never rendered.

  They are on the coverage guard's exempt list.
- **Developer practice concepts** (`worktrees-and-git`, `builds-under-the-lock`,
  `reviews-and-landing`, `suggestion-box`) are in `orgtree-working › workspace`.
  Org agents doing software work need them. They are written as practices, with their
  ground truth in `AGENTS.md` and `docs/`, not as engine features.
- **`orgtree-engine-start-mode` is gone** (4.3.1, decision 84). The "engine starts" choice it
  explained was removed (docket `option-to-run-the-background-engine-in-the-user-s`, the user
  2026-10-16): the engine always starts at boot and agents move into the signed-in session.
  `app-runtime-desktop` now explains "Run on boot", and `halts-and-restarts`
  (orgtree-working › runtime) what agents see when they move. Ground truth:
  `docs/rust-engine/run-on-boot.md`.
- **Harnesses have their own section** (`orgtree-app › harnesses`, user request 2026-10-15
  12:41Z). It holds one page per harness the engine runs (`runtime/`: Claude Code, Codex,
  Antigravity, Muse, OpenCode over ACP). OpenRouter and local language servers are not
  harnesses: they are routes that run through Claude Code, Codex or OpenCode (`harnesses.rs`), so `route-openrouter` and
  `route-local-server` state only how they differ from the underlying harness page.
  `harness-comparison` is a side-by-side table whose cells summarize and link; every fact
  lives on a harness page. Setup stays in `providers` (`openrouter`, `language-servers`,
  `providers-tab`, `accounts-registry`). The delivery contract shared by all harnesses
  stays in `skills-and-instructions`, and harness pages link to it rather than repeat it.
- **Settings scope.** `app-*` leaves are app-wide (one machine), `org-*` leaves are per
  organization, and `agent-*` leaves are per agent. Each leaf states the storage behind
  each setting, using the prefixes in `covers`:

  | Prefix | Storage |
  |---|---|
  | `np:` | native preference |
  | `ls:` | renderer localStorage |
  | `rt:` | `/api/app-settings/runtime` |
  | `org:` | org settings |
  | `defaults:` | default org settings |
  | `node:` | agent scope op |
  | `hub:` | `/api/desktop/hub` |
  | `api:` | provider/account endpoint |
  | `bridge:` | desktop bridge call |

  Known traps the leaves must state, all measured by skills-docs-sol:
  - `default_top_grant` is 20 in the engine default but the UI fallback is 50.
  - `default_visibility` is subtree in the engine default but the UI fallback is full.
  - The reminder defaults come from the loaded payload.

## 4. Writer split

Folders are disjoint: each section has exactly one writer, and the writer owns every
leaf in it.

| Writer | Sections | Leaves |
|---|---|---|
| org-sol | working › team, working › docket, app › canvas | 33 |
| comms-sol | working › mail, working › user, working › workspace, app › mailhub | 28 |
| runtime-sol | working › runtime, working › watchdogs, working › inspection, app › app-shell | 33 |
| providers-sol | working › accounts, app › providers, app › harnesses, app › desk | 33 |
| skills-docs-sol | app › app-settings; plus the coverage guard, category pages and final source review | 13 |
| orgsettings-sol | app › org-settings | 13 |
| agentsettings-sol | app › agent-settings | 9 |
| hubchat-dm-sol | working › team, `tool-org-logo` (4.3.1) | 1 |
| rig-opus | working › runtime, `tool-session` (4.3.1) | 1 |
| machine-traps-sol | working › workspace, `machine-traps` (4.3.2) | 1 |
| skilltree-opus | workflows › collaboration-patterns | 2 |
| session0-docs-luna | working › runtime, `session-0-ui-testing` | 1 |

- **Section pages** (`<section>/SKILL.md`) are written by the section's writer, using
  the child order and purposes in `tree.json`.
- **The category pages** are written by skills-docs-sol, using the descriptions
  fixed below.
- **Order of work:** tool leaves first (fixed in v0), then concept leaves, then screens
  and settings.

## 5. The registered descriptions (fixed)

```
name: orgtree-working
description: Orgtree skill library (glossary; Orgtree Encyclopaedia or encyclopedia): tools and workflows for teams, mail, the docket, turns, watchdogs, accounts and folders.

name: orgtree-app
description: Orgtree skill library (glossary; Orgtree Encyclopaedia or encyclopedia): desktop screens and settings, providers, harnesses, accounts and the mail hub.

name: orgtree-workflows
description: Orgtree skill library (glossary; Orgtree Encyclopaedia or encyclopedia): suggested workflows for committees and development teams.
```

Measured size: 442 UTF-8 description-value bytes; 548 bytes for registered
`name` and `description` lines together (below the 600-byte coverage-guard cap).

## 6. Coverage guard

The guard is a Node test, `tests/skills-tree-coverage.test.mjs`. skills-docs-sol
implements it. It reads `docs/skills/tree.json` and the source, uses no network and no
build, and runs in under a second. It fails, naming each offender, in these cases:

1. **Tools.** A name in `implemented()` in `engine/rs/orgtree-engine/src/tools/defs.rs`
   (parsed as the quoted `orgtree_*` names between `fn implemented` and its closing
   bracket) is not the `covers` of exactly one `kind: "tool"` node. It also fails when a
   tool node covers a name that is no longer in `implemented()`.
2. **Screens.** An exported React component under `apps/desktop/renderer/src` whose
   name ends in `Panel`, `Modal`, `Dialog`, `View`, `Page`, `Sheet`, `Desk`, `Menu` or
   `Picker` meets none of these conditions:
   - one node lists it in its `components` field (a `file#Component` list that
     skills-docs-sol adds to screen and setting nodes when implementing the guard);
   - it is in `tree.json` `exempt.components`, with a reason;
   - it lives in the hidden switch's own renderer folder, which the guard skips
     silently. skilltree-opus gives the implementer that path by mail; it is not
     written here.

   The guard also fails when a listed component no longer exists.
3. **Settings.** A literal label of a settings row (`SetRow`, `SetToggle` or `SetBlock`
   `label=`/title text, as in `_teams/601/skills-docs/settings-source-labels.json`) in
   the settings sources (`canvas/accounts.tsx`, `App.tsx` SettingsPanel,
   `canvas/modals.tsx` NodeConfig and HireDefaultsTab, `shell/defaults.tsx`, and the
   subcontrol files) is neither in some node's `ui_labels` nor in `exempt.labels`. It
   also fails when a `covers` key with a storage prefix no longer appears in the
   source.
4. **Structure.** It also fails when any of these does not hold:
   - Every node with status `fixed` or `written` whose folder exists has `SKILL.md` with
     frontmatter `name` equal to the node's name and a column-0 `description:` line.
   - Every section and leaf starts with the Up line.
   - Every parent page links every child in `children`.
   - Slugs are unique, and names are at most 45 characters.
   - Category entry files have no `../` links and no cross-category relative links.
   - No `SKILL.md` exists outside the tree, except folders listed in `current_path`.
   - Every `see_also` target exists.
   - The hidden switch's name (whole word, any case) appears only in `app-developer`
     and nowhere else under `docs/skills/`.
   - The registered description bytes are at most 600.

Until leaves exist, the guard checks parts 1 to 3 against `tree.json` alone. This lets
it land before the content.

## 7. `tree.json` schema (schema 1)

```
{ schema: 1, source_commit, registered_description_bytes,
  counts: {categories, sections, leaves, tools, total}, leaves_per_writer: {writer: n},
  exempt: {components: [{id, reason}], labels: [{label, file, reason}]},   // added by the guard
  nodes: [ {
    path,          // "<category>/<section>/<leaf>" relative to docs/skills
    name,          // skill name: category name, or "orgtree-<slug>"
    level,         // 1 | 2 | 3
    kind,          // category | section | tool | concept | screen | setting
    registered,    // true only for the three categories
    description?,  // categories only (the fixed registered text)
    purpose,       // the one line the parent's child list shows
    children?,     // level 1-2: slugs in display order
    covers?,       // level 3: unique keys - orgtree_* tool names, screen:<id>, harness:<id>,
                   //   or storage-prefixed setting keys (np:/ls:/rt:/org:/defaults:/node:/hub:/api:/bridge:)
    tool_group?,   // tool leaves: group from tool_groups.rs required()
    must_cover?,   // the minimum the page must answer
    sources?,      // ground-truth files (file:line at source_commit)
    see_also?,     // slugs; filled by the rules in section 2
    components?, ui_labels?,   // added by the guard implementer
    writer, status,            // fixed | written | exists-standalone:move-at-tree-release
    current_path?  // where the node lives today if different from path
  } ] }
```

## 8. Generated node tables

Columns: leaf slug (skill name is `orgtree-<slug>`), kind, what it covers, purpose, ground truth.

### Category `orgtree-working` — `docs/skills/orgtree-working/SKILL.md`

Agent-work entry point to the skill library, also called the glossary or Orgtree Encyclopaedia (encyclopedia): find the tool or workflow page you need.

#### Section `team` — `orgtree-working/team/` — writer org-sol

Building and shaping your team: hiring, tiers, credits, charters, scope, and every team tool.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `tool-hire` | tool | `orgtree_hire` | Hire a subordinate or insert a superior: tiers, harnesses, scope, charter, credits. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:460`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("hire")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions, committee-mode, dev-team |
| `tool-rehire` | tool | `orgtree_rehire` | Bring back a retired agent with its context. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:484`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("rehire")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-retire` | tool | `orgtree_retire` | Retire an agent below you; what survives retirement. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:495`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("retire")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-dissolve` | tool | `orgtree_dissolve` | Retire an agent together with its whole team. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:496`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("dissolve")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-retool` | tool | `orgtree_retool` | Change an agent's folders, tools, permission mode or charter. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:498`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("retool")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-switch-model` | tool | `orgtree_switch_model` | Move an agent below you to another tier/model. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:508`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("switch_model")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-move` | tool | `orgtree_move` | Reparent an agent within your subtree. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:514`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("move")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-rename` | tool | `orgtree_rename` | Rename an agent below you. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:521`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("rename")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-reorder` | tool | `orgtree_reorder` | Set a descendant's position among its siblings. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:523`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("reorder")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-reallocate` | tool | `orgtree_reallocate` | Give credits to or take them from a report. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:531`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("reallocate")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-swap` | tool | `orgtree_swap` | Swap the seats of two agents below you. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:732`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("swap")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-self-subjugate` | tool | `orgtree_self_subjugate` | Step down so a descendant takes your seat. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:734`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("self_subjugate")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-list-tiers` | tool | `orgtree_list_tiers` | Model tiers you can hire on and their seat prices. Group `inspection`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:350`<br>`engine/rs/orgtree-engine/src/tools/orgview.rs list_tiers`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | hiring, delegating, team-shape, credits, charters, scope-and-permissions |
| `tool-project` | tool | `orgtree_project` | Create a project node: a free, turn-less node with its own folder, mailbox and presentations. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs orgtree_project`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("create_project")`<br>`engine/rs/orgtree-engine/src/domain/ops.rs create_project` | projects, hiring, credits |
| `hiring` | concept | — | The hiring workflow end to end: choosing a tier and harness, scope, charter, credits, the kickoff message, and draft hires. Must cover: choose tier/harness/model by task difficulty; what a hire costs (seat price) and where the credits come from; scope and charter at hire time, inherited caps; kickoff: what the new agent sees first; rehire before hire: retired agents keep context. | `engine/rs/orgtree-engine/src/runtime/identity.rs TOOLS_SENTENCE, REHIRE, TEAM_SHAPE`<br>`engine/rs/orgtree-engine/src/domain/staffing.rs`<br>`engine/rs/orgtree-engine/src/domain/ops.rs`<br>`docs/rust-engine/parent-hire.md`<br>`docs/rust-engine/hire-token-price.md` | tool-hire, tool-rehire, tool-staff, tool-list-tiers, credits |
| `delegating` | concept | — | Delegating and supervising: one owner per piece, reading reports instead of asking, escalation to the superior. Must cover: chain of command and who you may address; read transcript/scratch before asking; escalate decisions upward; the user is reached only by top-level agents or audience holders; when to keep work vs hand it down; direct-child peer-mail setting and directional audience exception. | `engine/rs/orgtree-engine/src/runtime/identity.rs READ_REPORTS, l.226`<br>`engine/rs/orgtree-engine/src/tools/orgview.rs`<br>`engine/rs/orgtree-engine/src/domain/peer_mail.rs` | reading-reports, chain-and-audiences, reaching-the-user |
| `team-shape` | concept | — | Changing the shape of a team: retire, rehire, dissolve, move, swap, self-subjugate, and what survives each. Must cover: what each operation keeps (context, docket items, scratch); archived agents and rehiring; seat/credit effects; undo from the app. | `engine/rs/orgtree-engine/src/runtime/identity.rs REHIRE, TEAM_SHAPE`<br>`engine/rs/orgtree-engine/src/domain/lifecycle.rs` | tool-retire, tool-rehire, tool-dissolve, tool-move, tool-swap, tool-self-subjugate |
| `credits` | concept | — | Credits: seats, grants, free credits, cascading cost up the chain, and asking for more. Must cover: seat vs grant vs free; credits bound concurrent capacity, not tokens; cost bubbling (cascade_hire, cascade_alloc); reallocate and request_credits. | `engine/rs/orgtree-engine/src/domain/ops.rs`<br>`docs/rust-engine/credit-cascade-boundary.md` | tool-reallocate, tool-request-credits, org-policies-cost |
| `charters` | concept | — | Charters: your own charter, team charters, standing charters from superiors and org.md, and how they are delivered. Must cover: precedence of charter sources; org.md and its trusted notes; how a charter change reaches a running agent; retool to change one. | `engine/rs/orgtree-engine/src/runtime/identity.rs l.88-104, org_charter()` | tool-retool, org-charter-md, agent-charter-tab |
| `scope-and-permissions` | concept | — | What an agent may touch: folders, tool groups, native tools, MCP servers, permission modes and the sensitive-path gate. Must cover: the seven tool groups and which tools each gates; permission modes plan < default < acceptEdits < bypassPermissions; read-only vs writable folders; the sensitive-path gate; caps inherited from the superior; request_scope. | `engine/rs/orgtree-engine/src/domain/tool_groups.rs`<br>`engine/rs/orgtree-engine/src/domain/scope.rs:7`<br>`engine/rs/orgtree-engine/src/runtime/identity.rs GATE_*, scoped_tool_instructions, scope_request_guidance`<br>`docs/rust-engine/tool-groups.md`<br>`docs/rust-engine/approved-folder-grants.md` | tool-request-scope, tool-retool, visibility |
| `projects` | concept | — | Project nodes: free tree nodes that run no turns, with a folder, a mailbox shared through the fair queue, and presentations. Must cover: who reaches a project (above and below only); reporting and transparent credits through a project; the project folder and its AGENTS.md; the mailbox, the fair_queue watchdog and inspection without claiming; presentations under a project; direct-child peer-mail setting and directional audience exception. | `docs/rust-engine/PROJECT-NODES.md`<br>`engine/rs/orgtree-engine/src/domain/projects.rs`<br>`engine/rs/orgtree-engine/src/runtime/watchdogs.rs run_fair_queue`<br>`engine/rs/orgtree-engine/migrations/0025_project_nodes.sql`<br>`engine/rs/orgtree-engine/src/domain/peer_mail.rs` | tool-project, team-shape, credits |
| `tool-org-logo` | tool | `orgtree_org_logo` | Set/remove the caller's own organization Logo immediately, with logging, crop limits and undo history. Group `logo`. Must cover: set/remove parameters and defaults; permitted files, image limits and crop coordinates; inherited logo grant, default on, any agent; immediate application, audit, undo conflicts and delayed hub convergence. | `engine/rs/orgtree-engine/src/tools/logo.rs`<br>`engine/rs/orgtree-engine/src/domain/undo.rs logo()/apply_logo()`<br>`engine/rs/orgtree-engine/src/profile_pictures/` | scope-and-permissions, tool-retool, shared-folders |
| `peer-mail` | concept | `node:peer_mail` | Per-node default-on peer-mail setting, actual direct-child boundary, audience routes and hidden neighbour connectors. Must cover: default ON and noninheritance; actual common parent only and moves; directional audiences and shared superior delegation; project settings and chart/team state; neighbour lines hidden in both renderers at all zooms. | `engine/rs/orgtree-engine/src/domain/peer_mail.rs`<br>`engine/rs/orgtree-engine/src/domain/mail.rs`<br>`engine/rs/orgtree-engine/src/domain/audiences.rs`<br>`engine/rs/orgtree-engine/src/http/nodes.rs`<br>`apps/desktop/renderer/src/canvas/modals.tsx`<br>`apps/desktop/renderer/src/canvas/OrgCanvas.tsx`<br>`docs/rust-engine/peer-mail.md` | tool-message, tool-audience, projects, delegating |

#### Section `docket` — `orgtree-working/docket/` — writer org-sol

The docket, the org's durable record of work: items, statuses, review and attention.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `tool-work` | tool | `orgtree_work` | The docket tool: every action, its arguments, refusals and retired actions. Group `docket`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:626`<br>`engine/rs/orgtree-engine/src/tools/mod.rs work_tool -> domain/docket.rs`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | docket-items, docket-statuses, docket-review-and-attention, committee-mode, dev-team |
| `tool-staff` | tool | `orgtree_staff` | Create/update a docket item and hire or rehire its owner in one call. Group `docket+team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:699`<br>`engine/rs/orgtree-engine/src/tools/mod.rs dispatch -> domain/staffing.rs staff`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | docket-items, docket-statuses, docket-review-and-attention |
| `docket-items` | concept | — | Writing docket items: slugs, the problem-first description, progress lists, evidence, and recording rulings. Must cover: one item per piece of work; continue, never duplicate; description structure and authority; done_so_far/working_on_next and keep/append with expected_rev; evidence kinds; rulings go in the description. | `engine/rs/orgtree-engine/src/runtime/identity.rs DOCKET`<br>`engine/rs/orgtree-engine/src/domain/docket.rs`<br>`docs/rust-engine/docket-opening.md` | tool-work, docket-statuses |
| `docket-statuses` | concept | — | Statuses and their rules: backlogged, open, in_progress, blocked, review, approved, deploy_ready, done, dropped; archive and reopen. Must cover: what each status means and who may set it; blocked_reason and dropped_reason; auto-archive timing; reopen; delete vs archive vs drop. | `engine/rs/orgtree-engine/src/domain/docket.rs`<br>`docs/rust-engine/tool-work-status-transitions.md` | tool-work, docket-review-and-attention |
| `docket-review-and-attention` | concept | — | Agent review vs the user's attention flag: reviewers, approval, raising, amending and retracting attention. Must cover: review is by agents only; when an attention flag is warranted and what attention_reason must say; flags persist until retracted or answered; dismissals; questions vs flags. | `engine/rs/orgtree-engine/src/runtime/identity.rs DOCKET`<br>`engine/rs/orgtree-engine/src/domain/docket.rs` | reaching-the-user, tool-ask |

#### Section `mail` — `orgtree-working/mail/` — writer comms-sol

Mail inside and outside the org: messages, notices, audiences, other orgs and the mail hub.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `tool-message` | tool | `orgtree_message` | Send mail: recipients, kinds, questions/options, attachments, urgent, replies; flat Antigravity variant. Group `messaging`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call; direct-child peer-mail setting and directional audience exception; tags; alpha build; eight; first committed; non-user. | `engine/rs/orgtree-engine/src/tools/defs.rs:170`<br>`engine/rs/orgtree-engine/src/tools/mailtools.rs message(..,false)`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()`<br>`engine/rs/orgtree-engine/src/domain/peer_mail.rs`<br>`engine/rs/orgtree-engine/src/domain/mail_tags.rs` | mail-basics, chain-and-audiences, external-mail, org-inbox, committee-mode, dev-team |
| `tool-send-notice` | tool | `orgtree_send_notice` | Passive mail that wakes nobody. Group `messaging`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:179`<br>`engine/rs/orgtree-engine/src/tools/mailtools.rs message(..,true)`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | mail-basics, chain-and-audiences, external-mail, org-inbox |
| `tool-inbox` | tool | `orgtree_inbox` | Read your own mail: list, fetch, chunk, conversation. Group `messaging`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:296`<br>`engine/rs/orgtree-engine/src/tools/mailtools.rs inbox`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | mail-basics, chain-and-audiences, external-mail, org-inbox |
| `tool-audience` | tool | `orgtree_audience` | Request, grant, deny, revoke audiences outside the chain of command. Group `messaging`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call; direct-child peer-mail setting and directional audience exception. | `engine/rs/orgtree-engine/src/tools/defs.rs:556`<br>`engine/rs/orgtree-engine/src/tools/mod.rs audience_tool -> domain/audiences.rs`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()`<br>`engine/rs/orgtree-engine/src/domain/peer_mail.rs` | mail-basics, chain-and-audiences, external-mail, org-inbox, committee-mode, dev-team |
| `tool-transfers` | tool | `orgtree_transfers` | Inspect and control attachment transfers. Group `messaging`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:290`<br>`engine/rs/orgtree-engine/src/tools/mailtools.rs transfers`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | mail-basics, chain-and-audiences, external-mail, org-inbox |
| `tool-list-orgs` | tool | `orgtree_list_orgs` | Other organizations reachable as @org: and @net: addresses. Group `inspection`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:351`<br>`engine/rs/orgtree-engine/src/tools/orgview.rs list_orgs`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | mail-basics, chain-and-audiences, external-mail, org-inbox |
| `mail-basics` | concept | — | How mail works: messages vs notices, kinds, wakes, replies, mid-task delivery and the authentic-channel marker. Must cover: message wakes, notice does not; question kind and options; reply_to/replies threading; mail delivered mid-task and its marker; never wait for replies inside a turn. | `engine/rs/orgtree-engine/src/runtime/identity.rs TOOLS_SENTENCE, AUTHENTIC_CHANNEL`<br>`engine/rs/orgtree-engine/src/domain/mail.rs`<br>`engine/rs/orgtree-engine/src/domain/notices.rs`<br>`engine/rs/orgtree-engine/src/domain/replies.rs`<br>`docs/mail-delivery-boundaries.md`<br>`docs/rust-engine/multi-replies.md` | tool-message, tool-send-notice, tool-inbox |
| `chain-and-audiences` | concept | — | Who may write to whom: superior, reports, descendants, peers, the user, and audiences that open other paths. Must cover: default reach; audience request/grant lifecycle; user and extern audiences; top-level special cases; direct-child peer-mail setting and directional audience exception. | `engine/rs/orgtree-engine/src/domain/audiences.rs`<br>`engine/rs/orgtree-engine/src/tools/mod.rs:377`<br>`engine/rs/orgtree-engine/src/domain/peer_mail.rs` | tool-audience, delegating |
| `external-mail` | concept | — | Mail from outside: @org: and @net: addresses, why it is untrusted by default, and the org.md authorization exception. Must cover: untrusted by default; the exact-sender org.md authorization and its scope; envelope sender vs claimed sender; Unlink removes authority. | `engine/rs/orgtree-engine/src/runtime/identity.rs EXTERNAL_AUTHORITY`<br>`docs/rust-engine/phone-link-authority.md`<br>`docs/rust-engine/bare-mail-routing.md` | org-inbox, tool-list-orgs, phone-link |
| `org-inbox` | concept | — | The org inbox: outside mail to the org, holding its audience, and multiple holders. Must cover: what lands there; extern audience; policies that enable it. | `engine/rs/orgtree-engine/src/runtime/identity.rs ORG_INBOX`<br>`engine/rs/orgtree-engine/src/domain/orginbox.rs`<br>`docs/rust-engine/org-inbox-isolation.md` | external-mail, org-policies-inbox |

#### Section `user` — `orgtree-working/user/` — writer comms-sol

Reaching the user: questions, documents, files and requests for credits or scope.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `tool-ask` | tool | `orgtree_ask` | Ask the user on a question card (or the superior without a user audience). Group `user`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:418`<br>`engine/rs/orgtree-engine/src/tools/mod.rs ask_tool -> domain/asks.rs`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | reaching-the-user |
| `tool-withdraw-ask` | tool | `orgtree_withdraw_ask` | Withdraw your open question card. Group `user`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:438`<br>`engine/rs/orgtree-engine/src/tools/mod.rs ask_tool`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | reaching-the-user |
| `tool-present` | tool | `orgtree_present` | Present a document for the user to read. Group `user`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:440`<br>`engine/rs/orgtree-engine/src/tools/mod.rs doc_tool -> domain/docs.rs`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | reaching-the-user |
| `tool-send-file` | tool | `orgtree_send_file` | Deliver a file to the user as a download card. Group `user`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:451`<br>`engine/rs/orgtree-engine/src/tools/mod.rs doc_tool`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | reaching-the-user |
| `tool-request-credits` | tool | `orgtree_request_credits` | Ask the user for a larger credit grant. Group `user`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:538`<br>`engine/rs/orgtree-engine/src/tools/mod.rs ask_tool`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | reaching-the-user |
| `tool-request-scope` | tool | `orgtree_request_scope` | Ask the user for more folders, tools, MCP servers or a permission mode. Group `user`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:544`<br>`engine/rs/orgtree-engine/src/tools/mod.rs ask_tool`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | reaching-the-user |
| `reaching-the-user` | concept | — | Choosing how to reach the user: question card, docket attention flag, presented document, file card or plain mail. Must cover: question vs attention flag vs mail; presenting documents vs sending files; what non-top-level agents get instead (superior); notifications the user receives. | `engine/rs/orgtree-engine/src/runtime/identity.rs QUESTIONS_AND_FILES`<br>`engine/rs/orgtree-engine/src/domain/asks.rs`<br>`engine/rs/orgtree-engine/src/domain/docs.rs` | tool-ask, tool-present, tool-send-file, docket-review-and-attention |

#### Section `runtime` — `orgtree-working/runtime/` — writer runtime-sol

Your turns and sessions: status, wakes, checkups, context, compaction, halts and restarts.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `tool-status` | tool | `orgtree_status` | Report working/done/blocked/idle to your superior; always available. Group `none`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:279`<br>`engine/rs/orgtree-engine/src/tools/mailtools.rs status`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | turns-and-wakes, turn-envelope, checkups-and-reminders, context-and-compaction, halts-and-restarts |
| `tool-next-turn` | tool | `orgtree_next_turn` | Read your own prefix/namespace changes, instruction-file copies and compaction forecast; always available. Group `none`. Must cover: self only/no arguments/read only; prefix and namespace changes only; per-file delivered baseline and legacy uncertainty; compaction observations and thresholds; no cache-hit promise. | `engine/rs/orgtree-engine/src/tools/next_turn.rs`<br>`engine/rs/orgtree-engine/src/runtime/actor.rs next_turn`<br>`engine/rs/orgtree-engine/src/runtime/next_turn.rs` | cache-continuity, context-and-compaction |
| `tool-session` | tool | `orgtree_session` | Where your turns run: Session 0 or the user's signed-in session, whether the user is signed in, and whether your next turn moves; always available. Group `none`. Must cover: when to use it and when not; every returned field, and when it is null; moves only at a turn's start; background work and the sign-in helper; the sign-out resume; refusals and a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/session.rs`<br>`engine/rs/orgtree-engine/src/runtime/actor.rs session_view()`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | halts-and-restarts, turns-and-wakes, turn-envelope |
| `session-0-ui-testing` | concept | `concept:session-0-ui-testing` | Session 0 has no interactive desktop; check your session and use reliable UI-test patterns. Must cover: Session 0 desktop limitations and failure modes; check current session before UI work; posted window messages with a positive control; hidden/offscreen Electron capture timing and size constraints; one-off interactive scheduled-task route with temporary userData; name the session constraint when assigning UI work. | `_shared/feedback-4.3.1.md §5.1`<br>`docs/rust-engine/test-rig.md:347-371`<br>`tools/rig/proofs/session-query.mjs`<br>`tools/rig/proofs/credential-broker.mjs` | tool-session, turns-and-wakes, builds-under-the-lock |
| `tool-interrupt` | tool | `orgtree_interrupt` | Stop a report's current turn, or end your own and start a new one at once. Group `none (yourself); runtime (others)`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:368`<br>`engine/rs/orgtree-engine/src/tools/control.rs interrupt`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | turns-and-wakes, turn-envelope, checkups-and-reminders, context-and-compaction, halts-and-restarts |
| `tool-halt` | tool | `orgtree_halt` | Halt agents below you. Group `runtime`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:374`<br>`engine/rs/orgtree-engine/src/tools/control.rs halt(..,true)`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | turns-and-wakes, turn-envelope, checkups-and-reminders, context-and-compaction, halts-and-restarts |
| `tool-unhalt` | tool | `orgtree_unhalt` | Release halted agents. Group `runtime`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:380`<br>`engine/rs/orgtree-engine/src/tools/control.rs halt(..,false)`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | turns-and-wakes, turn-envelope, checkups-and-reminders, context-and-compaction, halts-and-restarts |
| `tool-unstick` | tool | `orgtree_unstick` | Release a usage-limit freeze. Group `runtime`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:386`<br>`engine/rs/orgtree-engine/src/tools/control.rs unstick`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | turns-and-wakes, turn-envelope, checkups-and-reminders, context-and-compaction, halts-and-restarts |
| `tool-cheap-compact` | tool | `orgtree_cheap_compact` | Restart an agent on a fresh session with a summary; what carries over. Group `team`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:536`<br>`engine/rs/orgtree-engine/src/tools/treetools.rs run("cheap_compact")`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()`<br>`docs/rust-engine/recovery-commands.md` | turns-and-wakes, turn-envelope, checkups-and-reminders, context-and-compaction, halts-and-restarts |
| `turns-and-wakes` | concept | — | What a turn is, what wakes you, and the rule never to end a turn with background work running. Must cover: wakes: mail, checkups, watchdogs, restarts; the background-work rule and idle watchdog; turn time and silence limits; ending at milestones so mail can arrive. | `engine/rs/orgtree-engine/src/runtime/identity.rs BACKGROUND`<br>`engine/rs/orgtree-engine/src/runtime/prompt.rs`<br>`docs/rust-engine/background-work.md` | turn-envelope, checkups-and-reminders, waiting-for-events, app-turn-limits |
| `turn-envelope` | concept | — | Reading the blocks at the top of each turn: ORG STATE, PROVIDER USAGE, MAIL, notices. Must cover: each block's fields and freshness; newest copy wins; dynamic facts vs prefix. | `engine/rs/orgtree-engine/src/runtime/envelope.rs`<br>`engine/rs/orgtree-engine/src/runtime/event_text.rs` | usage-windows, mail-basics |
| `checkups-and-reminders` | concept | — | Automatic checkups for working agents and idle/blocked docket reminders. Must cover: the 20-minute working checkup; idle and blocked docket reminders and their switches; what they never do. | `engine/rs/orgtree-engine/src/runtime/identity.rs CHECKUPS`<br>`engine/rs/orgtree-engine/src/runtime/reminders.rs`<br>`engine/rs/orgtree-engine/src/events.rs:235-242` | app-concurrency-and-checkups, tool-status |
| `context-and-compaction` | concept | — | Context size, compaction, cheap compact, auto cheap compact and cache continuity costs of restarts. Must cover: compact_at threshold; cheap compact: what the summary carries; auto cheap compact policy; handoff notes and breadcrumbs after compaction. | `engine/rs/orgtree-engine/src/domain/ops.rs:2023`<br>`engine/rs/orgtree-engine/src/domain/lifecycle.rs:142` | tool-cheap-compact, cache-continuity, breadcrumbs, org-policies-compaction |
| `halts-and-restarts` | concept | — | Halts, interrupts, the kill switch and engine restarts: what happens to running turns and how to resume. Must cover: halt vs interrupt; STOP ALL kill switch; engine restart notices and continuing; frozen-turn lifecycle. | `docs/agent-halt.md`<br>`docs/frozen-turn-lifecycle.md`<br>`engine/rs/orgtree-engine/src/domain/lifecycle.rs` | tool-halt, tool-interrupt, kill-switch |

#### Section `watchdogs` — `orgtree-working/watchdogs/` — writer runtime-sol

Watching for events without polling: watchdogs and how to wait.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `tool-watchdog` | tool | `orgtree_watchdog` | Persistent watchers (file/command/process/stream/activity/event) that mail you. Group `watchdogs`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:573`<br>`engine/rs/orgtree-engine/src/tools/mod.rs dog_tool -> domain/watchdogs.rs`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | waiting-for-events, machine-traps, committee-mode, dev-team |
| `waiting-for-events` | concept | — | How to wait for a build, file, process or event: a watchdog, never a polling loop or a sleeping turn. Must cover: choose the watchdog kind; foreground long jobs vs watchdog; cleaning up watchdogs. | `engine/rs/orgtree-engine/src/runtime/identity.rs WATCHDOGS`<br>`engine/rs/orgtree-engine/src/domain/watchdogs.rs`<br>`docs/rust-engine/event-watchdogs.md` | tool-watchdog, turns-and-wakes, builds-under-the-lock |

#### Section `inspection` — `orgtree-working/inspection/` — writer runtime-sol

Seeing the org: the chart, agent state, transcripts and scratch folders, within your visibility.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `tool-chart` | tool | `orgtree_chart` | The org chart within your visibility. Group `inspection`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:317`<br>`engine/rs/orgtree-engine/src/tools/orgview.rs chart`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | visibility, reading-reports |
| `tool-state-inspect` | tool | `orgtree_state_inspect` | Structured agent state: folders, tools, permission mode. Group `inspection`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:328`<br>`engine/rs/orgtree-engine/src/tools/orgview.rs state_inspect`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | visibility, reading-reports |
| `tool-read-transcript` | tool | `orgtree_read_transcript` | Read the recent conversation of yourself or a descendant. Group `inspection`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:353`<br>`engine/rs/orgtree-engine/src/tools/orgview.rs read_transcript`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | visibility, reading-reports |
| `tool-read-scratch` | tool | `orgtree_read_scratch` | Browse or read the working folder of yourself or a descendant. Group `inspection`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:362`<br>`engine/rs/orgtree-engine/src/tools/orgview.rs read_scratch`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | visibility, reading-reports |
| `visibility` | concept | — | Visibility: self, team, subtree, full; the narrowest setting up your chain wins. Must cover: levels and defaults; effective visibility; what each inspection tool shows at each level. | `engine/rs/orgtree-engine/src/domain/scope.rs`<br>`engine/rs/orgtree-engine/src/tools/orgview.rs:213`<br>`engine/rs/orgtree-engine/src/tools/mod.rs:282` | tool-chart, scope-and-permissions |
| `reading-reports` | concept | — | Looking at your reports instead of interrogating them: transcript and scratch first, verify claimed results. Must cover: read before asking; verify a claimed file or commit; downward-only reach. | `engine/rs/orgtree-engine/src/runtime/identity.rs READ_REPORTS` | tool-read-transcript, tool-read-scratch, delegating |

#### Section `accounts` — `orgtree-working/accounts/` — writer providers-sol

Provider accounts from an agent's side: usage windows, account binding, freezes and cache continuity.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `tool-usage` | tool | `orgtree_usage` | Provider usage readings, filters and refresh rules. Group `inspection`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:339`<br>`engine/rs/orgtree-engine/src/tools/usage.rs usage`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | account-lanes, usage-windows, usage-freezes, cache-continuity |
| `tool-continue-on` | tool | `orgtree_continue_on` | Move a frozen agent to another account of the same provider. Group `runtime`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:392`<br>`engine/rs/orgtree-engine/src/tools/control.rs continue_on`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | account-lanes, usage-windows, usage-freezes, cache-continuity |
| `tool-account-mark` | tool | `orgtree_account_mark` | Inspect or clear an account's capacity mark. Group `runtime`. Must cover: when to use it and when not; every parameter/action with defaults and limits from the definition; refusals and error texts agents hit; top-level vs. non-top-level differences; a minimal correct example call. | `engine/rs/orgtree-engine/src/tools/defs.rs:398`<br>`engine/rs/orgtree-engine/src/tools/control.rs account_mark`<br>`engine/rs/orgtree-engine/src/domain/tool_groups.rs required()` | account-lanes, usage-windows, usage-freezes, cache-continuity |
| `account-lanes` | concept | — | Account lanes and binding: which account your turns run on, fallback, and why agents do not switch on their own. Must cover: binding at hire and in settings; fallback on usage limits; no gratuitous switches. | `engine/rs/orgtree-engine/src/runtime/identity.rs ACCOUNT_LANES`<br>`engine/rs/orgtree-engine/src/org_accounts.rs` | agent-account-tab, usage-windows |
| `usage-windows` | concept | — | Reading usage windows: session, weekly and scoped windows, freshness, and when a reading counts as exhaustion. Must cover: window kinds per provider; fresh/stale/unavailable; limited state; refresh rules. | `engine/rs/orgtree-engine/src/usage.rs`<br>`engine/rs/orgtree-engine/src/usage/query.rs`<br>`docs/rust-engine/usage-refresh.md` | tool-usage, turn-envelope, usage-screens |
| `usage-freezes` | concept | — | Usage-limit freezes: what freezes an agent, auto-resume, unstick, continue_on and account marks. Must cover: freeze causes and states; auto-resume; unstick vs continue_on; account marks. | `engine/rs/orgtree-engine/src/runtime/freeze.rs`<br>`engine/rs/orgtree-engine/src/runtime/freeze/continuation.rs`<br>`engine/rs/orgtree-engine/src/account_marks.rs`<br>`docs/rust-engine/freeze-recovery.md`<br>`docs/rust-engine/continue-primary.md` | tool-unstick, tool-continue-on, tool-account-mark, org-autonomy |
| `cache-continuity` | concept | — | Provider prompt-cache continuity: what changes the cache namespace or prefix, TTLs per auth lane, and why no hit is guaranteed. Must cover: namespace changes (provider, account, model, session); prefix changes; TTLs per lane; what does not invalidate. | `engine/rs/orgtree-engine/src/runtime/identity.rs CACHE_CONTINUITY` | context-and-compaction, account-lanes |

#### Section `workspace` — `orgtree-working/workspace/` — writer comms-sol

Your folders and working practices: scratch, notes, breadcrumbs, shared folders, git worktrees, builds and reviews.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `scratch-folder` | concept | — | Your scratch folder and its AGENTS.md standing notes. Must cover: what the folder is and who can read it; standing notes delivered each session; identity files not to edit; native personal/team/shared folder actions and distinct creation rules. | `engine/rs/orgtree-engine/src/runtime/identity.rs l.283-292, own_notes()`<br>`docs/rust-engine/scratch-folder.md`<br>`docs/rust-engine/standing-notes.md` | breadcrumbs, shared-folders, tool-read-scratch |
| `shared-folders` | concept | — | The org shared folder and team workspaces: what goes where and their AGENTS.md notes. Must cover: _shared and _teams/<id>; narrowest folder its readers share; no secrets; re-read before editing. | `engine/rs/orgtree-engine/src/runtime/identity.rs org_notes_rule, team_rule`<br>`docs/rust-engine/org-shared-notes.md`<br>`docs/rust-engine/team-workspaces.md`<br>`engine/rs/orgtree-engine/src/domain/teams.rs` | scratch-folder |
| `breadcrumbs` | concept | — | breadcrumbs.md: the realtime compaction log a fresh session resumes from. Must cover: what to write and when; writing for a stranger; where it lives; record reusable commands on their first run. | `engine/rs/orgtree-engine/src/runtime/identity.rs BREADCRUMBS` | context-and-compaction, scratch-folder |
| `suggestion-box` | concept | — | suggestion-box.md: notes on how Orgtree should better inform agents about its own functions. Must cover: the standing rule and its origin; what makes a useful note. | `team notes rule (coordinator-opus, user 2026-10-15); not in engine source` | breadcrumbs |
| `machine-traps` | concept | `concept:machine-traps` | Windows shell escaping, CRLF, encodings, Git Bash paths and file-edit pitfalls on the development machine. Must cover: shell transport escaping and saved scripts; CRLF and byte checks; Git Bash versus WSL and watchdog shell selection; Windows and MSYS argument paths; PowerShell and Python encodings; Edit tool Unicode escapes; rerere and mojibake; legacy machine traps and current workflow boundaries. | `.gitattributes`<br>`AGENTS.md (Machine traps)`<br>`engine/rs/orgtree-engine/src/runtime/watchdogs.rs:707-762`<br>`docs/machine-traps.md (compatibility pointer)`<br>`user/coordinator 2026-10-16 machine-traps docket scope and feedback section 6` | worktrees-and-git, builds-under-the-lock, tool-watchdog |
| `worktrees-and-git` | concept | — | Working on a git repository from an org: your own worktree, never another's, never a bare stash, commit before probing. Must cover: create and remove a worktree; shared stash hazard; branch from the right base. | `docs/worktree-operations.md`<br>`engine/rs/orgtree-engine/src/runtime/identity.rs GATE_GATED` | builds-under-the-lock, reviews-and-landing, machine-traps |
| `builds-under-the-lock` | concept | — | Heavy builds and tests under the machine lock and build queue, with memory limits and watchdog waits. Must cover: one heavy phase machine-wide; lock and queue files, handover; memory floor; wait with a watchdog. | `docs/rust-engine/test-rig.md`<br>`AGENTS.md (machine lock sections)` | waiting-for-events, worktrees-and-git, machine-traps |
| `reviews-and-landing` | concept | — | Independent review and landing: reviewer approval of an exact commit, rebase, targeted checks, honest evidence. Must cover: review of the exact tip; rebase and re-run targeted tests; evidence labeling measured vs inferred; the coordinator integrates. | `AGENTS.md (Reviews and landing)` | docket-review-and-attention, worktrees-and-git, iterative-development |

### Category `orgtree-app` — `docs/skills/orgtree-app/SKILL.md`

App entry point to the skill library, also called the glossary or Orgtree Encyclopaedia (encyclopedia): find the screen or setting page you need.

#### Section `app-shell` — `orgtree-app/app-shell/` — writer runtime-sol

The app's frame: windows, homepage, header and menus, status bar, quick chat, tray, onboarding and shared dialogs.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `homepage` | screen | `screen:homepage` | The homepage window: the org list, phone card and create button. Must cover: opening orgs; org rows and badges. | `apps/desktop/renderer/src/shell/homepage.tsx:38`<br>`apps/desktop/renderer/src/shell/orgrows.tsx:20`<br>`apps/desktop/main/index.ts:2254` | create-organization, onboarding |
| `create-organization` | screen | `screen:create-organization`, `screen:template-picker` | Creating an organization: name, folders, layout and template. Must cover: fields; templates; discarding a creation. | `apps/desktop/renderer/src/shell/createorg.tsx:80`<br>`apps/desktop/renderer/src/shell/templatepicker.tsx:61` | app-charters-and-templates, org-templates, dev-team |
| `org-header-and-menu` | screen | `screen:org-header`, `screen:app-menu` | The org window header and the Orgtree app menu: view toggle, Inbox, Work, Presentations, Org settings, and the menu items. Must cover: every header button and where it leads; every app-menu item. | `apps/desktop/renderer/src/shell/header.tsx:58`<br>`apps/desktop/renderer/src/shell/menu.tsx:84`<br>`apps/desktop/renderer/src/shell/modetoggle.tsx:18` | attention-view, inbox-screens, docket-screens |
| `kill-switch` | screen | `screen:kill-switch` | STOP ALL: arming, latching an org-wide halt, and releasing it. Must cover: arm/press/release; what it halts. | `apps/desktop/renderer/src/KillSwitch.tsx:56` | halts-and-restarts |
| `status-bar` | screen | `screen:status-bar` | The bottom status bar chips: active agents, hub, audit, connectivity. Must cover: each chip. | `apps/desktop/renderer/src/shell/statusbar.tsx:58`<br>`apps/desktop/renderer/src/shell/treeinfo.tsx:95` | quick-chat |
| `quick-chat` | screen | `screen:quick-chat` | The quick chat box: hiring and starting a new agent from the window chrome. Must cover: superior/model/files popovers; placement setting. | `apps/desktop/renderer/src/QuickChatBox.tsx:56` | app-display-input-and-startup |
| `toasts-and-undo` | screen | `screen:toasts`, `screen:undo-history` | Toasts with Undo, Ctrl+Z/Ctrl+Y undo/redo, and the undo-hire confirmation. Must cover: what can be undone; toast lifetimes. | `apps/desktop/renderer/src/toasts.tsx:44`<br>`apps/desktop/renderer/src/historyui.tsx:40` | confirm-dialogs, org-history |
| `confirm-dialogs` | screen | `screen:confirm-dialogs` | Every confirmation dialog: delete org, delete/retire/dissolve/rescind agent, batch halt, cheap compact, compact now, undo hire. Must cover: each use and its consequence. | `apps/desktop/renderer/src/canvas/modals.tsx:87`<br>`apps/desktop/renderer/src/canvas/bulkcompact.tsx:184` | team-shape, context-and-compaction |
| `folder-picker` | screen | `screen:folder-picker` | The in-app folder chooser used by every folder field. Must cover: behavior. | `apps/desktop/renderer/src/picker.tsx:21` | agent-folders-tab |
| `crash-and-restart` | screen | `screen:crash-screen`, `screen:restart-notice`, `screen:freeze-log` | Crash screen, restart notice and the debug freeze log page. Must cover: what each shows and what to do. | `apps/desktop/renderer/src/CrashBoundary.tsx:18`<br>`apps/desktop/renderer/src/popout.tsx:51`<br>`apps/desktop/renderer/src/FreezeLogPage.tsx:22` | app-developer |
| `onboarding` | screen | `screen:onboarding`, `screen:first-use-guide` | First run: onboarding on the homepage and the first-use guide on a new org's canvas. Must cover: steps. | `apps/desktop/renderer/src/canvas/onboarding.tsx:65`<br>`apps/desktop/renderer/src/canvas/firstuse.tsx:69` | homepage |
| `attention-view` | screen | `screen:attention-view`, `screen:attention-queue`, `screen:attention-desk-panel` | The Attention view: the needs-attention queue and the agent desk panel. Must cover: queue contents; panels pin/popout. | `apps/desktop/renderer/src/attention/AttentionView.tsx:353`<br>`apps/desktop/renderer/src/attention/AttentionQueue.tsx:108`<br>`apps/desktop/renderer/src/attention/AgentDeskPanel.tsx:140` | docket-review-and-attention, ask-cards |
| `mobile-layout` | screen | `screen:mobile-agent-sheet`, `screen:hire-sheet`, `screen:legacy-drawer` | Narrow-width layout: the mobile agent sheet, its hire sheet, and the legacy drawer. Must cover: what differs at mobile width. | `apps/desktop/renderer/src/canvas/OrgCanvas.tsx:~4290`<br>`apps/desktop/renderer/src/canvas/OrgCanvas.tsx:4467`<br>`apps/desktop/renderer/src/App.tsx:1402` | agent-desk |
| `tray-and-windows` | screen | `screen:tray`, `screen:tray-menu`, `screen:taskbar`, `screen:popout-windows`, `screen:mockup-viewer`, `screen:conversion-window`, `screen:native-dialogs` | Main-process surfaces: the tray icon and menu, popout windows, mockup viewer, data-conversion window and native dialogs. Must cover: every tray menu item; Windows taskbar Home, New org and current organization tasks; popout windows. | `apps/desktop/main/index.ts:1753`<br>`apps/desktop/main/index.ts:554`<br>`apps/desktop/main/index.ts:770`<br>`apps/desktop/main/windows.ts:81`<br>`apps/desktop/main/index.ts:2222`<br>`apps/desktop/main/conversion-window.ts:21`<br>`apps/desktop/main/editmenu.ts:114`<br>`apps/desktop/main/jumplist.ts` | app-runtime-desktop, phone-link |

#### Section `canvas` — `orgtree-app/canvas/` — writer org-sol

The org canvas: the agent tree, cards, the user node, piles, the agents list, menus and pinned windows.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `org-canvas` | screen | `screen:org-canvas` | The canvas itself: background and middle-button pan across desks and pinned frames, zoom, wires, zoom HUD, off-screen jump chips, drag to move or reorder. Must cover: navigation; drag interactions; middle-button pan across canvas desks and pinned frames; separate desk popouts excluded. | `apps/desktop/renderer/src/canvas/OrgCanvas.tsx:401`<br>`apps/desktop/renderer/src/canvas/viewport.tsx:28` | agent-card, app-display-desk-and-chart |
| `agent-card` | screen | `screen:agent-card` | The agent card: tier, name, context wheel, state badges, credit bar, chips and zoom variants. Must cover: every badge and chip and what it means. | `apps/desktop/renderer/src/canvas/cards.tsx:1413`<br>`apps/desktop/renderer/src/canvas/nextturn.tsx`<br>`apps/desktop/renderer/src/canvas/progress.tsx:534` | context-menus, agent-desk |
| `user-node` | screen | `screen:user-node`, `screen:overseer-eye` | The user's root card and its overseer eye with bulk halt, dissolve and cheap compact. Must cover: bulk actions; shared scratch folder context entry on overview and focused switchboard. | `apps/desktop/renderer/src/canvas/cards.tsx:113`<br>`apps/desktop/renderer/src/canvas/cards.tsx:368` | confirm-dialogs |
| `draft-hires` | screen | `screen:draft-node`, `screen:draft-scope-modal` | Hiring from the canvas: spawn chips, the draft card's model picker and its pre-hire permissions modal. Must cover: fields and defaults; how it maps to orgtree_hire; model icon choices before initialization and preservation of draft fields. | `apps/desktop/renderer/src/canvas/cards.tsx#DraftNode`<br>`apps/desktop/renderer/src/canvas/cards.tsx:648`<br>`apps/desktop/renderer/src/canvas/modals.tsx:563`<br>`apps/desktop/renderer/src/canvas/newproject.tsx`<br>`apps/desktop/renderer/src/canvas/projectcard.tsx` | hiring, org-hire-defaults-scope |
| `org-inbox-tile` | screen | `screen:org-inbox-tile` | The org inbox tile on the canvas and its hub status dots. Must cover: when shown. | `apps/desktop/renderer/src/canvas/OrgCanvas.tsx:~3955` | inbox-screens, org-inbox |
| `piles` | screen | `screen:pile-picker` | Crowd and retired piles and the pile picker. Must cover: when piles form. | `apps/desktop/renderer/src/canvas/modals.tsx:1691` | app-display-desk-and-chart |
| `agents-list` | screen | `screen:agents-list` | The agents list: hierarchy, search, active checkbox in the title bar beside pin/pop-out, and archived filter. Must cover: search, active-only meaning and persistence, and archived. | `apps/desktop/renderer/src/canvas/OrgCanvas.tsx:4147`<br>`apps/desktop/renderer/src/canvas/agenttray.tsx:102`<br>`apps/desktop/renderer/src/canvas/modalpin.tsx:522` | org-canvas |
| `context-menus` | screen | `screen:context-menus` | Context menus, above all the agent menu and every item in it. Must cover: every agent-menu item; own-led numeric-id team scratch next to personal scratch. | `apps/desktop/renderer/src/canvas/contextmenu.tsx:461`<br>`apps/desktop/renderer/src/canvas/agentmenu.tsx`<br>`apps/desktop/renderer/src/canvas/shared.ts:1381`<br>`apps/desktop/renderer/src/api.ts:889` | agent-card |
| `pinned-windows` | screen | `screen:pinned-windows`, `screen:temporary-desk`, `screen:desk-popout` | Pinning desks and modals as canvas windows, popping them out, and the temporary desk. Must cover: pin/popout/close; related display settings. | `apps/desktop/renderer/src/canvas/pins.tsx:376`<br>`apps/desktop/renderer/src/canvas/modalpin.tsx:543`<br>`apps/desktop/renderer/src/canvas/tempdesk.tsx:61`<br>`apps/desktop/renderer/src/popout.tsx:151` | app-display-desk-and-chart |

#### Section `desk` — `orgtree-app/desk/` — writer providers-sol

An agent's desk and the work panels: chat, inboxes, ask cards, dockets, presentations and watchdogs. Agent event history is in agent settings; scratch folders open in the OS file explorer.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `agent-desk` | screen | `screen:agent-desk` | The desk: opening it, header actions, banners (turn status, halted, queued, cache forecast) and the tab strip. Must cover: each banner; each header action. | `apps/desktop/renderer/src/canvas/desk.tsx:1907`<br>`apps/desktop/renderer/src/canvas/haltcontrol.tsx:13` | desk-chat, agent-config |
| `desk-chat` | screen | `screen:desk-chat` | The Chat tab: transcript, tool chips, live one-level Claude helper activity, thoughts, event cards and the composer. Must cover: composer, effort switch, slash hints; event cards. | `apps/desktop/renderer/src/canvas/desk.tsx:3627` | agent-desk |
| `inbox-screens` | screen | `screen:user-inbox`, `screen:agent-inbox`, `screen:org-inbox`, `screen:desk-inbox-tab`, `screen:transfers-panel` | The user inbox, an agent's inbox (modal and desk tab), the org inbox, and the transfers panel. Must cover: list, read pane, reply box; responsive list width and popout resizing; org record search; transfers; tag; chip; hue; bounded; Retry. | `apps/desktop/renderer/src/App.tsx:2631`<br>`apps/desktop/renderer/src/canvas/mail.tsx:1146`<br>`apps/desktop/renderer/src/canvas/narrowlist.tsx`<br>`apps/desktop/renderer/src/canvas/mail.tsx:1376`<br>`apps/desktop/renderer/src/canvas/mail.tsx:1424`<br>`apps/desktop/renderer/src/canvas/transfers.tsx:29`<br>`apps/desktop/renderer/src/usemailtags.ts`<br>`apps/desktop/renderer/src/canvas/mailtags.ts` | mail-basics, ask-cards |
| `ask-cards` | screen | `screen:ask-card` | Ask cards: answering questions, credit requests and batch asks. Must cover: states. | `apps/desktop/renderer/src/canvas/asks.tsx:82` | tool-ask, tool-request-credits |
| `docket-screens` | screen | `screen:org-work`, `screen:agent-docket`, `screen:team-docket`, `screen:desk-docket-tab` | The Work modal, agent and team dockets, the desk Docket tab and the item pane. Must cover: filters and grouping; item pane fields. | `apps/desktop/renderer/src/canvas/docket.tsx:942`<br>`apps/desktop/renderer/src/canvas/docket.tsx:1740`<br>`apps/desktop/renderer/src/canvas/agentdocket.tsx:12`<br>`apps/desktop/renderer/src/canvas/teamdocket.tsx:40` | docket-statuses, tool-work |
| `presentations` | screen | `screen:org-presentations`, `screen:agent-presentations`, `screen:desk-presented-tab`, `screen:document-reader`, `screen:file-cards` | Presented documents: galleries, the document reader and file cards. Must cover: opening, pinning, downloading; responsive list width and popout resizing. | `apps/desktop/renderer/src/canvas/gallery.tsx:325`<br>`apps/desktop/renderer/src/canvas/narrowlist.tsx`<br>`apps/desktop/renderer/src/canvas/gallery.tsx:670`<br>`apps/desktop/renderer/src/canvas/docs.tsx:222`<br>`apps/desktop/renderer/src/canvas/download.tsx:37` | tool-present, tool-send-file |
| `watchdog-panel` | screen | `screen:watchdog-panel` | The watchdog panel and dog chips. Must cover: controls. | `apps/desktop/renderer/src/canvas/modals.tsx:163`<br>`apps/desktop/renderer/src/canvas/deskdogs.tsx:46` | tool-watchdog |

#### Section `app-settings` — `orgtree-app/app-settings/` — writer skills-docs-sol

App settings (Orgtree menu > App settings…): Runtime, Display, Default org settings, Developer, Shortcuts and About.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `app-runtime-desktop` | setting | `np:startAtLogin`, `np:exitOnClose`, `np:automaticUpdates`, `bridge:setRunAsAdministrator` | Runtime > desktop behavior: run on boot (where agents run), exit on close, automatic updates, run as administrator. Must cover: each switch, default and effect; restarting the background engine; run on boot: the engine at boot in Session 0, agents in the signed-in session while the user is signed in; "run on sign-in" where Orgtree cannot start at boot. | `apps/desktop/renderer/src/canvas/desktopsettings.tsx:50`<br>`apps/desktop/renderer/src/canvas/desktopsettings.tsx:107` | tray-and-windows |
| `app-notifications` | setting | `np:notificationsEnabled`, `np:notifyQuestions`, `np:notifyUrgentMail`, `np:notifyTerminalFailures`, `np:notifyDocketAttention`, `np:notifyAllMail`, `np:notifyDocuments`, `np:notifyFrozen`, `np:notifyWhileFocused` | Runtime > Notifications: the master switch and each notification kind. Must cover: each kind and default. | `apps/desktop/renderer/src/canvas/desktopsettings.tsx:69`<br>`packages/contracts/notifications.ts:3` | reaching-the-user |
| `app-quick-staff` | setting | `rt:quick_staff_behavior` | Runtime > Quick staff behavior: request staffing vs staff immediately. Must cover: each choice. | `apps/desktop/renderer/src/canvas/quickstaffsetting.tsx:18` | tool-staff |
| `app-turn-limits` | setting | `rt:turn_timeout_s`, `rt:turn_idle_s` | Runtime > Turn time limits: total and silence limits. Must cover: defaults and effect. | `apps/desktop/renderer/src/canvas/turnlimitssetting.tsx:84` | turns-and-wakes |
| `app-concurrency-and-checkups` | setting | `rt:max_concurrent_turns`, `rt:working_checkups_enabled`, `rt:wait_for_mcp_tools_enabled`, `rt:idle_docket_reminders_enabled`, `rt:blocked_docket_reminders_enabled`, `rt:warming_enabled` | Runtime > Turns: concurrent turns, working checkups, MCP wait, docket reminders, process warming. Must cover: each switch and default. | `apps/desktop/renderer/src/canvas/accounts.tsx:636`<br>`apps/desktop/renderer/src/canvas/accounts.tsx:871-890` | checkups-and-reminders |
| `app-charters-and-templates` | setting | `rt:charter-template-dirs` | Runtime > Charter documents and Organization templates: template folders, populating documents, restoring default templates. Must cover: actions and folders. | `apps/desktop/renderer/src/canvas/chartersettings.tsx:46`<br>`apps/desktop/renderer/src/canvas/templates.tsx:41`<br>`engine/rs/orgtree-engine/src/domain/templates.rs` | create-organization, org-templates |
| `app-display-appearance` | setting | `np:visualTheme`, `np:contrastTheme`, `np:agentColorSource`, `np:canvasBackground` | Display > Appearance and Canvas background: theme, custom color, contrast color, agent colors, canvas background and intensity. Must cover: each choice. | `apps/desktop/renderer/src/themes.tsx:234`<br>`apps/desktop/renderer/src/contrast.tsx:93`<br>`apps/desktop/renderer/src/agentcolors.tsx:142`<br>`apps/desktop/renderer/src/canvas/canvasbgsetting.tsx:15`<br>`apps/desktop/renderer/src/canvasbgpref.ts:19`<br>`packages/contracts/canvas-background.ts:27` | — |
| `app-display-desk-and-chart` | setting | `ls:orgtree-chart-layout`, `ls:orgtree-desk-dpi`, `ls:orgtree-crowd-piles`, `ls:orgtree-hide-retired`, `ls:orgtree-agent-shortcuts`, `ls:orgtree-modal-overlap-fade`, `ls:orgtree-pin-snap`, `ls:orgtree-jump-fold`, `ls:orgtree-canvas-anchor-bounded` | Display > Desk: chart layout, desk text size, piles, retired agents, card shortcuts, pinned-panel behavior. Must cover: each switch and default. | `apps/desktop/renderer/src/canvas/accounts.tsx:317-401`<br>`apps/desktop/renderer/src/canvas/pinoverlap.tsx:40`<br>`apps/desktop/renderer/src/canvas/canvasanchor.tsx:127` | org-canvas, pinned-windows, piles |
| `app-display-input-and-startup` | setting | `ls:orgtree-quickchat-position`, `rt:enter_key_behavior`, `np:startupMode`, `ls:orgtree-start-view`, `ls:orgtree-start-zoom` | Display > quick chat position, Enter key, and Startup behavior. Must cover: each choice and default. | `apps/desktop/renderer/src/canvas/accounts.tsx:430-458`<br>`apps/desktop/renderer/src/canvas/accounts.tsx:903`<br>`apps/desktop/renderer/src/shell/general.tsx:107` | quick-chat |
| `app-default-org-settings` | setting | `defaults:max_top_grant`, `defaults:default_top_grant`, `defaults:compact_at`, `defaults:default_effort`, `defaults:cascade_hire`, `defaults:cascade_alloc`, `defaults:auto_resume` | Default org settings: values new organizations start with (also the standalone form). Must cover: each field and default; applies only to new orgs. | `apps/desktop/renderer/src/shell/defaults.tsx:46-78`<br>`apps/desktop/renderer/src/App.tsx:2947` | org-basic |
| `app-developer` | setting | `ls:orgtree-engine-debug`, `rt:verbose_logging` | Developer: the engine debug view and verbose engine logging, and the logs folder. Must cover: engine debug panel contents; ORGTREE_LOG_VERBOSE lock; SECRET NOTE: one offhand line only for the hidden switch at the bottom of this tab; never a heading. | `apps/desktop/renderer/src/canvas/enginedebug.tsx:43`<br>`apps/desktop/renderer/src/canvas/enginedebug.tsx:104`<br>`apps/desktop/renderer/src/canvas/accounts.tsx:922-946` | crash-and-restart |
| `app-keyboard-shortcuts` | setting | `screen:keyboard-shortcuts` | Keyboard shortcuts: the read-only list of bindings, including org-canvas navigation. Must cover: every binding; opening panel focus and auto-selected Alt-arrow navigation. | `apps/desktop/renderer/src/canvas/shortcutsettings.tsx`<br>`apps/desktop/renderer/src/canvas/panelsteps.ts` | toasts-and-undo |
| `app-about` | setting | `screen:about` | About: version, engine commit, update check. Must cover: fields. | `apps/desktop/renderer/src/canvas/accounts.tsx:769` | app-runtime-desktop |

#### Section `org-settings` — `orgtree-app/org-settings/` — writer orgsettings-sol

Org settings (header > Org settings): Basic, Hire defaults, Policies, Connections, Autonomy, Accounts, History.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `org-basic` | setting | `org:max_top_grant`, `org:default_top_grant`, `org:compact_at`, `org:default_effort`, `screen:org-logo` | Basic: org logo, credit caps and grants, compaction threshold, default effort; which tabs save together. Must cover: each field; one save vs immediate tabs; shared scratch folder button independent of Save. | `apps/desktop/renderer/src/App.tsx:3127-3155`<br>`apps/desktop/renderer/src/canvas/orgpicture.tsx:63` | credits, app-default-org-settings |
| `org-charter-md` | setting | `org:org.md` | Basic > org.md: the org charter every agent receives; saving restarts agents. Must cover: restart effect; trusted notes like Connect your phone. | `apps/desktop/renderer/src/App.tsx:3170` | charters, external-mail |
| `org-templates` | setting | `action:save-as-template` | Basic > save as template: what a template includes. Must cover: include options. | `apps/desktop/renderer/src/canvas/templates.tsx:66-184` | app-charters-and-templates, create-organization, dev-team |
| `org-hire-defaults-folders` | setting | `org:org_dirs`, `action:retire-all` | Hire defaults > Folders, and retire all agents. Must cover: folder defaults. | `apps/desktop/renderer/src/canvas/modals.tsx:416-426` | scope-and-permissions |
| `org-hire-defaults-scope` | setting | `org:default_visibility`, `org:permission_mode`, `org:default_account` | Hire defaults > visibility, file and command access, provider and account. Must cover: each default; engine default vs UI fallback for visibility. | `apps/desktop/renderer/src/canvas/modals.tsx:472-500` | visibility, account-lanes |
| `org-hire-defaults-tools` | setting | `org:default_tools`, `org:default_tools.orgtree`, `org:default_tools.mcp` | Hire defaults > native tools, Orgtree tool groups and MCP servers. Must cover: each group. | `apps/desktop/renderer/src/canvas/modals.tsx:509-518`<br>`apps/desktop/renderer/src/canvas/modals.tsx:898` | scope-and-permissions |
| `org-policies-compaction` | setting | `org:auto_cheap_compact.enabled`, `org:auto_cheap_compact.occ` | Policies > reset a session before a known-cold turn. Must cover: threshold. | `apps/desktop/renderer/src/App.tsx:3244-3256` | context-and-compaction |
| `org-policies-cost` | setting | `org:cascade_hire`, `org:cascade_alloc` | Policies > cost bubbling up the chain. Must cover: each switch. | `apps/desktop/renderer/src/App.tsx:3266-3271` | credits |
| `org-policies-inbox` | setting | `org:org_inbox_enabled`, `org:org_inbox_multi_holder` | Policies > outside communication through the org inbox. Must cover: each switch. | `apps/desktop/renderer/src/App.tsx:3276-3280` | org-inbox |
| `org-autonomy` | setting | `org:account_fallback_default`, `org:auto_resume` | Autonomy: automatic account switching and auto-resume of frozen agents. Must cover: each switch; resume now action. | `apps/desktop/renderer/src/App.tsx:2513-2549` | usage-freezes |
| `org-accounts` | setting | `org:disabled_accounts` | Accounts: which accounts this org may use. Must cover: per-account toggles. | `apps/desktop/renderer/src/orgaccounts.tsx:80` | account-lanes |
| `org-history` | setting | `screen:org-history` | History: the org's history browser (read-only; not undo). Must cover: what it lists. | `apps/desktop/renderer/src/history.tsx:17` | toasts-and-undo |
| `org-advanced` | setting | `screen:advanced-org` | The advanced org modal (legacy new-org form): General and Mail hub tabs. Must cover: fields. | `apps/desktop/renderer/src/shell/advancedorg.tsx:19` | create-organization |

#### Section `agent-settings` — `orgtree-app/agent-settings/` — writer agentsettings-sol

Agent settings (desk gear or agent menu > Settings): Charter, Model, Scope, Tools and conditional History tabs.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `agent-config` | setting | `node:rename`, `screen:agent-settings` | The agent settings window: name, agent actions, save and confirmations. Must cover: what save sends; provider-change confirmation. | `apps/desktop/renderer/src/canvas/modals.tsx:976`<br>`apps/desktop/renderer/src/canvas/modals.tsx:1286-1306` | team-shape |
| `agent-history-tab` | setting | `screen:agent-history` | Agent settings History tab: retained event records, shown only when records exist. Must cover: what kinds of records appear; difference from Chat; eligibility. | `apps/desktop/renderer/src/canvas/modals.tsx#AgentConfig`<br>`apps/desktop/renderer/src/canvas/historyview.tsx#HistoryView` | agent-config, desk-chat |
| `agent-charter-tab` | setting | `node:charter`, `node:team_charter` | Charter tab: instructions and team instructions. Must cover: delivery to the agent; node-local default-on peer-mail setting. | `apps/desktop/renderer/src/canvas/modals.tsx:1337-1340` | charters, peer-mail |
| `agent-model-tab` | setting | `node:tier`, `node:model_version`, `node:effort` | Model tab: tier, model version, thinking effort, pending model change. Must cover: pending changes. | `apps/desktop/renderer/src/canvas/modals.tsx:1343-1436` | tool-switch-model |
| `agent-account-tab` | setting | `node:account`, `node:account_fallback` | Model tab > account and switch-when-limited. Must cover: org default vs on/off. | `apps/desktop/renderer/src/canvas/modals.tsx:1392-1399` | account-lanes |
| `agent-fresh-start` | setting | `node:auto_cheap_compact` | Model tab > start fresh when needed, conversation size, current session. Must cover: defaults. | `apps/desktop/renderer/src/canvas/modals.tsx:1407-1418` | context-and-compaction |
| `agent-credit-grant` | setting | `node:grant` | Scope tab > credit grant slider. Must cover: limits. | `apps/desktop/renderer/src/canvas/creditgrant.tsx:138` | credits |
| `agent-visibility-access` | setting | `node:org_visibility`, `node:permission_mode`, `node:session` | Scope tab > visible agents, file and command access, and desktop session. Must cover: caps from superior. | `apps/desktop/renderer/src/canvas/modals.tsx:1448-1458` | visibility, scope-and-permissions |
| `agent-folders-tab` | setting | `node:add_dirs` | Scope tab > folders. Must cover: read-only vs writable. | `apps/desktop/renderer/src/canvas/modals.tsx:1462` | scope-and-permissions, folder-picker |
| `agent-tools-tab` | setting | `node:tools`, `node:tools.orgtree`, `node:tools.mcp` | Tools tab: native tools, Orgtree tool groups, MCP servers. Must cover: capped by superior. | `apps/desktop/renderer/src/canvas/modals.tsx:1508-1524`<br>`apps/desktop/renderer/src/canvas/modals.tsx:774` | scope-and-permissions, tool-request-scope |

#### Section `providers` — `orgtree-app/providers/` — writer providers-sol

Providers and accounts (App settings > Providers): sign-in, accounts, API-key fallback, OpenRouter and local servers, MCP servers, skills delivery and the usage windows.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `providers-tab` | setting | `api:providers/{id}/enabled`, `ls:orgtree-show-legacy-models` | Providers tab: enabling each provider for new agents, sign-in, status, tiers, legacy models. Must cover: per-provider row; sign-in flows. | `apps/desktop/renderer/src/canvas/accounts.tsx:478`<br>`apps/desktop/renderer/src/canvas/accounts.tsx:518`<br>`apps/desktop/renderer/src/canvas/accounts.tsx:355` | accounts-registry |
| `accounts-registry` | setting | `api:accounts/{id}/enabled`, `screen:add-account-dialog`, `screen:clear-account-mark-dialog` | Accounts: account rows, Active, adding (managed, profile folder, API key), removing, clearing marks. Must cover: each add path; marks. | `apps/desktop/renderer/src/canvas/accountsregistry.tsx:100`<br>`apps/desktop/renderer/src/canvas/accountsregistry.tsx:217`<br>`apps/desktop/renderer/src/canvas/accountsregistry.tsx:343` | account-lanes, tool-account-mark |
| `api-key-fallback` | setting | `api:providers/{id}/subscription-inference`, `api:providers/{id}/apikey-fallback` | Subscription inference and falling back to API-key accounts. Must cover: when it shows. | `apps/desktop/renderer/src/canvas/accounts.tsx:830-840` | accounts-registry |
| `openrouter` | setting | `setting:openrouter-models`, `setting:openrouter-keys`, `screen:openrouter-dialogs` | OpenRouter: hireable models, keys, spend caps and the model browser. Must cover: keys and caps. | `apps/desktop/renderer/src/canvas/openrouter.tsx:224`<br>`apps/desktop/renderer/src/canvas/openrouterkeys.tsx:40-132`<br>`apps/desktop/renderer/src/canvas/providerdialog.tsx:7`<br>`docs/rust-engine/openrouter-keys.md` | harness-opencode |
| `language-servers` | setting | `setting:language-servers`, `screen:langserver-dialogs` | Local language servers: adding, editing, agents at once, seat price. Must cover: every field. | `apps/desktop/renderer/src/canvas/langserver.tsx:354-418`<br>`apps/desktop/renderer/src/canvas/langserver.tsx:715-748` | harness-opencode |
| `mcp-servers` | concept | `api:mcp-servers/refresh`, `screen:mcp-refresh` | MCP servers: read-only discovery and import from every supported source, the Refresh button, collisions and redaction, and how servers are granted to agents. Must cover: each discovery source and format; refresh and caching; aliases on collision, secret redaction; grants: link to the tools-tab and hire-defaults leaves, do not restate. | `engine/rs/orgtree-engine/src/providers/mcp.rs`<br>`engine/rs/orgtree-engine/src/providers/mod.rs:126`<br>`engine/rs/orgtree-engine/src/http/settings.rs:745`<br>`apps/desktop/renderer/src/canvas/modals.tsx:795`<br>`apps/desktop/renderer/src/api.ts:508` | agent-tools-tab, org-hire-defaults-tools, skills-and-instructions |
| `skills-and-instructions` | concept | `concept:shared-skills`, `concept:global-instructions` | Skills and global instructions: built-in Orgtree skills, discovered user skills, global instruction files, how each harness receives them, and why edits change the startup prefix. Must cover: built-in vs discovered skills and name collisions; only categories registered; nested pages read by path; per-harness delivery (common contract once; harness leaves link here); global instructions; snapshot digest and prefix/cache effect; verified-lane instruction trim and separate Antigravity standing-note parts. | `agy-astra/skills-share: engine/rs/orgtree-engine/src/providers/skills.rs`<br>`agy-astra/skills-share: engine/rs/orgtree-engine/build.rs`<br>`agy-astra/skills-share: docs/rust-engine/shared-skills.md`<br>`engine/rs/orgtree-engine/src/runtime/identity.rs:145` | mcp-servers, harness-claude-code, cache-continuity |
| `usage-screens` | screen | `screen:usage-modal`, `screen:usage-history` | The Usage and Usage history windows. Must cover: bars, charts, sign-in prompts. | `apps/desktop/renderer/src/App.tsx:2234`<br>`apps/desktop/renderer/src/usagehistory.tsx:431` | usage-windows, tool-usage |

#### Section `harnesses` — `orgtree-app/harnesses/` — writer providers-sol

Every harness Orgtree runs agents on, and the routes through them: how each runs, reports, caches, compacts, loads instructions and skills, and how they differ.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `harness-comparison` | concept | `concept:harness-comparison` | Side-by-side table of every harness and route across the seven topics; each cell links to the harness page that is its home. Must cover: one row per topic, one column per harness/route; cells summarize and link; facts live on the harness pages; n/a and unknown stated explicitly; gotchas and workarounds: what silently goes wrong on this harness and how to avoid it; a gotchas column/row per harness, linking each gotcha's home. | `engine/rs/orgtree-engine/src/runtime/claude.rs`<br>`engine/rs/orgtree-engine/src/runtime/codex.rs`<br>`engine/rs/orgtree-engine/src/runtime/agy.rs`<br>`engine/rs/orgtree-engine/src/runtime/muse.rs`<br>`engine/rs/orgtree-engine/src/runtime/opencode.rs`<br>`engine/rs/orgtree-engine/src/runtime/acp.rs`<br>`engine/rs/orgtree-engine/src/runtime/actor.rs` | harness-claude-code, harness-codex, harness-antigravity, harness-muse, harness-opencode, route-openrouter, route-local-server, cache-continuity, context-and-compaction, skills-and-instructions |
| `harness-claude-code` | concept | `harness:claude-code` | Claude Code seats: tiers, auth lanes, skills, sandbox and quirks. Must cover: capabilities and limits; how it runs: process model, protocol, turn start/end, interrupt and shutdown, resume; what it reports and when: streaming text, thinking, tool start/end and real timings, token/usage figures, usage windows read, errors and rate-limit signals; caching: cached prefix, TTL by auth lane (unknown unless sourced), what breaks and what keeps the cache; compaction: native behaviour and threshold, what Orgtree does, what survives; instructions and skills: files read natively, size limits, how Orgtree delivers identity, skills and MCP; tools, permissions and sandbox, incl. Windows/Session 0; models, effort levels, quirks; state n/a or unknown explicitly, never guess; gotchas and workarounds: what silently goes wrong on this harness and how to avoid it. | `engine/rs/orgtree-engine/src/runtime/claude.rs`<br>`docs/provider-capability-evidence.md` | providers-tab |
| `harness-codex` | concept | `harness:codex-cli` | Codex seats: sandbox modes, read-only seats, limits. Must cover: capabilities and limits; how it runs: process model, protocol, turn start/end, interrupt and shutdown, resume; what it reports and when: streaming text, thinking, tool start/end and real timings, token/usage figures, usage windows read, errors and rate-limit signals; caching: cached prefix, TTL by auth lane (unknown unless sourced), what breaks and what keeps the cache; compaction: native behaviour and threshold, what Orgtree does, what survives; instructions and skills: files read natively, size limits, how Orgtree delivers identity, skills and MCP; tools, permissions and sandbox, incl. Windows/Session 0; models, effort levels, quirks; state n/a or unknown explicitly, never guess; gotchas and workarounds: what silently goes wrong on this harness and how to avoid it. | `engine/rs/orgtree-engine/src/runtime/codex.rs`<br>`docs/rust-engine/codex-sandbox-runner.md` | providers-tab |
| `harness-opencode` | concept | `harness:opencode` | OpenCode seats over ACP. Must cover: capabilities and limits; how it runs: process model, protocol, turn start/end, interrupt and shutdown, resume; what it reports and when: streaming text, thinking, tool start/end and real timings, token/usage figures, usage windows read, errors and rate-limit signals; caching: cached prefix, TTL by auth lane (unknown unless sourced), what breaks and what keeps the cache; compaction: native behaviour and threshold, what Orgtree does, what survives; instructions and skills: files read natively, size limits, how Orgtree delivers identity, skills and MCP; tools, permissions and sandbox, incl. Windows/Session 0; models, effort levels, quirks; state n/a or unknown explicitly, never guess; gotchas and workarounds: what silently goes wrong on this harness and how to avoid it. | `engine/rs/orgtree-engine/src/runtime/opencode.rs`<br>`docs/rust-engine/opencode-acp.md` | openrouter, language-servers |
| `harness-antigravity` | concept | `harness:antigravity`, `rt:antigravity_claude_enabled` | Antigravity seats, the flat mail tools, and enabling Claude models through Antigravity. Must cover: no-shell limits; Claude-through-Antigravity switch; how it runs: process model, protocol, turn start/end, interrupt and shutdown, resume; what it reports and when: streaming text, thinking, tool start/end and real timings, token/usage figures, usage windows read, errors and rate-limit signals; caching: cached prefix, TTL by auth lane (unknown unless sourced), what breaks and what keeps the cache; compaction: native behaviour and threshold, what Orgtree does, what survives; instructions and skills: files read natively, size limits, how Orgtree delivers identity, skills and MCP; tools, permissions and sandbox, incl. Windows/Session 0; models, effort levels, quirks; state n/a or unknown explicitly, never guess; gotchas and workarounds: what silently goes wrong on this harness and how to avoid it; instruction limits: 24 KB per file, 20k-token total; how Orgtree splits the identity into numbered always-on rule parts; native steer vs interrupt: which Orgtree tool or action maps to which native boundary. | `engine/rs/orgtree-engine/src/runtime/agy.rs`<br>`apps/desktop/renderer/src/canvas/accounts.tsx:865`<br>`docs/antigravity-provider-parity.md` | tool-message |
| `harness-muse` | concept | `harness:muse` | Muse seats: limits and usage reporting. Must cover: capabilities and limits; how it runs: process model, protocol, turn start/end, interrupt and shutdown, resume; what it reports and when: streaming text, thinking, tool start/end and real timings, token/usage figures, usage windows read, errors and rate-limit signals; caching: cached prefix, TTL by auth lane (unknown unless sourced), what breaks and what keeps the cache; compaction: native behaviour and threshold, what Orgtree does, what survives; instructions and skills: files read natively, size limits, how Orgtree delivers identity, skills and MCP; tools, permissions and sandbox, incl. Windows/Session 0; models, effort levels, quirks; state n/a or unknown explicitly, never guess; gotchas and workarounds: what silently goes wrong on this harness and how to avoid it. | `engine/rs/orgtree-engine/src/runtime/muse.rs`<br>`docs/rust-engine/muse-code.md` | usage-windows |
| `route-openrouter` | concept | `route:openrouter` | OpenRouter seats: which harness each key routes through (Claude Code, Codex or OpenCode), what that changes per topic, spend caps and reasoning. Must cover: how it runs: process model, protocol, turn start/end, interrupt and shutdown, resume; what it reports and when: streaming text, thinking, tool start/end and real timings, token/usage figures, usage windows read, errors and rate-limit signals; caching: cached prefix, TTL by auth lane (unknown unless sourced), what breaks and what keeps the cache; compaction: native behaviour and threshold, what Orgtree does, what survives; instructions and skills: files read natively, size limits, how Orgtree delivers identity, skills and MCP; tools, permissions and sandbox, incl. Windows/Session 0; models, effort levels, quirks; state n/a or unknown explicitly, never guess; which harnesses it runs through (Claude Code, Codex, OpenCode per harnesses.rs) and only the differences from each harness page; link them for the rest; gotchas and workarounds: what silently goes wrong on this harness and how to avoid it. | `engine/rs/orgtree-engine/src/openrouter.rs`<br>`engine/rs/orgtree-engine/src/runtime/actor.rs`<br>`docs/rust-engine/openrouter-keys.md`<br>`engine/rs/orgtree-engine/src/harnesses.rs` | openrouter, harness-opencode, harness-codex, harness-comparison, harness-claude-code |
| `route-local-server` | concept | `route:langserver` | Local language-server seats (e.g. llama.cpp): which harness they run through (Claude Code, Codex or OpenCode), agents-at-once limit, context size, no usage windows. Must cover: how it runs: process model, protocol, turn start/end, interrupt and shutdown, resume; what it reports and when: streaming text, thinking, tool start/end and real timings, token/usage figures, usage windows read, errors and rate-limit signals; caching: cached prefix, TTL by auth lane (unknown unless sourced), what breaks and what keeps the cache; compaction: native behaviour and threshold, what Orgtree does, what survives; instructions and skills: files read natively, size limits, how Orgtree delivers identity, skills and MCP; tools, permissions and sandbox, incl. Windows/Session 0; models, effort levels, quirks; state n/a or unknown explicitly, never guess; which harnesses it runs through (Claude Code, Codex, OpenCode per harnesses.rs) and only the differences from each harness page; link them for the rest; gotchas and workarounds: what silently goes wrong on this harness and how to avoid it. | `engine/rs/orgtree-engine/src/langserver.rs`<br>`engine/rs/orgtree-engine/src/runtime/actor.rs`<br>`engine/rs/orgtree-engine/src/harnesses.rs` | language-servers, harness-opencode, harness-codex, harness-comparison, harness-claude-code |
| `harnesses-tab` | setting | `screen:harnesses-tab` | Harnesses tab: installed harnesses and install guidance. Must cover: detection. | `apps/desktop/renderer/src/canvas/harnesses.tsx:71` | harness-claude-code, harness-codex |

#### Section `mailhub` — `orgtree-app/mailhub/` — writer comms-sol

The mail hub, org connections, Hubchat and the phone link.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `mailhub-hosting` | setting | `hub:name`, `hub:max_attachment_bytes`, `hub:port`, `hub:bind`, `hub:retention_days`, `hub:public_listener` | App settings > Mail hub: hosting, retention and the relay-only door. Must cover: each field and default; save behavior. | `apps/desktop/renderer/src/canvas/hosthub.tsx:130-191` | org-connections, tool-transfers |
| `org-connections` | setting | `org:net_autoconnect`, `org:net_hubs` | Org settings > Connections: the org's mail identity, hub connections and adding a hub. Must cover: identity and secret; adding a hub. | `apps/desktop/renderer/src/canvas/connections.tsx:103-160` | external-mail, tool-list-orgs |
| `phone-link` | setting | `hub:keep_awake`, `screen:phone-panel` | Connecting a phone: the phone panel, its setup steps and keep-awake. Must cover: steps; authority note it adds to org.md. | `apps/desktop/renderer/src/canvas/phonelink.tsx:184-317` | external-mail, hubchat |
| `hubchat` | concept | `surface:hubchat` | Hubchat, the human chat client for people and orgs on a mail hub (used from a phone or browser). Must cover: what the user sees and can do; how it maps to org mail and @net: addresses. | `docs/team-setup.md`<br>`docs/rust-engine/mailhub-v2-hosting.md` | phone-link |

### Category `orgtree-workflows` — `docs/skills/orgtree-workflows/SKILL.md`

Suggested workflow entry point: organise independent decisions, development teams and iterative releases.

#### Section `collaboration-patterns` — `orgtree-workflows/collaboration-patterns/` — writer skilltree-opus

Choose independent committee decisions, accountable development-team roles and an iterative release process.

| Leaf | Kind | Covers | Purpose | Ground truth | See also |
|---|---|---|---|---|---|
| `committee-mode` | concept | `workflow:committee-mode` | Different-model proposals, supervisor-only communication, consensus rounds and an undetermined result at the limit. Must cover: when requested by committee; different models and eligible accounts; reuse or hire with identical materials; no member contact in any round; written adoption/rejection reasons; identical supervisor clarifications; 10 rounds by default; undetermined at limit, never pick a winner; durable round records. | `User committee rulings 2026-10-16 23:03Z, 23:10Z and 23:12:59Z; publication request 2026-10-17 11:28Z`<br>`engine/rs/orgtree-engine/src/tools/defs.rs`<br>`engine/rs/orgtree-engine/src/domain/mail.rs` | dev-team, tool-hire, tool-rehire, tool-list-tiers, credits, tool-message, tool-audience, tool-work, tool-watchdog |
| `dev-team` | concept | `workflow:dev-team` | The bundled flat coordinator/implementer/redteam/curator layout, accountable ownership, review, evidence and adaptations. Must cover: roles and flat reporting shape; source template tiers and spare credits; coordinator/owner/author responsibility; current review phases and waivers win; docket, build queue and evidence references; no automatic build/review authorization; kickoff and template portability; adapt with one owner per piece. | `engine/docs/templates/devteam-claude.json`<br>`engine/docs/templates/devteam-codex.json`<br>`engine/docs/templates/devteam-antigravity.json`<br>`engine/docs/templates/devteam-muse.json`<br>`engine/docs/charters/coordinator.md`<br>`engine/docs/charters/implementer.md`<br>`engine/docs/charters/redteam.md`<br>`engine/docs/charters/curator.md`<br>`engine/rs/orgtree-engine/src/domain/templates.rs`<br>`docs/skills/orgtree-working/workspace/builds-under-the-lock/SKILL.md`<br>`docs/skills/orgtree-working/workspace/reviews-and-landing/SKILL.md` | committee-mode, tool-hire, delegating, tool-message, tool-audience, tool-work, tool-watchdog, builds-under-the-lock, reviews-and-landing, org-templates, create-organization, iterative-development |
| `iterative-development` | concept | `workflow:iterative-development` | Two-phase specification/feedback and hardening, release-line routing, feature freeze and exact-build delivery. Must cover: explicit user phase gates per release line; phase1 author checks and exact-SHA integration; alpha quick smoke without independent or combined rounds; phase2 static/exact-SHA independent review and combined base comparison; user question returns phase1 until renewed go-ahead; release notes/version/publication owner; patch and feature lines with both-line patch base and merge forward; feature freeze and retained last fixes; installer path/sha256/change list; explicit small-fix alpha waiver; all new bugs target next line after confirmed release; generic suggested workflow, no new authority. | `User development-phase rulings 2026-10-16 15:57Z, 15:58Z and 16:01Z; release-line ruling 2026-10-16 20:17Z; final-fix/release routing and publication request 2026-10-17 14:49-14:50Z`<br>`docs/skills/orgtree-working/workspace/reviews-and-landing/SKILL.md`<br>`docs/skills/orgtree-working/workspace/builds-under-the-lock/SKILL.md`<br>`docs/skills/orgtree-working/docket/tool-work/SKILL.md`<br>`docs/skills/orgtree-working/user/tool-send-file/SKILL.md` | dev-team, tool-work, reviews-and-landing, builds-under-the-lock, tool-send-file |

