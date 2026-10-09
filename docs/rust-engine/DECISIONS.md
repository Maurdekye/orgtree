# Orgtree 4 rewrite — the user's standing decisions

Every explicit decision the user (product owner) has made about the Rust rewrite, in the order
made. These bind the plan ([`PLAN.md`](PLAN.md)) and the code. A later entry that changes an earlier
one says so; nothing here is dropped without a new decision from the user. Add new decisions as
they are made, in the same landing as any change they cause.

All entries are dated 2026-10-06 unless stated otherwise.

## Mandate and working rules

1. **Rewrite the entire engine backend from the ground up in Rust**, using the existing bundled
   PostgreSQL. The frontend and its UX contract stay in place.
2. **Design from the frontend contract, not from the old backend.** Treat the renderer as the
   requirements document; pretend the Python engine does not exist; reuse none of its
   architectural patterns. Technical documents from the orgtree org's work docket may be borrowed.
3. **Prefer deprecating and omitting old or outdated features** wherever that makes the
   implementation more consistent, faster or more robust.
4. **Scale target: 1,000+ simultaneously active agents.** Multithreading, highly concurrent
   database access, channels between agents' tasks.
5. **No global locks of any kind.**
6. **Do all the work personally: no delegation** (no subagents).
7. **Work from the `dev` branch** (the rewrite branch is cut from `origin/dev`).
8. **After the plan is approved: no review agents and no unit tests during the build.** Churn out
   the rewrite as fast as possible; the user tests it personally; hardening with tests and review
   comes afterwards.
9. **Any conflict between a current user-facing feature and the new architecture goes to the
   user.** The user will usually accept reducing or altering features for performance or a
   simpler data model.
10. **The user must be told about every user-facing difference**, explicitly (kept in PLAN.md §10).
11. **Record every explicit decision as a standing note** (this file).

## Architecture

12. **Reduce overhead as much as possible.**
13. **Transport: HTTP for loading and actions; sockets for pushed updates.** (First "one socket per
    window" was chosen; the user then questioned using a socket for loading and HTTP was kept for
    loads. Supersedes the one-socket choice.)
14. **Socket rooms, like socket.io rooms / MQTT topic subscriptions**, so a window receives only
    what it shows — e.g. a room per agent for its live transcript.
15. **A full MQTT broker was considered** (user question); the recommendation against it (extra
    process and hop, no fit with the ordered record feed) stands unless the user decides otherwise.
16. **This ships as Orgtree 4 (4.0.0)**, because it removes notable functionality.

## Features that must stay (overriding the first draft of the ledger)

17. **The boot-time background engine task** (scheduled task, attach) is part of the MVP.
18. **Cache forecasting** (badge, countdown, changed parts, send warnings).
19. **The MCP waiting state**: MCP tools may come from external MCP servers that might not be
    present yet, so the tool-count / waiting state and "wait for MCP tools" stay.
20. **The org inbox** must be present (with `@org:` and `@net:` mail, holders, hub settings).
21. **The hiring credit cascade** (cascade hire / cascade allocate).
22. **Account fallback** remains an option.
23. **Mid-turn effort changes for Claude** must reach the running turn.
24. **Typed system-message cards** (ledger D1) stay.
25. **API-key accounts** (create them; metered spend) and the **ability to disable using
    subscriptions for inference** stay (ledger H3), with the API-key fallback switch.
26. **Agent tools kept:** `orgtree_staff`, `orgtree_swap`, `orgtree_self_subjugate`,
    `orgtree_unstick`, `orgtree_continue_on`, `orgtree_account_mark`, `orgtree_state_inspect`.
27. **Agent tools not needed:** `orgtree_preview`, `orgtree_capabilities` (reverses their keep in 26).

## Approval

28. **The plan is approved**: "all other decisions remain as planned" — every ledger entry in
    PLAN.md §10 not overridden above (no lineage nodes; no parked CLI per agent; Codex reserve
    routing, remote control, primed-restart chip and Fable policies removed; Antigravity mail at the
    next turn; one delivered state for steered rows; only `/compact` handled locally; old desk
    history from the CLIs' transcripts; cost diagnostics removed; crash recovery by a "continue"
    message; direct audience requests; the lean docket without acceptance checks, W08 evidence,
    review machinery, addenda or reservations; no Codex version-drift report; the agent-restart
    tools removed; and the data/startup changes A3–A6).

## UI and change management

29. **UI clean-up is allowed outside the canvas**, e.g. the settings menus. The canvas is not
    touched.
30. **Purely visual UI work goes on its own branch** (`rust-engine-ui`) so it can be rolled back
    cleanly. UI changes that follow from the featureset differences stay on the main rewrite
    branch (clarifies an earlier "keep frontend UI work separate").
31. **Settings for dropped features are omitted entirely** from the UI — not kept, not greyed out.
    Re-checked at the user's request on 2026-10-07: the Luna "prefer reserve" switch (App settings
    › Runtime, the hire form and the agent's ⚙) and the Fable weekly-limit, content-filter and
    autopsy policies and lock (Org settings › Policies, Default org settings) were still shown and
    are now gone.
41. **Every account has its own active checkbox** (user 2026-10-07; refines decision 25): each
    provider's native subscription (the CLI's own sign-in, shown as `default`) has an
    active/inactive checkbox, and so does every secondary account (managed, imported or API key).
    They replace the per-provider "use signed-in subscription accounts" switch, which turned off
    every subscription account of a provider at once. An inactive account serves no new turn: a
    running turn finishes, its agents' mail waits until the account is active again or they move
    to another account, and hiring and account fallback skip it.
42. **CLIs are warmed as in 3.x** (user 2026-10-07, "clis still aren't warmed"; supersedes the "no
    parked CLI per agent" part of decision 28 and the plan's 10-minute keep-alive, ledger B4): every
    live agent's CLI starts at engine start and on hire, and stays parked between turns. Two limits
    remain: at most 64 idle CLIs (the longest idle closed first), and warming pauses while the machine
    has under 6 GB of free commit memory.
43. **Keep as much agent context as possible across provider, account and model switches** (user
    2026-10-07): a model switch resumes the session; an account switch carries the Claude transcript or
    the Codex thread to the new account; a provider switch, or a session that cannot be resumed, starts
    a fresh session with a handoff note (last status and a summary of the recent conversation) and the
    agent's whole desk history saved as a file in its folder.
44. **The orgtree org finishes the interrupted 3.2.0 work that still applies to 4.0** (user 2026-10-07):
    it inventories the tickets that were open when the rewrite began, classifies them against 4.0, and
    hands the relevant ones in as branches off `rust-engine` for review and merge (decision 39 terms).
45. **The orgtree org takes over Orgtree 4 development** (user 2026-10-07: "hand off your work to the
    orgtree org, they'll take further development from here; orgtree is stable enough to continue work
    there moving forward"). The rust-engine session is retired. The org's coordinator owns the
    `rust-engine` branch and its checkout `.worktrees/rust-engine`, and reviews and merges hand-ins
    (this replaces the rust-engine session's role in decision 39). Who builds and delivers alpha
    installers (decisions 37-38) is for the user to say. Where things stand: `HANDOFF.md`.

46. **The engine runs at Normal CPU priority everywhere** (user 2026-10-07 00:00Z).
    The boot task must request Normal, matching desktop-started engines; no launch path raises it.
47. **Agent Rust build caches can be redirected off C:** (user 2026-10-07 00:00Z).
    **Superseded by the user, 2026-10-07 07:56Z:** remove the app's "Agent build cache folder"
    setting and its launcher environment override. Rust build-cache placement is an instruction
    for this org's agents, not a setting in a general-purpose app. An already-saved value is
    ignored; no migration is needed. Agents building Rust in this org use their own
    `CARGO_TARGET_DIR` on E: under the team's instructions. Decision 46 (Normal CPU priority)
    remains unchanged.

## Verification during the build

48. **App-wide Enter key choice** (user 2026-10-07 00:01Z): App settings › Display › Typing ›
    Enter key offers Send message (default: Enter sends, Shift+Enter inserts a new line)
    and Insert new line (Enter inserts a new line, Ctrl+Enter sends). Persist the choice
    with app settings and use it in every message composer, including desks, user and
    org inboxes, docket replies and question free-text answers. Single-line inputs keep
    their own behavior. Send buttons keep working and shortcut hints follow the choice.
    Placement ruling (user 2026-10-07 07:22Z): remove the one-setting General tab;
    put Enter key in Display's Typing group, keeping its choices and stored behavior.

33. **Brief smoke tests are allowed**; beyond that the user judges for themselves how well the app
    works once it launches.

## Diagnostics

49. **State inspection covers chart visibility plus the caller's whole subtree**
    (user 2026-10-07 08:28Z: "Yes: chart + own subtree"). At every visibility,
    `orgtree_state_inspect` includes all descendants; team/subtree also include
    the superior and peers, as the chart does. No-argument and explicit requests
    use the same visibility set. Archived rows still require `include_archived`;
    safe-field restrictions remain. This supersedes the 3.x diagnostic contract's
    team-only self/siblings restriction and the original P55 parity rule.

34. **Dense, verbose per-method invocation logging** (user 2026-10-06):
    - Every method defined in the engine is logged when it is invoked, with its full input and its
      full output, each capped at 8 KB (decision 36). The only exceptions are extremely hot calls (run thousands
      of times per request), such as per-token streaming, per-record feed rebuilding and tiny
      helpers.
    - Every line carries a request id prefix, a client id prefix (`user`, `desktop`,
      `agent:<id>/<name>` or `engine`) and a method invocation id prefix: one id per stack frame,
      shared between that method's call line and its return line.
    - Every line also carries the emitting Tokio task id `T<id>` before the request id
      (user 2026-10-07 07:46Z: the green thread id). `T-` means no Tokio task context,
      including startup and a runtime's root `block_on` future. Read it at emission,
      not from the request span: spawned tasks have their own id even with inherited
      request/client/invocation context. File and console prefixes use the same value.
    - Log lines have sub-millisecond timestamps.
    - Each engine start writes its own log file, named with the start time.
    - Log files are kept for 30 days.
    - The style is borrowed from the galaxy-star backend (nick-pc): `LEVEL [time] T… RQ… EX… message`
      lines, `module.fn(args)` call lines and `module.fn(...) -> value` return lines (`!!` for an
      error), REQUEST/HEADERS/RESPONSE lines per HTTP request, `*****` for sensitive fields,
      multiline messages split into prefixed lines, and daily/size rollover to gzip archives.
    - A line over the cap is brought under it like this. First, values (arguments, or the members
      of a return value) are shortened largest-first to their first 160 characters (arguments)
      or 240 characters (return values; decision 36) followed by
      `[rest omitted: x.y kb]`, until the line fits. If every value is shortened and the line is
      still too long, values are replaced largest-first by `[omitted: x.y kb]` alone. The line is
      truncated only as a last resort.
35. **Verbose logging can be turned off, as galaxy-star's `LOG_VERBOSE` does, and is off by
    default** (user 2026-10-06):
    - Verbose logging is the per-method call and return lines of decision 34, each request's HEADERS
      line, and the settings written at startup. REQUEST and RESPONSE lines, warnings and errors
      are written either way.
    - Off by default in packaged builds; on by default in every local development build.
    - Implementation: a runtime switch (App settings › Developer › "verbose engine logging"),
      applied at once, rather than a compile-time flag; with it off, a logged method costs one
      atomic load. Packaged builds are compiled with `ORGTREE_RELEASE_BUILD` set, and
      `ORGTREE_LOG_VERBOSE=0|1` fixes the switch for one run.
36. **Log line limits** (user 2026-10-06; replaces decision 34's 5 KB cap and 100-character
    preview): a line is capped at 8 KB; a shortened argument keeps its first 160 characters and
    a shortened return value its first 240; the console mirror cuts lines at 500 characters (the
    file keeps them whole).

## Release

37. **The first complete prototype of Orgtree 4 is delivered as a local installer in the user's Downloads
    folder** (user 2026-10-06): built locally from `rust-engine` as version 4.0.0; no tag, release, push or
    install by the agent.
38. **Prototype builds are versioned `4.0.0-alpha.N`** (user 2026-10-06): the alpha number counts
    delivered builds. The first delivered build, labelled 4.0.0, is alpha.0; the next is
    `4.0.0-alpha.1`. Installers go to the user's Downloads folder, `E:\Libraries\Downloads`.
39. **The orgtree org may help with 4.0.0** (user 2026-10-06; amends decision 6), "but only if it isn't
    unstable from having to restart the org often during prototype builds". Every prototype install
    restarts Orgtree, which interrupts running turns and kills every process agents started; so the
    org takes only work that survives that (small committed steps, no long-running jobs), stops any
    task that restarts keep breaking, and hands changes in as branches off `rust-engine` that the
    rust-engine session reviews and merges. No subagents are added (decision 6 otherwise stands).
40. **Read-only copies of live data are allowed for rehearsals** (user 2026-10-06): an agent may copy
    files from the live data folder or dump databases from the live PostgreSQL cluster, read-only,
    to rehearse imports and upgrades on the copy. Nothing in the live folder or cluster is ever
    changed. The copies hold secrets (network identities, account details): they stay in the agent's
    own scratch area, are never committed or sent anywhere, and are deleted when no longer needed.
32. **Migration from 2.x is not needed for the first build, but must ship before the release is
    published.**

50. **Credit cascades stop at the acting agent's allocation** (user 2026-10-07 08:25Z):
    "cascades should still work, just only up to what the hiring agent has allocated, not more".
    Hire, rehire, reallocate, model/seat changes and every other credit cascade may raise
    descendant grants using the caller's allocation, but never the caller's own grant or
    anything above it. An unaffordable call refuses with "insufficient credits" and commits
    nothing. User actions retain the top-level cap. Single and batch moves transfer the
    existing subtree stake between reporting paths below their common ancestor; a batch
    validates its final net grants before committing. Details: `credit-cascade-boundary.md`.


51. **Boot git/GitHub access uses the signed-in desktop credential bridge**
    (user 2026-10-07 12:40Z; coordinator design/startup approval 12:47Z). Keep
    BootTrigger/S4U unchanged and do not hold or restart agents. Electron main
    brokers on-demand git HTTPS and gh credentials over an authenticated local
    channel, with revocable per-agent capabilities and same-SID interactive
    ownership proof. Secrets are never logged or persisted by Orgtree. The
    desktop starts at login by default; when that preference is off, the user
    opens Orgtree to restore access. No separate logon helper. SSH, absolute-path
    gh and general Credential Manager/DPAPI access are outside this bridge.
    Details and verification limits: `credential-bridge.md`.

    Review clarification (coordinator 2026-10-07 13:24Z): normal signed-in engines
    inject no credential adapters. Isolated engines preserve native git helpers
    and execute real gh without a token when the desktop broker is unavailable.
    The interactive credential round trip is verified after alpha.9 installation;
    local source/isolated smoke checks must prove the normal-mode environment is
    unchanged. Same-user capabilities are not an OS isolation boundary.

52. **Edit agent grants in their settings with a horizontal credit bar**
    (user 2026-10-07 13:49Z). Keep the canvas bar's seat, committed and free
    segments and colours. Drag its end, show the numeric grant, and commit on
    release through reallocate. Clamp to committed holdings and available parent
    or cascade credits, show both limits, and restore the saved grant with the
    reason on refusal. Arrow keys step the grant. This does not edit the user's
    own top-level grant.

    User additions, 2026-10-07 16:45–16:49Z: move the Agent tab contents above
    the tabs and remove that tab; put destructive buttons together and a large
    model-card icon beside the name. Start the grant bar's range at no more
    than twice the saved grant (a small usable range for zero), expanding it
    while dragging at the right edge. Remove the handle: the whole bar drags.
    Reuse the canvas bar's exact paint and always show its exact stats above
    the bar. Restyle all settings with App/Org shared rows and controls, and
    use short, plain labels/descriptions; preserve behavior and keep the visual
    restyle in a separate commit. Wording list and details:
    `agent-settings-refresh.md`.

53. **Agent CLIs run in essential-traffic mode, with PowerShell and the cached feature flags**
    (coordinator 2026-10-08 19:09Z, after the neoja report that agents lost PowerShell).
    Every Claude CLI the engine starts gets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
    It has been set since the first engine commit, but nobody wrote down why. The reason:
    agents share the user's global CLI, and the switch stops each of them from checking
    for or applying an update mid-run. It also stops telemetry and error reports. 3.x never
    set it, because it ran its own pinned copy of the CLI. The switch also turns off the
    CLI's server-side feature flags. On Windows with Git Bash installed, CLI 2.1.280 to
    2.1.292 offer the PowerShell tool only behind the flag `tengu_cobalt_ridge` or
    `CLAUDE_CODE_USE_POWERSHELL_TOOL`. So 4.0 agents lost a tool that 3.x agents had,
    and that their identity text still promised. The engine therefore also sets
    `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` whenever the agent's terminal switch is on. It
    sets `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1` too, so the other flags follow
    the account's cached values, the ones the user's own CLI runs with. These bring
    back Monitor and PushNotification, as 3.x had them. As in 3.x, only top-level
    agents are allowed Monitor and TaskStop up front (the user's 3.x ruling that
    standing listeners are for top-level agents), and PushNotification is not
    denied (coordinator 19:26Z). Details:
    `cli-environment.md`.

54. **The cold-turn reset defaults to 25%** (user 2026-10-08 22:05Z: "reduce the default cold
    turn compact threshold to 25%"). "Reset a session before a known-cold turn"
    (`auto_cheap_compact.occ`) resets only above this share of the context window. Its default
    was 3.x's 50%; it is now 25% wherever neither the agent, the org nor the app defaults name
    one (`settings::CHEAP_COMPACT_OCC`, and the desktop's fallbacks). A stored occupancy is
    unchanged. `compact_at` (the CLI's own compaction, 80%) is a different setting and stays.

55. **Agents recall a conversation with one correspondent** (user 2026-10-09 00:01Z via
    Hubchat: "agents should have a tool they can use to recall a list of previous messages
    sent and received between a specific peer / recipient"). `orgtree_inbox
    action=conversation peer=<agent | user | @org:<slug> | @net:<address>>` lists the mail
    both ways, newest page first, previews only. The user's caps (00:03Z): 20 by default, 100
    at most, 500-character previews, 16,000 characters a page. It reads only the mail
    `reply_to` already accepts, so it adds no visibility. The fresh-session note tells the
    agent to recall a conversation before replying and names its six most recent
    correspondents (user 00:02Z). `fetch` returns sent mail too. 3.x had no equivalent: its
    inbox listed waiting mail only and refused peer arguments, so this is a new 4.x feature.
    Details: `conversation-recall.md`.

56. **A real message behind more than 64 waiting notices starts its turn** (coordinator
    2026-10-09 00:25Z, found by the conversation-recall proof). The turn's mail claim takes the
    64 oldest waiting mails and, when those are all notices, also the oldest real message.
    The notices left over ride the next turns, oldest first. Before this, such an agent
    started no turn at all for new mail. That was a 4.0 regression: in 3.x every real message
    queued its own wake. Details: `conversation-recall.md`.

57. **Documents the user reads are presented, never sent as files** (user 2026-10-09 05:53Z:
    "if it's something I am intended to read myself directly it should always be a presented
    document"; approved 05:55Z). The agent instructions led with "WHEN THE USER ASKS FOR A FILE
    ... deliver it with orgtree_send_file" and kept `orgtree_present` for "only when they wanted
    to READ a document in-page", as 3.x's did, so "send me the report" produced a download card.
    Now the passage leads with the rule: anything the user is meant to read (report, plan,
    proposal, write-up, summary, any `.md`) goes through `orgtree_present`, even when they ask
    for it to be sent; `orgtree_send_file` is only for files wanted as files (installers, logs,
    exports, images, archives). Agents without a user audience still send documents to their
    superior; "a path is not a delivery", images and the angle-bracket links are unchanged. The
    two tool descriptions say the same, and a markdown body over 64 KB is refused with "present
    a shorter document or split it across several cards" instead of "or send it as a file".
    Proof: `tools/rig/proofs/present-documents.mjs`.

58. **`orgtree_present` takes a `.md` file as `path`** (coordinator 2026-10-09 06:08Z,
    approving a suggestion from the decision 57 hand-in). An agent with a report on disk had
    to paste its text into `body`, while `orgtree_send_file` takes a path, which nudged
    documents towards download cards. `path` now takes a `.md` or `.markdown` file as well as
    an `.html`/`.htm` mockup. The file's text becomes the markdown body under the same 64 KB
    limit, and a leading byte-order mark is dropped. A file that is not UTF-8 text, a folder,
    or a file outside the agent's folders is refused. `replaces` works as with `body`. 3.x
    took only `.html`/`.htm` by path, so this adds a route and removes nothing. The
    instructions passage and the tool description say so. Proof:
    `tools/rig/proofs/present-documents.mjs`.

59. **Outside mail does not wait for a halted or frozen org-inbox holder** (user 2026-10-09
    07:03Z: "if the holder is halted or frozen, outside mail goes to another active agent who
    can take it, usually the first live top-level agent, and nothing is lost"). Before, a
    halted or frozen holder still counted: `@org:` and `@net:` mail waited in its queue,
    nobody else got it, and an `@org:` sender was told it was delivered. When the last holder
    retired, the inbox went to the first live top-level agent even if it was halted. 3.x did
    the same: its holders were checked only for `state == "live"`. Now inbound outside mail
    goes to the holders who can run (not halted, not frozen). While none can, it goes to the
    first top-level agent who can run, without a grant, so the audience and the org inbox
    panel stay with the holders and their next mail reaches them once they are back. With no
    live holder, the inbox goes to the first top-level agent who can run (the first live one
    when none can). When nobody can run, the mail waits with the holders, the user gets the
    "external mail unroutable" notice saying who it waits for, and an `@org:` sender is told
    it waits. The org-inbox instructions say who receives outside mail. Proof:
    `tools/rig/proofs/org-inbox-unavailable.mjs`.

60. **Opening or revealing an organization's window never touches another window** (user
    2026-10-09 08:12Z: "dont minimize any existing window", after a notification for another
    organization opened that organization's window and the window they were in ended up
    minimized). Nothing in the desktop did that. The only minimize calls are the minimize
    buttons of a window and of a popout, each acting on itself. The only hide is the close of
    the last visible window, hiding itself. The reveal path shows, restores, re-maximizes and
    focuses only the window it reveals. That is now a tested guarantee:
    `main/window-reveal.ts` holds the reveal (pure, handed exactly one window), and
    `tests/window-reveal.test.mjs` drives the real notification manager, registry and
    `openOrg` against windows that record every call. A click for another organization opens
    its window and makes no call at all on any other window; all seven notification kinds take
    that path; a source check fails on any new minimize or hide, or any line added to the
    reveal path. The live log of the reported click shows the new window opening while the
    user's window kept running with its own organization. Whether that window was minimized
    before the click, by a Windows gesture, or by the user cannot be told from the logs.
    So the next time can (coordinator 08:22Z): `main/window-events.ts` writes every main
    window's minimize, restore, show, hide and focus to
    `<data root>/diagnostics/desktop-windows.jsonl` (time, window, kind, organization), and
    Orgtree's own causes just before it acts (`reveal`, `minimize-button`, `close-hide`). A
    `minimize` with no `minimize-button` line for that window just before it did not come from
    Orgtree. No per-frame events; rotated to `.1` past 1 MB; best effort.
    `node tools/test-window-events-native.mjs` checks the log and the reveal against real
    Electron windows.

61. **An edit to a CLI's startup instruction files reaches the agent at its next turn**
    (user 2026-10-09 08:34Z: "an edit to your standing notes or anything fed at the start of
    context should trigger a queued restart of your session, which was the 3.x behavior").
    Claude Code and the Codex app-server read some instruction files once, when their process
    starts, and hold them. 3.x hashed those files into the warm process's identity
    (`warmpool.native_startup_context_digest`, `codex_startup_context_digest`). After an edit
    the parked process was stale, never disturbed mid-turn, and the next turn spawned a
    replacement that resumed the SAME session (`--resume`) with the new text. 4.0 respawned and
    resumed on a fingerprint change, but the fingerprint had no such files. So for Claude agents
    an edit to the scratch CLAUDE.md, the user CLAUDE.md or MEMORY.md applied only when some
    unrelated respawn happened, and the cache forecast never showed it.

    The fingerprint now has a seventh part, `startup`, with exactly 3.x's scope
    (`runtime/startup.rs`):
    - **Claude:** the managed-policy CLAUDE.md; `<config>`/CLAUDE.md; CLAUDE.md and
      CLAUDE.local.md from the root to the cwd; `<cwd>`/.claude/CLAUDE.md; each granted
      folder's CLAUDE.md and CLAUDE.local.md; unscoped rules; `@` imports five hops deep; and
      MEMORY.md's first 25 KiB / 200 lines.
    - **Codex:** `<CODEX_HOME>`/AGENTS.md, and AGENTS.override.md or else AGENTS.md in the
      cwd (up to a `.git` root).
    - **Not covered, as in 3.x:** memory topic files and path-scoped rules (read lazily),
      skills folders (the CLI watches them live), and each CLI's other file.

    `<config>` and `<CODEX_HOME>` are the folders the launch actually uses. The next turn
    respawns and resumes, and the forecast lists `startup`. An idle agent re-reads its files
    every 20 s, so after an edit its forecast updates and its parked CLI is replaced at once.
    It compares against the CLI's own launch, so an edit made during a turn is caught as soon
    as the turn ends. A running turn is never touched. A fingerprint saved by an older engine
    reads as unknown, not changed, so the upgrade causes no false cold reset. Proof:
    `tools/rig/proofs/startup-context.mjs`.
