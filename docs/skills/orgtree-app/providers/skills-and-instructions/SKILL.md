---
name: orgtree-skills-and-instructions
description: Explain built-in and imported skills, native delivery, instruction-file boundaries and pending sharing status.
---
Up: [orgtree-providers](../SKILL.md)

# Skills and instructions

This page separates the native instruction behavior in the library's `72ea305` source base from the pending cross-harness sharing pipeline. Shared skills were source-checked on unlanded `agy-astra/skills-share` at `a8b71bc`; personal global instructions were checked on unapproved `astra/global-instructions` at `8088df1`. These changes require composition and independent verification before delivery. This documentation pass did not run a harness or model; dated native-file observations below belong to the implementation owner's evidence, not a claim of end-to-end model use.

## Built-in guides and user skills

In the sharing pipeline, the engine build embeds every file under `docs/skills`; an installed engine does not need a source checkout to supply those resources. This large guide library registers only two category entries, `orgtree-working` and `orgtree-app`. Each section and leaf remains a nested directory with its own `SKILL.md`, read by following the parent page's links on demand.

Only category entry files enter native discovery roots. Their complete resource trees, including nested `SKILL.md` pages, live beside those roots; category entry links are retargeted and nested links keep their relative meaning. A recursive native loader therefore does not advertise every leaf description. Follow the delivered entry links rather than inventing paths from a developer checkout.

The importer accepts a top-level bundle from the source tree; it does not hard-code those two category names. The large library was excluded from the 4.3.0 release cut; that cut required only the standalone engine-start-mode guide. Do not infer this library is present from its source files or the app version alone.

Global imports require the corresponding harness to be installed. The pending pipeline reads:

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

Discovery skips malformed entries, linked bundles/resources, generated copies, `.git`, `.trash`, `.in_use` and `node_modules`. Bounds include 512 imported bundles, 64 MiB imported content, 8 MiB per file, 32 MiB per bundle and 2,048 entries per bundle, with bounded traversal depth. The public registry exposes aliases, source labels and a content digest; bodies, resources, native paths and plugin definitions remain private.

Discovery does not execute a skill, authenticate or change a native user configuration. Loading guidance does not itself authorize its scripts or external actions; apply the session's actual scope and instructions.

## Native delivery contract, pending integration

| Harness | Delivery in the sharing branch |
| --- | --- |
| Claude Code | `--add-dir` points to an immutable snapshot containing `.claude/skills`. |
| Codex | `skills/extraRoots/set` supplies the snapshot root before thread start or resume. |
| Antigravity and Muse | Owned copies go into the agent's `.agents/skills`; built-in resources live outside that recursive discovery root. |
| OpenCode 2.x | Explicit `skills` paths enter its private launch config; loading is permitted for each exact exported skill ID. |

OpenCode's `skills: []` means no additional roots, not a universal off switch for all native skills. Native contract evidence and fake-CLI configuration checks do not prove that a provider model will choose a skill or that older CLI versions accept the same APIs. Use the inventory and paths actually delivered to the current session.

Global discovery is cached at startup and explicit refresh. Launch planning combines it with the agent's applicable sources. Content-addressed snapshots are published immutably and retained for existing sessions. Workspace-only copies are replaced after the old process closes and before its successor starts; only owned copies are removed.

Refresh does not interrupt an active turn. A changed startup fingerprint applies the new set at the next launch boundary; unchanged content retains the same snapshot paths and bytes. Direct user edits in native folders can still be observed by a harness's own watchers. The shared Refresh button's partial-success behavior is documented in [MCP servers](../mcp-servers/SKILL.md).

## Instruction files and pending global sharing

In the `72ea305` base, native startup files and otherwise omitted scratch/granted `AGENTS.md` and legacy `CLAUDE.md` notes are accounted for separately. Native files are excluded from mirrored standing notes to avoid duplicate delivery. The harness pages explain their own native file selection; having a file on disk does not establish that another harness reads it.

The separate `astra/global-instructions` branch at `8088df1` implements a read-only snapshot of personal global notes. It is committed but not independently approved, composed or present in the library's source base. The earlier `71924ec` was its test-only baseline. The shared-skills branch alone does not provide this implementation; its presence in a private branch does not establish availability in a running app.

Its source contract supplies nonempty personal globals to every agent without requiring per-agent folder grants, leaving source files unchanged. Canonical identity deduplicates aliases. The snapshot excludes files the actual account/profile loads natively, including isolated Claude/Codex profile differences. Original readable text and its digest come from the same snapshot. Native CLI file/token limits still apply; supplied text is not proof that a model received or followed every byte.

| Source in `8088df1` | Selection and evidence boundary |
| --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/CLAUDE.md`, default `~/.claude/CLAUDE.md`, plus recursive Markdown rules without a `paths` restriction. Existing native-manifest evidence, checked against Claude Code 2.1.292. |
| Codex | `$CODEX_HOME/AGENTS.override.md`, otherwise `AGENTS.md`, default `~/.codex`. Shipped 0.160.0 instruction-file selection source; global override precedence is inferred from that contract. |
| Gemini CLI personal notes | `~/.gemini/GEMINI.md`, or simple filenames selected by user `settings.json` → `context.fileName`. `GEMINI_CLI_HOME` replaces home, so `.gemini` is appended to it. Comment-aware settings parsing and roots were inspected in shipped 0.57.0 source/docs. Importing these notes does not add Gemini CLI as an Orgtree runtime harness. |
| Antigravity | `~/.gemini/{GEMINI,AGENTS}.md`, `~/.gemini/config/{GEMINI,AGENTS}.md`, and unconditional Markdown under `~/.gemini/config/rules`. Shipped 1.3.5 customization/changelog evidence names those native roots; rules with an explicit non-`always_on` trigger remain on demand. Gemini's home override does not relocate these roots. |
| Muse | `$XDG_CONFIG_HOME/muse/AGENTS.md`, otherwise `CLAUDE.md`, default `~/.config/muse`. The owner observed canonical and absent-canonical fallback with pinned Muse 1.4.6, synthetic roots and an offline echo provider on 2026-10-15; no authenticated model request. |
| OpenCode | `$XDG_CONFIG_HOME/opencode/AGENTS.md`, default `~/.config/opencode/AGENTS.md`, from shipped 2.0.28 instruction-plugin/root resolution source. |

Muse launches in that branch set `context.foreign_personal_rules=false` without editing saved settings, preventing its foreign-personal-rule loader from supplying a second copy. The owner's offline `/rules` observation retained Muse's native fallback and workspace positive controls and showed the fixture Claude/Codex globals not read. This is native file-loading evidence, not a model-use test; Muse's separate foreign-skills setting is unaffected.

`POST /api/global-instructions/refresh` has no body and returns only `{ "files": N, "refreshed": true }`; the count includes canonical nonempty files even if a particular CLI loads them natively. Unreadable or invalid existing sources produce a sanitized error count, while readable sources remain usable. No instruction bodies or paths are returned by that endpoint. Startup takes fresh snapshots independently, so a button press is not required for the next permitted boundary to see an edit. An active turn or held process is not rewritten mid-turn; the next permitted process boundary resumes the same session with changed startup text and fingerprint.

For full evidence and composition limits, read `docs/rust-engine/global-instructions.md` in that implementation branch. Its documented pre-existing Antigravity project-note feedback issue is separate work; this global snapshot does not claim to fix managed scratch `AGENTS.md` overwrites or remove native truncation limits.

## Startup fingerprints and provider cache

In the sharing branch, launch planning, idle rechecks and cache forecasts use the same combined instruction-file and skill-content digest. Resource edits matter as well as entry-file edits. A changed digest can replace a parked process at the next boundary while retaining its conversation session; it changes startup input and may cost provider cache continuity.

A local process restart does not itself prove a provider miss. Unchanged snapshots show compatible input, not a guaranteed provider hit. Provider/account/model/session changes and changes to already-sent prompt content have their own namespace or prefix effects. See `orgtree-cache-continuity` (orgtree-working › accounts) for the receipt and freshness rules.

## See also

- [orgtree-mcp-servers](../mcp-servers/SKILL.md)
- [orgtree-harness-claude-code](../harness-claude-code/SKILL.md)
- See `orgtree-cache-continuity` (orgtree-working › accounts).
