# Shared native skills and installed Claude plugins

The engine discovers read-only skill bundles and exposes the same content to
Claude Code, Codex, Antigravity, Muse and OpenCode. No discovery operation starts
a harness, executes a skill, authenticates, or changes a native user config.

## Sources and evidence

Global imports are gated on each harness being installed. Source roots are:

| Harness | Global roots | Native delivery |
| --- | --- | --- |
| Claude Code | `~/.claude/skills` (or `CLAUDE_CONFIG_DIR/skills`) | `--add-dir` points at an immutable snapshot containing `.claude/skills` |
| Codex | `~/.agents/skills`, `CODEX_HOME/skills` (default `~/.codex/skills`, including `.system`) | app-server `skills/extraRoots/set` before thread start/resume |
| Antigravity | `~/.gemini/antigravity-cli/skills`, IDE/legacy `~/.gemini/config/skills` and `~/.gemini/antigravity/skills` | owned copies in the agent's `.agents/skills` |
| Muse | `XDG_CONFIG_HOME/muse/skills` (default `~/.config/muse/skills`) and `~/.agents/skills` | owned copies in the agent's `.agents/skills` |
| OpenCode | `XDG_CONFIG_HOME/opencode/{skills,skill}` and `OPENCODE_CONFIG_DIR`; additional `skills` roots in that directory's JSON/JSONC config | explicit `skills` paths in the private launch config; allow loading each exact skill ID |

Per-agent discovery additionally reads skill folders in that agent's scratch and
explicitly granted folders. They never enter the app-wide registry or another
agent's exports. Generated ownership markers prevent reimporting our own copies.
Rig source resolution stays under the synthetic home, never ambient config roots.

Read-only inventory on 2026-10-15 found Claude/Codex skills and one installed
Claude plugin; other harness global roots were absent. Native delivery contracts
come from [Claude documentation](https://code.claude.com/docs/en/skills),
[Antigravity documentation](https://www.antigravity.google/docs/skills?tab=ide),
[Muse documentation](https://dev.meta.ai/docs/muse-code/extending), installed
Codex 0.160.0 app-server JSON schema (`SkillsExtraRootsSetParams`), and pinned
[OpenCode 2.0.28 loader source](https://github.com/anomalyco/opencode/blob/v2.0.28/packages/core/src/config/plugin/skill.ts).
OpenCode `skills: []` means no additional roots, not a universal native-skills off
switch. The rig checks emitted paths/configuration with fake CLIs; it does not
prove a provider model will choose a skill or that every older CLI version accepts
the same API. No live user profile or model invocation is required by the proofs.

## Bundle and collision rules

A bundle has a UTF-8 `SKILL.md` with YAML `name` and `description` frontmatter,
plus its relative resource tree. Source files are not rewritten. Native export
normalizes the advertised name and keeps the other frontmatter and body. Whole
bundle bytes (including resources and Unix executable modes) determine identity:
identical copies combine source labels; different content with the same name gets
a deterministic source suffix. Built-ins take their plain names first. Native
workspace copies use an `orgtree-` alias to avoid replacing user-created files;
reserved-name collisions are resolved deterministically and an unowned destination
is never overwritten. Different source files do not become identical merely
because their headers happen to match.

Discovery skips `.trash`, `.git`, `.in_use`, `node_modules`, generated copies,
malformed entry files and linked bundles/resources. Bounds are 512 imported
bundles, 64 MiB of imported bytes, 8 MiB per file, 32 MiB per bundle, 2,048 entries
per bundle and bounded traversal depth. These are implementation limits, not
claims that arbitrary external packages were validated. OpenCode's flat Markdown
format is accepted with its sibling resource tree. Skill bodies, resource bytes,
native paths and plugin definitions never appear in the public registry or logs.

## Built-in guides

`build.rs` embeds every file under `docs/skills` into the engine; no runtime source
checkout or separately provisioned docs directory is needed. Guide writers own
that source tree. The future guide-library catalog has two category skills,
`orgtree-operations` and `orgtree-configuration`. Section and leaf pages have their
own nested folders and `SKILL.md` files, loaded only on demand.

Release cut, 2026-10-15 11:04Z: the large guide library is excluded from 4.3.0.
Only rig-opus's standalone `orgtree-engine-start-mode` built-in is required for
this release. The importer does not depend on the library or hard-code two names;
each source tree's top-level bundle is one registered entry.

Only category entry files are exported inside native discovery roots. The complete
resource tree, including ordinary Markdown and nested `SKILL.md` pages, is exported
beside those roots under `resources/<category>` (or the scratch's owned resource
directory for workspace-only loaders). Entry Markdown links are retargeted;
nested links and filenames remain intact. Thus a recursive native loader cannot
advertise hundreds of leaf descriptions. Ordinary skill bundles keep their native
resource layout. No guide content is silently flattened or dropped.

## Publication and boundaries

The engine caches global discovery at startup and on explicit refresh. Launch
planning combines it with applicable per-agent sources and includes the content
digest in the existing startup fingerprint. Identical inputs produce identical
snapshot paths and exported bytes. Content-addressed snapshots are staged and
published by rename, never rewritten underneath active agents. Old snapshots are
retained so existing sessions' paths remain valid.

Launch planning, the 20-second idle recheck and the forecast's remembered startup
value all use `shared_startup_digest`: instruction-file digest plus skill digest.
The idle check retains the agent's applicable folders and re-discovers local skills
against the current global registry. Comparing the raw instruction digest against
the combined launch digest would spuriously retire every unchanged parked CLI.

Workspace-only copies are replaced only after closing the old process, immediately
before starting its successor; owned old copies are removed, user-created files
are preserved. A running turn is not interrupted by Refresh. The changed startup
fingerprint causes the next launch boundary to use the new set; unchanged content
does not cause a new prefix or promise a provider cache hit. Existing native user
watchers may still observe edits made directly by the user in native directories;
this change does not disable that native behaviour.

## Installed Claude plugins and Refresh

One reader uses `.claude/plugins/installed_plugins.json` v2. Only recorded user,
managed or applicable project installs count. A marketplace catalog or an unrelated
cache directory is never scanned. Default `skills/` and declared skill paths feed
the skill registry. `.mcp.json` and `plugin.json` `mcpServers` feed the existing MCP
normalizer; `${CLAUDE_PLUGIN_ROOT}` is expanded privately. Manifest file references
must remain within the installed package. User-global plugin MCP definitions are
imported into the app registry; project-scoped plugin skills remain agent-scoped.
Private OAuth stores are not transferred.

The shared Settings Refresh invokes `/api/mcp-servers/refresh`,
`/api/skills/refresh`, and `/api/global-instructions/refresh`. It retains successful
results and names failed sources rather than claiming all sources refreshed.
The last endpoint is provided by the separate global-instructions change; compose
both changes before shipping the shared button. Public skill responses contain
only aliases, source labels and a content fingerprint.

## Verification hand-in

Source-only author checks: `node --check` on both new proof scripts, Rust source
parse/format and `git diff --check`. Compilation and runtime outcomes belong to the
independent rig receipt, not this document.

Under the normal rig lock, fake-home-only commands:

```
cargo test --locked -j 2 -p orgtree-engine --bin orgtree-engine skills_import_ -- --test-threads=1
node tools/rig/rig.mjs run tools/rig/proofs/skills-import.mjs
node tools/rig/rig.mjs run tools/rig/proofs/skills-delivery.mjs
node tools/rig/rig.mjs run tools/rig/proofs/skills-idle.mjs
```

There are six focused unit cases. Import proof: nine checks, expected predecessor
red six failures/three passes. Delivery proof: eighteen checks, expected predecessor
red seventeen failures/one pass. The latter inspects all five emitted native
bindings, resource contents, unchanged paths/bytes, and a refresh during an active
turn followed by boundary updates. Execute the same proof and fake-CLI fixture at
base `b77512f` for red; keep all failures, including unexpected setup failures.
Renderer: `mcpimport.test.tsx` (four cases) plus `orgsettings.test.tsx`, with the
base API/modal implementation as the red control. Compose global-instructions and
the standalone start-mode guide, then verify its alias and complete resources are
present in each native layout. The nested-category unit fixture separately verifies
that leaf `SKILL.md` pages never become extra catalog entries.

The separate idle regression has three checks: initial native loading, then two
unchanged Refresh cycles, each spanning 22 seconds and a subsequent turn. It checks
the original PID remains alive, the start count is unchanged, the forecast has no
startup change and exported bytes remain identical. Run the identical proof at
`2bf5e71` for the focused digest-mismatch red (expected one pass/two failures),
then the fix for green. These are expected outcomes until independently measured.
