# The test rig: a scratch engine you can drive end to end

`tools/rig` runs the real Rust engine against a throwaway data root with its own PostgreSQL
cluster, plays scripted CLI output through a fake Claude Code CLI, calls any `orgtree_*` tool as a
chosen agent, and tears everything down. Use it to prove a change through the real path instead
of labelling it "inferred". Node 24 built-ins only; no `npm install` needed (the desktop smoke
runs an existing `electron.exe` in place).

## Quick start

```bash
export CARGO_TARGET_DIR='E:\cargo-target\<you>'      # team rule: your own folder on E:
node tools/rig/rig.mjs build                          # debug engine + fake CLI (needs >= 6 GB free RAM)
node tools/rig/rig.mjs up                             # ~20 s: run + basic fixture; prints url, token, org
node tools/rig/rig.mjs tool alice orgtree_chart '{}'  # any tool, as any live agent
node tools/rig/rig.mjs mail user carol "hello"        # desk mail from the user (wakes carol)
node tools/rig/rig.mjs sql "select name, frozen from ot.agents"
node tools/rig/rig.mjs fakelog carol --kind turn      # what the fake CLI was sent and played
node tools/rig/rig.mjs down                           # graceful stop, then the run is deleted
```

Scripted runs: `node tools/rig/rig.mjs run tools/rig/proofs/turn-recovery.mjs` brings a run up,
calls the script's default export with a `Rig` handle (`tools/rig/lib.mjs`), and always stops the
run (also on Ctrl-C); a run whose script failed keeps its files for inspection until
`rig cleanup`. A script may `export async function setup(flags)` returning `up` options
(`{ fixture: 'none', legacy: <dir>, prepare: async ({ data, pgBin }) => … }`). `proof.mjs`
records pass/fail checks and evidence under `<rig home>\evidence\<proof>-<time>\`, which outlives
the run.

| Proof (`tools/rig/proofs/`) | What it runs through the real engine |
|---|---|
| `turn-recovery.mjs` | CLI exits mid-turn → connection freeze → timer retry with the banner on the resumed session; a 401 result → auth park and the superior's one-time notice |
| `background-and-mail.mjs` | stopped and orphaned background tasks (P33), the 45 s unread notice (P36), mid-turn mail through the PostToolUse hook |
| `docket-rules.mjs` | docket read/update permissions and stale `expected_rev` refusals, checked in the database |
| `batch-halt.mjs` | Halt subtree / Unhalt all / Halt all (with a turn running) / Unhalt subtree from the menus, in the real renderer |
| `import-2x.mjs` | first-start import of a synthetic 2.x store, section by section; a damaged store keeps nothing, retries, and shows its line in the org list |
| `import-30.mjs` | first-start import of a synthetic 3.1.0 store (the `orgtree` database the released 3.0.9/3.1.0 leave, migrations from git at `v3.1.0`); an unmarked org stays out; a broken org keeps nothing, is named in the org list, retries without restoring an account the user removed, and imports once repaired; an unreadable `public.orgs` never stops the engine |
| `import-3x.mjs` | first-start import of a synthetic 3.2 store (the 3.2 alpha layout) with a row in every section; an older alpha schema (0015) imports in full; a broken store keeps nothing, is named in the log, ot.kv, the app feed and the org list, retries, and imports in full once repaired; an unreadable registry never stops the engine |
| `canvas-resize-crash.mjs` | the canvas survives a viewport resize right after mount (finding F1); run with `up --ui <bundle>` |

## What keeps it safe

- **Rig mode in the engine** (`src/rig.rs`) is compiled into debug builds only. It switches on
  only with `ORGTREE_ENGINE_SAFE_START=1`, `ORGTREE_ENGINE_RIG=1`, the marker file
  `.orgtree-rig-root` in the data root, and a root outside `%APPDATA%\Orgtree v2`; asking for it
  anywhere else (or from a release build) refuses to start before anything is written. In rig
  mode every home-folder lookup goes to `<root>\rig-home` (a fake profile: the real `~/.claude`,
  `~/.codex`, `~/.orgtree` are never read or written), provider CLIs come only from
  `ORGTREE_CLAUDE_BIN`/`ORGTREE_CODEX_BIN`/`ORGTREE_AGY_BIN`, no usage probe or OpenRouter call
  is made (canned readings may be dropped into `rig-home\rig-usage\<lane>.json`), and one
  test-only route exists: `POST /api/rig/tool {org, agent, tool, args}`.
- **Without rig mode a SAFE_START engine is not isolated**: it reads the real user's sign-ins and,
  every few minutes, runs the real usage probes (HTTPS with the real Claude token,
  `codex app-server`, `agy --print /usage`). Do not run scratch engines without the rig.
- **The rig home** (`ORGTREE_RIG_HOME`, default `E:\orgtree-rig`) is refused inside the live data
  folder or the repository. PostgreSQL binaries are copied there once (never run from the
  installed app, whose files an installer must be able to replace). Each run gets a copy of a
  cached `initdb` template (the engine's own `initdb` path: `up --initdb`).
- **Processes**: a detached keeper (`keeper.mjs`) is the engine's parent. `rig down`, 20 minutes
  without a rig command touching the run (`--ttl`), or 120 minutes in all (`--max`) stop it
  gracefully. If the keeper dies the engine shuts down, and the engine's kill-on-close job takes
  PostgreSQL and every fake CLI with it. `rig cleanup` deletes stopped runs and kills anything
  under the rig home that no live run owns (`--mine` also stops your live runs). The engine gets
  a clean environment: none of the host agent's `ORGTREE_*`, `CLAUDE*`, credential or Codex
  variables.

## Fixtures

`up --fixture <name|file|none>` (default `tools/rig/fixtures/basic.json`): boss (opus) → alice
(sonnet) → bob (haiku), and carol (haiku) under boss; one docket item `rig-smoke-item` created by
boss and owned by alice; one passive note alice → boss. Format:

```json
{
  "org": { "name": "Rig Org", "dirs": [], "settings": {} },
  "agents": [ { "name": "boss", "tier": "opus", "grant": 24, "charter": "..." },
              { "name": "alice", "parent": "boss", "tier": "sonnet" } ],
  "docket": [ { "as": "boss", "args": { "title": "...", "objective": "...", "owner": "alice" } } ],
  "mail": [ { "from": "alice", "to": "boss", "body": "...", "notice": true },
            { "from": "user", "to": "carol", "body": "..." } ],
  "scenario": { "default": { "turns": [ { "steps": [ { "text": "OK." } ] } ] } }
}
```

Agents are hired with the real `ops` route (any `hire` field works), docket items and agent mail go
through `orgtree_work`/`orgtree_message` as the named agent, user mail through the desk route.
Assigning a docket item wakes its owner, so the owner runs one fake turn during seeding.

## The fake CLI and its scenario

`tools/rig/fakecli` (`orgtree-fakecli.exe`, copied into each run as `claude.exe`) is launched by
the engine exactly like Claude Code. It answers `initialize`, connects the in-process `orgtree`
MCP server (initialize, tools/list), runs `orgtree_*` calls through `mcp_message`, fires the
PostToolUse hook after every tool use (that is where the engine hands over mid-turn mail), and
writes session transcripts under the fake home so `--resume` works.

At every turn it re-reads `<run>\fakecli\scenario.json` (`rig scenario <file>` or
`rig.scenario({...})`) and plays the first turn script whose `match` substrings all occur in the
prompt (case-insensitive; `unless` excludes), trying `agents.<name>.turns` before
`default.turns`; `once: true` / `times: n` limit a script's uses (counted in
`fakecli\state\<agent>.json`, so they survive CLI restarts). No match: it answers "OK.".

| Step | Effect |
|---|---|
| `{"text": "...", "chunk": 24, "delay_ms": 0}` | text deltas, then the assistant message |
| `{"thinking": "..."}` | thinking deltas and block |
| `{"tool": "orgtree_x", "args": {...}, "expect": "substr", "expect_error": false}` | a real tool call through the engine; the result and the expectation are logged |
| `{"tool": "Bash", "args": {...}, "result": "...", "is_error": false, "run_ms": 0}` | any other tool: announced and answered from the script |
| `{"poll_mail": {"every_ms": 2000, "timeout_ms": 30000}}` | tool boundaries until the hook hands mail over |
| `{"sleep_ms": n}` / `{"hang": true}` | silence (an interrupt ends either) |
| `{"exit": 1}` | the CLI dies mid-turn |
| `{"result": {"is_error": true, "text": "...", "api_error_status": 401}}` | ends the turn with this result (fields merged into the result line) |
| `{"usage": {...}, "cost_usd": 0.02}` | this turn's usage and cost |
| `{"system": {"subtype": "task_notification", ...}}` | a system event (background tasks, compaction) |
| `{"rate_limit": {...}}` / `{"raw": {...}}` | a rate-limit event / any line as is |

`fakecli\log\<agent>.jsonl` holds every line received and sent plus `turn` (script and prompt),
`tool_result` (with `ok` for expectations), `hook_mail` (mail handed over mid-turn), `exit` and
`interrupted` entries. The real CLI's result for a rejected credential carries
`api_error_status` (seen in the Claude Code 2.1 binary, not with a live 401).

## Tool calls as an agent

`POST /api/rig/tool {org, agent, tool, args, tool_use_id?}` → `{ok, text, json}` calls
`tools::call_tool` as that live agent, exactly what its CLI's `mcp_message` reaches (permissions,
visibility and side effects included). `rig.tool(agent, tool, args)` in scripts,
`rig tool <agent> <tool> '<json>'` on the command line; assert on the result and on the database
with `rig.sql(query, { db })` (psql against any database of the run's cluster, rows as JSON).
`rig.exec(statements, { db })` runs statements (DDL, writes) on the run's cluster, and
`await rig.restart()` stops the engine gracefully and starts it again on the same data root and
cluster, which is what quitting and reopening the app does to the engine.

Before and after: `ORGTREE_RIG_ENGINE=<exe>` makes every run of a script (and the runs it starts)
use that engine instead of your build, so keep a copy of the integration build's debug engine and
run the same proof on it to show the "before".

## Desktop smoke

`rig desktop <page-script.cjs> ['<json args>'] [--preset short|tall|wide|WxH]` (or
`runDesktop(rig, script, { preset, args, out })` from `tools/rig/desktop.mjs`) starts
`electron.exe` where it is installed (this worktree's, the main checkout's or the integration
checkout's `node_modules`, or `ORGTREE_RIG_ELECTRON`; never linked or copied) on
`desktop/main.cjs`. That loads the run's real renderer bundle at `/o/<org>` in an offscreen window
with a fresh profile per invocation, and signs engine requests with the run's token the way the
desktop does (`session.webRequest`). A page script is a CommonJS module
`async (page, { org, args, out }) => value`; `page` offers `goto`, `waitFor(target)`,
`click`/`rightClick`/`hover(target)` (after the target stops moving), `press(key)`, `type(text)`,
`screenshot(name)`, `resize(preset)`, `eval(fn, ...args)`, `api(method, path, body)` and
`consoleErrors`. A target is a CSS selector or `{ selector, text, regex }` (the innermost visible
element whose text matches). Clicks, keys and text go through CDP `Input.dispatch*`, so the page
sees trusted events. Examples: `desktop/menu-action.cjs` (walk a card's context-menu path and
confirm it), `desktop/explore.cjs` (screenshot plus a card summary), `desktop/watch-crash.cjs`,
`desktop/frozen-card.cjs` (a frozen agent's card and desk), `desktop/org-list.cjs` (the org list on
`/`; pass `org: ''`).

The renderer bundle defaults to this worktree's `dist/renderer`, else the installed app's `ui`;
`node tools/rig/build-ui.mjs [--dev]` builds this worktree's renderer into the rig home for
`up --ui <dir>` or `ORGTREE_RIG_UI=<dir>` (which also covers the runs a script starts; `--dev`:
unminified React with source maps, so a crash names its component).

What it cannot test, and does not pretend to: the desktop main process (tray, pop-out windows,
native menus, window controls, notifications, the preload bridge: the renderer runs as it does in
a plain browser); native `<select>` popups and OS drag and drop (Chromium draws them outside the
page); real Windows DPI. Agents run in session 0, whose display is 1024x768 and Windows clamps
windows to it, so viewport presets are a CDP device-metrics override (what layout, events and
screenshots see), not a native window size.

## Legacy stores for importer runs

`tools/rig/legacy2x.mjs` writes a synthetic 2.x data folder (`orgs/<slug>.db`); pass its folder
as `up --legacy <dir>` (copied into the new data root before the engine's first start).
`tools/rig/legacy30.mjs` builds a 3.0/3.1 store as the released 3.0.9 and 3.1.0 leave it: one
`orgtree` database made by the `v3.1.0` migrations (read from git and recorded in
`schema_migrations` as 3.x did), each org in an `org_<id>` schema holding the 2.x seam's five
tables, 3.x's `<data>\orgs\<slug>.pg` markers and `accounts-registry.json`; a `prepare` hook with
`variant: 'full' | 'no-log_l'`.
`tools/rig/legacy32.mjs` builds a 3.2 store (`orgtree_app` + `orgtree_org_1`, the layout of the 3.2
alphas) in the run's own cluster with the 3.x engine's migrations and one row in every section the
importer reads, as a `prepare` hook; `level` stops at an older org migration and `damage` runs SQL
after seeding. Migrated templates are cached under `<rig home>\pg\template30-*` and
`template32-*` (the first build of one takes up to a few minutes).

## Traps

- Git Bash rewrites `/api/...` arguments into `C:/Program Files/Git/api/...`; `rig api` undoes it,
  other tools need `MSYS_NO_PATHCONV=1`.
- A turn's prompt is long (ORG STATE, mail envelopes); match on a token you put in the mail.
- Timers are real: a connection retry waits 30 s, the unread-mail notice 45 s.
- A halt (single or batch) kills the agent's CLI process tree; it does not send an interrupt, so
  the fake CLI logs no `interrupted` entry for it (the turn row is `killed`).
- Write page scripts and scenarios with an editor, not a bash heredoc: heredocs mangle
  backslashes in regexes and Windows paths.
- Several agents may share the rig home: `cleanup` only stops runs whose keeper is gone (or your
  own with `--mine`), and never another live run's processes; `--dry-run` shows the plan.
