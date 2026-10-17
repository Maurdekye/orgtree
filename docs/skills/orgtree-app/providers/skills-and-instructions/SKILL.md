---
name: orgtree-skills-and-instructions
description: Explain built-in and imported skills, native delivery, instruction-file boundaries and Refresh.
---
Up: [orgtree-providers](../SKILL.md)

# Skills and instructions

Shared skills and personal global instructions are implemented in the integrated source at `de6d356` (including global instructions from `7f5f27f`). This page describes that source contract. This documentation pass did not run a harness or model; native-file observations below belong to the implementation owner's dated evidence. Source inclusion and emitted native bindings do not prove that a model chose or followed a skill.

## Built-in guides and user skills

The built-in Orgtree skill library is also called the glossary or Orgtree Encyclopaedia (encyclopedia). These are aliases for the same guides, with `orgtree-working`, `orgtree-app` and `orgtree-workflows` entry points; imported user skills are separate bundles.

In the sharing pipeline, the engine build embeds every file under `docs/skills`; an installed engine does not need a source checkout to supply those resources. This large guide library registers only three category entries: `orgtree-working` for tools and operating rules, `orgtree-app` for screens and settings, and `orgtree-workflows` for suggested team workflows. Each section and leaf remains a nested directory with its own `SKILL.md`, read by following the parent page's links on demand.

Only category entry files enter native discovery roots. Their complete resource trees, including nested `SKILL.md` pages, live beside those roots; category entry links are retargeted and nested links keep their relative meaning. A recursive native loader therefore does not advertise every leaf description. Follow the delivered entry links rather than inventing paths from a developer checkout.

### Short built-in instructions

On harness lanes listed in `runtime/identity.rs::SKILL_LANES`, Orgtree supplies shorter engine-written instructions with pointers into this library. Authority, safety and other rules that must apply before opening a guide remain inline, together with the docket summary. Open the named guide before first acting on its area in a session; read the docket pages before writing an item. Lanes without verified library delivery keep the full instructions.

This trim does not shorten the user's standing notes, charters or personal global instructions. On Antigravity, standing notes start their own numbered always-on rule part after the engine rules, splitting further when needed. The existing per-file and aggregate native limits still apply; separate parts do not create an unlimited notes budget. See the [Antigravity guide](../../harnesses/harness-antigravity/SKILL.md#instructions-and-skills).

The focused synthetic proof is `tools/rig/proofs/instructions-trim-skills.mjs`: fake agents open a category, follow a section link and read a leaf through their native bindings, while the proof compares every resource with the built-in source. This establishes synthetic delivery and access. It does not establish real-model guide selection, obedience or compatibility with every native CLI version.

The importer accepts a top-level bundle from the source tree; it does not hard-code the category names. The library is included in the 4.3.0 release scope. Its landing moves the standalone engine-start-mode guide into its category and removes the old copy. Use the catalog and resources supplied to the current session to establish availability.

Global imports require the corresponding harness to be installed. The pipeline reads:

| Source | Global skill roots |
| --- | --- |
| Claude Code | `~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills` |
| Codex | `~/.agents/skills` and `$CODEX_HOME/skills` (default `~/.codex/skills`), including `.system` |
| Antigravity | `~/.gemini/antigravity-cli/skills`, `~/.gemini/config/skills`, `~/.gemini/antigravity/skills` |
| Muse | `$XDG_CONFIG_HOME/muse/skills` (default `~/.config/muse/skills`) and `~/.agents/skills` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/{skills,skill}` (default under `~/.config`), `$OPENCODE_CONFIG_DIR/{skills,skill}`, and additional `skills` roots declared in that config directory's JSON/JSONC files |

Per-agent discovery additionally checks `.claude/skills`, `.agents/skills`, `.codex/skills`, `.agent/skills`, `.opencode/skills` and `.opencode/skill` in its scratch and explicitly granted folders. These local bundles do not enter the app-wide inventory or another agent's exports. Installed Claude-plugin skills come from the recorded installed-plugin registry and applicable package manifests, not a marketplace scan. Project-scoped plugin skills remain agent-scoped.

## Bundle identity and boundaries

A bundle contains a UTF-8 `SKILL.md` with `name` and `description` frontmatter plus its relative resources. OpenCode's flat Markdown form is also accepted with sibling resources. Native exports normalize the advertised name without rewriting source files. Identity includes the complete bundle's bytes and Unix executable modes; matching names or headers alone do not establish equality.

Identical bundles combine source labels. Different content with the same normalized name receives a deterministic source suffix, with numeric disambiguation when necessary; built-ins keep their plain names first. Workspace exports use reserved `orgtree-` aliases and ownership markers. An existing user-created destination is not overwritten.

At an agent's launch boundary, the shared inventory is filtered for its actual harness. A named harness suffix (such as `-codex`, optionally with a numeric copy suffix) selects that variant when the family has another member. Prefer the explicit matching variant, then that harness's unsuffixed native source, then a generic fallback. A guide without an alternative remains available on every harness. Distinct equally preferred same-source bundles keep their collision aliases and resources. The complete global inventory and user files remain unchanged; built-in category names stay reserved. Independently discovered native-only skills remain governed by the CLI.

Launch, idle refresh checks and next-turn forecasts use the same selected content digest. A change only to an unselected variant does not reset another harness's skill prefix; changed selected content still takes effect at the normal process boundary. Availability and a stable digest do not guarantee provider prompt-cache hits or that a model chooses a guide.

Claude Code also discovers native skills independently of the synced export. A bare shared copy is omitted when identical bundle content is available in the launching account's native synced bucket, or through an enabled installed plugin for that profile and working directory. Account metadata selects the matching org bucket; missing or unknown metadata, absent buckets and disabled plugins keep the fallback. Different resource content remains distinct. Claude seats omit the Codex-only `openai-docs`, `imagegen` and `skill-installer` families; other unpaired portable skills remain available. User skill files and plugin settings are not changed.

For startup diagnostics, a native `prompt_snapshot` records system and tool inputs; it is not an additional model-input message. Count a rendered attachment once, rather than both its structured and rendered copies. Repeated assistant blocks can share one provider usage record, and diagnostic tool descriptions may be clipped. Byte-based token estimates are not provider counts for individual components.

Discovery skips malformed entries, linked bundles/resources, generated copies, `.git`, `.trash`, `.in_use` and `node_modules`. Bounds include 512 imported bundles, 64 MiB imported content, 8 MiB per file, 32 MiB per bundle and 2,048 entries per bundle, with bounded traversal depth. The public registry exposes aliases, source labels and a content digest; bodies, resources, native paths and plugin definitions remain private.

Discovery does not execute a skill, authenticate or change a native user configuration. Loading guidance does not itself authorize its scripts or external actions; apply the session's actual scope and instructions.

## Snapshot retention

Background cleanup is best effort. It keeps the current global snapshot, the newest other complete snapshot (including timestamp ties), and snapshots referenced by live sessions, working folders, explicit grants or managed CLI and keepalive launch folders. Warm processes retain their launch references. Startup, Refresh, successful launches and provider maintenance schedule the sweep; these events do not guarantee a disk-space reduction.

Older sessions without a recorded snapshot binding defer cleanup. On their next resumed launch, all existing snapshot paths are conservatively associated with that session and can remain protected until the session is replaced or the agent retires. A new session does not inherit that legacy set. An engine restart alone therefore need not free disk space. Read errors and reference limits also defer cleanup rather than assume disuse.

The sweep removes only owned, complete, link-free direct snapshots in the shared-skills namespace, plus unreferenced owned staging directories older than one hour. It does not scan arbitrary OS processes or prune each agent's `.agents` workspace copies. See the retention contract in `docs/rust-engine/shared-skills.md`; implementation: `providers/skills/retention.rs`.

## Native delivery contract

| Harness | Native delivery |
| --- | --- |
| Claude Code | `--add-dir` points to an immutable snapshot containing `.claude/skills`. |
| Codex | `skills/extraRoots/set` supplies the snapshot root before thread start or resume. |
| Antigravity and Muse | Owned copies go into the agent's `.agents/skills`; built-in resources live outside that recursive discovery root. |
| OpenCode 2.x | Explicit `skills` paths enter its private launch config; loading is permitted for each exact exported skill ID. |

OpenCode's `skills: []` means no additional roots, not a universal off switch for all native skills. Native contract evidence and fake-CLI configuration checks do not prove that a provider model will choose a skill or that older CLI versions accept the same APIs. Use the inventory and paths actually delivered to the current session.

Global discovery is cached at startup and explicit refresh. Launch planning combines it with the agent's applicable sources. Content-addressed snapshots are published immutably and retained for existing sessions. Workspace-only copies are replaced after the old process closes and before its successor starts; only owned copies are removed.

Refresh does not interrupt an active turn. A changed startup fingerprint applies the new set at the next launch boundary; unchanged content retains the same snapshot paths and bytes. Direct user edits in native folders can still be observed by a harness's own watchers. The shared Refresh button's partial-success behavior is documented in [MCP servers](../mcp-servers/SKILL.md).

## Instruction files and global sharing

Native startup files and otherwise omitted scratch/granted `AGENTS.md` and legacy `CLAUDE.md` notes are accounted for separately. Native files are excluded from mirrored standing notes to avoid duplicate delivery. The harness pages explain their own native file selection; having a file on disk does not establish that another harness reads it.

Personal global instructions use a read-only snapshot, integrated at `7f5f27f` and composed with shared skills at `de6d356`. The runtime/endpoint implementation was independently approved; the library's composed delivery receipt is a separate check. No source-status claim establishes availability in an older installed build.

Its source contract supplies nonempty personal globals to every agent without requiring per-agent folder grants, leaving source files unchanged. Canonical identity deduplicates aliases. The snapshot excludes files the actual account/profile loads natively, including isolated Claude/Codex profile differences. Original readable text and its digest come from the same snapshot. Native CLI file/token limits still apply; supplied text is not proof that a model received or followed every byte.

| Personal source | Selection and evidence boundary |
| --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/CLAUDE.md`, default `~/.claude/CLAUDE.md`, plus recursive Markdown rules without a `paths` restriction. Existing native-manifest evidence, checked against Claude Code 2.1.292. |
| Codex | `$CODEX_HOME/AGENTS.override.md`, otherwise `AGENTS.md`, default `~/.codex`. Shipped 0.160.0 instruction-file selection source; global override precedence is inferred from that contract. |
| Gemini CLI personal notes | `~/.gemini/GEMINI.md`, or simple filenames selected by user `settings.json` → `context.fileName`. `GEMINI_CLI_HOME` replaces home, so `.gemini` is appended to it. Comment-aware settings parsing and roots were inspected in shipped 0.57.0 source/docs. Importing these notes does not add Gemini CLI as an Orgtree runtime harness. |
| Antigravity | `~/.gemini/{GEMINI,AGENTS}.md`, `~/.gemini/config/{GEMINI,AGENTS}.md`, and unconditional Markdown under `~/.gemini/config/rules`. Shipped 1.3.5 customization/changelog evidence names those native roots; rules with an explicit non-`always_on` trigger remain on demand. Gemini's home override does not relocate these roots. |
| Muse | `$XDG_CONFIG_HOME/muse/AGENTS.md`, otherwise `CLAUDE.md`, default `~/.config/muse`. The owner observed canonical and absent-canonical fallback with pinned Muse 1.4.6, synthetic roots and an offline echo provider on 2026-10-15; no authenticated model request. |
| OpenCode | `$XDG_CONFIG_HOME/opencode/AGENTS.md`, default `~/.config/opencode/AGENTS.md`, from shipped 2.0.28 instruction-plugin/root resolution source. |

Muse launches set `context.foreign_personal_rules=false` without editing saved settings, preventing its foreign-personal-rule loader from supplying a second copy. The owner's offline `/rules` observation retained Muse's native fallback and workspace positive controls and showed the fixture Claude/Codex globals not read. This is native file-loading evidence, not a model-use test; Muse's separate foreign-skills setting is unaffected.

`POST /api/global-instructions/refresh` has no body and returns only `{ "files": N, "refreshed": true }`; the count includes canonical nonempty files even if a particular CLI loads them natively. Unreadable or invalid existing sources produce a sanitized error count, while readable sources remain usable. No instruction bodies or paths are returned by that endpoint. Startup takes fresh snapshots independently, so a button press is not required for the next permitted boundary to see an edit. An active turn or held process is not rewritten mid-turn; the next permitted process boundary resumes the same session with changed startup text and fingerprint.

For full evidence and composition limits, read `docs/rust-engine/global-instructions.md`. The separate Antigravity own-notes fix is approved at `3454e80` and integrated at `0f41fc3`: native project notes remain separate from numbered generated identity rules, with byte-preserving backup of recognized old envelopes. Its global/project manifest retains the combined skill digest. Read the [Antigravity guide](../../harnesses/harness-antigravity/SKILL.md#instructions-and-skills) for migration caveats and native truncation limits; splitting does not raise the aggregate rules budget.

## Startup fingerprints and provider cache

Launch planning, idle rechecks and cache forecasts use the same combined instruction-file and skill-content digest. Resource edits matter as well as entry-file edits. A changed digest can replace a parked process at the next boundary while retaining its conversation session; it changes startup input and may cost provider cache continuity.

A local process restart does not itself prove a provider miss. Unchanged snapshots show compatible input, not a guaranteed provider hit. Provider/account/model/session changes and changes to already-sent prompt content have their own namespace or prefix effects. See `orgtree-cache-continuity` (orgtree-working › accounts) for the receipt and freshness rules.

## See also

- [orgtree-mcp-servers](../mcp-servers/SKILL.md)
- [orgtree-harness-claude-code](../../harnesses/harness-claude-code/SKILL.md)
- See `orgtree-cache-continuity` (orgtree-working › accounts).
