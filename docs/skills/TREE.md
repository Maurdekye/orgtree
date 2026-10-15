# The built-in Orgtree skill tree

Design of the built-in Orgtree skill library: which skills exist, where each one lives,
what it covers and who writes it. `tree.json` beside this file is the machine-readable
manifest of the same tree; the coverage guard reads it. When the two disagree,
`tree.json` wins and this file is fixed.

Status of this revision: **v0, partial.** The conventions and every per-tool leaf are
FIXED (writers may start on them). Concept, screen and setting leaves, the category
descriptions and the coverage-guard spec arrive in the next revision.

Enumerated from source at `296deb0` (rust-engine local tip).

## Conventions (fixed)

- **Three levels.** Level 1 = category, level 2 = section, level 3 = leaf. Every node
  is its own folder holding one `SKILL.md`:
  `docs/skills/<category>/<section>/<leaf>/SKILL.md`.
- **Two categories**, the only skills registered for automatic discovery:
  `orgtree-working` (how to work inside an org: every tool, every rule and workflow) and
  `orgtree-app` (the desktop app: every screen, every setting, providers and accounts).
- **Folder names.** Category folders are the skill name (`orgtree-working`). Section
  and leaf folders are short kebab-case slugs, unique across the whole tree
  (`team`, `tool-hire`). The skill `name` of a section or leaf is `orgtree-<slug>`.
- **Frontmatter:** `name` and `description` only. The description is one sentence
  saying what the page answers. Levels 2 and 3 are not registered, so their
  descriptions are read only by the parent's child list.
- **Links are bundle-relative** (`../tool-message/SKILL.md`). Every SKILL.md starts
  its body with a parent line: `Up: [orgtree-team](../SKILL.md)`.
- **Parents list children**, one line each, in the order of their table here. A parent
  carries no facts of its own beyond orientation: every fact has exactly one home leaf,
  and every other page links to it.
- **Three hops:** category → section → leaf. No level 4.
- **Never name or describe EPIC Mode** in any name, heading, description or child
  list. It appears only as one offhand note inside the Developer settings leaf.

## Category `orgtree-working`

### Section `team` — `orgtree-working/team` (writer: org-sol)

| Leaf | Covers | Purpose |
|---|---|---|
| `tool-hire` | `orgtree_hire` | Hire a subordinate or insert a superior: tiers, harnesses, scope, charter, credits. |
| `tool-rehire` | `orgtree_rehire` | Bring back a retired agent with its context. |
| `tool-retire` | `orgtree_retire` | Retire an agent below you; what survives retirement. |
| `tool-dissolve` | `orgtree_dissolve` | Retire an agent together with its whole team. |
| `tool-retool` | `orgtree_retool` | Change an agent's folders, tools, permission mode or charter. |
| `tool-switch-model` | `orgtree_switch_model` | Move an agent below you to another tier/model. |
| `tool-move` | `orgtree_move` | Reparent an agent within your subtree. |
| `tool-rename` | `orgtree_rename` | Rename an agent below you. |
| `tool-reorder` | `orgtree_reorder` | Set a descendant's position among its siblings. |
| `tool-reallocate` | `orgtree_reallocate` | Give credits to or take them from a report. |
| `tool-swap` | `orgtree_swap` | Swap the seats of two agents below you. |
| `tool-self-subjugate` | `orgtree_self_subjugate` | Step down so a descendant takes your seat. |
| `tool-list-tiers` | `orgtree_list_tiers` | Model tiers you can hire on and their seat prices. |

### Section `docket` — `orgtree-working/docket` (writer: org-sol)

| Leaf | Covers | Purpose |
|---|---|---|
| `tool-work` | `orgtree_work` | Every docket action, its arguments, refusals and retired actions. |
| `tool-staff` | `orgtree_staff` | Create/update an item and hire or rehire its owner in one call. |

### Section `mail` — `orgtree-working/mail` (writer: comms-sol)

| Leaf | Covers | Purpose |
|---|---|---|
| `tool-message` | `orgtree_message` | Send mail: recipients, kinds, options, attachments, urgent, replies; the flat variant. |
| `tool-send-notice` | `orgtree_send_notice` | Passive mail that wakes nobody. |
| `tool-inbox` | `orgtree_inbox` | Read your own mail: list, fetch, chunk, conversation. |
| `tool-audience` | `orgtree_audience` | Request, grant, deny, revoke audiences outside the chain. |
| `tool-transfers` | `orgtree_transfers` | Inspect and control attachment transfers. |
| `tool-list-orgs` | `orgtree_list_orgs` | Other organizations reachable as `@org:` and `@net:`. |

### Section `user` — `orgtree-working/user` (writer: comms-sol)

| Leaf | Covers | Purpose |
|---|---|---|
| `tool-ask` | `orgtree_ask` | Question cards to the user (or the superior without a user audience). |
| `tool-withdraw-ask` | `orgtree_withdraw_ask` | Withdraw your open question card. |
| `tool-present` | `orgtree_present` | Present a document for the user to read. |
| `tool-send-file` | `orgtree_send_file` | Deliver a file as a download card. |
| `tool-request-credits` | `orgtree_request_credits` | Ask the user for a larger credit grant. |
| `tool-request-scope` | `orgtree_request_scope` | Ask for more folders, tools, MCP servers or a permission mode. |

### Section `runtime` — `orgtree-working/runtime` (writer: runtime-sol)

| Leaf | Covers | Purpose |
|---|---|---|
| `tool-status` | `orgtree_status` | Report working/done/blocked/idle; always available. |
| `tool-interrupt` | `orgtree_interrupt` | Stop a report's current turn. |
| `tool-halt` | `orgtree_halt` | Halt agents below you. |
| `tool-unhalt` | `orgtree_unhalt` | Release halted agents. |
| `tool-unstick` | `orgtree_unstick` | Release a usage-limit freeze. |
| `tool-cheap-compact` | `orgtree_cheap_compact` | Restart an agent on a fresh session with a summary. |

`orgtree_cheap_compact` is in tool group `team` but lives here, beside the other
session-lifecycle tools. Its leaf states the group.

### Section `watchdogs` — `orgtree-working/watchdogs` (writer: runtime-sol)

| Leaf | Covers | Purpose |
|---|---|---|
| `tool-watchdog` | `orgtree_watchdog` | Persistent watchers that mail you: every kind and action. |

### Section `inspection` — `orgtree-working/inspection` (writer: runtime-sol)

| Leaf | Covers | Purpose |
|---|---|---|
| `tool-chart` | `orgtree_chart` | The org chart within your visibility. |
| `tool-state-inspect` | `orgtree_state_inspect` | Structured agent state: folders, tools, permission mode. |
| `tool-read-transcript` | `orgtree_read_transcript` | Read the conversation of yourself or a descendant. |
| `tool-read-scratch` | `orgtree_read_scratch` | Browse or read a descendant's working folder. |

### Section `accounts` — `orgtree-working/accounts` (writer: providers-sol)

| Leaf | Covers | Purpose |
|---|---|---|
| `tool-usage` | `orgtree_usage` | Provider usage readings, filters and refresh rules. |
| `tool-continue-on` | `orgtree_continue_on` | Move a frozen agent to another account of the same provider. |
| `tool-account-mark` | `orgtree_account_mark` | Inspect or clear an account's capacity mark. |

`orgtree_continue_on` and `orgtree_account_mark` are in tool group `runtime` but live
with the account tools; their leaves state the group.

### What every tool leaf covers

When to use it and when not; every parameter and action with defaults and limits as
the definition states them; the refusals and error texts agents actually hit;
differences for top-level agents; the tool group that gates it; one minimal correct
call. Ground truth: the tool's entry in `engine/rs/orgtree-engine/src/tools/defs.rs`,
its handler (listed per node in `tree.json`) and `required()` in
`engine/rs/orgtree-engine/src/domain/tool_groups.rs`.

Count check: 13 + 2 + 6 + 6 + 6 + 1 + 4 + 3 = 41 = the names in `implemented()`
(`defs.rs:8-51`).
