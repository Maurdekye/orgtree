---
name: orgtree-org-templates
description: Explain Save as template, include choices, replacement and portability limits.
---

Up: [orgtree-org-settings](../SKILL.md)

# Save as template

**Org settings > Basic > Templates > save as template…** opens
`action:save-as-template`. It saves this org's live agent layout into a JSON
file in `~/.orgtree/templates`, independently of the footer Save. It reads the
current stored org, not unsaved edits in the settings panel. Agents suggest
using it; the user saves or replaces templates.

**Template name** starts as `<org name> layout` and must contain letters or
digits after normalization. **Description** is optional, starts empty, and
appears in the creation picker's list. Tree, names and tiers are always included.

| Include choice | Initially checked | Content |
| --- | --- | --- |
| Charters, team charters and project Summary | Yes | Agent instructions, team instructions and project Summary. |
| Credits | Yes | Each agent's spare credits. |
| Effort, fast mode and harness pin | Yes | Saved effort and explicit fast-mode booleans, plus explicitly pinned OpenRouter harnesses. An unpinned harness stamp is not exported. |
| Tool switches, visibility and permission mode | Yes | Saved scope controls. |
| org.md | Yes | Org charter content. |
| Quick chat defaults | Yes | Starting superior, model and effort. A superior absent from the saved live layout becomes top level. |
| Org defaults and project queue/event settings | Yes | Portable org grant/default/compaction/resume settings plus each project's queue mode, sender exclusion, ACK timeout/attempt/reminder policy and event-listener switch. Excludes folders, accounts and hubs. |
| Include watchdogs | Yes | Armed/paused definitions owned by saved agents; node targets remap to the new layout. No runtime history or credentials. |
| Include machine-specific watchdogs | No | Sub-choice under watchdogs: file, command, process, stream, MQTT and WebSocket. Recreated paused; check the targets before resuming. |
| Include audiences | Yes | Active explicit directional grants between saved nodes, plus user and extern grants. Inherited/project-derived routes come from structure. |
| Account binding | No | Preferred accounts and saved per-agent fallback overrides; where an account is unavailable at creation, another runnable account is selected. |
| Folder scopes | No | Machine-specific agent folders, trimmed to folders held by the new org when used. |
| Scratch AGENTS.md files | No | Copies this org's shared, team/project and personal standing notes into the template file. Include only secret-free text; limits and refusals are below. |

An unticked group takes normal hire defaults when the template is used. Mail,
docket items, transcripts and watchdog runtime history are never copied. Live agents and projects are saved; a node without a live saved parent becomes top level. Project Summary is included with charters; its slots and peer-mail policy retain the structural configuration. Projects are free and pass funding through to the nearest agent; the saved spare-credit calculation accounts for their descendants.

## Watchdogs and audiences

The preview shows watchdog counts per node and lists each node's explicit audience grants, including **user** and **outside mail**, before creation. Renaming a node remaps watchdog owners, activity/project targets and both ends of audience grants. Removing a node drops its dogs and any dog or grant whose endpoint is absent, with warnings in the preview and creation result. Event-name targets and the literal usage target stay unchanged; usage account IDs remain as saved and scoped account eligibility is checked again during restoration.

Watchdogs keep silence/quiet period, once, notice, intervals, filters and secret-free fire actions. Clocks, output, events, queue position, leases and sealed secret rows are never exported. Credential objects and credential-file paths are never copied. A fire-action entry containing credentials anywhere inside it is removed as a whole with a warning. Its parent dog, and any network dog whose credentials were removed, is marked **needs credentials**, stays paused and must be recreated with credentials before use. Recognizable credential material in other definition text causes that dog to be omitted with a warning; review arbitrary command/message text before sharing a template.

Creation restores audiences after all nodes exist through normal grant checks in the node transaction. Grants provide contact only, never tools or folders; org-inbox eligibility and multi-holder policy still apply. It then stages dogs paused after commit and before warm/first-message effects, without command/network smoke or immediate one-shot/fire-action effects. Eligible portable dogs arm only after all imported rows exist, and evaluate normally once armed. They can wake agents even when the first-message checkbox is off. Saved-paused, machine-specific and credential-dependent dogs stay paused with a reason. A per-dog restore refusal leaves the organization created and appears as a visible warning.

There is no template agent tool. Existing HTTP/file/shell parity remains: POST /api/orgs/{slug}/template accepts include.watchdogs (default true), include.machine_watchdogs (default false, effective only with watchdogs), and include.audiences (default true). Template JSON adds watchdogs as owner/args/paused/needs_credentials definitions, audiences as grantee/grantor pairs (grantor is the contact destination), and warnings. POST /api/templates/resolve previews the remapped definitions; POST /api/orgs recreates the selected template. Normal agent tools manage the recreated watchdogs and audiences within existing permissions.

**Save template** is disabled with a blank name or while busy. An org with no
live agents is refused. A normalized filename collision is refused first and
offers **Replace it**, which overwrites that template file only after the user
chooses it. Filesystem failures remain visible for retry.

Saving can succeed while reporting **This template cannot be used as saved**.
The saver reads the complete live layout through keyset paging. Template validation
has no node-count or tree-depth limit and reports other layout problems. A saved JSON file
is not proof that its model/account choices can run on a different computer.

After saving, the dialog shows filename, agent count and path, with **Download**,
**open templates folder** and **close**. The file is offered under Starting
layout when creating an org. Suggest this for reusing a known team structure;
leave machine-specific groups off for portable layouts.

## Optional standing-notes copies

Template list/preview/save HTTP request and response bodies are omitted from wire diagnostics with verbose logging both off and on, including rejected requests and unknown child routes in those endpoint families. Request paths and status remain logged. This does not remove copied text from the returned downloadable template or its saved file; review those files before sharing them. Creation selects a stored template by id and returns copy counts/warnings, not note contents.

The save checkbox is off by default. It reads only AGENTS.md from this org's shared scratch, each live node's ID-based team/project folder, and each live agent's stored personal scratch within this org. It never walks arbitrary folders, reads other scratch files or imports another org's notes. Absent files add no field. Linked/reparse paths, non-regular files, invalid UTF-8, NUL, files over 16,000 UTF-8 bytes or more than 128,000 bytes combined refuse the save. Recognizable credential assignments, bearer tokens, private-key headers and common API-token forms are refused; this guard cannot prove arbitrary prose contains no secret. Review text before opting in. The complete UTF-8 template file is capped at 16 MiB as a parse-safety bound; a larger file is refused with that limit in the message, never truncated. A refusal writes no new template file.

Portable template fields are shared_agents_md on the template, plus team_agents_md and scratch_agents_md on an agent slot; a project may carry team_agents_md but has no personal note. Values are UTF-8 text, never filenames. A slot with tier=project represents a container with optional description (Summary), slots (0–9,999,999) and peer_mail (always copied with the layout). Its optional settings object carries mail_queue (round_robin or ack), exclude_sender, ack_timeout, max_attempts (1–100), ack_reminders (1–10), turn_end_reminder and event_listeners. Creation validates and applies these through normal configure_project operations. Agent slots may request user or extern audiences explicitly through the usual atomic hire checks; the separate Include audiences choice also captures explicit grants as described above. They grant contact only, not tool/folder rights. Project slots cannot carry model, credit, audience or other agent settings, and cannot be switched into a model through picker overrides.

Creation writes supplied note text into the new org's matching folders after the node transaction commits and before its warm/kickoff effects. It creates missing directories and uses create-new files, never overwriting an existing AGENTS.md. Missing fields add no template note; normal header seeding still applies. The response reports created/existing counts and any copy warnings. If a file write fails, the org remains created and the creation view shows the warning with an Open organization button; inspect its notes before starting work. The preview distinguishes free project rows from agent seats and shows how many AGENTS.md files will be copied. Removing a slot also removes its subtree and its notes from creation; renamed nodes get the correct new personal/team locations.

## Heavy dev shop

This bundled layout mimics the structure of the org used to develop Orgtree itself for significant software projects. It has an Opus/medium Liaison over an Opus/medium coordinator, with eleven developers using the Developer preset (three each on Opus, Sol and Astra, plus Sonnet and Argon), a Sol/high test-rig engineer and a Sol/high curator under a three-slot build project with peer mail ON. The Liaison owns conversation; the coordinator has an explicit user audience and retains execution and staffing. Five developers use medium effort, the three Sol developers and Argon use high, and exactly one Opus and one Astra developer use max. These named seat choices override the general effort defaults in the inherited notes. Fifteen agent seats cost 64 credits at the bundled catalog rates, plus 20 spare (84 total); the actual preview uses the current offered seats/accounts. No private paths or account names are supplied. Missing models must be replaced or left out before creation; there are no silent cross-provider fallbacks.

Generic operating practices live once at the widest shared level that needs them. Every agent inherits org-wide AGENTS.md; development-team notes add only development policy, build-project notes add only resource protocol, and personal notes add only role-specific procedures or refer upward. Short charters summarize roles without repeating these rules. The template starts in specification/feedback, requires user go-ahead for hardening and leaves the first message off until selected. The coordinator/test-rig engineer establish machine-specific resource floors and output roots before heavy work. See orgtree-dev-team (orgtree-workflows › collaboration-patterns) for the workflow. Existing four small templates stay unchanged; Restore default templates also restores a missing Heavy dev shop file without overwriting local edits.

## See also

- [orgtree-app-charters-and-templates](../../app-settings/app-charters-and-templates/SKILL.md).
- [orgtree-create-organization](../../app-shell/create-organization/SKILL.md).

For the roles and workflow behind the bundled layouts, see `orgtree-dev-team` (orgtree-workflows › collaboration-patterns).

## Deep layouts and portable choices

Files retain nested version-1 agents/reports JSON. There is no node or level limit; only the 16 MiB file bound applies. Internally the engine owns a flat node list and uses iterative parsing, planning and export, so deep trees also clone and drop without recursive ownership. Other JSON parsers keep their normal limits. Older 4.4.1 readers keep their own restrictions: their validator allows four tree levels and their default parser accepts 63 tree levels, refusing 64. They cannot open a 5,000-level template. An unknown format version is refused with a clear version message.

The creation preview displays 100 nodes per page with Previous 100/Next 100. Large depths show the actual level and parent while visual indentation is capped. All nodes remain in the creation plan. A saved fast_mode=true that the chosen model cannot support blocks creation until turned off or the model is changed; explicit false is preserved. An unavailable explicit OpenRouter harness pin is shown and blocks creation until an installed harness is selected. Selecting a different provider removes the inapplicable OpenRouter pin with a preview note.

HTTP/file parity: include.effort controls effort, fast_mode and the explicit harness pin; include.settings controls org defaults and the project queue/event settings. Agent slots use fast_mode and harness; project slots use settings. POST /api/templates/resolve and POST /api/orgs accept per-slot overrides.fast_mode and overrides.harness along with the existing tier/name overrides. The same canonical speed, harness and configure_project checks run at creation. Slots capacity and peer_mail remain part of the always-copied project layout.

Creation applies the complete node layout in one transaction and records its net inherited-audience notices once. Explicit grant restoration still follows the node steps through the normal grant checks and notices. A refused creation rolls back the nodes and their notices together; mailbox updates publish only after commit.
