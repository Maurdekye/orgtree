---
name: orgtree-skills-and-instructions
description: Explain built-in and imported skills, native delivery, instruction-file boundaries and pending sharing status.
---
Up: [orgtree-providers](../SKILL.md)

# Skills and instructions

This page separates the native instruction behavior at source base `b77512f` from the pending cross-harness sharing pipeline. The shared-skills contract below was source-checked on unlanded `agy-astra/skills-share` at `a8b71bc`; it requires composition, compilation and independent verification before delivery. No real-harness loading or model use of these bundles was verified by this documentation pass.

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

At `b77512f`, native startup files and otherwise omitted scratch/granted `AGENTS.md` and legacy `CLAUDE.md` notes are accounted for separately. Native files are excluded from mirrored standing notes to avoid duplicate delivery. The harness pages explain their own native file selection; having a file on disk does not establish that another harness reads it.

The separate `astra/global-instructions` branch at `71924ec` contains a synthetic proof specification, not a delivered implementation. Its intended contract is cross-harness global-note delivery once, native-file deduplication, unchanged-prefix stability, metadata-only Refresh and changes deferred until the next turn boundary while preserving the session. These are pending requirements, not measured behavior. The shared-skills branch alone does not provide `/api/global-instructions/refresh`; complete global source coverage and real delivery remain unverified here.

The implementation owner's pending contract reads personal global notes without editing them and supplies them to every agent without a per-agent folder grant. Planned sources are Claude config `CLAUDE.md` and unscoped rules; Codex `$CODEX_HOME/AGENTS.md` and its override; `~/.gemini/GEMINI.md`; Antigravity `~/.gemini/config/rules`; and `$XDG_CONFIG_HOME/opencode/AGENTS.md`. Native-file deduplication must use the actual account/profile, empty notes are skipped, and captured text and digest must describe the same startup snapshot. Muse's global filename and Antigravity's legacy native-loading behavior were still under investigation when this page was written. This source list is a design contract awaiting approved implementation, not an inventory this base can already deliver.

## Startup fingerprints and provider cache

In the sharing branch, launch planning, idle rechecks and cache forecasts use the same combined instruction-file and skill-content digest. Resource edits matter as well as entry-file edits. A changed digest can replace a parked process at the next boundary while retaining its conversation session; it changes startup input and may cost provider cache continuity.

A local process restart does not itself prove a provider miss. Unchanged snapshots show compatible input, not a guaranteed provider hit. Provider/account/model/session changes and changes to already-sent prompt content have their own namespace or prefix effects. See `orgtree-cache-continuity` (orgtree-working > accounts) for the receipt and freshness rules.

## See also

- [orgtree-mcp-servers](../mcp-servers/SKILL.md)
- [orgtree-harness-claude-code](../harness-claude-code/SKILL.md)
- See `orgtree-cache-continuity` (orgtree-working > accounts).
