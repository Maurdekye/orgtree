# The test rig: a scratch engine you can drive end to end

`tools/rig` runs the real Rust engine against a throwaway data root with its own PostgreSQL
cluster, plays scripted CLI output through a fake Claude Code CLI, calls any `orgtree_*` tool as a
chosen agent, and tears everything down. Use it to prove a change through the real path instead
of labelling it "inferred". Node 24 built-ins only; no `npm install` needed (the desktop smoke
runs an existing `electron.exe` in place).

## Quick start

```bash
export CARGO_TARGET_DIR='C:/orgtree-build/<you>'             # team rule: use your own C:/orgtree-build folder; E: is refused
node tools/rig/rig.mjs build                          # debug engine + fake CLI, under the machine-wide build lock in queue order (see "The build lock"; needs >= 3 GB free RAM)
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
(`{ fixture: 'none', legacy: <dir>, prepare: async ({ data, pgBin }) => … }`; `maxParked: n` sets
the engine's cap on idle CLIs for the run, `ORGTREE_RIG_MAX_PARKED`, the product's being 64). `proof.mjs`
records pass/fail checks and evidence under `<rig home>\evidence\<proof>-<time>\`, which outlives
the run.

| Proof (`tools/rig/proofs/`) | What it runs through the real engine |
|---|---|
| `turn-recovery.mjs` | CLI exits mid-turn → connection freeze → timer retry with the banner on the resumed session; a 401 result → auth park and the superior's one-time notice |
| `turn-start-clock.mjs` | the running turn's start reaches the desk ([tool-writing-and-link-menus.md](tool-writing-and-link-menus.md)): `turn_started_at` null while idle, the same on the node and the chat payload while a call runs, the call started at or after it, this turn's own, null again after |
| `background-and-mail.mjs` | stopped and orphaned background tasks (P33), the 45 s unread notice (P36), mid-turn mail through the PostToolUse hook |
| `claude-bg-result.mjs` | a command Claude Code runs in the background, on the fake's `bg` step ([background-work.md](background-work.md)): its chip gets the output from the output file; the turn the CLI starts by itself is interrupted and an idle agent woken once; a later turn takes one that ends while it runs; one that ends during that turn's last model step is caught by the CLI's own turn right after; a failed one says so |
| `bg-keep-open.mjs` | background work keeps a process open (decision 77), with the idle cap at 1 (`maxParked`): a parked process evicted by the cap, or by warming switched off, is held while its command runs and not counted; with warming off a turn's end holds the Claude CLI or Muse host until the result reached the agent on the same process, then it closes; a result settled in a turn's last model step; a startup-file edit leaves a held process alone |
| `muse-bg-result.mjs` | a shell command Muse moves to the background ([muse-code.md](muse-code.md)): the late result on its chip, one wake for an idle agent, Muse's own delivery turns cancelled, a later turn taking it, a failure, a host halted or closed at a usage limit, a turn slot wait |
| `undo-history.mjs` | the user's persistent undo history ([undo-history.md](undo-history.md)): a move, a hire with its placement (one gesture, a back-reference), a retired team and a model/effort/charter save undone and redone in place through the forward ops; a hire that ran asks first and a stale confirmation asks again; a new action clears redo; a change outside the history refuses that entry with its reason and nothing else, the next undo moving on; agent tools, no-ops and repeated request ids never record; a stale id and a second window answer `history_moved`; the bound of 100; the history across an engine restart; no entry data in any answer or the feed. Red: each conflict is made by a real change, and each restored tree differed before |
| `muse-approval-stages.mjs` | a compound shell command Muse asks about in stages, on the fake's `stages` approvals ([muse-code.md](muse-code.md)): every open stage answered once in order and the command runs; each update delivered twice, still one decision a stage; a seat without the shell refused at the first stage; a `write_todos` call's list on the call's own chip, no second chip |
| `docket-rules.mjs` | docket read/update permissions and stale `expected_rev` refusals, checked in the database |
| `batch-halt.mjs` | Halt subtree / Unhalt all / Halt all (with a turn running) / Unhalt subtree from the menus, in the real renderer |
| `import-2x.mjs` | first-start import of a synthetic 2.x store, section by section; a damaged store keeps nothing, retries, and shows its line in the org list |
| `import-30.mjs` | first-start import of a synthetic 3.1.0 store (the `orgtree` database the released 3.0.9/3.1.0 leave, migrations from git at `v3.1.0`); an unmarked org stays out; a broken org keeps nothing, is named in the org list, retries without restoring an account the user removed, and imports once repaired; an unreadable `public.orgs` never stops the engine |
| `import-3x.mjs` | first-start import of a synthetic 3.2 store (the 3.2 alpha layout) with a row in every section; an older alpha schema (0015) imports in full; a broken store keeps nothing, is named in the log, ot.kv, the app feed and the org list, retries, and imports in full once repaired; an unreadable registry never stops the engine |
| `openrouter-lane.mjs` | agents on the OpenRouter lane (key and favorite carried over from a 3.x `openrouter\state.json`; the gateway's key check scripted through `rig-home\rig-usage\openrouter-key.json`): a 401 parks with the OpenRouter remedy and the panel stops saying "connected" at once; the fourth 402 parks with the balance remedy; a key check without credit fields does not crash the panel's document |
| `openrouter-numbered-keys.mjs` | every OpenRouter key alike (user 2026-10-14): ids numbered from 1, the panel and lists uniform, a hire naming no key placed and bound, removing the first key like any key; migration 0022 on a rewritten legacy scratch database (`openrouter-key`/lane `openrouter`, unbound and lane-bound seats, turns, history, marks, spend, org default and switched-off list) renumbered once, idempotent, the seats on the same secret. Red: an engine without 0021 |
| `langserver-lane.mjs` | the Language Server lane with the REAL harnesses (`--real-cli`: the installed Claude Code and Codex, their home the run's fake one) against `fakellm.mjs`, a scripted server that answers like Ollama and streams Anthropic Messages and OpenAI Responses: the settings probe reads models and windows; one server per harness on one address; each agent's scripted `orgtree_status` call reaches the engine; what reached the server (model, the lane's placeholder key, the orgtree tools, a reply size the window can spare); turns cost 0, `local`; the agents-at-once cap; "Create a 64K version of this model" only on request (API and a real click); Codex's per-server model catalog (checked by Codex, used, and silencing its "model metadata not found" warning); a template saved from the org; the lane colour per theme |
| `langserver-real.mjs` | NOT part of the regular set: the Language Server lane against a REAL model server (a GPU and a running server, for example llama-server; `--url --model --ctx --server-log <its log> [--only claude|codex]`). The installed Claude Code and Codex each get one small docket ticket, one after the other; it records the outcome (item, evidence, the script re-run), the turn (time, tokens, cost) and every tool call, and from the server log each request's new prompt tokens, context in use and speed. With `--preset ollama --variant [--ui <bundle>]` it first loads the model at Ollama's default window and checks the lane sees it, then makes the 64K version the way the settings button does (a real click in the add form with `--ui`; the page script's `fresh` mode needs no org, agent or server yet), hires on that version, and afterwards checks Ollama holds it at 64K (the spikes of 2026-10-10: llama.cpp b11540 and Ollama 0.40.2 with Qwen3.6-35B-A3B) |
| `langserver-strict.mjs` | the Language Server lane against STRICT chat templates (`--real-cli`; live bug 2026-10-10, llama.cpp + Qwen 3.8: "System message must be at the beginning", retried every 30 s): `fakellm.mjs` with `strict: true` turns each request into chat messages the way a llama.cpp-style server does and refuses a system message after the first or two turns of one role in a row, with llama.cpp's 500 and Jinja words. The installed Claude Code and Codex pointed straight at it are refused (the control); through the engine's pass-through (`lsproxy.rs`) an agent on every preset (Ollama, LM Studio, llama.cpp, vLLM, custom) and both harnesses finishes a turn with a tool call, none refused; a server gets its own key or the placeholder, never the CLI's; a template that still refuses fails the turn once with the server's words (no CLI retry, no freeze) |
| `langserver-compact.mjs` | a Language Server agent whose context fills keeps going (`--real-cli`; live bug 2026-10-11, llama.cpp + Qwen 3.8, 64K: "automatic compaction failed: summarization produced empty response"): `fakellm.mjs` in WINDOW mode (64K, llama.cpp's 400 past it, an answer cut where the window ends) answers the CLI's summary request like a model that calls an offered tool (TOOLS) or thinks past any window (RUNAWAY), honouring only the thinking switches each real server is known to honour. 5 presets x both harnesses x both profiles (20 agents): every agent finishes its task; where the pass-through can switch thinking off, the CLI's own compaction works (summary requests without tools, answered with the summary); elsewhere the engine moves the agent to a fresh session with a handoff note and tells its superior once; every agent has its window and an occupancy (the gauge). `PROOF_COMPACT_ONLY=a,b` runs the cases whose name contains one |
| `langserver-context.mjs` | NOT part of the regular set: a measurement. Captures the whole FIRST request a Claude Code and a Codex agent on a language server send (through the engine, and with each CLI's own trimming options), for splitting into parts and counting with a server's tokenizer outside the repo |
| `muse-lane.mjs` | the Muse Code lane on the fake `muse serve` (MSP v1): discovery and entitlement by the account's own catalog, native effort names, launch switches (contributor mode off), session MCP tools, steer, queue, interrupt, quota and auth, subagents, read-only seats, resume, compaction, account fallback among Muse logins, key roots |
| `muse-r1.mjs` | the Muse lane's sticky workspace roots (the fake keeps them per session as MSP does): a resumed session's turns carry the current grants (read-only, added, unchanged, revoked); synthetic sentinel credentials in a granted MCP server's environment, header and argument reach the host but never the engine log. Run it again with `up --quiet-log` (the engine without verbose call lines) |
| `muse-routes.mjs` | Muse's account routes on canned readings: the limit fallback onto the user's own login and each gate that refuses it, and the org account-list move's catalog gates |
| `muse-placement.mjs` | a Muse seat placed and tuned by the login it runs on: staffing per login, hire/switch/account move, pinned and per-login effort, an unreadable login, a signed-out own login |
| `muse-r2.mjs` | the Muse lane's round-2 corrections: a retool naming an account and an effort is checked on the login the seat lands on (the primary aliases, the account it is on, an unknown one; a refusal changes nothing); a busy seat queues the account and the level is checked on the queued login (retool and the settings route, turns held by a `hang` step); `/api/providers` lists a model only a registered login offers and `muse.logins` each login's levels, and stays hirable with the own login signed out; staffing account kinds and levels; best-allowed placement skips a login lacking the model; removing a Muse login moves a seat to the own login or the subscription that offers its exact model and pin |
| `muse-r4-removal.mjs` | the Muse lane's round-3 removal correction: a removed login's live seat goes to the own login when every gate passes and its catalog offers the exact model, else the first registered subscription that does (never a key; the own login's switch, org list, sign-in, re-authentication and a full window each skip it); none left: unbound and frozen, the held request kept, refused on the own login and recovered on a login that offers it; queued moves and switches retargeted or dropped; defaults to the own login; a mid-turn refusal changes nothing (readings name the model observed running: Muse windows count only for it) |
| `muse-held-replay.mjs` | the Muse lane's round-4 correction: a removal that moves a seat and releases a freeze holding a request (a removal freeze kept from a quota wall, kept again by the account operation) gives the request back as one wake mail in its own transaction: once through a first attempt rolled back at the NOWAIT org scan (an event-trigger barrier and an org-first psql writer, as `folder-grants-account-removal.mjs`); a halted seat keeps its halt and its mail waits; no request, no mail |
| `muse-r4-routes.mjs` | the Muse lane's round-3 retool and continue-on corrections: an effort-only retool after a queued account move is checked on the queued login (route and agent tool, inverse refused with nothing changed, a named account overriding, a queued `default`, no-queue control); continue-on (route and tool) refused on logins whose own catalog lacks the exact model or pin, or cannot be read, with nothing changed; a frozen seat's continue choices; positives |
| `muse-ui-logins.mjs` | with `--ui`, the real renderer: "Hire a subordinate" offers Wonder Full only a profile offers and the draft lands on it; a signed-out own login's Wonder hire lands on a registered login; a seat switched to Full in its settings is not offered its profile that lacks Full and is told why; a pinned seat's settings and desk offer the pinned version's levels, a profile seat its own (`desktop/muse-logins.cjs`) |
| `muse-visual.mjs` | Muse's colours, tier letters, frozen icons, Providers row, Usage card, the Muse Eggshell theme and effort names in the real renderer (`--ui <bundle>`) |
| `muse-real.mjs` | NOT part of the regular set: the REAL Muse Code (`up --real-muse <muse-bin-*.exe>`, the user's own login; synthetic turns on every offered model, contributor mode off, resume) |
| `provider-chips.mjs` | the provider cards' model chips, clicked (`--ui <dir>`; user 2026-10-10: change the models without the edit form; more than eight chosen are icons alone): on three fake language servers and one that is down, a click offers or withdraws a model at once (the engine's list and the hire offers follow; no edit form opens), a short list shows every model with the ones not offered dimmed, ten offered are cards alone, a 302-model server shows "+300 more" opening the browser that saves each change at once; OpenRouter (rig mode's canned key check and catalog, `rig-usage\openrouter-models.json`): nine favorites are cards alone, a click deselects one (dimmed in place, names back at eight) and a second selects it again, "+" opens the picker whose pick adds a chip; dark and light screenshots |
| `input-panics.mjs` | inputs from outside that used to panic the engine: non-object tool arguments, NULLs in a 3.2 store's folder and list tables, a foreign file name in `diagnostics\logs` |
| `turn-failures.mjs` | after a failed turn (3.x parity): a Codex turn stopped by a usage limit keeps its mail in the freeze (`resume_texts`) and is given it again at the automatic wake and after `orgtree_unstick`, and its reset sends nobody a weekly-Fable notice; consecutive failed turns (Codex and Claude, and turns the idle limit killed) are reported to the superior once, and a completed turn makes the next failure news again; a Codex turn's mail is delivered once `turn/start` was accepted (a provider that keeps failing does not get a growing batch), while a refused `turn/start` gives it back |
| `agy-lane.mjs` | flash agents on the fake `agy`: a normal turn (an orgtree tool through the engine's mcp-bridge, a native tool, tokens summed over responses), mid-turn mail through the PostInvocation hook, a seat without shell rights denied by the PreToolUse hook, an interrupt, the CLI dying mid-turn (the retry resumes the conversation), a quota wall frozen until its own "Resets in" countdown (keeping the request), the same countdown anchored once (kept while ahead, the 5-minute probe floor once stale, forgotten after a completed turn), the 3.x limit words, a refused model pin, the conversation resumed after an engine restart |
| `account-windows.mjs` | the user's rule, never a model on a login whose window it spends is at 100%, with per-login readings: quick staff does not offer (and its commit refuses) a full login or a full default; continue-on (the tool and the user's route) refuses it, with Fable's own weekly window counting for fable only; the automatic fallback moves an agent only onto proven room, else it freezes |
| `fallback-slow-read.mjs` | a login whose usage read takes 20 s (`"rig_delay_ms"` in its canned reading) cannot stall an agent through the account fallback: the turn ends at once (frozen first), the read is cut off after 5 s and counts as no proven room, and the agent moves to the next login with room |
| `engine-restart.mjs` | the engine killed mid-turn (`rig.crash()`) and started again with the restart path: Claude and Codex turns it cut are closed as stopped, their mail stays delivered and is not sent again, the restart message resumes each agent on its own session and thread, a pending connection-freeze retry is re-armed and runs on time, idle agents get the passive notice |
| `watchdogs.mjs` | an agent's watchdogs in a `recover` run: a file dog fires on matching lines only, a ONE-SHOT command dog fires once and is spent, `pid:N` fires when the process goes down, a stream dog fires on its command's lines and removing it ends that process, an activity dog fires on a report's `turn_done`, the mail wakes the owner, the ninth dog is refused, and a file dog survives an engine restart |
| `watchdog-slugs.mjs` | readable watchdog ids (decision 67) in a `recover` run: two dogs with one name get `build-watch` and `build-watch-2`, each named by its id; the fire's mail, monitor event and the turn it wakes carry `build-watch-2`; `list`, pause, resume and remove take the slug; a removed and a spent dog free their ids; a dog without a name is named by kind and target; two owners each keep a `build-watch` (a superior's bare id is its own, `owner/id` names the report's, a report cannot reach up, the user's bare id is refused as ambiguous and `owner/id` works); two racing creates get `race` and `race-2`; a dog with a random id still works by it; the desktop feed's `owner/id` handles are unique while a spent one-shot's id is reused; the dogs fire after an engine restart |
| `compaction.mjs` | compaction from each side: Claude compacting on its own mid-turn (`compact_boundary`: the desk row with the size before, the automatic notice, the turn goes on), the user's compact route (`/compact` as its own turn: context estimated and not yet run until the next turn measures it), Codex's `thread/compacted`, and a superior's cheap compact (a new session with the handoff note, the earlier conversation saved in the agent's folder, the old session closed) |
| `compaction-live.mjs` | the live compaction row in a `recover` run: a Claude `status compacting` start gives one `running` row timed from the engine's receipt, the end closes the same row (`done`, size before, start before end); an end with no start gives a row with no times; Codex's `contextCompaction` item then `thread/compacted` give one row and one notice; a failed compaction closes it `failed`; the CLI dying mid-compaction closes it `interrupted` with no end; the engine killed mid-compaction (`rig.crash()`) leaves it `interrupted` after the restart. Red on f1eed04: 7 of 10 checks fail |
| `questions.mjs` | the user's question cards (`orgtree_ask`): an ask from inside a turn opens the card, attached to the asker's docket item (which then cannot be deleted); asking again amends the one open card (a new tab joins, the same text replaces its tab, at most 4 per call and 8 per card); stale and holey submits are refused; the answer arrives as mail that wakes the asker (mid-turn through the hook, held while halted) and the item lets go of it; without a user audience the question goes to the superior; withdraw; the card's close reads dismissed; a retired asker's card reads moot; a cheap compact keeps the card and the fresh session is told of it; a malformed call's leaked options are recovered or refused, and options are clipped as in 3.x; the older answer route (`/asks/{id}/answer`) keeps 3.x's guards (every pick of a one-question card, no empty answer, no unstamped answer to an amended card, one answer per tab) |
| `questions-moot.mjs` | an open question across session replacement: a provider switch and the removal of the Codex account an agent ran on close its card as moot and tell the fresh session to pose it again; a user's account move that carries the Codex thread keeps the card open |
| `mailbox.mjs` | an agent's own mailbox and mail attachments (P11, P13): `orgtree_inbox` pages of 50 with a cursor bound to the agent, limits, target-shaped arguments and foreign cursors refused; fetch of 1–20 ids, long bodies as chunk 0 with digests, the 256 KB budget deferring rather than cutting, other agents' mail not found; chunk reads at UTF-8 boundaries back to the exact body, wrong handles refused, the handle still good after a restart; reading changes no delivery state; attachments capped at 10, only to the user or `@net:`, from the sender's folders, as outbox snapshots, and only with a user audience |
| `conversation-recall.mjs` | conversation recall (decision 55; `--hub <orgtree-mailhub.exe>` adds the `@net:` part): alice's mail with carol in order both ways with boss's mixed in, 20 a page with a cursor bound to her and the start said plainly, a limit-5 walk losing nothing, carol's mirror view, a reply linked to what it answers; the caps (limit 1000 gives 100, 500-character previews marked cut with the whole length, a page stopping at 16,000 characters with the cursor for the rest, `fetch` of sent and received mail whole); the user's mail with an attachment named; `@org:` and `@net:` mail of the org-inbox holders on both sides, a bare org name; refusals (another agent's cursor, unknown peer, herself, extra arguments) and nobody else's mail; 114 waiting notices: a real message still starts its turn with the 64 oldest and the leftovers ride the next (decision 56); the fresh-session note after a cheap compact names her correspondents newest first |
| `org-inbox.mjs` | mail between two orgs on one machine (`@org:`) and the org-inbox holders (P14, P15, P28): only a top-level agent or a holder writes outside; an org with no holder grants its first live top-level agent; single-holder grants revoke the previous holder; multi-holder off is refused while several hold it; a retired holder is replaced |
| `org-inbox-unavailable.mjs` | outside mail when the org-inbox holder cannot run (decision 59): a halted holder's `@org:` and `@net:` mail goes to the first top-level agent who can run, whose turn takes it, while the holder keeps the audience and gets no copy, and the sender is told who got it; the same for a holder frozen by a usage limit; with the first top-level agent halted too, the next one gets it; in multi-holder mode the holder who can run gets it and the frozen one no copy; with the holders retired, the inbox goes to the first top-level agent who can run; when nobody can run, the mail waits with the holder, the user is told, and it is read once an agent is unhalted |
| `agent-typing.mjs` | typing in Hubchat ([agent-typing.md](agent-typing.md)), on a hosted hub with the `typing` feature: the flat and split message shapes and a split notice are sent, a mixed call and an unknown metadata key refused; a haiku agent streaming `orgtree_message` sends a typing heartbeat about every 500 ms, never a second apart, to a registered person whose sync sends back its `typing_seq`, from the moment `metadata` is whole until the call's block ends, and none after its message; a body written first sends none and still sends the message; a block that never becomes a call stops at its end, seconds before the turn's; a quick call sends none |
| `hubchat-reply.mjs` | a person on the mail hub is answered with `orgtree_message` to their `@net:` address (decision 63): a new top-level hire's instructions say so in the org-inbox passage, even when that person is the user; a new report with no outside audience has no org-inbox passage; a message from `@net:peer.rig` reaches the inbox holder's turn with the reminder line naming that address; the user's own mail has none |
| `audiences.mjs` | who an agent may write to (superior, reports, peers; a distant superior's message grants a reply audience) and `orgtree_audience` request, grant, revoke and deny between agents, and an audience with the user |
| `attention.mjs` | attention flags and the user's replies on docket items: a reason required and bounded; a later update keeps the flag; amending keeps its revision; a stale dismiss refused; the dismiss clears, blocks and tells the owner; the dismissed reason cannot be raised again; a reply reaches the owner as item-linked mail and clears the flag with the reply on record, unless a linked question is open; the owner takes a flag down; replies addressed to a participant, refused for anyone else, and sent as a notice |
| `tree-credits.mjs` | the tree operations that move credits (3.x §4.5/§4.6), with no overdraft after any of them: move budget-neutral along the common-ancestor path (between teams, to and from the top level); retire returning the stake, a retire with reports archiving the team and saying it became a dissolve, a repeated retire a no-op; dissolve; rehire paying seat and grant, a live rehire a no-op; reallocate raising the chain, a cut below the reports' share refused; swap between siblings budget-neutral, a cross-team swap the payer cannot afford refused; self-subjugate; an archived agent moved for free and rehired under its new superior |
| `rehire-unrecoverable.mjs` | a 3.2 store's agent marked unrecoverable (its session lost), imported and rehired: live again on a fresh session whose first turn starts with the handoff note |
| `org-ops.mjs` | the user's org operations: Stop All (a running turn interrupted, armed dogs paused with 3.x's reason, no turn while latched; release lifts only the latch); delete mid-turn (the org gone from the list and its routes, its CLI stopped, its folders taken to the trash as 3.x did, a folder held open reported and a same-named org refused until it is let go, then swept); folders an earlier delete left behind swept before a new org takes the name; dissolve all; create's 3.x name rules (a held name refused, a name with no letter or digit refused, no slug cap, a name the file system refuses refused with nothing created); a restart after the delete leaves the deleted org alone |
| `org-settings.mjs` | the user's org settings as 3.x applied them: a folder taken off the org revoked from the top-level grants (warned per agent) and not given back when re-added (future hires only); a folder turned read-only downgrading the top-level grants (warned) and not upgraded back; a malformed folder entry refused (422) with the org's folders kept; a lowered cap below existing top-level grants kept and warned (D-014); bad values (permission mode, visibility, account, effort, switches) refused with 422 on the org settings, hire defaults and app defaults; cheap compaction occ kept within 5-95% with partial writes merged; a hire with an unknown mode refused, and a stored one never run as given |
| `visibility.mjs` | visibility as a capability (D-021): an agent hired with full visibility sees only itself and its reports once its superior is narrowed to self (orgtree_chart, orgtree_state_inspect and the org state block of its turns), and only its team once moved under a team-only superior; reads reach downward only (no transcript or folder outside the subtree, no path out of a report's folder) |
| `reminders.mjs` | the automatic wakes in a `reminders` run (3.x keeper order and next-action rules): an idle owner is reminded of its actionable items only (not blocked, backlogged, flagged or questioned ones); a reviewer of the item in review; an owner whose review has no reviewer, or a retired one, to name one; a deploy_ready item reaches the owner's nearest live superior (a top-level owner keeps it); a working agent with actionable items gets the reminder that names them, not the checkup; an unread notice holds no wake back; the text the agent reads is the one stored and asks for no `waiting` status; no halted/retired agent is woken; working agents with no items or only blocked items get generic checkups, while blocked/idle/done statuses without actionable items do not; each item's `next_action` agrees; no second wake on the next sweeps; the blocked option org-wide; working checkups with docket reminders off and docket reminders with checkups off; nothing with both off |
| `reminder-race.mjs` | an automatic wake is idle-only (`reminders` with `reminderPauseMs`): an agent that starts real work between its reminder's reservation and its mail has the reminder withdrawn (it never reaches him and runs no turn behind his work); an idle agent at the turn cap has its reminder accepted, waiting for the slot |
| `cache-keeper.mjs` | the working cache keeper with working checkups off: a working Claude agent idle 55 minutes gets one read of its own launch on a fork of its session (`--fork-session --max-turns 1`); nothing of it stays in the session; its cost and cache receipt are booked; not repeated; nobody idle, Codex or halted; the API-key lane after 4 minutes; tools denied; real work kills a running read and is not held up; a cancel is no failure, a failure backs off; nothing with checkups on |
| `startup-context.mjs` | an edit to a CLI's startup instruction files reaches the agent (decision 61, 3.x parity): the fake CLIs log the file they read at start; with no edit no CLI is replaced (through an idle re-check and a turn); after an idle edit to the scratch CLAUDE.md the forecast lists `startup` (not ready), the parked CLI is closed, and the next turn's CLI read v2 and resumed the SAME session; an edit during a long turn leaves that turn's CLI running, and after it ends a CLI that read v3 resumes the session; a Codex agent's AGENTS.md edit gives a new app-server that read it and resumed the same thread |
| `org-shared-notes.mjs` | the org's shared folder and AGENTS.md ([org-shared-notes.md](org-shared-notes.md)): a new org has an empty `_shared` before any launch; a launch holds it read-write, with the rule in the prompt and the folder kept off the granted list; an edit never respawns a warm CLI or shows in its forecast; with the CLI stopped the forecast lists `org_notes`, and the next CLI resumes the session with the text; a new hire gets the text, a read-only seat gets it with Edit/Write denied; it reaches the Codex, Muse (workspace root) and Antigravity prompts; another org's agent holds and reads only its own; a file watchdog on it is refused across orgs; attaching it works |
| `org-shared-notes-real.mjs` | the same file edited with the INSTALLED Claude Code (`--real-cli`, a language-server seat on `fakellm.mjs`) on an acceptEdits seat: its Write creates the org's shared AGENTS.md and a file in a new subfolder there, a Write of another org's is refused, a Write into lead's team workspace succeeds and one into a sibling's own workspace is refused, a later hire's first request carries the text, and the other org's agent sees only its own |
| `team-workspaces.mjs` | team workspaces ([team-workspaces.md](team-workspaces.md)): nested agents hold their own and every ancestor subtree's workspace nearest first, a sibling subtree's never; launches create them; a read-only seat holds them read-only; team AGENTS.md copies arrive nearest first, only in the subtree; a move changes the set at the next CLI; another org holds none |
| `org-shared-notes-keeper.mjs` | the working cache keeper (a `reminders: 3` run, working checkups off) reads a warm CLI's copy of the org's shared notes: the CLI started with V1, an edit makes V2, the keeper's fork carries V1, and the warm CLI runs on |
| `ticket-list.mjs` | a fresh session starts with the agent's live docket items (decision 64): cheap-compacted, an agent's next turn lists each item she owns in a live status (open, in_progress, blocked, review, approved, deploy_ready) with its status and first next step, newest updated first, the backlogged one apart, and her superior's item in review that names her as reviewer (not his item still in progress); no done, dropped or archived item; her instructions name none of them; a docket change afterwards replaces no CLI and her next turn does not repeat the list; an agent with 33 open items switched from Claude to Codex gets the 30 newest, "…and 3 more" and the `orgtree_work` call |
| `team-shape.mjs` | teams are flat by default (decision 65): a new report's and the top-level agent's launch instructions say to keep a team flat by default and to put a manager between you and a group of reports only when coordinating all direct reports takes too much bandwidth for one agent; the bundled coordinator charter preset has no "Never hire deeper" and says the same |
| `live-effort.mjs` | an effort change reaches a running Claude turn (3.x `send_live_effort`): mid-turn, `orgtree_retool`, the settings route, a clear (sent as the level it resolves to) and an unchanged level each answer `effort_delivery` in 3.x's shape and send `apply_flag_settings` (or nothing) to the running fake CLI, with no next-turn effort card; the next turn starts a fresh CLI with `--effort`; an idle change and a Codex agent (parked, and mid-turn with its card) take it from the next turn (`turn/start` effort); an effort-only retool leaves a report's parked CLI alone; with `--ui`, the desk after a retool mid-turn and the composer's toast |
| `cli-environment.mjs` | the Claude CLI's environment as in 3.x: agents carry `ORGTREE_NODE` (the mail hub's SessionStart hook stands down for them) and have PowerShell: with the terminal switch on, the CLI starts in essential-traffic mode, asked for PowerShell and reading cached flags, and its init lists Bash and PowerShell; with it off, neither shell is listed (the fake CLI models 2.1.292's PowerShell gate; the rig home caches `tengu_cobalt_ridge` as on) |
| `cold-reset-default.mjs` | the cold-turn reset's default occupancy, 25% (decision 54): an org with no setting stores none and reports `{enabled: false, occ: 0.25}`, as do the app defaults; agents switched on with an override naming only `enabled` inherit 0.25; with cold receipts, an agent at 30% of its context starts on a fresh session with the compaction handoff and one at 20% resumes; an org occupancy of 40% reaches such an override (3.x key-by-key merge); with `--ui`, a fresh org's Org settings panel saved untouched stores the reset explicitly at 25%, and switched on shows 25% |
| `expired-marks.mjs` | an expired account limit mark: the account list's standing (and a registered account's usage readout) carries only marks still in force, so a card never reads "limited until" the past; inspect still lists the mark as `expired`, and a clear of it (app route and the agent tool) deletes it, audited, with `was_expired`, keeping a mark still in force; a stale fingerprint still answers `changed`. The hourly prune of marks a day past their horizon runs in the usage loop, which a rig engine does not run |
| `launch-failure.mjs` | a turn that could not start is told once, as 3.x's terminal belt did: a Codex `turn/start` refusal puts the mail back with the reason in `last_error`, gives the agent a notice that does not wake it and tells its superior (the user at the top level); a second refusal in the same run is not told again; a completed turn delivers the waiting mail and ends the run; a launch refused before any process starts (Claude through Antigravity turned off) is told too |
| `pending-switch.mjs` | a queued switch on an idle agent applies at once and a refused turn start never spins (decision 62): an Antigravity agent retired in the middle of a long turn has that turn closed as killed and none of its mail left claimed; rehired and switched to haiku, the switch applies at once and her next turn runs on the Claude lane with no refused start; a turn on record that no running turn owns (with mail it claimed) makes a switch queue, the idle agent closes the record herself (killed, the mail back in her mailbox, not in flight), the switch applies with no mail to wake her, and her next turn runs on sonnet carrying that mail; a record a database fault keeps open gets a handful of refused starts in 10 s on a backoff (not a loop), and once the fault is gone a later retry closes it, the switch applies and the turn runs. A BEFORE engine loops on each (cut short by a halt). A switch queued in a turn survives a retire in the middle of it: a rehire naming opus cancels it (recorded) and the agent stays on opus; a rehire naming no tier applies it at once; a queued Codex account change is cancelled (recorded) by a rehire naming the account |
| `hire-scope.mjs` | a new hire's folders and tools (3.x hire rules, PLAN I6): a user's hire without folders gets its superior's (the org's at the top level) and its CLI starts with them; a folder the superior does not hold, or holds read-only when read/write is asked, is refused; an agent's hire must state folders, every tool and its visibility, and cannot pass on a tool its superior lacks; a user's hire is clamped to the superior's tools and visibility with a warning, and an agent asking for more visibility than it holds is refused (D-021) |
| `retool-dirs.mjs` | `orgtree_retool`'s folders (decision 69): `add_dirs` adds a folder and keeps the agent's others, and its next CLI start carries them all; naming a held folder, in any case or separators, changes its mode, and making it read-only clamps the agent beneath (`clamped`, with a warning); `remove_dirs` removes a held folder from the agent and its report, and the agent is told; removing a folder it does not hold, or one also being added, is refused and changes nothing; the result lists the folders added, changed and removed, and a user's deep grant lists the raised middle under `raised`; `orgtree_state_inspect` shows each agent's effective folders; a rehire's `add_dirs` still sets the whole list |
| `harness-native.mjs` | `harness` on a hire or staffing is for OpenRouter tiers: an opus hire naming claude-code and a luna hire naming codex-cli (their own CLIs) are accepted as no-ops; opus with codex-cli, luna with claude-code and flash with claude-code are refused with "harness only applies to OpenRouter tiers; <tier> always runs on <its CLI>" and nothing is hired; `orgtree_staff` with tier opus and harness claude-code staffs its ticket |
| `documents.mjs` | `orgtree_present` and `orgtree_send_file`: markdown read back by the user, `replaces` in place, an `.html` mockup, the refusals (no title, over 64 KB, body and path, another's card, no user audience), the title clipped to 120; deliveries as snapshots, one delivery per `delivery_id`, folders held and not held, a folder, a climbing path, an empty file and one over 256 MB refused; P17: a report's stale folder grant does not outlive its superior's |
| `unread-restart.mjs` | a presented document's read state survives restarts (user report 2026-10-10: every card turned unread again after a PC restart): three cards, one opened in the desktop; the engine restarted (graceful) and a fresh Electron run on the SAME profile shows it read and the others NEW; a run on a brand-new profile (no localStorage, as after a crash or a lost profile) shows the same, because the engine holds `documents.viewed_at` and the payloads carry `viewed_at` |
| `present-documents.mjs` | documents the user reads are presented (decision 57): a new hire's launch instructions lead with "anything the user is meant to read goes through `orgtree_present`, even when they ask for it to be sent" and limit `orgtree_send_file` to files wanted as files; the old "WHEN THE USER ASKS FOR A FILE" lead is gone and the kept guidance (the superior route, a path is not a delivery, images, angle-bracket links) is still there; the top-level agent has the same text; the tool list the CLI is served carries the same rule; a markdown body over 64 KB is refused with "shorter or split", not "send it as a file". A `.md` file as `path` (decision 58): the instructions and the tool description say so; the user reads the file's text back exactly (multi-byte characters included); `replaces` with a path updates the same card; a byte-order mark is dropped; exactly 64 KB is presented and one byte more refused; a non-UTF-8 file, a `.txt`, a folder named `.md`, a `.md` outside the agent's folders and an agent without a user audience are refused, and nothing refused is presented |
| `credits.mjs` | `orgtree_request_credits` and the user's decision as the agent is told it: one credit tab amended in place, withdrawn by asking for no more; approved, counter-offered, declined (exactly the old grant) and reduced (less than before), and denied; the older `/credit-requests` route's dry run refusing past the top-level cap and below what the reports hold; zero headroom makes no request; a cap of 0 is uncapped |
| `scope-requests.mjs` | `orgtree_request_scope` and what the agent is told after the user approves: a tool and both narrow-inside-RO/outside folders granted; org defaults absorb approved folder intent (user 2026-08-08/P56), matching the refreshed CLI; already-held items dropped; routing to the superior without a user audience |
| `approved-folder-grants.mjs` | Explicit top-level/deep/direct folder intent enters org defaults atomically; unchanged latent scope, deny/skip and ordinary-agent elevation excluded; RO/RW, revoked child grant, concurrent user routes, org isolation, fake-CLI refresh and injected answer-mail rollback |
| `approved-folder-grants-round2.mjs` | Omitted/unchanged mixed RO/RW aliases in either order; equivalent aggregate intent, genuine additions/upgrades and explicit clamped reapproval; controlled user/agent hire/rehire audience transactions versus real folder routes, with observed wait queries and uncontended control |
| `approved-folder-grants-round3.mjs` | Paused no/empty-audience staffing and ordinary event INSERT before FK; real competing scope route, held-lock FK compatibility and atomic settlement, restored-seat control, two ordinary writers entering concurrently |
| `folder-grants-account-removal.mjs` | Qualifying synthetic Claude secondary/idle bound seat/matching org default; removal barrier before late org lock vs real approval/direct route, stale account binder, durable answer, removal delete-failure atomic rollback, queue/tombstone/primary guards and bounded contention refusal |
| `questions-import.mjs` | the requests a 3.2 store hands over open (`prepare32` with an open question in the older single-question shape, and an open batch with a pending credit request and a pending scope request): each agent's one open card, the docket links, a new ask adding to the imported card, and the desk's batch submit delivering the answers, the credits and the access |
| `claude-accounts.mjs` | Claude agents across accounts: an imported Claude folder (B) and an API-key account (K) added through the accounts route; hires on B run with its `CLAUDE_CONFIG_DIR`, on K with `ANTHROPIC_API_KEY`; a usage limit with account fallback moves an agent to B at once (transcript carried into B's folder, session resumed); `orgtree_continue_on` does the same for a frozen agent; B turned off holds its agents' mail; B removed puts them back on the primary (the fake refuses a `--resume` whose transcript is not in its folder, as the CLI does) |
| `codex-accounts.mjs` | Codex agents across accounts: an imported Codex home (B) and an API-key account (K) added through the accounts route; agents hired on B run with its `CODEX_HOME`, on K with the key in the key's own home; a usage limit with account fallback moves an agent to B at once (thread carried into B's home and resumed, the stopped request given again); `orgtree_continue_on` does the same for a frozen agent; B turned off holds its agents' mail until it is back; B removed puts its agents back on the primary with a fresh thread and the handoff note |
| `codex-lane.mjs` | luna agents on the fake `codex app-server`: a normal turn (reasoning, message, a dynamic `orgtree_*` tool, an approval, tokens as a difference of the thread's totals), the thread resumed after an engine restart, mid-turn mail through `turn/steer`, an interrupt, the app-server dying mid-turn (connection freeze, the retry resumes the thread), `usageLimitExceeded` (a limit freeze until the turn's own reset), `unauthorized` (superior told, no park), the sandbox runner hint |
| `canvas-resize-crash.mjs` | the canvas survives a viewport resize right after mount (finding F1); run with `up --ui <bundle>` |
| `mailhub-v2.mjs` | Orgtree 4.0.2 against mail hub v2 through the real net client (`up --hub`): the engine hosts `orgtree-mailhub.exe` on its own role and database (that role kept out of the engine's database, at most 8 connections) and imports a v1 `hub.sqlite3` at the first start (kept; a message v1 had queued is delivered); two orgs register, long-poll, acknowledge, receipts go sent/delivered/read, an attachment round-trips; a person registered over HTTP is listed with kind person and each hub's version; replies over @net (an agent's, the org inbox panel's, a person's and one to a person) carry `reply_to` through the hub and arrive quoted (IN REPLY TO), an internal reply and its refusals; 30,000 characters, 100 KB and 40,000 characters arrive whole; the hub forgets an org and the engine registers again; `--big`: one whole 1 GiB file between the orgs, timed and sha256 checked, and refused at send with one byte of text more |
| `mailhub-upgrade.mjs` | the hosted hub upgraded in place (decision 71; `--from <older orgtree-mailhub.exe>`, `--to` the newer, by default the one `up --hub` picks): the older hub registers two orgs and carries mail; the engine stops, the run's hub binary is replaced, and the engine starts again on the same data: the hub reports the new version and its features, its database moved to the new schema, it kept both addresses (same fingerprints, nobody registered anew) and every message with its receipts, and mail flows both ways; going back to the older binary, the hub refuses the newer database and exits, the Mail hub panel's error carries hub.log's reason, the engine keeps running and an @net send is refused at once saying this computer's mail hub is not running; with the newer binary again nothing was lost and mail flows again; a hub killed from outside is reported as exited without borrowing an earlier run's reason from hub.log |
| `mailhub-v2-desktop.mjs` | the org inbox panel against a hosted hub in the real renderer (`up --hub --ui <bundle>`, desktop script `desktop/orginbox-reply.cjs`): the reading pane quotes what an inbound hub reply answers; the pane's Reply, with a file chosen in its box, goes out as the organization naming that row (reply_to through the hub, quoted on arrival, the file byte-identical); no notice toggle for an outside sender; the mailservers tab and the canvas tile name the hub's version |
| `rig-cleanup.mjs` | the rig itself, with `cleanup({ dryRun: true })` only (it never stops anyone's run): a restarting run, a run still being created (asked from its prepare hook) and a run crashed on purpose before its restart are never cleanup candidates, and once ready its `busy` mark is gone; in a temporary rig home of fake runs, a stopped run and a run whose `busy` mark is older than 15 minutes are candidates and a fresh mark is not, a command without `--run` picks your own newest run over a newer one of another agent and refuses when only others' runs are up, and `down --run` removes a half-made run folder; a process running from the home's `runs` folder is a stray and one from elsewhere in the home is not, and a home with another agent's rig home inside it is refused; the rig cluster runs with fsync off (on with `fsync: true`) and a restart is timed |
| `pg-stop.mjs` | a measurement, not a pass/fail proof: how the engine stops its PostgreSQL under each caller's budget (docs/AGENTS.md, Stopping), in a run with fsync on; before each stop `--mb` MB of fresh dirty data, during it a writer fsyncing a file on the rig drive (`--calm` leaves it out), `--agents` an agent mid-turn; the keeper kills the engine tree after each of `--budgets` (default 8,12,15,45,300 s; run.json `stopKillMs`); per stop: when the engine reached the database stop, when the database was down (postgres.log), whether the kill came first, the checkpoint lines, and the next start's time and recovery. `ORGTREE_RIG_ENGINE=<exe>` measures another engine |
| `boot-host-stop.mjs` | the two ways the installer stops the background engine, on a real `orgtree-engine host` (the boot task's supervisor) over the run's data, with a Claude and a Codex agent mid-turn: asked (the attach descriptor's token, `POST /api/desktop/shutdown`): the engine runs its own shutdown and stops each agent itself, PostgreSQL stops cleanly, and the host removes the descriptor and exits 0, so restart-on-failure leaves it stopped; the installer's fallback when it cannot ask (decision 80): a stop request in its record (the run's HKCU key, `ORGTREE_RIG_STOP_KEY`), then the host process alone terminated, as Task Scheduler's End does: the engine, which outlives its host since 2026-10-12, reads the request and stops the same way by itself (the descriptor stays behind); a bare host exit with no request: the engine keeps running and answering (the recovery rule), the older request stops nothing, and it stops when asked. How each CLI ended is recorded as a note: the engine's shutdown terminates them today (docket urgent-orgtree-s-hard-killing-of-codex-processes) |
| `session-upgrade.mjs` | agents moving between Session 0 and the signed-in session at their next turn (decision 84; a `recover` run, fake CLIs, `--session0 1`, the sign-in helper through a temporary interactive task as `codex-host.mjs`, so it needs a rig home under your profile): a Claude and an Antigravity seat run in CLIs the engine starts until the helper takes the host role, then their next turns run in CLIs the helper starts (its children, in a non-zero session), each told once with an `[ORGTREE SESSION NOTICE]`; a further turn is told nothing; the helper killed mid-turn (sign-out) ends the hosted CLI, the turn stops as "the user's Windows session ended" with no error left, its mail reaches the next turn, in Session 0, with the downgrade notice and the "continue" message; after an engine restart a seat back in Session 0 gets no notice and a restart notice ending "Session access at start: Session 0.", and one last in the signed-in session waits for the helper (logged once) and moves down, told so |
| `self-interrupt.mjs` | `orgtree_interrupt` on yourself (decision 86; fake CLIs, no helper): restart stops the turn at once and starts exactly one new turn within 10 s, logged; without restart no turn follows; refused while background work runs; an agent with every tool group off may restart itself but not interrupt others; restarting another agent is refused |
| `session-choice.mjs` | sign-in/out notices, 2c, 2d and the choice among the user's sessions (decision 86; set up as `session-upgrade.mjs`, so a `recover` run, helper B standing for a synthetic second session via `ORGTREE_RIG_HELPER_SESSION` and `<data>\rig-sessions.json`): the sign-in notice reaches a running Session 0 turn at its next tool boundary and idle agents passively (a Session 0 preference is told it stays); a watchdog on `session.signed_in` fires; an agent that picked Session 0 for its next turn is told so; a working agent with no docket work gets its checkup at once; the engine starts a dead helper's task after 30 s (`<data>\rig-helper-task.txt`); `orgtree_session` lists the sessions; a "remote" preference plus restart moves under helper B; an on-demand Session 0 plus restart runs in Session 0; helper B dying mid-turn while A stays stops the turn as the session's end and starts one new turn at once, under A, with one kill-record line and no sign-out notice, and a turn ended on purpose as B dies is not resumed; the sign-out notice reaches idle agents passively |
| `session-query.mjs` | `orgtree_session` and the sign-out resume (decision 85; set up as `session-upgrade.mjs`, with the core monitor's debug-rig stand-in `<data>\core-rig-signed-out` for the user's sign-in): a Claude and an Antigravity seat ask while nobody is signed in (`signed_in` false, Session 0, no move); a Claude turn asks again after the helper came up during it (this turn Session 0, the next one moves); both ask once upgraded (signed-in, no move); the helper killed under a hosted turn (sign-out) stops it, one new turn starts by itself within 15 s in Session 0 and its answer says so, no further turn follows, the idle seat gets none, and the kill record has one `codex-session-ended` line for the cut CLI |
| `run-on-startup.mjs` | the "run on boot" switch (it was "run on startup") in the real renderer (`--ui <bundle>`, desktop script `desktop/run-on-startup.cjs`, decisions 70 and 83): App settings › Runtime › Desktop with a planted bridge standing in for main; the switch reads "run on boot" (nothing still says "run on startup" or "start at login", and there is no "engine starts" choice) with a hint saying what on and off mean; a change main reports as declined (a Windows permission prompt answered No) shows main's message and leaves it on; an accepted change turns it off. What main does with it is `tests/disruptive/run-on-startup.test.mjs` and `tests/unix-boot-engine.test.mjs` |
| `build-lock.mjs` | the rig itself, no engine and no run (`node tools/rig/proofs/build-lock.mjs`): `rig build`'s lock against a temporary lock folder and queue with a fake build, never the real ones: a MOVED marker is refused and kept even when it looks stale; a free lock is taken only by the first queued name, whose line goes, and goes to the next name when the build ends, failed or not (the caller is told to mail them); a lock handed over to the caller, or claimed by its own watchdog, builds; a fresh lock of another agent is refused; a stale lock is left while a build process runs in the build folder, then cleared for a caller with nobody ahead or handed to the first queued name; a lock someone took during the build stays theirs; short of RAM a free lock is not taken and a held one is kept; blank lines and CR/LF in the queue; the D: defaults for the rig home (your own `D:\orgtree-work\rig\<agent>`), the lock, with `C:/orgtree-build/<agent>` as the cargo-target example; the shared `D:\orgtree-work\rig` and a home holding another rig home are refused |

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
  `<folder>`; they are cached like a probe's reading; the OpenRouter key check reads
  `rig-home\rig-usage\openrouter-key.json` and the OpenRouter catalog
  `rig-home\rig-usage\openrouter-models.json`, the body of `GET /api/v1/models`), and one test-only route exists:
  `POST /api/rig/tool {org, agent, tool, args}`.
- **Without rig mode a SAFE_START engine is not isolated**: it reads the real user's sign-ins and,
  every few minutes, runs the real usage probes (HTTPS with the real Claude token,
  `codex app-server`, `agy --print /usage`). Do not run scratch engines without the rig.
- **The build lock** (team rules 2026-10-09 and 2026-10-10): `rig build` holds the machine-wide
  lock folder `D:\orgtree-work\cargo-target\build.lock` (`ORGTREE_BUILD_LOCK` names another) for
  its one build, in the order of `build.queue.txt` beside it. It takes a free lock only when the
  queue is empty or names you (`ORGTREE_AGENT`) first, removing your line; it builds at once under
  a lock whose owner.txt already names you (handed over, or your watchdog's claim). When the build
  ends, failed or not, the lock goes to the first queued name (owner.txt "handed over by", their
  line removed): the rig cannot send org mail, so it prints that you must mail them "build lock is
  yours". With nobody queued the folder goes. An owner.txt older than 30 minutes is cleared only
  when no build process runs in the build folder, and then goes by the queue the same way. A
  folder whose owner.txt starts with MOVED (`E:\cargo-target\build.lock` since 2026-10-10) is a
  marker, never a lock: the rig refuses it and never removes it. `CARGO_TARGET_DIR` on C: is
  allowed only under `C:/orgtree-build/<agent>`; other C: paths are refused. E: remains refused
  while `D:\orgtree-work` exists.
- **The rig home** (`ORGTREE_RIG_HOME`; by default your own `D:\orgtree-work\rig\<agent>`, by
  `ORGTREE_AGENT`, when `D:\orgtree-work` exists, else `E:\orgtree-rig`; runs, evidence and
  "before" engines made earlier stay in `E:\orgtree-rig`) is refused inside the live data folder
  or the repository. So is the shared `D:\orgtree-work\rig`, or any home with another rig home
  inside it (a folder holding `runs` or `pg`), because its cleanup would kill that home's
  processes (it did once, 2026-10-10). PostgreSQL binaries are copied there once (never run from the
  installed app, whose files an installer must be able to replace). Each run gets a copy of a
  cached `initdb` template (the engine's own `initdb` path: `up --initdb`). A run's cluster runs
  with `fsync = off` (only the rig's, never the app's cluster; coordinator 2026-10-10): surviving an
  OS crash is not under test, and with fsync on a busy disk a stop's checkpoint outlasts the
  engine's wait, so the next start fsyncs the whole cluster for minutes. `up --fsync` (or
  `startRun({ fsync: true })`) keeps it on, for a run that measures stops. An `--initdb` run's
  cluster keeps the default.
- **Processes**: a detached keeper (`keeper.mjs`) is the engine's parent. `rig down`, 20 minutes
  without a rig command touching the run (`--ttl`), or 120 minutes in all (`--max`) stop it
  gracefully, and the keeper kills the engine tree 45 s after asking it to stop (run.json
  `stopKillMs` sets another budget). If the keeper dies the engine shuts down, and the engine's
  kill-on-close job takes PostgreSQL and every fake CLI with it. `rig cleanup` deletes stopped
  runs and kills anything running from the rig home's `runs` or `pg` folder that no live run owns
  (nothing elsewhere in the home; `--mine` also stops your live runs). Every `up` and `run` cleans up first, so a run that is down on purpose (being created,
  restarting, or crashed by a proof before its restart) carries a `busy` mark in its run.json,
  which cleanup counts as live for up to 15 minutes; run.json is the first thing a new run
  writes. The engine gets a clean environment: none of the host agent's `ORGTREE_*`, `CLAUDE*`,
  credential or Codex variables.

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
| `{"spawn": "sleep 300"}` | starts the command through a shell (`cmd /C` on Windows, `sh -c` elsewhere) and leaves it running in the fake's process group and session, as a tool's child of a real CLI; logs `spawned` with `child_pid` and `command` (every log line's `pid` is the fake's own) |
| `{"bg": {"task": "b1", "id": "toolu_b1", "command": "npm test", "finish_ms": 3000, "status": "completed", "exit_code": 0, "output": "...", "description": "...", "agent": false, "miss_running_turn": false}}` | a call run in the background as Claude Code 2.1.292 reports one ([background-work.md](background-work.md)): the Bash call (`agent`: an Agent call) with `run_in_background`, `background_tasks_changed` and `task_started` (`is_backgrounded`), and its result naming the task and its output file (`<temp>\claude\<project>\<session>\tasks\<task>.output`). `finish_ms` later the file gets `output` and the fake prints `task_updated`, `task_notification` (status, a summary with the exit code, the file) and the live set. A turn running then takes it at its next step, unless `miss_running_turn` (it ended during that turn's last model step); else the fake starts a turn of its own (`system init`), which an interrupt within 400 ms ends with `[Request interrupted by user]` and an `error_during_execution` result with no usage (else it answers). At the end of its input it first waits for tasks still running. Logs `bg_started`, `bg_finished`, `own_turn`, `bg_delivered` (`how`) and `drain` |
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

`exit`, `hang`, `sleep_ms`, `spawn` and `raw` work as above. The engine's account and model probes run
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
stdin; their answers are logged as `hook` and `hook_mail`). A hook command runs through a shell, as
the real CLI runs it: `cmd /D /C` on Windows, `sh -c` on macOS and Linux, so a command a shell would
split fails here too. On macOS and Linux the bridge is a Unix socket (decision 66). `spawn` works
as for the CLI.

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
cluster, which is what quitting and reopening the app does to the engine (`rig.restart({ hub: '<exe>' })`
also replaces a hosted hub's binary while the engine is down, as installing another Orgtree does). `await rig.crash()`
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

`up --real-cli` (or `{ 'real-cli': true }` from a script's `setup()`) runs the INSTALLED Claude Code and
Codex as the agents' CLIs instead of the fake (copies of `claude.exe` from its npm package and of Codex's
bin folder; `ORGTREE_RIG_REAL_CLAUDE` / `ORGTREE_RIG_REAL_CODEX` name others). Every child's `USERPROFILE`
and `HOME` is the run's fake home (its `TEMP` and `TMP` the run's `tmp` folder), and a fixture may hire only language-server tiers (`ls-…`): any other
tier would run the installed CLI on whatever login it finds. Point such agents at `tools/rig/fakellm.mjs`
(`startFakeLlm({ rules })`), a scripted server that answers like Ollama and streams Anthropic Messages
and OpenAI Responses, so no model, GPU or account is involved (see `langserver-lane.mjs`). Its `models`
may carry a Modelfile window (`num_ctx`, shown by `/api/show`), `POST /api/create` (`from` + `parameters`)
adds a model the way Ollama does, and `bodies: '<dir>'` keeps every inference request's whole body. A fixture's
`langservers: [...]` adds servers (`POST /api/langservers`) before its agents are hired.

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
- The engine log carries prompt text too: logged functions log their return values, so an
  agent's instructions ("as it was when your CLI started") appear under its name. Match an
  engine line by its target and message, e.g. a harness launch by
  `runtime.claude: CLI started agent=N pid=P` with a positive pid, and check that every pid you
  compare is positive. A bare `/CLI started/` picked those prompt lines (pid 0) and let two
  `session-upgrade.mjs` checks pass on nothing (2026-10-16).
- Timers are real: a connection retry waits 30 s, the unread-mail notice 45 s.
- A halt (single or batch) kills the agent's CLI process tree; it does not send an interrupt, so
  the fake CLI logs no `interrupted` entry for it (the turn row is `killed`).
- Write page scripts and scenarios with an editor, not a bash heredoc: heredocs mangle
  backslashes in regexes and Windows paths.
- Several agents may share the rig home: `cleanup` only stops runs whose keeper is gone (or your
  own with `--mine`), and never another live run's processes; `--dry-run` shows the plan. A
  command without `--run` acts on your own newest live run (by `ORGTREE_AGENT`) and refuses when
  only other agents' runs are up, naming them. `down --run <id>` also removes a half-made run
  folder (one whose start never wrote run.json).
