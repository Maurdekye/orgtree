# Personal global instructions

An agent receives the user's personal instruction files from all harnesses, even
when its own CLI uses an isolated account profile. Each nonempty file is labelled
with its source path. Discovery reads files and never creates, imports, renames or
edits them. Project instruction chains, granted-folder permissions and native CLI
limits keep their existing behavior.

## Sources

The sources below were checked against the installed versions on 2026-10-15.
"Measured source" means shipped documentation or executable source was inspected;
it does not mean an authenticated model request was captured.

| Harness | Personal source | Evidence |
| --- | --- | --- |
| Claude Code 2.1.292 | `CLAUDE_CONFIG_DIR/CLAUDE.md`, default `~/.claude/CLAUDE.md`, plus recursive `rules/*.md` without a `paths` restriction | Existing measured native manifest and [standing-notes verification](standing-notes.md) |
| Codex 0.160.0 | `CODEX_HOME/AGENTS.override.md`, otherwise `AGENTS.md`; default home `~/.codex` | Native filenames measured in the shipped `agents_md` module; global override precedence inferred from its instruction-file selection contract |
| Gemini CLI 0.57.0 | `~/.gemini/GEMINI.md`, or filenames in user `settings.json` → `context.fileName` | Measured bundled `gemini-md.md`, `getGlobalMemoryPaths`, `Storage.getGlobalSettingsPath`, and comment-aware settings loader |
| Antigravity 1.3.5 | `~/.gemini/{GEMINI,AGENTS}.md`, `~/.gemini/config/{GEMINI,AGENTS}.md`, and unconditional Markdown in `~/.gemini/config/rules/` | Measured shipped customization guide and changelog: canonical dedup fixes explicitly name all four standalone paths |
| Muse 1.4.6 | `$XDG_CONFIG_HOME/muse/AGENTS.md`, otherwise `CLAUDE.md`; default root `~/.config/muse` | Measured isolated echo TUI `/rules` canonical and absent-canonical fallback; config root from shipped settings documentation |
| OpenCode 2.0.28 | `$XDG_CONFIG_HOME/opencode/AGENTS.md`, default `~/.config/opencode/AGENTS.md` | Measured shipped `ConfigInstructionPlugin` and global config-root resolver |

Gemini's `GEMINI_CLI_HOME` replaces the **home**, so its global folder is
`$GEMINI_CLI_HOME/.gemini`, not `$GEMINI_CLI_HOME` itself. The settings parser accepts
comments. Configured context names must be simple filenames; paths out of that
folder are not part of personal-global discovery. Antigravity still uses its own
home-based sources if Gemini's override points somewhere else. Conditional Claude
rules and Antigravity rules with another explicit trigger remain on demand.

Muse's read-only MSP settings schema exposes only nine settings and does not
establish a rules-file location. The native `/rules` check used the exact pinned
1.4.6 binary, echo provider, synthetic home/config/project roots and no model or
auth request; a project AGENTS.md also appeared in its native list. Its alternative
`.muse/AGENTS.md` and `.agents/AGENTS.md` candidates were not listed with the
canonical user file present. Those candidates are not invented fallback roots.

Missing files are normal. Whitespace/BOM-only files are skipped. Canonical file
identity prevents duplicate blocks through aliases or repeated global roots.
The original text is supplied; this is not a new project/import expansion system.
Only personal roots are scanned, without requiring a grant to each agent.

## Native delivery and startup boundaries

`runtime/global_instructions.rs` returns an unlogged private snapshot of source
text, canonical identities and read failures. `startup::snapshot` combines it
with the **actual** native profile manifest. Files already loaded by that CLI are
excluded from the shared block. A Codex or Claude seat using an isolated account
home therefore still receives the user's personal files. OpenCode's isolated
launch receives the originals through Orgtree. A granted global directory does
not add another copy.

Muse hosts receive `-c context.foreign_personal_rules=false`, because Orgtree now
delivers foreign personal instructions. This leaves Muse's own native rules and
its separate foreign-skills setting intact. It is a launch-only override; saved
Muse settings are unchanged. Native startup accepted the key in an offline echo
host, and `/rules` explicitly listed the fixture Claude and Codex global files as
**not read** with it set. The same run loaded Muse's native `CLAUDE.md` fallback
and the workspace's `AGENTS.md`, keeping both positive controls. No real-model
inference was needed for these native file-loading observations.

The text appended to a launch and its global fingerprint come from one read.
Equal inputs produce equal bytes. File edits, additions and removals participate
in decision 61's existing `startup` fingerprint. An active turn and a held process
are not rewritten. At the next permitted boundary, the CLI starts with the new
text and resumes the same session. Existing idle checks refresh the forecast;
changes are named `startup`, rather than hidden in the turn envelope.

Adding this feature changes the prefix for agents that gain instructions.
Resuming a local session does not establish a provider cache hit; an edited
startup prefix can require a cold cache read.

## Refresh and errors

The shared App settings Refresh button (skills/MCP sharing) calls
`POST /api/global-instructions/refresh` alongside those other refreshes. It has
no request body and returns only `{ "files": N, "refreshed": true }`. `N` counts
nonempty canonical files, including files a particular CLI will load natively.
An existing unreadable/invalid source produces a sanitized HTTP 500 with a count,
so the shared UI can show a partial failure. Neither the response nor invocation
logging includes instruction text; the response contains no source paths either. An unavailable file does not
erase other readable sources.

The endpoint does not write a file or mutate an active process. Startup reads
fresh snapshots independently, so a button press is not required to pick up an
edit at a subsequent boundary.

## Isolation and verification

Rig mode resolves all personal roots under `rig-home`, ignoring inherited
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME` and `XDG_CONFIG_HOME` overrides.
Canonical targets, including linked directories, must remain inside that home
before their contents are read. Instruction-bearing helpers are `#[nolog]`;
private snapshots have no `Debug` or `Serialize` implementation.

The test-only commit `71924ec` ran against unchanged product base `b77512f`:
all 12 behavioral checks executed, with six controls passing and six expected
failures (three foreign files, Refresh, the startup forecast, and next-start
delivery). The green proof retains those checks and adds verbose-log privacy
and explicit sanitized Refresh failure. Unit tests cover canonical native
exclusion, account isolation, source selection, empty/scoped files, stable
snapshots, edits/deletions, JSON comments, aliases and confined roots.

Final green and independent exact-commit verification are pending. Tests use
synthetic homes and CLIs, without live profile writes or provider inference.

Pre-existing Antigravity limitation: its launcher writes the managed identity to
scratch `AGENTS.md`, which the next plan can read back as standing notes. This
project-note feedback path belongs to the separate
`antigravity-agents-own-agents-md-is-overwritten-b` item (coordinator ruling,
2026-10-15 12:15Z); this change does not rewrite that project mechanism. Native
global-file discovery is independently covered.

## Composition with skills sharing

The skills patch's `shared_startup_digest` must retain its skills digest in all
three sites: launch planning, idle checking and forecast state. At launch, feed
the captured `startup::Snapshot.digest` into that helper, so it describes the
same text that is sent. Idle/forecast calls may compute `startup::digest(inputs)`
fresh. Do not replace the combined value with the instructions-only digest.
