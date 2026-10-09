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
| `openrouter-lane.mjs` | agents on the OpenRouter lane (key and favorite carried over from a 3.x `openrouter\state.json`; the gateway's key check scripted through `rig-home\rig-usage\openrouter-key.json`): a 401 parks with the OpenRouter remedy and the panel stops saying "connected" at once; the fourth 402 parks with the balance remedy; a key check without credit fields does not crash the panel's document |
| `input-panics.mjs` | inputs from outside that used to panic the engine: non-object tool arguments, NULLs in a 3.2 store's folder and list tables, a foreign file name in `diagnostics\logs` |
| `turn-failures.mjs` | after a failed turn (3.x parity): a Codex turn stopped by a usage limit keeps its mail in the freeze (`resume_texts`) and is given it again at the automatic wake and after `orgtree_unstick`, and its reset sends nobody a weekly-Fable notice; consecutive failed turns (Codex and Claude, and turns the idle limit killed) are reported to the superior once, and a completed turn makes the next failure news again; a Codex turn's mail is delivered once `turn/start` was accepted (a provider that keeps failing does not get a growing batch), while a refused `turn/start` gives it back |
| `agy-lane.mjs` | flash agents on the fake `agy`: a normal turn (an orgtree tool through the engine's mcp-bridge, a native tool, tokens summed over responses), mid-turn mail through the PostInvocation hook, a seat without shell rights denied by the PreToolUse hook, an interrupt, the CLI dying mid-turn (the retry resumes the conversation), a quota wall frozen until its own "Resets in" countdown (keeping the request), the same countdown anchored once (kept while ahead, the 5-minute probe floor once stale, forgotten after a completed turn), the 3.x limit words, a refused model pin, the conversation resumed after an engine restart |
| `account-windows.mjs` | the user's rule, never a model on a login whose window it spends is at 100%, with per-login readings: quick staff does not offer (and its commit refuses) a full login or a full default; continue-on (the tool and the user's route) refuses it, with Fable's own weekly window counting for fable only; the automatic fallback moves an agent only onto proven room, else it freezes |
| `fallback-slow-read.mjs` | a login whose usage read takes 20 s (`"rig_delay_ms"` in its canned reading) cannot stall an agent through the account fallback: the turn ends at once (frozen first), the read is cut off after 5 s and counts as no proven room, and the agent moves to the next login with room |
| `engine-restart.mjs` | the engine killed mid-turn (`rig.crash()`) and started again with the restart path: Claude and Codex turns it cut are closed as stopped, their mail stays delivered and is not sent again, the restart message resumes each agent on its own session and thread, a pending connection-freeze retry is re-armed and runs on time, idle agents get the passive notice |
| `watchdogs.mjs` | an agent's watchdogs in a `recover` run: a file dog fires on matching lines only, a ONE-SHOT command dog fires once and is spent, `pid:N` fires when the process goes down, a stream dog fires on its command's lines and removing it ends that process, an activity dog fires on a report's `turn_done`, the mail wakes the owner, the ninth dog is refused, and a file dog survives an engine restart |
| `compaction.mjs` | compaction from each side: Claude compacting on its own mid-turn (`compact_boundary`: the desk row with the size before, the automatic notice, the turn goes on), the user's compact route (`/compact` as its own turn: context estimated and not yet run until the next turn measures it), Codex's `thread/compacted`, and a superior's cheap compact (a new session with the handoff note, the earlier conversation saved in the agent's folder, the old session closed) |
| `questions.mjs` | the user's question cards (`orgtree_ask`): an ask from inside a turn opens the card, attached to the asker's docket item (which then cannot be deleted); asking again amends the one open card (a new tab joins, the same text replaces its tab, at most 4 per call and 8 per card); stale and holey submits are refused; the answer arrives as mail that wakes the asker (mid-turn through the hook, held while halted) and the item lets go of it; without a user audience the question goes to the superior; withdraw; the card's close reads dismissed; a retired asker's card reads moot; a cheap compact keeps the card and the fresh session is told of it; a malformed call's leaked options are recovered or refused, and options are clipped as in 3.x; the older answer route (`/asks/{id}/answer`) keeps 3.x's guards (every pick of a one-question card, no empty answer, no unstamped answer to an amended card, one answer per tab) |
| `questions-moot.mjs` | an open question across session replacement: a provider switch and the removal of the Codex account an agent ran on close its card as moot and tell the fresh session to pose it again; a user's account move that carries the Codex thread keeps the card open |
| `mailbox.mjs` | an agent's own mailbox and mail attachments (P11, P13): `orgtree_inbox` pages of 50 with a cursor bound to the agent, limits, target-shaped arguments and foreign cursors refused; fetch of 1–20 ids, long bodies as chunk 0 with digests, the 256 KB budget deferring rather than cutting, other agents' mail not found; chunk reads at UTF-8 boundaries back to the exact body, wrong handles refused, the handle still good after a restart; reading changes no delivery state; attachments capped at 10, only to the user or `@net:`, from the sender's folders, as outbox snapshots, and only with a user audience |
| `conversation-recall.mjs` | conversation recall (decision 55; `--hub <orgtree-mailhub.exe>` adds the `@net:` part): alice's mail with carol in order both ways with boss's mixed in, 20 a page with a cursor bound to her and the start said plainly, a limit-5 walk losing nothing, carol's mirror view, a reply linked to what it answers; the caps (limit 1000 gives 100, 500-character previews marked cut with the whole length, a page stopping at 16,000 characters with the cursor for the rest, `fetch` of sent and received mail whole); the user's mail with an attachment named; `@org:` and `@net:` mail of the org-inbox holders on both sides, a bare org name; refusals (another agent's cursor, unknown peer, herself, extra arguments) and nobody else's mail; 114 waiting notices: a real message still starts its turn with the 64 oldest and the leftovers ride the next (decision 56); the fresh-session note after a cheap compact names her correspondents newest first |
| `org-inbox.mjs` | mail between two orgs on one machine (`@org:`) and the org-inbox holders (P14, P15, P28): only a top-level agent or a holder writes outside; an org with no holder grants its first live top-level agent; single-holder grants revoke the previous holder; multi-holder off is refused while several hold it; a retired holder is replaced |
| `org-inbox-unavailable.mjs` | outside mail when the org-inbox holder cannot run (decision 59): a halted holder's `@org:` and `@net:` mail goes to the first top-level agent who can run, whose turn takes it, while the holder keeps the audience and gets no copy, and the sender is told who got it; the same for a holder frozen by a usage limit; with the first top-level agent halted too, the next one gets it; in multi-holder mode the holder who can run gets it and the frozen one no copy; with the holders retired, the inbox goes to the first top-level agent who can run; when nobody can run, the mail waits with the holder, the user is told, and it is read once an agent is unhalted |
| `hubchat-reply.mjs` | a person on the mail hub is answered with `orgtree_message` to their `@net:` address (decision 63): a new top-level hire's instructions say so in the org-inbox passage, even when that person is the user; a new report with no outside audience has no org-inbox passage; a message from `@net:peer.rig` reaches the inbox holder's turn with the reminder line naming that address; the user's own mail has none |
| `audiences.mjs` | who an agent may write to (superior, reports, peers; a distant superior's message grants a reply audience) and `orgtree_audience` request, grant, revoke and deny between agents, and an audience with the user |
| `attention.mjs` | attention flags and the user's replies on docket items: a reason required and bounded; a later update keeps the flag; amending keeps its revision; a stale dismiss refused; the dismiss clears, blocks and tells the owner; the dismissed reason cannot be raised again; a reply reaches the owner as item-linked mail and clears the flag with the reply on record, unless a linked question is open; the owner takes a flag down; replies addressed to a participant, refused for anyone else, and sent as a notice |
| `tree-credits.mjs` | the tree operations that move credits (3.x §4.5/§4.6), with no overdraft after any of them: move budget-neutral along the common-ancestor path (between teams, to and from the top level); retire returning the stake, a retire with reports archiving the team and saying it became a dissolve, a repeated retire a no-op; dissolve; rehire paying seat and grant, a live rehire a no-op; reallocate raising the chain, a cut below the reports' share refused; swap between siblings budget-neutral, a cross-team swap the payer cannot afford refused; self-subjugate; an archived agent moved for free and rehired under its new superior |
| `rehire-unrecoverable.mjs` | a 3.2 store's agent marked unrecoverable (its session lost), imported and rehired: live again on a fresh session whose first turn starts with the handoff note |
| `org-ops.mjs` | the user's org operations: Stop All (a running turn interrupted, armed dogs paused with 3.x's reason, no turn while latched; release lifts only the latch); delete mid-turn (the org gone from the list and its routes, its CLI stopped, its folders taken to the trash as 3.x did, a folder held open reported and a same-named org refused until it is let go, then swept); folders an earlier delete left behind swept before a new org takes the name; dissolve all; create's 3.x name rules (a held name refused, a name with no letter or digit refused, no slug cap, a name the file system refuses refused with nothing created); a restart after the delete leaves the deleted org alone |
| `org-settings.mjs` | the user's org settings as 3.x applied them: a folder taken off the org revoked from the top-level grants (warned per agent) and not given back when re-added (future hires only); a folder turned read-only downgrading the top-level grants (warned) and not upgraded back; a malformed folder entry refused (422) with the org's folders kept; a lowered cap below existing top-level grants kept and warned (D-014); bad values (permission mode, visibility, account, effort, switches) refused with 422 on the org settings, hire defaults and app defaults; cheap compaction occ kept within 5-95% with partial writes merged; a hire with an unknown mode refused, and a stored one never run as given |
| `visibility.mjs` | visibility as a capability (D-021): an agent hired with full visibility sees only itself and its reports once its superior is narrowed to self (orgtree_chart, orgtree_state_inspect and the org state block of its turns), and only its team once moved under a team-only superior; reads reach downward only (no transcript or folder outside the subtree, no path out of a report's folder) |
| `reminders.mjs` | the automatic wakes in a `reminders` run (3.x keeper order and next-action rules): an idle owner is reminded of its actionable items only (not blocked, backlogged, flagged or questioned ones); a reviewer of the item in review; an owner whose review has no reviewer, or a retired one, to name one; a deploy_ready item reaches the owner's nearest live superior (a top-level owner keeps it); a working agent with actionable items gets the reminder that names them, not the checkup; an unread notice holds no wake back; the text the agent reads is the one stored and asks for no `waiting` status; nobody halted, all-blocked or without items is woken; each item's `next_action` agrees; no second wake on the next sweeps; the blocked option org-wide; the checkup with reminders off; nothing with both off |
| `reminder-race.mjs` | an automatic wake is idle-only (`reminders` with `reminderPauseMs`): an agent that starts real work between its reminder's reservation and its mail has the reminder withdrawn (it never reaches him and runs no turn behind his work); an idle agent at the turn cap has its reminder accepted, waiting for the slot |
| `cache-keeper.mjs` | the working cache keeper with working checkups off: a working Claude agent idle 55 minutes gets one read of its own launch on a fork of its session (`--fork-session --max-turns 1`); nothing of it stays in the session; its cost and cache receipt are booked; not repeated; nobody idle, Codex or halted; the API-key lane after 4 minutes; tools denied; real work kills a running read and is not held up; a cancel is no failure, a failure backs off; nothing with checkups on |
| `startup-context.mjs` | an edit to a CLI's startup instruction files reaches the agent (decision 61, 3.x parity): the fake CLIs log the file they read at start; with no edit no CLI is replaced (through an idle re-check and a turn); after an idle edit to the scratch CLAUDE.md the forecast lists `startup` (not ready), the parked CLI is closed, and the next turn's CLI read v2 and resumed the SAME session; an edit during a long turn leaves that turn's CLI running, and after it ends a CLI that read v3 resumes the session; a Codex agent's AGENTS.md edit gives a new app-server that read it and resumed the same thread |
| `ticket-list.mjs` | a fresh session starts with the agent's live docket items (decision 64): cheap-compacted, an agent's next turn lists each item she owns in a live status (open, in_progress, blocked, review, approved, deploy_ready) with its status and first next step, newest updated first, the backlogged one apart, and her superior's item in review that names her as reviewer (not his item still in progress); no done, dropped or archived item; her instructions name none of them; a docket change afterwards replaces no CLI and her next turn does not repeat the list; an agent with 33 open items switched from Claude to Codex gets the 30 newest, "…and 3 more" and the `orgtree_work` call |
| `live-effort.mjs` | an effort change reaches a running Claude turn (3.x `send_live_effort`): mid-turn, `orgtree_retool`, the settings route, a clear (sent as the level it resolves to) and an unchanged level each answer `effort_delivery` in 3.x's shape and send `apply_flag_settings` (or nothing) to the running fake CLI, with no next-turn effort card; the next turn starts a fresh CLI with `--effort`; an idle change and a Codex agent (parked, and mid-turn with its card) take it from the next turn (`turn/start` effort); an effort-only retool leaves a report's parked CLI alone; with `--ui`, the desk after a retool mid-turn and the composer's toast |
| `cli-environment.mjs` | the Claude CLI's environment as in 3.x: agents carry `ORGTREE_NODE` (the mail hub's SessionStart hook stands down for them) and have PowerShell: with the terminal switch on, the CLI starts in essential-traffic mode, asked for PowerShell and reading cached flags, and its init lists Bash and PowerShell; with it off, neither shell is listed (the fake CLI models 2.1.292's PowerShell gate; the rig home caches `tengu_cobalt_ridge` as on) |
| `cold-reset-default.mjs` | the cold-turn reset's default occupancy, 25% (decision 54): an org with no setting stores none and reports `{enabled: false, occ: 0.25}`, as do the app defaults; agents switched on with an override naming only `enabled` inherit 0.25; with cold receipts, an agent at 30% of its context starts on a fresh session with the compaction handoff and one at 20% resumes; an org occupancy of 40% reaches such an override (3.x key-by-key merge); with `--ui`, a fresh org's Org settings panel saved untouched stores the reset explicitly at 25%, and switched on shows 25% |
| `launch-failure.mjs` | a turn that could not start is told once, as 3.x's terminal belt did: a Codex `turn/start` refusal puts the mail back with the reason in `last_error`, gives the agent a notice that does not wake it and tells its superior (the user at the top level); a second refusal in the same run is not told again; a completed turn delivers the waiting mail and ends the run; a launch refused before any process starts (Claude through Antigravity turned off) is told too |
| `pending-switch.mjs` | a queued switch on an idle agent applies at once and a refused turn start never spins (decision 62): an Antigravity agent retired in the middle of a long turn has that turn closed as killed and none of its mail left claimed; rehired and switched to haiku, the switch applies at once and her next turn runs on the Claude lane with no refused start; a turn on record that no running turn owns (with mail it claimed) makes a switch queue, the idle agent closes the record herself (killed, the mail back in her mailbox, not in flight), the switch applies with no mail to wake her, and her next turn runs on sonnet carrying that mail; a record a database fault keeps open gets a handful of refused starts in 10 s on a backoff (not a loop), and once the fault is gone a later retry closes it, the switch applies and the turn runs. A BEFORE engine loops on each (cut short by a halt). A switch queued in a turn survives a retire in the middle of it: a rehire naming opus cancels it (recorded) and the agent stays on opus; a rehire naming no tier applies it at once; a queued Codex account change is cancelled (recorded) by a rehire naming the account |
| `hire-scope.mjs` | a new hire's folders and tools (3.x hire rules, PLAN I6): a user's hire without folders gets its superior's (the org's at the top level) and its CLI starts with them; a folder the superior does not hold, or holds read-only when read/write is asked, is refused; an agent's hire must state folders, every tool and its visibility, and cannot pass on a tool its superior lacks; a user's hire is clamped to the superior's tools and visibility with a warning, and an agent asking for more visibility than it holds is refused (D-021) |
| `documents.mjs` | `orgtree_present` and `orgtree_send_file`: markdown read back by the user, `replaces` in place, an `.html` mockup, the refusals (no title, over 64 KB, body and path, another's card, no user audience), the title clipped to 120; deliveries as snapshots, one delivery per `delivery_id`, folders held and not held, a folder, a climbing path, an empty file and one over 256 MB refused; P17: a report's stale folder grant does not outlive its superior's |
| `present-documents.mjs` | documents the user reads are presented (decision 57): a new hire's launch instructions lead with "anything the user is meant to read goes through `orgtree_present`, even when they ask for it to be sent" and limit `orgtree_send_file` to files wanted as files; the old "WHEN THE USER ASKS FOR A FILE" lead is gone and the kept guidance (the superior route, a path is not a delivery, images, angle-bracket links) is still there; the top-level agent has the same text; the tool list the CLI is served carries the same rule; a markdown body over 64 KB is refused with "shorter or split", not "send it as a file". A `.md` file as `path` (decision 58): the instructions and the tool description say so; the user reads the file's text back exactly (multi-byte characters included); `replaces` with a path updates the same card; a byte-order mark is dropped; exactly 64 KB is presented and one byte more refused; a non-UTF-8 file, a `.txt`, a folder named `.md`, a `.md` outside the agent's folders and an agent without a user audience are refused, and nothing refused is presented |
| `credits.mjs` | `orgtree_request_credits` and the user's decision as the agent is told it: one credit tab amended in place, withdrawn by asking for no more; approved, counter-offered, declined (exactly the old grant) and reduced (less than before), and denied; the older `/credit-requests` route's dry run refusing past the top-level cap and below what the reports hold; zero headroom makes no request; a cap of 0 is uncapped |
| `scope-requests.mjs` | `orgtree_request_scope` and what the agent is told after the user approves: a tool granted, a folder inside the org's read-only folder partially clamped (held read-only), a folder outside the org's folders clamped (not in effect), matching what the CLI gets; already-held items dropped; routing to the superior without a user audience |
| `questions-import.mjs` | the requests a 3.2 store hands over open (`prepare32` with an open question in the older single-question shape, and an open batch with a pending credit request and a pending scope request): each agent's one open card, the docket links, a new ask adding to the imported card, and the desk's batch submit delivering the answers, the credits and the access |
| `claude-accounts.mjs` | Claude agents across accounts: an imported Claude folder (B) and an API-key account (K) added through the accounts route; hires on B run with its `CLAUDE_CONFIG_DIR`, on K with `ANTHROPIC_API_KEY`; a usage limit with account fallback moves an agent to B at once (transcript carried into B's folder, session resumed); `orgtree_continue_on` does the same for a frozen agent; B turned off holds its agents' mail; B removed puts them back on the primary (the fake refuses a `--resume` whose transcript is not in its folder, as the CLI does) |
| `codex-accounts.mjs` | Codex agents across accounts: an imported Codex home (B) and an API-key account (K) added through the accounts route; agents hired on B run with its `CODEX_HOME`, on K with the key in the key's own home; a usage limit with account fallback moves an agent to B at once (thread carried into B's home and resumed, the stopped request given again); `orgtree_continue_on` does the same for a frozen agent; B turned off holds its agents' mail until it is back; B removed puts its agents back on the primary with a fresh thread and the handoff note |
| `codex-lane.mjs` | luna agents on the fake `codex app-server`: a normal turn (reasoning, message, a dynamic `orgtree_*` tool, an approval, tokens as a difference of the thread's totals), the thread resumed after an engine restart, mid-turn mail through `turn/steer`, an interrupt, the app-server dying mid-turn (connection freeze, the retry resumes the thread), `usageLimitExceeded` (a limit freeze until the turn's own reset), `unauthorized` (superior told, no park), the sandbox runner hint |
| `canvas-resize-crash.mjs` | the canvas survives a viewport resize right after mount (finding F1); run with `up --ui <bundle>` |
| `mailhub-v2.mjs` | Orgtree 4.0.2 against mail hub v2 through the real net client (`up --hub`): the engine hosts `orgtree-mailhub.exe` on its own role and database (that role kept out of the engine's database, at most 8 connections) and imports a v1 `hub.sqlite3` at the first start (kept; a message v1 had queued is delivered); two orgs register, long-poll, acknowledge, receipts go sent/delivered/read, an attachment round-trips; a person registered over HTTP is listed with kind person and each hub's version; replies over @net (an agent's, the org inbox panel's, a person's and one to a person) carry `reply_to` through the hub and arrive quoted (IN REPLY TO), an internal reply and its refusals; 30,000 characters, 100 KB and 40,000 characters arrive whole; the hub forgets an org and the engine registers again; `--big`: one whole 1 GiB file between the orgs, timed and sha256 checked, and refused at send with one byte of text more |
| `mailhub-v2-desktop.mjs` | the org inbox panel against a hosted hub in the real renderer (`up --hub --ui <bundle>`, desktop script `desktop/orginbox-reply.cjs`): the reading pane quotes what an inbound hub reply answers; the pane's Reply, with a file chosen in its box, goes out as the organization naming that row (reply_to through the hub, quoted on arrival, the file byte-identical); no notice toggle for an outside sender; the mailservers tab and the canvas tile name the hub's version |

## What keeps it safe

- **Rig mode in the engine** (`src/rig.rs`) is compiled into debug builds only. It switches on
  only with `ORGTREE_ENGINE_SAFE_START=1`, `ORGTREE_ENGINE_RIG=1`, the marker file
  `.orgtree-rig-root` in the data root, and a root outside `%APPDATA%\Orgtree v2`; asking for it
  anywhere else (or from a release build) refuses to start before anything is written. In rig
  mode every home-folder lookup goes to `<root>\rig-home` (a fake profile: the real `~/.claude`,
  `~/.codex`, `~/.orgtree` are never read or written), provider CLIs come only from
  `ORGTREE_CLAUDE_BIN`/`ORGTREE_CODEX_BIN`/`ORGTREE_AGY_BIN`, no usage probe or OpenRouter call
  is made (canned readings may be dropped into `rig-home\rig-usage\<lane>.json`, or
  `<lane>@<folder>.json` for the one login whose Claude config folder or Codex home is named
  `<folder>`; they are cached like a probe's reading), and one test-only route exists:
  `POST /api/rig/tool {org, agent, tool, args}`.
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

`tools/rig/fakecli` (`orgtree-fakecli.exe`, copied into each run as `claude.exe`, `codex.exe`
and `agy.exe`) is launched by the engine exactly like Claude Code. It answers `initialize`,
connects the in-process `orgtree` MCP server (initialize, tools/list), runs `orgtree_*` calls
through `mcp_message`, fires the PostToolUse hook after every tool use (that is where the engine
hands over mid-turn mail), and writes session transcripts under the fake home so `--resume` works.
As `codex.exe` it plays the Codex app-server, as `agy.exe` the Antigravity CLI (below).

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

### As `codex app-server`

The same binary is also copied in as `codex.exe`; launched with `app-server` it speaks the
JSON-RPC the engine drives (`src/runtime/codex.rs`): `initialize`, `thread/start` and
`thread/resume` (a rollout file under `<CODEX_HOME or rig-home\.codex>\sessions`, so a resume
finds the thread, also after an engine restart), `turn/start`, `turn/steer`, `turn/interrupt`,
`model/list` (the five Codex tier models, every effort) and the account reads. The rig's fake home
carries a Codex login (`rig-home\.codex\auth.json`, an unsigned id token naming
`rig@example.invalid`), so the openai lane reads as signed in and luna/sol/terra/astra agents can
be hired. A turn plays the same scenarios, with these differences:

| Step | Effect on the Codex wire |
|---|---|
| `text` / `thinking` | an `agentMessage` / `reasoning` item with its deltas |
| `{"tool": "orgtree_x", ...}` | a `dynamicToolCall` item; the engine answers `item/tool/call` |
| `{"tool": "shell", "args": {"command": "..."}, "result": "...", "exit_code": 0, "approval": true}` | any other tool: a `commandExecution` item, with `approval` first asking `item/commandExecution/requestApproval` (the decision is logged as `approval`) |
| `{"poll_mail": {...}}` | waits until a `turn/steer` arrives (mail, or an engine hint) |
| `{"error": {"message": "...", "codexErrorInfo": "unauthorized"}, "will_retry": false}` | an `error` notification; without `will_retry` the turn completes as `failed` with that error |
| `{"result": {"status": "failed", "error": {...}}}` | ends the turn with that status |
| `{"start_error": "..."}` (a script's first step) | `turn/start` is answered with that error; the turn never starts |
| `{"usage": {"input": 5000, "cached": 4000, "output": 120}}` | this turn's tokens (the thread totals carry on across resumes) |
| `{"rate_limit": {"primary": {"usedPercent": 100, "resetsAt": <epoch s>}}}` | an `account/rateLimits/updated` notification |

`exit`, `hang`, `sleep_ms` and `raw` work as above. The engine's account and model probes run
without an agent name and log to `fakecli\log\probe.jsonl`.

### As `agy` (Antigravity)

As `agy.exe` (`ORGTREE_AGY_BIN`; the lane reads as installed and signed in, so `flash` agents can
be hired) it plays print mode with stream-json both ways (`src/runtime/agy.rs`): one process,
one turn per `{"event":"user"}` line, answered with `init` (the conversation id; `--conversation`
resumes it), `step_update`s and a `result`. It works from the agent's folder like the CLI:
`orgtree_*` tools go to the MCP server named in `.agents\plugins\orgtree\mcp_config.json` (the
engine's `mcp-bridge` over the agent's named pipe), every tool first passes the `PreToolUse` hooks
and every model invocation ends with the `PostInvocation` hooks from `.agents\hooks.json` (the
engine's `agy-hook` rights check and `agy-steer` mail handoff, run as commands with their JSON on
stdin; their answers are logged as `hook` and `hook_mail`).

| Step | Effect on the Antigravity wire |
|---|---|
| `text` | an `agent_response` step: deltas, then DONE with its tokens |
| `{"tool": "orgtree_x", ...}` / `{"tool": "run_command", "args": {...}, "result": "..."}` | a `tool` step; a denied call ends in ERROR with the hook's reason |
| `{"poll_mail": {...}}` | runs the PostInvocation hooks until one hands over mail |
| `{"usage": {"input": 3000, "cached": 2000, "output": 50}}` | the tokens of the following responses |
| `{"error": "..."}` / `{"result": {"status": "ERROR", "error": "..."}}` | ends the turn with that result |
| `{"init_model": "..."}` (a first step) | `init` names this model instead of the pinned one |

## Tool calls as an agent

`POST /api/rig/tool {org, agent, tool, args, tool_use_id?}` → `{ok, text, json}` calls
`tools::call_tool` as that live agent, exactly what its CLI's `mcp_message` reaches (permissions,
visibility and side effects included). `rig.tool(agent, tool, args)` in scripts,
`rig tool <agent> <tool> '<json>'` on the command line; assert on the result and on the database
with `rig.sql(query, { db })` (psql against any database of the run's cluster, rows as JSON).
`rig.exec(statements, { db })` runs statements (DDL, writes) on the run's cluster, and
`await rig.restart()` stops the engine gracefully and starts it again on the same data root and
cluster, which is what quitting and reopening the app does to the engine. `await rig.crash()`
kills it at once instead (an install or a crash: its job takes PostgreSQL and the CLIs with it);
follow it with `restart()`. A safe-start engine wakes no agent at start, so a run that needs the
restart path (cut turns closed, their mail settled, the restart message and notices, freeze timers
re-armed, waiting mail woken) is started with `recover` (`up --recover`, or `{ recover: true }`
from a script's `setup()`). A safe start also never runs the automatic wakes (working checkups,
idle docket reminders, abandoned docket recovery); `reminders` (`up --reminders [seconds]`, or
`{ reminders: true }`) starts that sweep on a 5 s cycle (or every N seconds; the product's is
20), the working cache keeper included; `reminderPauseMs` holds each wake between its
reservation and its mail, so a script can start real work in that window.
`up --hub [exe]` (or `{ hub: true }`) makes the engine host a mail hub inside
the run: the binary (by default an `orgtree-mailhub.exe` in your cargo target,
release first, else the submodule's release build) is copied into the run, gets
a free loopback port and the name "rig hub", and the run's network mail reaches
it and no other hub (`rig.hubUrl`); without it network mail stays off. The wakes fire after 20 minutes without activity, so a script back-dates the agents' turns,
status and wake stamps with `rig.exec` rather than waiting (see `reminders.mjs`).

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
