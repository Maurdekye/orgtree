# Orgtree 4 rewrite — the user's standing decisions

**Idle turn clocks, coordinator 2026-10-17 17:33Z (user report 16:54Z):**
completed turns use `ended_at` in the shared `TurnStat.at` projection for every
harness, falling back to `started_at` only for open or legacy rows without an
end. Active clocks stay on `inflight_at`; ordinary Antigravity hook mail does
not start a new turn. See [turn clocks](turn-completion-clock.md).

**Antigravity thinking, user 2026-10-17 17:10Z:** show the thinking stored in
AGY's native local history after each completed step, before its response, using
the existing collapsed thinking rendering. Live thinking requires upstream AGY
support. Read-only exact session/step matching, duplicate-safe persistence and
no thinking text in logs are required. 4.4.0 only. See [AGY thinking](antigravity-thinking.md).

**Watchdog recurrence, user 2026-10-17 14:46Z/14:48Z:** periodic polling and
quiet timers retain fixed next timestamps through restarts. Missed slots
produce at most one immediate catch-up, then continue the original phase
(h0 +6h, restart h7 -> next h12). Explicit resume starts a new recurrence.
Coordinator 14:50Z keeps target-check-first for overdue polling silence: a
fresh match resets quiet and suppresses the alarm. Process-down edges remain
observations, not periodic fires. See [watchdog recurrence](watchdog-recurrence.md).

**EPIC heat camera lock, user 2026-10-17 12:58Z:** heat stays attached to
the cards during pan, zoom and animated camera movement. Diffusion remains
in canvas coordinates; the shared `.space` transform moves both. Grid bounds
come from complete world layout, so camera virtualization never resamples
temperatures. 4.4.0 only. See [EPIC heat](epic-activity-sound.md#heat-equation).

**Custom user-mail tags, user 2026-10-17 12:39Z/12:40Z/12:45Z:** agents may
attach up to eight custom tags to user mail; the inbox filters by one tag,
intersecting search. Labels keep the first committed org-wide spelling,
matching ignores case, and chips use a stable normalized-name hue. Non-user
routes refuse tags before attachments/transport; fan-out remains per recipient.
No hub tags or legacy backfill. 4.4.0 only. See [mail tags](mail-tags.md).

**Direct-child peer mail, user 2026-10-17 11:24Z/11:27Z:** a manager or project
may turn OFF **Subordinates may message each other** (default ON). Direct
siblings then need a directional audience; neighbour connector lines disappear
in GL/SVG at every zoom. The coordinator confirmed the actual-parent boundary
and shared nearest-agent-superior delegation between those siblings at 11:26Z.
Different physical groups retain existing reach. See [peer mail](peer-mail.md).
4.4.0 only.

**EPIC tray mute, user 2026-10-17 11:06Z:** the tray's right-click menu shows
a checkable "Mute EPIC sounds" only while EPIC is enabled. All audio fades
out/in; heat and motion continue. Coordinator defaults retain mute across
restarts and apply it to all windows/pop-outs, with no other audio control.
4.4.0 only. See [EPIC tray mute](epic-activity-sound.md#tray-mute).

**EPIC continuous sound and physical heat, user 2026-10-17 09:18–09:25Z:**
live mid-turn agents hum; their activity adds distinct continuous layers whose
volume grows with count, capped. The sounds drive a world-space heat-diffusion
simulation with fixed flux and delta impulses, solved by Jacobi iteration with
cooling. This replaces the initial radial-glow proposal; reduced motion shows
a static field. Every tool signature hashes its normalised name to select
  pitch, interval, timbre and envelope, replacing the proposed family table.
  The 09:41Z factory directive uses machinery and mechanical impacts. User
  feedback at 21:25Z retains five original 4.3.2 event phrases alongside that
  palette: hire and victory fanfares, turnEnd bells, answer harp and coins.
  Their existing event routing, gain and pitch remain. Real-link tool/message transport pulses remain,
  disabled under reduced motion. User feedback at 19:33Z removes the working-card
  piston bump as distracting, replacing the coordinator's 09:42Z approval:
  working cards stay still. Heat and sound are unchanged.
4.4.0 only. Details: [EPIC activity sound](epic-activity-sound.md).

**EPIC combo removal, user 2026-10-16 20:45–20:46Z:** remove the combo
meter, ranks, milestones and rank fanfare. The final correction is "keep the
rising pitch, but remove everything else": retain only the private burst count
and decay needed by the existing small-sound pitch climb. Momentum, charge,
level, chains and action effects are unchanged. This supersedes the small
corner combo badge; see [EPIC Mode](epic-mode-final.md#combo-removal-2026-10-16).

**Agent mail requests and fan-out, user 2026-10-16 20:20Z:** `orgtree_message`
accepts `kind: request`, displayed as a request and otherwise handled as a
message. Attachments addressed to local agents become validated absolute path
references in the body; user and `@net:` attachments retain their uploaded-copy
path. Multi-recipient sends may carry `reply_to` and `replies`; each recipient
gets only references belonging to its conversation, with unmatched references
omitted and explained. See the `orgtree_message` and `orgtree_send_notice`
skill leaves.

**Recovery commands and current scope, 2026-10-16:** the user's staffed
`compaction-keeps-the-actual-commands-and-the-rec` ticket leads fresh-session
recovery with live docket scope/blockers/dependencies, recorded source/worktree
evidence and latest superior mail before older history. Coordinator confirmed
8,192 UTF-8 bytes per shell command in saved history/digest, explicit truncation,
and unchanged human-visible transcript UI (ma67dfed0accb). This refines decision
64's summary contents and ordering; the one-time snapshot remains outside startup
fingerprints. See [recovery commands](recovery-commands.md).

**Windows taskbar jump list, user 2026-10-16 15:43Z; staffed 20:24Z for
4.4.0 only:** right-clicking the taskbar icon lists the current organizations,
Home and New org. Every entry opens the right view in the running app through
single-instance handoff; additions, removals and renames update the list.
Existing switcher slug order and canonical org-window focus are retained.
Contract and verification limits: [`taskbar-jumplist.md`](taskbar-jumplist.md).

**Independent active-agent filters, user 2026-10-16 13:35Z:** the canvas Agents
list, Quick chat superior picker, and dynamic Attention desk each have their own
persisted "active only" setting. The two new settings default off so an upgrade
does not hide agents in those views. Checking one surface filters only that
surface; the canvas setting remains scoped to its Agents list. The checkbox uses
the shared active-filter style. See the active-agent filter item on the org
docket for implementation and verification evidence.

**Claude usage waits, coordinator 2026-10-15 10:09Z**, implementing the user's
reported short 429 refresh errors: suppress the error when last-good cache age
is under 900 s and remaining Retry-After is at most 60 s. Long waits or absent/
stale good readings use existing unavailable presentation and pause wording,
without "failed". Floor all Claude attempts at 60 s, including force; a provider
retry deadline overrides the ordinary floor and the existing scheduler retries
after expiry. Floor/cooldown manual requests finish quietly; same-key desktop
callers await the in-flight result. Preserve original bar/auth ages, 401/403 and
other real errors. This replaces decision 74's unchanged automatic cadence only
for Claude. See [`claude-usage-waits.md`](claude-usage-waits.md).

**Rainbow mode selection, user 2026-10-14 23:24:59UTC:** show its revealed
toggle only while the Custom visual theme is selected; hide the row for all
presets. The hidden picker gesture stays unchanged. Coordinator scope ruling:
switching themes retains the saved revealed/enabled/epoch preference, restoring
the previous toggle state on return to Custom. Animation, popouts and agent
colours are unchanged. See [`rainbow-custom-toggle.md`](rainbow-custom-toggle.md).

**Multi-reply transcript boundary, user 2026-10-14 23:11:17Z:** combine any
replyable events shown in one transcript, whoever authored them. Reply goes to
that transcript's agent; Hubchat uses its open conversation's contact. This
replaces the earlier same-sender interpretation. No fan-out means one recipient
and no mixing across transcripts or conversations. Picks/text remain exclusive
per question, and an empty question reply is a skip. See
[`multi-replies.md`](multi-replies.md).

**Function-key panel toggles, user 2026-10-14 17:58UTC:** F1-F3/F6-F9 and
Shift+F2 close their exact menu/panel target when it is already open, with
normal close cleanup and focus return. Different targets keep existing stacking;
held-key repeats do not invoke actions. This keyboard rule supersedes the
open/refocus behavior only for these shortcuts, preserving mouse open/raise.
User 18:02UTC: "No, leave windows" — Shift+F1/F3 keep opening or focusing
their separate top-level windows and never close them. F4/F5/F10/Shift+F10
keep their existing non-panel actions. See [`app-menu-shortcuts.md`](app-menu-shortcuts.md).

**Org-inbox icon consistency, user 2026-10-14 18:40–18:41UTC:** use the globe
(`PublicIcon`) for the far-zoom org-inbox tile, matching its normal tile and
modal header. This replaces the far OutboxOutlined tray glyph only; preserve
the class, size, title/aria and existing viewer action. See [`far-overview.md`](far-overview.md).

**Short org Accounts explanation, user 2026-10-14 18:46UTC:** replace the long
introductory blurb with at most about 40 words in the same place/style.
Retain accurate ticked-only access, turn-boundary move/stop and new-account
default meaning. Drop the detailed App settings and language-server explanation
from this paragraph, preserving existing per-row help. Source evidence:
[`org-accounts-copy.md`](org-accounts-copy.md).

**Transcript docket transitions, user 2026-10-14 12:44:47UTC:** an
`orgtree_work` call that actually changes ticket status shows `old → new`
inline, each in the docket's own colour and wording. Capture the real
previous status in the mutation transaction; failed/no-op calls add none.
Historical rows without before-state metadata keep their previous display.
Not required for the next alpha. See
[`tool-work-status-transitions.md`](tool-work-status-transitions.md).

**Popout Close versus Pop in, user 2026-10-13 08:22Z:** closing a popped-out
modal dismisses it; explicit Pop in returns it to the main window. Preserve
drafts/content, saved-row closure, cleanup and separately defined borrowing,
failure recovery and parent lifecycle. Coordinator caller ruling 08:26Z:
persistent desks keep their registry/content, but native Close cannot activate
a missing main destination; explicit Pop in retains that activation. Contract
and bounded proof limits: [`popout-close.md`](popout-close.md).

**Developer team deployment, user 2026-10-12 10:11–10:13Z:** each developer
installs Orgtree and Hubchat, and both connect to a shared standalone mailhub on
a company-accessible private server. The built-in Orgtree mailhub is for
individuals and small teams. This changes the documentation recommendation,
not runtime defaults; no numerical cutoff or mandatory migration. See
[`../team-setup.md`](../team-setup.md).

**Agent ordering, user 2026-10-11 23:14–23:15Z** (mb137ddaf7c1d,
m848012229292, relayed by lead-astra): allow agents to reorder descendants and
choose hire placement. Hiring by agents requires explicit values; placement
index is no exception (supersedes the initial optional-index interpretation).
Coordinator mechanics ruling 23:18Z: zero-based live siblings, excluding the
reorder target or superior-insertion anchor before insertion. Scope, transaction
rules and focused proof: [`agent-ordering.md`](agent-ordering.md).

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
    has under 6 GB of free commit memory. A process kept open only for its background work is
    outside the 64 and is not closed by it (decision 77, 2026-10-14).
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
    - The style is borrowed from the galaxy-star backend: `LEVEL [time] T… RQ… EX… message`
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
    opens Orgtree to restore access. No separate logon helper. (Superseded by
    decision 68: a sign-in credential helper now serves the bridge without the app.) SSH, absolute-path
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

62. **A cut turn never stays on record, a queued switch on an idle agent applies at once, and
    a refused turn start never spins** (coordinator 2026-10-09 09:26Z, after a live agent spun:
    "an idle agent with a pending switch applies it immediately, and certainly before its next
    turn"). An agent retired in the middle of a turn was rehired and switched to another
    provider. Its actor looped every ~2 ms and never started a turn. The retire had killed the
    CLI and dropped the turn in memory only: its `ot.turns` row stayed open and its claimed
    mail stayed `delivering`. `busy` (inflight_at or an open turn row) then held the queued
    switch back forever, and each refused turn start woke the actor again at once. 3.x settled
    a busy agent's turn before archiving it (`supervisor.interrupt_before_archive` waits for
    the turn's `finally`: cost booking and the queued D-234 switch).
    - **Retire, dissolve, delete:** a turn cut while the engine runs on is settled at once.
      Mail a conversation receipt proves consumed is delivered, the rest returns to the
      mailbox (the startup recovery's rule, `mail::recover_turns`), and the record is closed
      as killed. An engine shutdown still leaves it for the next start to resume.
    - **A turn on record that no running turn owns** (a lost actor, a failed write, a retire
      on an older engine): when its idle agent finds the seat busy, it closes that record the
      same way and clears `inflight_at`, then applies its queued switch or account.
    - **Applies at once:** a switch or account queued because the seat reads as busy tells
      the actor (`ApplyQueued`). An idle one applies it now; a running turn's end applies it as
      before.
    - **No spin:** a turn start refused for a configuration change applies a queued intent
      right there and retries on a timer: 250 ms, doubling to 60 s while refusals repeat.
      Other wakes wait for that timer. No refusal path wakes the actor again at once.
    - **A queue that outlives a retire** (coordinator ruling 2026-10-09 10:37Z): a switch or
      account queued during a turn stays on the seat when the agent is retired in the middle of
      it (3.x applied it in that turn's `finally`). A rehire that names a tier cancels a queued
      switch, and one that names an account cancels a queued account: the rehire's choice is
      the newer one, and the cancellation is recorded (`switch_cancelled`,
      `account_queue_cancelled`). A rehire that names neither applies the queue at its first
      wake.

    Proof: `tools/rig/proofs/pending-switch.mjs`.

63. **A person on the hub is answered with `orgtree_message` to their `@net:` address**
    (user 2026-10-09: agents "should always reply to a network address when communicating with
    a human over hubchat instead of replying inline, even if that human is the user who already
    has direct access to orgtree"). Someone writing over the mail hub (Hubchat, say) sees only
    what is sent to their address. A reply that stays in the turn's text never reaches them.
    That holds even when the person is the user, who could also read Orgtree directly.
    - **Instructions:** the org-inbox passage, which top-level agents and outside-audience
      holders get, says to ALWAYS answer an `@net:` sender with `orgtree_message` to that
      address, even when that person is the user.
    - **Mail:** each delivered non-notice message from an `@net:` sender carries one line under
      it: "↳ Answer with orgtree_message to @net:…: a reply only in your turn's text never
      reaches them."

    The passage is part of the identity, so a running agent picks it up at its next respawn
    (the system-prompt fingerprint), and the mail line applies at once. Proof:
    `tools/rig/proofs/hubchat-reply.mjs`.

64. **A fresh session starts with the agent's live docket items** (user 2026-10-09: "chats
    should receive a list of all their assigned tickets every time they start a fresh session so
    they dont drop work"). A fresh session (a cheap compact, a provider or account switch, a
    session that could not be resumed, a rehire onto a new session) began with the last status,
    the recent correspondents and a digest, but nothing told the agent which docket items it
    still held. 3.x had such a list only in an experimental handoff record (up to 8 items, in
    the system prompt after a cheap compact), behind a `handoff.flag` file that is off by
    default, so this is new behaviour (PLAN F8).
    - **What is listed** (in the fresh-session note, after the recent correspondents): every
      item the agent owns whose status is backlogged, open, in_progress, blocked, review,
      approved or deploy_ready, and is not archived, with slug, status, title and the first
      `working_on_next` entry; backlogged ones apart; and the items in review that name it as
      reviewer, with their owner. Done, dropped and archived items never appear, not even a
      done item in its hour before it archives (user ruling).
    - **Bounded:** newest updated first, at most 30 entries, then the count of the rest and
      `orgtree_work action=list include_backlogged=true`. Titles and next steps are cut at 200 characters.
    - **A snapshot, sent once** (user ruling: "changing that set shouldnt invalidate their
      session, its only sent once at the start"): it is not in the instructions, the startup
      digest or any fingerprint, so a docket change respawns nothing, and later turns do not
      repeat it.

    Proof: `tools/rig/proofs/ticket-list.mjs`.

65. **Teams are flat by default** (user 2026-10-09 12:39Z: "Keep a team flat by default.
    Subdivide it (put a manager between you and a group of reports) only when coordinating and
    collaborating with all your direct reports starts to take up too much bandwidth for one
    agent."). The agent instructions said nothing about a team's shape, and the bundled
    coordinator charter preset said the opposite of the exception: "ONE AGENT PER PIECE, HIRED
    DIRECTLY UNDER YOU … Never hire deeper".
    - **Instructions** (`runtime/identity.rs`, every agent, after the hiring and rehire
      guidance): "KEEP A TEAM FLAT BY DEFAULT. Subdivide it (put a manager between you and a
      group of reports) only when coordinating and collaborating with all your direct reports
      starts to take up too much bandwidth for one agent."
    - **Coordinator preset** (`engine/docs/charters/coordinator.md`, rule 6): "Never hire
      deeper" is replaced by the same rule. Hiring each piece directly under you, checking
      nobody already does it, and never policing how reports staff their own pieces stay.
    - Nothing else in the engine's prompt text, the tool descriptions or the other presets
      speaks of team depth.

    The rule is identity text, so every agent's system-prompt fingerprint changes once: each
    respawns (resuming its session) at its first turn after the build. A user copy of the
    presets (`~/.orgtree/charters/`, made by "populate") shadows the bundled file and keeps the
    old wording, as do the charters of agents already hired from it. Proof:
    `tools/rig/proofs/team-shape.mjs`.

66. **The tool bridge is a Unix socket on macOS and Linux** (user 2026-10-09 20:27Z: Mac and
    Linux agents must have their Orgtree tools before 4.1.0 is announced). Only the
    Antigravity lane uses the bridge (`runtime/agy.rs`): Claude Code agents get the tools as an
    SDK MCP server over the CLI's stdio, and Codex agents as app-server `dynamicTools`, on every
    platform. The bridge was a Windows named pipe only, so Antigravity agents on macOS and
    Linux had none.
    - **Where:** `orgtree-mcp-<16 hex>` (8 random bytes; the pipe keeps its 16) in the first
      of these whose path fits a socket address (under 104 bytes on macOS, 108 on Linux):
      `<data>/bridge`, `$XDG_RUNTIME_DIR/orgtree-<tag>`, `$TMPDIR` (else `/tmp`)
      `/orgtree-<uid>-<tag>`. The tag is 4 bytes of the data folder's SHA-256, so engines with
      different data folders never share a folder.
    - **Who:** the folder is created 0700. An existing one must be a real folder this user
      owns (a symlink or another user's folder is skipped), and it loses any group or other
      access. The socket is 0600, and a peer whose uid isn't the engine's is dropped (beyond
      what the folder already ensures; root aside). No TCP.
    - **Lifetime:** the socket file goes when its agent process's token is cancelled or the
      engine stops. At its start the engine removes the `orgtree-mcp-*` files a killed run
      left in its folders. A failed accept (a peer gone before it was accepted, no file
      handles to spare) waits 50 ms and keeps serving, where the Windows loop stops on a
      failed connect.
    - **Relay:** `mcp-bridge --pipe <path>` connects, retrying for up to 5 s while the backlog
      is full (EAGAIN on Linux, ECONNREFUSED on macOS, as on PIPE_BUSY), and copies stdio both
      ways. The MCP config already passes the path as one argument.
    - **Windows** behaves as before: the pipe code is unchanged, and the relay's
      connect-and-copy and the per-connection loop are shared. One round-trip test
      (initialize, tools/list, a real `orgtree_list_tiers` call) runs on every platform. The
      credential bridge stays Windows-only.

67. **A watchdog's id is the readable slug of its name** (user 2026-10-09 22:41Z: "watchdog
    tasks are referenced by an opaque id of random characters in their text. i want them to be
    represented by their slug as their id when created, so that it appears in the monitor event
    message"; confirmed: the slug fully replaces the random `wd…` id for new dogs). A dog's id
    was `wd` and 12 random hex digits (3.x: 8), and the desktop's Monitor event card headed a
    fire with it.
    - **The id:** the dog's short name (lowercase letters, digits and dashes, at most 24
      characters); without a name, or with one that has no letters or digits, its kind and
      target (a file by its file name: `file-owner-txt`). The dog's name is set to its id, so
      the fire mail's sender and body, the monitor event's actor and object, `list`, the canvas
      chip and the create result all show it.
    - **Unique per owner** among its dogs that hold an id (armed, paused, exited): a clash
      takes `-2`, `-3` and so on, and the create result says why. A removed dog, or a one-shot
      spent by its fire, frees its id. A unique index on (owner, id) for those states settles
      two creates racing for one name: the loser takes the next suffix. Two agents may each
      keep a `build-watch`.
    - **Naming a dog:** pause, resume and remove take the id. `owner/id` names one owner's dog
      (the desktop's handle for its chips, sparks and the user's actions); a bare id is the
      actor's own dog, else the one dog of that id the actor may manage. Two owners' dogs
      matching a bare id are refused, naming both `owner/id` forms.
    - **Dogs made before** keep their random ids and names, and still work by them.
    - **Inside the engine** dogs are keyed by their row id (runners, event subscriptions,
      health, activity fan-out and every update), as the id is no longer unique table-wide.
      Migration 0016 replaces the table-wide unique on `uid` with the unique (owner, uid) for
      dogs that hold their id; the 3.x and 2.x importers skip a dog already imported by
      checking its id.
    - **Desktop:** the Monitor event card names a watchdog once when the event is about the
      dog that sent it.

    Proof: `tools/rig/proofs/watchdog-slugs.mjs`.

68. **A sign-in credential helper serves git/GitHub access while the app is not running**
    (user 2026-10-10 07:56Z: "why not start a second subprocess at login that can carry the
    token"; coordinator rulings 08:02Z). Supersedes decision 51's "No separate logon helper".
    - **What:** `orgtree-credential-broker.exe`, a small windowless second binary beside the
      engine (`src/credential_broker.rs`; not the engine exe, which is a console program and
      would flash a window at every sign-in). It serves the desktop broker's exact pipe
      protocol and 20-second lease, so the engine accepts it on the same checks as Electron
      main (desktop token, pipe server PID, same SID, INTERACTIVE, nonzero session), and it
      attaches with the desktop's descriptor-trust and identity checks.
    - **Start:** the "Orgtree Credential Helper" scheduled task, registered by the installer's
      boot lifecycle beside the boot task: logon trigger for the operator only, interactive
      token, least privilege. Per-machine installs only (per-user installs have no boot
      engine). Independent of "Start at login" (ruling A): it runs at every sign-in while the
      boot engine is installed. No new setting.
    - **One broker at a time:** a live lease whose broker process still runs keeps the bridge;
      another broker gets 409 `[held]` and retries on its next poll. A holder may release
      (the desktop does on quit); a dead holder is replaced at once. No flapping.
    - **Install/update/uninstall:** the helper task is disabled and its process ended before
      the boot tree stops; Register re-creates and starts it; Remove deletes it.
    - **Limit:** after a reboot and before the user signs in to Windows there is still no
      access; Windows does not allow it.
    Details and proof: `credential-bridge.md` (Sign-in credential helper),
    `tools/rig/proofs/credential-broker.mjs`.
    - **Phase 2 (coordinator 2026-10-10 09:35Z):** while the helper runs, the Session 0
      engine has it start sandboxed Codex seats in the user's session, where Codex's
      sandbox works (openai/codex#46412). bypassPermissions seats stay in Session 0 (ruling
      Q1; superseded by decision 84, which hosts every agent's CLI, bypass seats too); only
      the helper hosts, never the desktop broker; hosted seats' MCP servers run in the
      user's session; signing out ends hosted seats, whose next turn starts in Session 0
      without the sandbox; a launch the helper cannot make falls back to Session 0.
      Details: `credential-bridge.md` (Codex launches in the user's session),
      `tools/rig/proofs/codex-host.mjs`.

69. **`orgtree_retool` adds folders, and `remove_dirs` removes them** (user 2026-10-10 11:50Z,
    on an outside report that a retool giving one folder had dropped the agent's other folders
    and its reports'; chosen: "Giving a folder adds it to the agent's list. A separate option
    removes folders, and it refuses a folder the agent doesn't have, so a typo can't slip
    through. Hiring still sets the whole starting list."). 3.x replaced the whole list, and its
    tool text said so ("REPLACES its folder grants when passed"); 4.x had kept the behaviour
    and lost the warning.
    - **Adding:** each folder in `add_dirs` is added; one the agent already holds (the same
      folder after case and separators are normalized) takes the new mode. Only the folders
      named are granted and checked against the caller (nobody grants above themselves); an
      intermediate that lacks one is still raised (D-106).
    - **Removing:** `remove_dirs` lists folders the agent holds (paths; `{path}` objects are
      accepted too). One it does not hold is refused, naming its folders, and so is a folder in
      both lists. Removing a folder, or narrowing it to read-only, does the same to the agents
      beneath, for good, as in 3.x; the agent's scope-changed notice names its folders.
    - **Hire, staff and rehire** keep `add_dirs` as the whole list: a hire's starting list, and
      a rehire's replaces the stored one (3.x).
    - **The result** lists `folders` (added, changed, removed) for the agent, `clamped` (node,
      removed, changed) for each agent beneath that lost folders, with a warning naming them,
      and `raised` (node, added, changed) for each agent above that a deep grant raised;
      `cascaded` is unchanged.
    - **State inspection** shows each agent's effective folders (path and mode, as its CLI is
      started with them) in `scope`; 3.x showed none.
    - **Unchanged:** the desktop's scope panel and the approval of a scope request set the
      whole list through their own route.
    Proof: `tools/rig/proofs/retool-dirs.mjs`.

70. **"Run on startup" governs everything of Orgtree that starts by itself** (user 2026-10-10
    17:45Z: "if i have start on boot disabled, then nothing should run at all on boot ever
    until i manually start orgtree"; 17:46Z: rename "Start at login" to "Run on startup"
    everywhere the user sees it; 17:58Z: a Windows permission prompt each time it changes on
    an all-users installation, declining leaves it as it was). Supersedes decision 68's ruling
    A (the credential helper ran independently of "Start at login"). 3.x and 4.x before this:
    the setting only added or removed the window's own sign-in entry, and the boot engine task
    started at every boot whatever it said, which also blocked the installer
    (installer-can-t-replace-a-running-orgtree-an-ins).
    - **On:** as before: the window's sign-in entry (`--background`, to the tray), the "Orgtree
      Background Engine" task at boot, the "Orgtree Credential Helper" task at sign-in; on
      macOS/Linux the engine host's LaunchAgent / systemd user unit / autostart entry.
    - **Off:** nothing of Orgtree starts at boot or sign-in: the window's entry is removed and
      both tasks are DISABLED (not deleted: the installer's ownership stays intact and on
      re-enables them); on macOS/Linux the login registration goes (`disableBootEngine`).
      Opening Orgtree then runs its own engine, as on a per-user installation (a disabled task
      cannot be run); closing the window keeps it in the tray, Quit stops it.
    - **A running engine is left running.** The change applies from the next boot or login;
      turning it on mid-session registers for the next login and starts nothing now (the
      session already has an engine).
    - **Who may change it:** the tasks are the installer's, writable by administrators only
      (the operator may read and run them), so that no agent running as the user can rewrite
      what starts at boot. On an all-users Windows installation the desktop switches both tasks
      through an elevated PowerShell behind a Windows permission prompt, like "Run Orgtree as
      administrator" (`apps/desktop/main/runonstartup.ts`), changing only tasks whose
      description carries the installer record's id (all are verified before any is changed),
      and records the choice as `RunOnStartup` (DWORD) in the installer's protected record
      `HKLM\SOFTWARE\Orgtree\BootEngine`. The switch flips only after the change reads back;
      a declined prompt leaves it as it was and says so.
    - **The switch shows the real state:** at start the desktop reads both tasks (no elevation
      needed); when the boot task disagrees with the stored value, the task wins.
    - **Updates keep the choice:** Prepare (`tools/boot-engine-task.ps1`) takes the recorded
      `RunOnStartup`, else the operator's own `startAtLogin` from
      `%APPDATA%\Orgtree v2\desktop-settings.json` (an installation from before this decision),
      else on. Never the task's own state: an update disables the task while it replaces files.
      Register then writes both tasks enabled or disabled accordingly and starts them only when
      on. A fresh installation defaults to on, as before.
    Proof: `tests/disruptive/run-on-startup.test.mjs` (the scripts against throwaway tasks and an HKCU key),
    `tests/boot-installer.test.ps1`, `tests/unix-boot-engine.test.mjs`.
71. **The bundled mail hub 2.1.0's first start is a one-way step; no automatic backup**
    (user 2026-10-10 19:42Z, via the coordinator: bundle hub 2.1.0, optional UnifiedPush, in
    4.2.0-alpha.5, with no automatic backup). The hosted hub migrates its database
    (`orgtree_mailhub` in the bundled cluster) to schema 9 the first time 2.1.0 starts. From then
    on a hub 2.0.x refuses that database ("the database schema is version 9, newer than this hub
    understands"). So going back to an Orgtree that bundles hub 2.0.x leaves the hosted hub
    stopped until a backup of the hub's database from before the upgrade is restored, losing the
    mail that arrived since. Orgtree takes no backup for this step by itself. The hub's own notes:
    orgtree-mailhub docs/OPERATIONS.md, Upgrades.
    Going back, the engine keeps running: the Mail hub panel says the hub process exited with the
    reason from mailhub/hub.log ("the database schema is version 9, newer than this hub
    understands"), and an @net send is refused at once saying this computer's mail hub is not
    running (without its hub the restarted engine knows no peer).
    Proof: `tools/rig/proofs/mailhub-upgrade.mjs --from <a 2.0.3 build>` (the hosted hub 2.0.3,
    then 2.1.0 built from the submodule on the same rig database: schema 8 to 9, addresses and
    messages kept, mail both ways; 2.0.3 again refuses the database and leaves it as it was;
    2.1.0 again loses nothing) and `tools/rig/proofs/mailhub-v2.mjs` (pins 2.1.0).
72. **Recover failed Windows core components; preserve healthy survivors**
    (user 2026-10-12 09:14Z). Unexpected engine death attempts engine recovery
    without killing the desktop; unexpected desktop death attempts desktop
    recovery/reattachment without killing the engine. Exhausted attempts,
    missing helpers and slow startup must not cascade to healthy processes.
    Only manual Orgtree Quit stops the whole application, cancelling recovery
    before graceful Codex drain. Normal sign-out retains background behavior;
    an intentional restart retains its bounded allowance. A desktop closed for
    an install is not recovered: its observer stands down, and the installer
    ends an older one and owns the relaunch (coordinator 2026-10-14, docket
    installer-can-t-replace-a-running-orgtree-an-ins; this replaced
    "intentional install/restart retains its bounded allowance", under which
    the observer held the installation's files). This supersedes
    the October11 coupled-stop rule and the short-lived October12 09:04
    teardown/relaunch proposal. Native identity, bounded retries/resource
    guards and diagnostics are required. Implementation and proof limits:
    [`core-recovery.md`](core-recovery.md). Earlier coupled-lifecycle evidence
    is historical and is not proof of the new recovery behavior.

73. **Desk undelivered runs collapse at six or more rows** (user 2026-10-11 22:33Z,
    mee853a883c0d, relayed by lead-astra). Apply independently to the shared desk's
    current-turn input and later waiting mail after rendered-event deduplication.
    Preserve their positions around the live response; optimistic/failed sends
    stay visible. The local Show/Hide summary retains all cards/actions, and
    reply navigation reveals its target before scrolling. No read/delivery side
    effects and no MailList/Attention changes. Details: `pending-mail-collapse.md`.

74. **Agents can read usage on demand and optionally refresh one account**
    (user 2026-10-11 22:35Z, mf9c7f431147b, relayed by lead-astra). Saved cache
    is the default. Optional fresh refresh is rate limited, needs inherited
    runtime permission and causes no inference or account switch. Coordinator
    mechanics: inspection permission for cached reads; caller org allowlist and
    account origin only; exact filters, bounded account/window pages; per-lane
    manual attempt floors 60 seconds (Google 300), failures included; longer
    provider cooldowns retained; shared reservations with automatic cadence
    unchanged. Inactive accounts may be inspected, never refreshed. Preserve
    explicit unavailable/stale/unsupported and original observation times;
    return only safe projected fields, no credentials or raw provider errors.
    OpenRouter's original lane is `openrouter` for `openrouter-key`; added
    registry IDs retain distinct lanes. Full contract and verification limits:
    [`usage-query-proposal.md`](usage-query-proposal.md).

75. **Human hub mail is composed in Hubchat** (user 2026-10-12 08:41Z,
    mdd198237e882). Remove the org-inbox window compose button and feature,
    including human outside replies and dedicated send/upload/staging APIs.
    Preserve agent mail, inbox history, recorded quotes, file access, transfer
    custody and the integrated inbox-disable policy. No replacement composer
    or launch flow. See [`org-inbox-viewer.md`](org-inbox-viewer.md).

76. **Muse Code is a provider lane at full feasible parity** (user 2026-10-12
    18:32Z, 19:57Z, 20:01Z, 20:09Z, 20:21Z, 20:31Z, relayed by lead-astra; lead
    decisions 2026-10-13). Muse runs as `muse serve` (MSP v1), one host per
    agent, contributor mode off on every process (the user's saved setting is
    never changed), never an API key on a subscription seat and never a silent
    move onto paid inference. A Muse tier (Wonder 4, Wonder Full 10, Spark 2) is offered only
    while the signed-in account's own catalog lists it; a bundled row is no
    entitlement. Effort levels are each harness's and model's own names
    (`catalog::EFFORT_ORDER` none..max); a saved level a tier does not name
    launches as the highest it names at or below it, else its lowest, and is
    never rewritten (agent's choice, replacing "the model's default": it is the
    renderer bar's own clamp). Provider colour `#afe5ff` sampled from Muse's
    official art, `#0077b0` on light surfaces; tier colours measured (lead:
    routine). Sign-in runs `muse login` in a terminal, like Antigravity's.
    Cost and cache lifetime stay unknown (Muse publishes neither). Account
    fallback is offered as for every provider (lead 2026-10-13 02:12Z: the
    team's fallback-off is staffing, not product scope): opt-in per agent,
    Muse logins only, each asked for the seat's exact model and its room; an
    API key only while "fall back to Muse API-key accounts" is on, and only if
    its own catalog offers the model. The Muse Eggshell theme preset follows the
    existing provider-theme rule, after Antigravity in initial detection.
    The user's own Muse login, which can never be a registry row, is a limit
    fallback target after the registered subscriptions, with the same gates
    and proven room, and an org account-list move only lands where the exact
    model is offered (lead 2026-10-13 06:50Z: feasible parity, no new ruling).
    Independent review R1 (2026-10-13): every turn carries the current
    workspace roots; no raw MSP request reaches the log; placement, effort and
    pins are judged by the seat's own login's catalog, an unknown login
    refused. Independent review R2 (2026-10-13, lead 08:17Z): every hire and
    settings surface offers what the seat's login offers, its levels by login
    and pin, and a retool naming an account and an effort checks the effort on
    that account. Removing a registered Muse login, refused before, moves a
    live seat to the user's own login only where that login offers its exact
    model; otherwise the seat waits frozen saying why (the entitlement rule
    applied to the existing reassign-or-freeze removal). Independent review
    R3 (2026-10-13, coordinator 09:49Z; user 11:02Z: fix, then one more
    review): removal examines every permitted replacement, not the own login
    alone: the own login first (as every provider's removal), then the
    registered subscriptions in registry order, each passing every
    continuation gate and offering the exact model and pin; never a key; with
    none the seat freezes saying why, replacing any freeze it had and keeping
    its held request; queued moves and switches naming the login are
    retargeted the same way (a move with no target dropped, a switch left
    naming no account); defaults go to the own login as for every provider. An
    effort saved with no account named is judged on the login the next turn
    runs on (a queued move's), in retool as in the settings route. Every
    continue-on checks the target login's own catalog for the exact model and
    pin before anything changes, an unknown catalog refused, and a frozen
    seat's choices leave out logins whose catalog lacks it. Independent review
    R4 (2026-10-13, lead 12:26Z: correction only, no further review round): a
    Muse removal that releases a freeze holding a request gives it back as the
    agent's wake mail in the removal's own transaction (once, through a
    rolled-back retry; a halt kept). Contract, evidence
    and every remaining gap: [`muse-code.md`](muse-code.md).

77. **Background work keeps an agent's process open** (user 2026-10-14
    09:44:51Z, mb0530d71c4ee, answering the gap-11 question "Keep open
    (Muse+Claude)"; scope by coordinator-opus 09:45Z). With warming off, an
    agent's Claude Code process or Muse host is not closed at its turn's end
    while it runs background work (a background command or subagent) or the
    CLI still owes the next turn a result; it closes as soon as that is over,
    with no time cap. Warming being switched off and the idle cap do not close
    it either; such a held process is outside the cap (neither counted nor
    evicted). The results reach the agent as for Muse: the chip, one waking
    message for an idle agent, the output delivered once by the CLI itself.
    Unchanged: halt, the stop control, the time-limit kill, the usage-limit
    end of turn, a settings change that restarts the process, engine
    shutdown, retire and delete, each still reporting lost work. The memory
    cost is accepted. Codex and Antigravity are unchanged. Within the ruling
    (coordinator-opus 2026-10-14 10:56Z, md6791e143443): a startup-file edit does not
    replace a held process; its next turn still starts a fresh one (decision
    61). Contract and limits: [`background-work.md`](background-work.md).

78. **Every OpenRouter key is alike** (user 2026-10-14 18:00Z, docket
    `openrouter-keys-are-all-equal-no-unnumbered-prim`; supersedes the id/lane
    compatibility in decision 74 and `openrouter-keys.md`'s original-key rows).
    Every key is `openrouter-N` from 1, its lane its id; no key is the original
    or the primary. Migration 0022 renumbers the old first key `openrouter-key`
    (lane `openrouter`) once, carrying every reference and binding its unbound
    seats. The one symmetric default: an unbound seat bills the first key in the
    key list (`ord`, then N); a hire naming no key is placed by the placement
    balancing (`best_allowed`) and bound. Removing any key is the same
    reassign-or-freeze path (`account_removal::remove_key`), its id retired.
    Contract: [`openrouter-keys.md`](openrouter-keys.md).

79. **Superseded by decision 84 (user 2026-10-16 09:37Z): the "engine starts" choice and the
    sign-in engine task are gone.** As decided on 2026-10-15:
    **Where the background engine starts is the operator's choice** (user 2026-10-15 10:37Z, docket
    `option-to-run-the-background-engine-in-the-user-s`; default 10:38Z; design approved by the
    coordinator 10:57Z, helper ruling 11:13Z). Extends decision 70. On an installation for all
    users on Windows, "Run on startup" has a second setting, "engine starts":
    - **At boot, before sign-in** (the default, new and existing installations): the "Orgtree
      Background Engine" task in Session 0, as before.
    - **At sign-in, in my session** (opt-in, 3.x style): "Orgtree Sign-in Engine", a logon task for
      the operator's SID only with their interactive token, Normal priority (decision 46). The
      engine and its agents run in the user's own session, with their desktop and sign-ins, only
      while they are signed in. The task runs `orgtree-engine-host.exe`, a windowless launcher that
      starts `orgtree-engine host` without a window (the engine is a console program and would open
      one at every sign-in). Its run level is least privilege, or highest available while "Run
      Orgtree as administrator" is on.
    - **Exactly one engine task is enabled** while "Run on startup" is on; off disables both. The
      credential helper follows "Run on startup" in both modes: the engine a task's host started
      counts it as a lifecycle member, and an engine in the user's session never uses it. Tasks are
      disabled, never deleted. The installer's protected record keeps `StartupMode` (`signin`, else
      boot) beside `RunOnStartup`, and updates keep it.
    - **Changing it:** Settings › Desktop › "engine starts", shown only on all-users Windows
      installations and disabled while "Run on startup" is off, not in the tray. One Windows
      permission prompt per change. A running engine keeps running until "Restart the background
      engine now" (offered when a task started the engine) or the next sign-in or boot. These
      three points were decided by the coordinator beyond the user's request.
    - **One engine:** the data root's lock decides, as always. At sign-in the desktop adopts the
      task's engine through its refused-then-attach path; when its own engine won instead, the
      task's host leaves.
    Its document was replaced by [`run-on-boot.md`](run-on-boot.md).

80. **An installer that cannot reach the engine asks it to stop through its own record** (docket
    `installer-s-end-task-fallback-no-longer-stops-th`; design approved by the coordinator
    2026-10-15 11:54Z). Since the core-lifecycle recovery (2026-10-12) an engine outlives its host,
    so ending its task (which ends only the host) no longer stops it. That was the installer's way
    when it could not read the operator's attach descriptor (another administrator), and its boot
    step timed out after 150 s.
    - **The request:** such an installer first writes `StopRequested` (REG_QWORD, Unix ms) into its
      protected record `HKLM\SOFTWARE\Orgtree\BootEngine`, which only administrators can write.
      Then it ends the task as before.
    - **The engine:** an engine a task's host started (core mode "boot") reads the
      value every 2 s (`src/install_stop.rs`). A request newer than its own start stops it the
      graceful way, as the desktop's request does. An older value never stops anything, and a
      future-dated one is logged and stops it. The value is never deleted: the next request
      overwrites it. The stop is logged with the request time, the engine's start time and the
      reason.
    - **Unchanged:** a host exit with no request leaves the engine running (the 2026-10-12 recovery
      rule), and so does **a manual End on the boot task**. (The sign-in engine's launcher, which
      stopped its engine on End, went with decision 79; decision 84.)
    - **Rig only:** a rig run (`crate::rig::active`) reads the request from
      `HKCU\<ORGTREE_RIG_STOP_KEY>`; every other engine ignores that variable.
    - Rejected: running the boot task through the windowless launcher. That would change the
      task's action, which every older installer's ownership check refuses, so downgrades would
      fail. Proof: `tools/rig/proofs/boot-host-stop.mjs` (B, C).

81. **Muse last-good usage survives restarts** (user 2026-10-15 11:45Z;
    mechanics approved coordinator-opus 11:47Z). Persist normalized windows
    per Muse account in `ot.kv`, retaining original observation times; restore
    without new authentication evidence. Removing an account deletes its key
    in the same transaction. Passed-reset Muse windows become unknown, not
    zero: retain times, clear percent/active, show `reset; awaiting reading`
    with no bar. Other providers retain existing behavior. Contract and proof:
    [`muse-usage-cache.md`](muse-usage-cache.md).

82. **Agents may edit their own org's Logo autonomously** (user 2026-10-15
    22:06–22:10Z; docket `let-orgs-update-or-remove-their-own-logo-autonom`).
    Any agent with the inherited `logo` tool group may set/remove its org's
    Logo through `orgtree_org_logo`. The group is **on by default**, including
    existing scopes (explicit user answer 22:10Z). The user controls it in
    existing per-agent Tools and hire defaults. No top-level or org-inbox
    audience restriction; changes apply immediately, without approval, are
    logged with agent/time/set-or-remove and can be undone through existing
    history. This is the explicit exception to the earlier user-actions-only
    undo rule, not a general expansion for agent tools. Reuse the human Logo
    decoder/storage/publication path, validation and orange-letter removal
    fallback; default centre-square crop, optional editor-compatible crop.
    Targets the 4.3.1 patch/alpha. Contract and measured limits:
    [`profile-pictures.md`](profile-pictures.md#autonomous-logo-tool-431),
    [`undo-history.md`](undo-history.md#logo-history).

83. **Every agent can read its own next-turn prefix and compaction evidence**
    (user 2026-10-16 12:16-12:18Z; mechanism approved coordinator 12:19Z;
    docket `agent-tool-is-my-prompt-cache-dirty-and-will-i-c`).
    `orgtree_next_turn {}` is self-only, read-only and always available, with
    no tool-group prerequisite. Dirty covers prefix/namespace changes only;
    the final user simplification removes all retention timing fields. Each
    instruction file that enters startup is compared with its private
    delivered hash baseline: own/granted/global/native files, org.md, all
    team notes and org shared notes. Unknown legacy/unreadable copies stay
    unknown; edits take effect at the next fresh/resumed process start, with
    existing shared/team warm-process deferral preserved. Compaction reports
    known occupancy/thresholds and current policy with honest harness/future
    uncertainty. No hit guarantee or new reset policy. This and the session
    control tool ship together, for one tool-list prefix change. Contract:
    [`next-turn-query.md`](next-turn-query.md).

84. **The engine always starts at boot; agents run in the signed-in session while the operator
    is signed in** (user 2026-10-16 09:37Z: "agents always start at boot, and then automatically
    get upgraded when signed in"; 09:38Z one checkbox; docket
    `option-to-run-the-background-engine-in-the-user-s`; design approved by the coordinator
    09:43Z with rulings A to E; user 09:43Z on B). Supersedes decision 79, and decision 68's
    phase 2 rule that bypassPermissions seats stay in Session 0 (ruling Q1).
    - **One switch, "Run on boot"** (it was "Run on startup"; still stored as `startAtLogin`) in
      Settings › Desktop, first-run setup and the tray. On (the default): the boot task starts the
      engine in Session 0 and the "Orgtree Credential Helper" task starts the helper at sign-in.
      Off: both disabled, never deleted; nothing starts by itself (decision 70). One Windows
      permission prompt per change. Where Orgtree cannot start at boot (per-user installations,
      macOS, Linux) the switch reads "Run on sign-in" and starts at sign-in as before (ruling A).
    - **The sign-in engine is gone.** At upgrade the installer deletes its own "Orgtree Sign-in
      Engine" task (marker-verified) and drops `StartupMode`; boot and sign-in choices both become
      on, off stays off (ruling E). `orgtree-engine-host.exe` is no longer shipped.
    - **Agents in the signed-in session:** while the helper hosts, the engine starts every agent's
      CLI through it in the operator's session: Claude, Codex, Muse, Antigravity, OpenCode, and
      bypassPermissions seats too (user 09:43Z: "Yes, all agents"; one switch,
      `session_host::HOST_BYPASS_SEATS`). Otherwise, and when a hosted start fails, the engine
      starts them in Session 0. The channel is decision 68's authenticated host role; the helper
      starts only the five harness CLIs by absolute path; per-agent limits and the forced-kill
      records are unchanged in either session. The helper task's run level follows "Run Orgtree
      as administrator" (ruling C).
    - **At a turn boundary only:** each turn's start picks the placement; a warm CLI elsewhere is
      replaced then, unless it holds background work. Sign-out ends hosted CLIs: the turn stops
      cleanly as "the user's Windows session ended" (no failure report; its mail requeued when the
      CLI had done nothing yet) and the agent is woken to go on in Session 0 (with decision 86: at
      once, wherever its next turn is placed).
    - **Agents are told:** a real move either way delivers an `[ORGTREE SESSION NOTICE]` in the
      turn where it took effect; an agent's first turn ever and a restart that comes back in the
      same session deliver none. The RESTART NOTICE gets "Session access at start: Session 0." or
      "...: signed-in session.". An agent last in the signed-in session waits at its first turn
      after an engine start until 15 s after that start for the helper; the expiry is logged once
      (ruling D).
    - Chosen in the implementation, flagged for the user on the docket item: the settle at the
      first turn; the restart line added at delivery from the real placement; plain system mail
      for the notices; an engine not in Session 0 counts as the signed-in session; deferral while
      background work runs; the Claude keepalive CLI stays in Session 0.
    Details, verification and limits: [`run-on-boot.md`](run-on-boot.md); proofs
    `tools/rig/proofs/session-upgrade.mjs` and `codex-host.mjs`.

85. **Agents can ask where their turns run, and a turn the sign-out cut off resumes at once**
    (user 2026-10-16 11:01Z and 11:03Z; docket `let-agents-query-machine-sign-in-state-and-which`,
    on decision 84).
    - **`orgtree_session`**, with no arguments and no tool group (like `orgtree_status`: every
      agent has it on every harness), answers whether the operator is signed in, whether the
      caller's current turn runs in Session 0 or the signed-in session, where its next turn will
      run and whether that is a move, and whether the sign-in helper is connected. The caller's
      own actor answers for the turns, by the rule it applies when a turn starts; Windows answers
      for the sign-in (`core_state::sessions`, as the core monitor reads it). Chosen as a tool
      rather than a field on another tool because no other read-only tool is available to every
      agent.
    - **Sign-out resume:** a turn whose hosted CLI ends with the user's session is resumed at once
      by one new turn in Session 0 (since decision 86, wherever the turn-start rule places it:
      another of the user's sessions while its helper runs), woken as a turn cut off by an engine
      restart is. A turn that was interrupted, halted, timed out or retired is not resumed
      (`may_be_session_end`). The
      end is logged and written to the kill record as `codex-session-ended`, with the pid and exit
      status: Windows ended the CLI, not the engine.
    - The new tool card changes every agent's tool list: one prompt-cache miss per agent, at its
      first turn after the upgrade.
    Details: [`run-on-boot.md`](run-on-boot.md); proof `tools/rig/proofs/session-query.mjs`.

86. **Agents run in a signed-in session as often as they can** (user 2026-10-16 12:00Z: "agents
    should find and take advantage of any way they can to locate and run in an active logged in
    session, as often as possible"; rulings 12:05Z, 12:07Z, 12:12Z, 12:13Z; docket
    `let-agents-query-machine-sign-in-state-and-which`).
    - **Self-interrupt:** `orgtree_interrupt` on yourself needs no tool group; `restart: true` starts
      exactly one new turn at once, placed by the turn-start rule. Refused with background work running.
    - **Sign-in/out notices:** every live agent gets one passive line when where new turns run changes
      (a running turn at its next tool boundary); not on a restart while signed in. The sign-in line
      follows the agent's own runtime: its on-demand `use` and a CLI held by background work count.
    - **A session's end is its own helper's:** a hosted CLI's exit during a turn is the session ending
      when the helper that started it is gone (its lease: session, pid, process creation stamp), not
      the last helper; with two sessions hosted, a turn cut when one ends resumes at once, placed by the
      turn-start rule (rig-sol-b's review finding, 2026-10-16).
    - **2c:** watchdog events `session.signed_in`/`session.signed_out`; at sign-in, working agents idle in
      Session 0 get their checkup at once, docket work or not, or a docket reminder instead if one is due
      then (the user's ruling of 10:01-10:03Z; the coordinator's correction, 13:03Z).
    - **2d:** the engine starts the helper's logon task when the user is signed in without a helper
      (30 s, then 2, 5, 10 minutes); never the machine's task from a rig engine.
    - **The user's sessions (only the engine user's own):** one helper lease per session; an agent's
      preference by kind (scope `session`, default `signed-in`, Session 0 the fallback), set in Agent
      settings or by `orgtree_session` `prefer`; an on-demand `use` for the next turn;
      `orgtree_session` lists Session 0 and every hosting session.
    - Rejected: a forced move of running turns at sign-in (user 12:12Z, item 5). The credential relay
      stays: every agent CLI still uses it, and Session 0 turns while signed in need it (12:03Z).
    Details: [`run-on-boot.md`](run-on-boot.md); proofs `self-interrupt.mjs`, `session-choice.mjs`.

87. **Expanded helper calls show live transcripts, one level only** (user
    2026-10-16 20:23Z; coordinator initial-slice order 20:25Z). New Claude
    Agent/Task calls use explicit parent-tool IDs and bounded private captures.
    Child events/usage never enter the parent turn; nested helper tools stay
    ordinary input/result details. Other harness adapters, history recovery and
    helpers continuing after the parent turn are deferred in this alpha slice.
    Contract and verification limits: [helper transcripts](helper-transcripts.md).

88. **Agent scratch is opened in the OS file explorer; event history lives in agent settings** (user 2026-10-17 19:16–19:18Z). Remove the Files browser from agent desks and its listing endpoint, but preserve the separate `read_scratch` tool, Quick chat attachments and uploads. Keep personal and team scratch-folder actions in the agent menu and settings header, following the same native capability and live/archive availability rules. Move the desk History view into an agent-settings History tab only when retained records exist; stale desk Files/History views fall back to Chat. Project settings without agent history have no History tab.
