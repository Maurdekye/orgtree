# Muse Code lane

Orgtree runs agents on Meta's Muse Code (1.4.6) through its own session protocol
(MSP v1, `muse serve`), with the same seats, folders, tools, usage, freezes and
UI the Claude Code and Codex lanes have, as far as Muse exposes them. Every
place it cannot match them is listed below with the reason. Docket item:
`assess-muse-code-harness-and-provider-integratio`.

Evidence labels used throughout: **measured** (observed on this build: the
real Muse Code, the rig's fake `muse serve`, a rendered UI or a unit test,
named), **documented** (Muse's help, schema or docs say so; not observed
here), **inferred** (follows from code or measurements but was not observed
directly), **untested**.

## User rulings this lane implements

- 2026-10-12 18:32Z: full parity pursuit (subscription and API-key auth,
  isolated profiles, model and reasoning selection, the structured stream,
  exact-turn steering, queued input, cancel/resume/compaction, Orgtree's tools
  with caller attribution, permissions and folder scopes, images, lifecycle,
  quota/reset/freshness/token/cache/cost/freeze/retry, UI and tool parity).
  What Muse cannot do is explicit and fails safe; never widen permissions,
  invent usage/cost/reset data or switch to paid inference; a cached usage
  read is not a forced refresh; unknown is not zero.
- 19:57Z: tier-aware, authenticated discovery. A tier is offered only while
  the signed-in account's own catalog lists it (Wonder Full included); a
  bundled catalog row is not an entitlement; Full is not Wonder, does not
  share its pool by assumption, and API entitlement is never inferred.
- 20:01Z: effort levels carry each harness's and model's own names in every
  selector, agent setting and tool; stored values keep their meaning through
  explicit compatibility mapping.
- 20:09Z: the provider colour is the exact baby-blue cyan of Muse's official
  marketing, with its source, readable in every theme. Lead decision
  2026-10-13: `#afe5ff`, pixel (1210,246) of
  `dev.meta.ai/images/landing/model_api_muse_glimmer.png` (sha256
  9680c092536bd5796687bc95b066bee3506aa739a36595fff01668d4c5dbdc29).
- 20:21Z: integration sessions with every offered model, Wonder Full
  included, through the adapter; synthetic, no paid fallback.
- 20:31Z: seats Wonder 4, Wonder Full 10, Spark 2. Contributor mode is off for
  Orgtree on every process (`--contributor-mode off`); the user's saved Muse
  setting is never changed.
- Lead 2026-10-13 02:12Z: Orgtree's own team keeps account fallback off as a
  staffing policy; that is not a product reason to leave it out. Muse has the
  existing same-provider fallback, off by default per agent, with no silent
  move onto paid inference and no mixing of credentials.
- 2026-10-13 18:32Z: a tool call that runs past the silence limit ends by
  itself and the agent's turn goes on ("it shouldnt stop the turn, just end
  the tool call and allow the agent to continue").

## How the lane runs

**Discovery** (`providers/mod.rs` `discover_muse`, `providers/muse_models.rs`).
The engine runs Muse's binary itself (`muse-bin-<version>.exe`, never the
auto-updating launcher; `MUSE_NO_AUTO_UPDATE=1`) as a short metadata host:
`initialize` (schema fingerprint checked against the measured stable one),
`account/read`, `model/list`, `usage/read`. The catalog's rows with a
`profileId` are the account's; a row without one (the bundled Wonder Full
fallback) offers nothing. The Muse tiers are `wonder` (muse-wonder-1.0),
`wonder-full` (muse-wonder-full-1.0) and `spark` (muse-spark-1.3, version 1.2
pinnable). A turn that arrives before startup discovery has read the catalog
waits for it (at most 60 s) instead of failing (measured race, fixed in this
landing).

**The host.** One `muse serve --provider meta --contributor-mode off` per
agent, warm between turns like the other lanes, in a kill-on-close job, shut
down gracefully before any force. Launch switches: `--trust-workspace`;
`--disable-shell` / `--disable-write` from the seat's scope;
`-c run.developer_prompt=<identity>` (by file past 26,000 characters);
`-c runtime_capabilities=...` turning Muse's six background observer agents
off; workflows off; web search and fetch off unless the scope allows web. The
environment is the agent's (Orgtree names, the credential bridge) with every
other provider's secrets and `MUSE_AUTH_PATH` removed; a subscription seat
never receives `META_API_KEY`.

**Sessions.** `session/start` with the agent's folder as primary workspace
root (canonical `\\?\` form, which Muse requires) and its read/write grants as
further roots; read-only grants are never roots (Muse gives every root the
same write access), reads there are approved on request. Posture: write seats
run `:ask-me` with approval `onRequest` (the engine answers each request from
the scope, once, never for the session), read-only seats `:read-only` with
`denyUnmatched`, bypass seats `:unrestricted` / `allowAll`. Orgtree's tools are
a session MCP server (`config.mcpServers.orgtree`, the engine's `mcp-bridge`),
so every call is the calling agent's. A restart resumes the same session
(`session/resume`) and re-applies the seat's posture. Every turn carries the
session's current roots (`turn/start.workspaceRoots`, MSP's sticky
replacement): a resume admits none, so without them a resumed session would
keep the set it started with, a folder revoked or made read-only since staying
a native writable root and a new grant never becoming one (independent review
R1, 2026-10-13).

**Turns.** `turn/start` with the text, image parts (base64, capped as for
Claude) and the effort; mail that arrives mid-turn goes into the exact running
turn (`turn/steer` with `expectedTurnId`); an interrupt is `turn/interrupt`; a
turn Orgtree did not start is cancelled; a subagent the scope does not allow
is stopped (`subagent/stop`); `/compact` is `session/compact`. Items become
the conversation: agent messages, reasoning, tool calls (orgtree tools on
their chips), the todo list as the checklist chip.

**Tool calls past the silence limit** (`actor.rs` `stop_silent_muse_tools`,
`muse.rs` `stop_task`). The silence limit (Runtime `turn_idle_s`, 10 minutes
by default) counts from the last thing the host sent. When it runs out on a
Muse turn that is waiting on tool calls, the silence is theirs. Orgtree first
steers a note into the turn ("Orgtree stopped your powershell call: it
produced no output for 10 minutes, the silence limit for a turn. Treat that
call as failed and carry on with your turn."), then stops each such call by
itself with `task/stop` (a tool call's task id is its item id), and restarts
the silence clock. The call's chip reads "stopped by Orgtree: no output for 10
minutes (the silence limit)". Measured on Muse 1.4.6 (synthetic turns in a
scratch folder): `task/stop` ends a call still in the foreground too; the
item settles `cancelled` ("cancelled by runtime client"); the steered note
reaches the model right after that result, in the same step; the model goes
on in the same turn. Orgtree kills nothing: the host keeps running and Muse
ends the call's own process.

Unchanged: a turn whose model itself is silent (nothing in flight, or only
work Muse moved to the background) stops as before ("the turn produced nothing
for too long and was stopped"), and the total ceiling (`turn_timeout_s`) still
ends a turn. Each call is stopped once: one still in flight a whole limit after
its stop ends the turn as before, so a stop that does not take cannot loop.
Muse moves a shell command still running after about 10 s to the background
by itself (measured), and the turn no longer waits on it, so such work is
never stopped here. Waking the agent when such a command finishes, and
recording its late result, is a separate item
(`muse-results-of-shell-commands-moved-to-the-back`). In the reported hangs
each call settled `timeout` ("tool timed out") 601 s after it started.
Orgtree's 600 s stop of the whole turn came first; Muse settled the call while
draining its shutdown (1.04 s, its session log's `drain_ms`). Whether Muse has
a foreground tool timeout of its own is not determined.

The other lanes are unchanged (no ruling to change them). Source-derived from
`on_timer`: the limit is the same for every lane and any event from the CLI
resets it. Claude Code (stream-json with partial messages), Codex (app-server
notifications, command output streamed as it arrives) and Antigravity
(stream-json) send nothing while a call is silent. So a call silent for the
whole limit still ends the whole turn there, as it did on Muse. Orgtree sets
none of their own tool timeouts; Antigravity gets only `--print-timeout`,
equal to the turn ceiling. Whether one of their calls can stay silent that
long is up to their CLIs:
- Claude Code's Bash tool times out after 2 minutes by default and at most 10
  (its tool definition), so a call given the maximum meets a 10-minute limit
  as it ends. Its MCP calls wait as long as `MCP_TOOL_TIMEOUT` allows (not
  verified here).
- Codex's and Antigravity's own timeouts are not verified here.

**What the log keeps.** No raw MSP request or answer reaches the engine log:
`session/start` and `session/resume` carry the session's configuration, a
granted MCP server's environment, headers and arguments included. One line
names each request's method, its time and how it ended (the MSP error kind); a
turn's start counts its characters, images and roots. The launch
fingerprint's input, which embeds that configuration, is not logged either
(every lane), and a plan prints its servers by name only. Verified with
synthetic sentinels in a server's environment, header and argument through a
session start and a resume, with verbose logging on and off.

**Effort.** `catalog::EFFORT_ORDER` is every name any harness exposes, lowest
first: none, minimal, low, medium, high, xhigh, max. A Muse tier offers its
catalog row's `variants`; Claude seats Claude Code's five `--effort` names;
Codex seats the model's `model/list` levels. A saved level the tier does not
name is sent as the highest it does name at or below it, else its lowest
(`launch_effort`), and the saved value is never rewritten; the renderer's
effort bar shows the same clamp. Muse's `ultra` is not offered (it is `max`
plus proactive workflows, which Orgtree turns off).

**Usage, limits and cost.** The lane's readings are Muse's own dated
observations (`usage/read` on the metadata host, `usage/changed` from live
sessions): the rolling 5-hour window and the week, by Muse's `observedAtMs`,
never re-dated and never replaced by an older one; a window Muse did not
report is absent, not zero. A window counts against a tier only when it was
observed under that tier's own model. A typed quota refusal freezes the agent
until Muse's `resetsAtMs` and marks the tier's pool (`muse:<tier>`); an
`authRequired` error parks it for a sign-in; a retryable error retries like a
network failure. Tokens come from `session/tokenUsage` (the cached part kept
apart). Muse publishes no price and no cache lifetime: cost is recorded as
unknown and no cache countdown is claimed.

**Accounts and sign-in.** `muse/primary` is the user's own Muse login. A
managed account is a profile folder with its own `config` and `data` roots
(`XDG_CONFIG_HOME` / `XDG_DATA_HOME`). An API-key account runs with
`META_API_KEY` in roots of its own (`profiles/muse-key-<id>`), never the
user's, so a key seat neither sees that sign-in nor resumes its sessions
(Codex keys get their own home the same way). Importing a folder is refused (a
Muse login is two roots Muse lays out itself). Sign-in runs Muse's own `muse
login` (a code approved in the browser) in a visible terminal the desktop
opens, like Antigravity's, and the user clicks Refresh; identity comes from
`account/read`, never the auth file. A seat on a registered login runs only
what that login's own catalog offers (`providers::muse_model_for`): a profile
is read in its own roots and a key with itself, so entitlement is never
borrowed from another login and never assumed for a key.

**Account fallback** is the existing product feature: per agent ("Switch
accounts when limited", off by default), with the provider-wide switches in
App settings › Providers. An opted-in Muse agent frozen by a Muse quota moves
only to another Muse login (`freeze::pick_fallback`). First the registered
subscription logins (managed profiles): each must offer the exact model the
seat runs, its pinned version included (`freeze::muse_pin`), and show room in
its own reading. Next the user's own login: Claude's or Codex's own login is
a candidate as a registry row once its default home is registered, but a Muse
login is two roots Muse lays out itself and never a row, so it is asked here,
for an agent on a registered login only (never one already on it), under the
same subscription switch: its catalog must offer the exact model, every
continuation gate must pass (the org's account list, activation, sign-in,
re-authentication, a full window) and its own reading, taken first, must prove
room; an unknown reading is never room (`freeze::muse_primary_takes`, lead
2026-10-13 06:50Z). Then, only while "fall back to Muse API-key accounts" is
on (off by default, the same switch every provider has), an API key whose own
catalog offers that model; a key is metered, so it needs no room proof, as for
every provider. Room
(`usage::room_in`): an account-wide window from a login's metadata read counts
for every tier the login offers; a window observed under another model never
does. Each read is limited to 5 s (a real metadata read took about 0.4 s).
The agent then continues on that login (`continue_on`, the step every
provider uses): its host restarts in the new login's roots and asks to resume
its session; Muse keeps sessions under the login's own data root, so on
another login the session is expected to be missing, and the agent starts a
new one with Orgtree's handoff note (inferred: the fake shares one session
store, so the rig resumes). `orgtree_continue_on` also takes `muse/primary`.
Every continuation of a Muse seat, the user's route and the agent's
`orgtree_continue_on` as well as an automatic one, first reads the target
login (bounded to 10 s, unless its last read is recent; the user's own login
when discovery holds no catalog) and then, in its transaction, refuses unless
that login's own catalog offers the seat's exact model, pinned version
included (`continuation::muse_offered`): a login that lacks it, or whose
catalog is unknown, is refused with nothing changed (binding, freeze, queued
account, mail; independent review R3, 2026-10-13). A frozen Muse seat's
continue choices (`continue_accounts`) leave out every login, the user's own
included, whose own catalog lacks the model; one not read yet, or whose read
failed, stays a choice, and continuing on it reads it, then decides.
When an org switches a Muse seat's login off (`org_accounts::leave`), its
pick keeps its own order, and every last-resort login, the user's own
included, must likewise offer the exact model and pass every gate (the
unbinding to the user's own login never bypasses one); otherwise the seat
freezes saying so, its mail waiting.

**Placement and effort.** A Muse seat is placed by the login it will run on
(the one named, the org's default, the best the org allows, or the user's
own), whose own catalog must offer the exact model, its pinned version
included (`ops::muse_admit`: hire, rehire, switch, account move). Its effort
must be one that model names on that login (`providers::check_effort_on`:
hire, retool, the agent's settings), and a pin one that login offers. Each
registered login's catalog is what its own metadata reads last said (launch,
fallback, usage probe, identity, a refresh bounded to 10 s;
`providers::muse_logins`, fresh for 5 minutes). Those reads happen before an
op's transaction, never inside it, and a login never read, or whose last read
failed, is refused as unknown rather than assumed. The user's own login is
judged by discovery and offers nothing while signed out. Staffing offers a
Muse tier when some login offers it, lists only the logins that do (each with
its own levels for the model; the tier's levels are every level some login
takes), and offers it with no account named only when the user's own login
does (independent review R1, 2026-10-13: the user's own entitlement is no
prerequisite for another login's, and never stands in for it). An omitted
account auto-placed on the best allowed login (the user's own switched off for
the org) skips a login that does not offer the model. A retool that names an
account and an effort together checks the effort on the account it names
(`primary`, `default` and `muse/primary` are the user's own login), before
anything is written, and the account move that follows keeps every gate and
the busy queue; the settings route asks the login of an account change queued
behind a running turn, the one the next turn runs on (independent review R2,
2026-10-13). A retool that names no account checks the level on that same
login (`accounts::next_turn_login`, shared with the settings route), and the
agent settings window lists that login's levels unless another login is picked
there (independent review R3, 2026-10-13). A queued model switch is not looked
ahead to: as on every lane, a level is judged on the tier the seat runs now,
and the switch's launch maps it to the nearest level its model takes. An
unchanged saved level keeps the launch's mapping to the nearest level the
model takes.

**Removing a Muse login.** A registered Muse profile or key can be removed
like any account (`account_removal::remove`; it was refused before), in one
transaction whose late org scan stays `FOR UPDATE NOWAIT` with
rollback-then-backoff. Every other registered Muse subscription login, and the
user's own login when discovery holds no catalog, is read first (bounded to
10 s each, in parallel); the transaction makes no provider request. A live
seat bound to the removed login goes to the user's own login when that login
passes every continuation gate (the org's account list, the subscription
switch, sign-in, re-authentication, marks, a window observed full for the
seat's model) and its own catalog offers the seat's exact model, pinned version
included, as every provider's removal rebinds to its own login; else to the
first other registered subscription login, in registry order, that passes the
same checks (`muse_target`, through `freeze::admits`); never to an API key, a
removal making no paid move nobody asked for. With none, it is unbound and
waits frozen (cause `account`), saying which login was removed and why no
login could take it; that freeze replaces any the seat had (a usage limit's
reset could not make it run) and keeps the request that one held, and
continuing the seat on a login that offers its model runs it there with that
request. When a removal does find a login for a seat and so releases a freeze
it may rebind past (cause `account`, `auth`, `balance`, or an untrusted one),
a request that freeze held comes back as the agent's wake mail, queued in the
removal's own transaction as continue-on queues its own (`freeze::queue_replay`):
committed with the release or not at all, so an attempt rolled back at the
late `NOWAIT` org scan leaves none and its retry queues it once; a halt stays,
the mail waiting for it (independent review R4, 2026-10-13). A queued account move naming the login names the login chosen for
the model it will run (a queued switch's tier, else the seat's), or is dropped
when none can take it; a queued model switch naming it names the login chosen
for its tier, or no account (it lands where the seat is at its boundary,
judged there as any switch is). A seat that is not live goes to the user's own
login, as for every provider, and is judged on the login it lands on when it
is rehired; an org or app default naming the login goes to the user's own
login, as for every provider (a default carries no model: each hire is judged
on the login it lands on, and the hire surfaces name an eligible subscription
login when the default's cannot run the model). The removal's answer gives
each moved seat's new login (`account`) and marks a frozen one `frozen`; the
Providers toast says how many went to the default, to which other login, and
how many wait frozen. A seat leaving a Muse login takes a session boundary,
its session living in that login's own data root. A removal refused because a
bound seat is mid-turn changes nothing. (Independent review R3, 2026-10-13,
under the coordinator's reassign-or-freeze ruling. Claude's and Codex's own
logins run every tier, so their removals never meet this case.)

**UI.** A Muse family in every hire surface, the agent settings model list,
quick chat and templates; the Providers row with its tiers and seats; a
Muse Code card in Usage; Muse in the usage title, glow and history. What a
surface offers a Muse seat is what the login it runs on offers:
`/api/providers` lists a Muse tier when the user's own login or any registered
login switched on offers it (`own`, `logins`), and `muse.logins` gives every
login's state and, per tier, the exact model's levels for the latest model and
each offered version. The payload is pushed to the windows when a login's read
changes its offer and on every account change. The hire menus, the draft, the
hire sheet and Quick chat name the first eligible subscription login that
offers the model when the login a no-account hire would land on (the org's
default Muse account, else the user's own) does not; a metered key is never
picked for the user. An agent's settings, its desk's effort control, the
draft, Quick chat and Quick staff offer the levels of the model's row on the
seat's login and pin, and the settings say why a login cannot run the chosen
model. Unknown stays unknown: a login whose catalog is not known is offered as
before and the engine decides at the door (independent review R2, 2026-10-13).
Colours:
`--prov-muse` `#afe5ff` (11.28:1 on `--panel`), rebound on the light surfaces
to the same hue at 34.6 % lightness, `#0077b0` (4.56:1 or more on every light
and solarized panel and background), with `--prov-muse-ink` for text on accent
fills. Tier colours: Wonder `#97edd0`, Wonder Full `#80b8ff`, Spark `#ffff7a`
(measured; see the stylesheet). Wonder Full uses a deeper blue per the user's
2026-10-13 request, replacing dusty rose `#da8181`; its shared F icon and hire
button retain blue text on a dark backing on light/solarized surfaces. The
same tier token paints cards, miniature cards and summary letters; provider
cyan, the other Muse tiers, letters and runtime behavior are unchanged.
Targeted colour proof (2026-10-13): existing `musecolor`/`argon` checks passed
14/14. Offscreen Chromium rendered the production `TierChip` with production
CSS in synthetic provider/desk/reference/configuration/summary/hire contexts
across charcoal, light, solarized-light and obsidian-black: 24 Wonder Full
text samples, minimum contrast 6.33:1, eight before/after screenshots inspected,
no console errors. Desk-card top borders followed the same blue token.
This is a narrow icon/cascade proof, not assembled-app, native DPI or installed
acceptance; miniature-card propagation is source-checked, not separately rendered.
Kept collisions, by decision: `#afe5ff` is
CIE76 1.9 from `--tier-flash` and 6.5 from the frozen `--ice`; `#0077b0` is
7.8 from the light `--work`. Each state also has its own rail, letter, icon
or label (rendered proof below).

**App theme.** Settings › Display offers **Muse Cyan**, the provider cyan, as
Claude Terracotta and Codex Teal are their providers' colours: the existing
provider-theme rule ([`v2-visual-themes.md`](../v2-visual-themes.md), with
Language Server Gold as the precedent in
[`langserver-theme.md`](langserver-theme.md)). `THEME_ACCENTS.muse` is the one
source for `#afe5ff`; the tray and window eye has a Muse variant
(`orgtree-eye-tray-muse.ico`). It is CIE76 20.0 from Orgtree Grey, its nearest
preset (the precedent's floor is 18). Initial detection, which uses installed
CLIs only, puts Muse after Claude, Codex and Antigravity, so it never changes
the starting theme of a machine that has any of those. On the light surfaces
the pale cyan would paint text at 1.36:1, so this theme's accent becomes the
provider's light partner `#0077b0` with white ink there (the other presets
have no such rule; their accents are darker).

## Verification

All on the candidate branch, output under the agent's own build root, every
build, test and proof (cargo included) inside the machine build lock and a
kernel Job's memory ceiling and deadline; each log ends with the step's exit
status and the exact HEAD it ran on.

| What | Result |
|---|---|
| `cargo check --all-targets`; engine and fake CLI builds | 0 warnings |
| Engine unit tests (Muse incl. each login's own catalog, effort incl. the next turn's login, staffing, usage incl. Muse room, accounts, account removal incl. queued intents, identity, the phone-link authority on every lane Muse included, startup incl. granted folders' notes, tool definitions, question cards, mail tools, OpenRouter, catalog) | 84 passed |
| The identity group test `prompt_follows_every_combination_of_group_switches` | fails the same way on the exact bases `9fc30fb` and `67fc92e` as on this branch (measured); not caused here, so left out of the 84 |
| Typecheck, renderer and desktop TypeScript (TypeScript 7.0.2) | exit 0 |
| Renderer tests touching providers, accounts, usage, effort, tiers, themes, OpenRouter keys, `musehire` (each login's offer and levels, the account a hire names), `musequeued` (settings levels after a queued move) and `museremoval` (the removal toast) (82 files) | 568 passed |
| Root tests: `providerlogin` (sign-in door), `themes` (presets), `icon-assets` (tray eyes) | 51 passed |
| Rig `muse-lane.mjs` on the fake `muse serve`, fallback and API-key fixtures included | 48 checks passed |
| Rig `muse-r1.mjs`: roots after a resume (B made read-only, C added, unchanged, C revoked); sentinel credentials never in the log, through a start and a resume | 12 passed with verbose logging, 12 with `--quiet-log` |
| Rig `muse-routes.mjs`: the limit fallback onto the user's own login and every gate that refuses it; the org account-list move | 19 passed |
| Rig `muse-placement.mjs`: placement, effort and pins by the login, entitled and not, the org default, an unreadable login, a signed-out own login | 13 passed |
| Rig `muse-r2.mjs`: a retool naming an account and an effort (A to B with max, B to A refused with nothing changed, the primary aliases, the account it is on, an unknown one); a busy seat's queue (retool, settings route); the providers payload and `muse.logins`; staffing kinds and levels; best-allowed placement; removing a Muse login (to the own login, Full to the subscription that offers it, the Spark 1.2 pin to the login that offers it) | 14 passed |
| Rig `muse-r4-removal.mjs`: a removed login's seats to another entitled subscription (never the Wonder-only login first in order, never the key), the pin, the own login first, the own login's five gates (switch, org list, signed out, sign-in, full), no login left (unbound, frozen with the held request, refused on the own login, recovered on PF and replayed), queued moves and switches retargeted or dropped, defaults, an atomic refusal | 10 passed |
| Rig `muse-held-replay.mjs`: the independent R4 schedule on the routes (quota walls hold requests; the logins removed with none left freeze the seats keeping them; the account operation binds them to B, keeping the freezes; B removed while C offers Full, through a first attempt rolled back at the NOWAIT org scan and a retry): one given-back wake mail per held request, run on C; a halted seat stays halted with its mail waiting and runs it once unhalted; a freeze holding no request gets no mail | 5 passed |
| Rig `muse-r4-routes.mjs`: an effort-only retool after a queued move (route and agent tool, the inverse with nothing changed, a named account overriding, a queued `default`, no queue); continue-on refused on the own login, a Wonder-only login, an unreadable login and a Spark-1.3-only login for a 1.2 pin with nothing changed; the frozen seats' choices; continue-on positives | 10 passed |
| Rig `muse-ui-logins.mjs`, the real renderer: Full in "Hire a subordinate" only a profile offers and the draft landing there; a signed-out own login; a seat's settings switched to Full leaving out its profile and saying why; pinned and profile levels in settings and on the desk | 7 checks passed; screenshots inspected |
| Rig `muse-visual.mjs`, the real renderer: cards in charcoal and light, Providers, Usage, the Muse Cyan theme in all four contrast themes, effort names | 24 checks passed; screenshots inspected |
| Rig `effort-selects.mjs` (existing effort UI) | 12 checks passed |
| Other providers' account paths, unchanged: `continue-primary.mjs`, `claude-accounts.mjs`, `codex-accounts.mjs`, `fallback-slow-read.mjs` | 46, 19, 22 and 2 passed |
| The integrated base's own proofs where its source overlaps this lane: `openrouter-keys.mjs`, `openrouter-keys-corrections.mjs`, `openrouter-lane.mjs`, `folder-grants-account-removal.mjs`, `approved-folder-grants.mjs` | 29, 50, 13, 23 and 24 passed |
| `question-options.mjs` (question cards) | not run here: it hosts a mail hub; the question-card unit tests ran (above) |
| `org-accounts.mjs` | 23 of 24: "the agent tool refuses it too" fails the same way on the exact base `67fc92e` (an agent hire now needs an explicit index); not caused here |
| Rig `muse-real.mjs` on the REAL Muse Code 1.4.6, the user's own login | see below |
| Engine unit tests `runtime::actor::muse_silence_tests` (which calls a silent turn waits on: the foreground ones, each stopped once; backgrounded work never; the note names the call and the limit) | 3 passed |
| Rig `muse-tool-silence.mjs` (4 s limit), the tool-call stop. One silent call: the note first, then the call alone; the turn ends well, the host untouched, the chip says why. A silent model: the turn stops as before. Two silent calls: each stopped in its turn. A stop that does not take: asked once, the turn stops a limit later. Backgrounded work: not stopped. A 10 s total ceiling: still ends the turn | 13 checks passed; `turn-failures.mjs` (15) and `muse-lane.mjs` (48) pass on the same engine |

**Red controls** (the same proof, run against an engine without the change):
without the Muse fallback five checks fail (the move to the profile, its
roots, the key seat's own roots, `muse/primary`, the key fixtures); without
the key's own-catalog check an agent is moved onto a key that lacks its model
and stranded there ("does not offer wonder"); without the pin a Spark 1.2
seat is moved onto a login that offers only Spark 1.3 and stranded the same
way. A first version of the pin fixture passed its red control too (that
login had no room for Spark anyway) and was replaced by one only the pin can
refuse. Without the roots on every turn and the unlogged requests, seven of
`muse-r1.mjs`'s checks fail: a resumed turn sends no roots, so the read-only
folder stays a native writable root, the added one never becomes one and the
revoked one stays; and all three sentinels reach the log. Without C4a and C4b
seven route checks fail: the user's own login is not taken, a key is taken
before it, and the org-list move strands seats on logins without their model
or past a needed sign-in. Without the placement change all thirteen placement
checks fail. Against the round-2 predecessor (the reviewed candidate rebased
onto this base), `muse-r2.mjs` fails 13 of its 14 checks (only its control,
the account the seat is on, passes) and `muse-ui-logins.mjs` 6 of its 7 (only
the unpinned control passes). Round 3, against an engine compiled from a
fresh, clean checkout of the reviewed candidate `b70ca2c` (its package
artifacts cleaned first; binary sha256 `2b6e6638…`): `muse-r4-removal.mjs`
fails 8 of 10 (its defaults and atomic-refusal controls pass),
`muse-r4-routes.mjs` 7 of 10 (the named-account override, no-queue and
continue-on positive controls pass) and `muse-r2.mjs` exactly its two
corrected removal checks; `b70ca2c`'s renderer with only the two new test
files added (`441d037`) fails exactly the four corrected-behaviour tests, their
three controls passing. Round 4, against an engine compiled from a clean
checkout of `d982c87` (sha256 `210a78fe…`): `muse-held-replay.mjs` fails its
three give-back checks (the seats are moved and released with no mail; the
retry happens there too), its setup and no-request control passing. The
tool-call stop, against an engine compiled from a clean checkout of its base:
`muse-tool-silence.mjs` fails 10 of its 13 checks (every silent call ends its
whole turn at the limit, nothing is stopped alone), its setup, silent-model and
backgrounded-work controls passing.

**Real Muse Code, 2026-10-13** (`muse-real.mjs`; its result files are kept
in the implementing agent's evidence folder, off the repository). The account's
catalog offered Wonder 1.0, Wonder Full 1.0, Spark 1.3 and Spark 1.2. Each ran
one synthetic turn at `minimal` through the adapter and answered `READY`; the
turn row, `run.model.configured` and every completion in Muse's own session
log named exactly the requested model (no `-contributor` route); every host's
command line carried `--contributor-mode off`; about 36k prompt tokens a turn,
cost unknown. A first run found a race (a turn 250 ms ahead of discovery was
refused as "not offered"); after the fix, a re-run on Wonder resumed the same
session across an engine restart, the relaunched host again carried
`--contributor-mode off`, and the resumed completions were the plain model.
The user's `settings.json` was byte-identical before and after (their saved
contributor preference, on, untouched). A provider cache read of 74,984
tokens on the re-run's first turn is a positive cache receipt, not a TTL.
Fallback, API keys, a second account and a resume with changed folder
grants were not run on the real binary (one real account, no key: a key would
be paid).

## Parity with Claude Code and Codex

"Same" means Orgtree behaves for the user as it does on that harness.

| Feature | Muse lane | vs Claude Code | vs Codex | Evidence |
|---|---|---|---|---|
| Subscription sign-in, user's own login | yes | same | same | measured (real) |
| Isolated managed profiles | own config/data roots per account | same idea | same idea | measured (fake: a moved host runs in the profile's roots, no key); no second real account |
| API-key accounts | `META_API_KEY` in the key's own roots | same | same (Codex keys get their own home) | measured (fake); real untested (no key; paid) |
| Sign-in from the app | `muse login` in a visible terminal, then Refresh | Claude pastes a code in-app | Codex completes on its own | measured (desktop tests); real sign-in not run |
| Model selection, entitlement-aware | catalog rows only; Wonder Full when offered | Claude tiers are fixed | Codex models are fixed | measured (real catalog, fake gating) |
| Model version pin | Spark 1.3 / 1.2 | same | same | measured (real Spark 1.2) |
| Reasoning effort | catalog names, rank-clamped launch | same mechanism | same mechanism | measured (real minimal; rendered bars) |
| Structured stream (text, reasoning, tools, todo) | yes | same | same | measured (fake); real text measured |
| Mid-turn mail into the running turn | `turn/steer` exact turn | tool-boundary hook | same as Codex | measured (fake) |
| Queued input while busy | `ifBusy: queue` | same | same | measured (fake) |
| Interrupt | `turn/interrupt`, ends cancelled | same | same | measured (fake) |
| A tool call silent for the silence limit | that call alone is stopped (`task/stop`, a note naming the limit first) and the turn goes on | the whole turn ends (unchanged) | the whole turn ends (unchanged) | measured (fake proof; the MSP stop, note and continuation measured on real Muse 1.4.6); other lanes source-derived |
| Resume across restarts | `session/resume` | same | same | measured (real) |
| Compaction | `/compact` → `session/compact`; cheap compact as everywhere | same | same | measured (fake); real untested |
| Orgtree tools, caller attribution | session MCP server | same | same | measured (fake) |
| Folder scopes, read-only folders | write roots; read-only by approval | same outcome | same outcome | measured (fake: a write outside the folders denied); read-only reads inferred |
| Shell / write closed on read-only seats | `--disable-shell` / `--disable-write` + `:read-only` | same | same | measured (fake) |
| Images | MSP image parts | same | same | untested |
| Subagents | stopped unless the scope allows | Claude Task allowed by scope | n/a | measured (fake stop); allowed path untested |
| Background observer agents | turned off | n/a | n/a | measured (real probe: no reminder children) |
| Usage bars, reset, freshness | Muse's own dated 5 h / weekly | same | same | measured (fake); real reading not asserted |
| Usage limit freeze to reset | typed quota → freeze to `resetsAtMs` | same | same | measured (fake); real untested |
| Auth-expired park | `authRequired` → park | same | same | measured (fake) |
| Tokens | input, cached, output | same | same | measured (real) |
| Cost | unknown (no price published) | known | known | measured |
| Cache countdown and keepalive | none (no lifetime published) | 5 min / 1 h, keepalive | 30 min estimate | measured (no TTL); receipts only |
| Contributor mode | off per process, saved setting untouched | n/a | n/a | measured (real, incl. resume) |
| Account fallback on limits | opt-in per agent; registered Muse logins, then the user's own login, each offering the seat's exact model (pin included), passing every gate and proving room; keys only with the key switch, on their own catalog | same mechanism (the own login as a registered row) | same as Claude Code | measured (fake, with red controls); real untested (one account) |
| Placement and effort by the login | hire, rehire, switch, account move, a retool naming both, effort and pins judged by the seat's own login's catalog (with no account named, the login an account change queued behind a running turn lands on); unknown refused; every hire and settings surface offers what that login offers | same outcome (Claude Code's models are fixed) | same outcome | measured (fake, routes and rendered, with red controls) |
| Removing an account | a live seat moves to the own login, else to the first registered subscription login that offers its exact model, each passing every gate; never a key; with none it waits frozen saying why, its held request kept; queued intents follow; a released freeze's held request given back once; defaults to the own login | moves to the own login (which runs every tier) | same as Claude Code | measured (fake, with red controls from the exact reviewed ref) |
| Resume after changed folder grants | every turn carries the current roots | same outcome (folders given at each launch) | same outcome | measured (fake sticky-roots model, with red control); real untested |
| Credentials in the engine log | no raw MSP request or answer; safe method lines | not audited here | not audited here | measured (sentinels, verbose and quiet, with red control) |
| Continue on another login, `muse/primary` | only onto a login whose own catalog offers the seat's exact model (unknown refused, nothing changed); host restarts in that login's roots; session resumed if that login has it, else a new one with a handoff note; the choices list only such logins | same | same (new conversation) | measured (fake, with red controls); the real session store per login inferred |
| UI parity (hire, settings, Providers, Usage, colours) | yes | same | same | measured (rendered) |
| App theme preset | Muse Cyan; `#0077b0` accent on light surfaces | Claude Terracotta | Codex Teal | measured (rendered in four contrast themes; unit tests) |
| Granted folders' instructions (AGENTS.md, CLAUDE.md) | own folder's rules loaded by Muse; every granted folder's in the identity | same identity injection | same identity injection | measured (unit test) |
| Network for shell commands | Muse's own default (`proxy-only`); Orgtree sets no mode | Claude Code's own default | Codex's own default for the seat's sandbox | source: no lane gets a network mode; Muse's modes undocumented, untested |
| Effort names in tools (`orgtree_hire`, `orgtree_retool`) | all harness names, checked per tier | same | same | measured (unit tests) |

### What does not match, and why

1. **Cost is unknown** (vs Claude Code and Codex). Muse publishes no price.
   Impact: Usage shows tokens, not dollars, for Muse. Class: upstream
   unsupported. Closes when Muse publishes per-model prices.
2. **No cache countdown or keepalive** (vs Claude Code; vs Codex's estimate).
   Muse reports cache reads but no lifetime. Impact: the cache badge says the
   lane publishes no lifetime. Class: upstream unsupported. Workaround: none
   needed for correctness. Closes with a documented TTL.
3. **Sign-in is not verified by the app** (vs both). `muse login` shows a code
   the user must see, so it runs in a terminal and the user presses Refresh.
   Class: adapter choice on an unscripted CLI flow (the output format was not
   measured, since that needs a real sign-in). Closes with a measured
   machine-readable login, or one supervised real sign-in to measure it.
4. **Network for shell commands is Muse's default, whose meaning is not
   known here** (vs both, which also run their own defaults: Orgtree sets no
   network mode on any lane). Muse's command sandbox takes
   `--sandbox-network restricted|enabled|proxy-only` (default `proxy-only`).
   Orgtree passes no network mode to any lane, so Muse runs its default, and
   Muse documents no meaning for the values locally (help, schema, bundled
   skills); none was measured. `enabled` would widen what a seat may do
   (refused by the parity ruling); `restricted` would narrow Muse below the
   other lanes without a ruling asking for it. Impact: a Muse command reaches
   the network as `proxy-only` allows. Class: upstream undocumented,
   unverified. Closes with Muse's documentation or a measured probe of each
   mode, then a ruling mapping scopes to one.
5. **Read-only extra folders are approval-gated, not roots** (vs both, which
   pass them read-only). Muse gives every workspace root write access. Impact:
   reads there go through an approval the engine grants; Muse's own
   project-rule loading does not see them. Class: upstream unsupported.
6. **Muse itself loads only the primary root's rules file** (measured probe).
   Not a gap for the agent: Orgtree's identity carries every granted folder's
   AGENTS.md and CLAUDE.md for every lane under "STANDING INSTRUCTIONS from
   your granted folders", Muse included (unit test), and Muse loads the
   agent's own folder's file itself. Only where the guidance is loaded
   differs. Class: upstream behaviour, covered by the adapter.
7. **Untested here**: API-key accounts and a second real subscription account
   (missing credentials; a key would be paid), fallback on the real binary,
   a resume with changed folder grants on the real binary, images, real
   quota/auth/retry paths, subagents allowed by scope, compaction on the real
   binary, the real sign-in, each network mode, and what Muse itself writes to
   its stderr (relayed to the log a line at a time, as for other hosts).
   Class: unverified. Closes with authorized tests.
8. **Wonder Full shares the F letter with Flash and Fable** in the header's
   agent summary, told apart there by colour (as Fable and Flash already
   are). Class: existing design. Cards also carry the family rail.

## Files

Engine: `providers/{mod,muse_models,catalog,codex_models}.rs`,
`runtime/{muse,actor,identity,recovery,startup,freeze}.rs`,
`runtime/freeze/continuation.rs`, `usage.rs`, `accounts.rs`,
`account_marks.rs`, `org_accounts.rs`, `domain/{staffing,ops,templates}.rs`,
`http/{accounts,settings,nodes,docket,mod}.rs`, `tools/{defs,usage}.rs`. Desktop:
`apps/desktop/main/{providerlogin,index}.ts`, `packages/contracts/{index,visual-theme}.ts`,
`tools/generate-icon.mjs` and `apps/desktop/assets/orgtree-eye-tray-muse.ico`, the
renderer's `canvas/{shared,OrgCanvas,cards,modals,desk,accounts,accountsregistry,effortbar,effortlevels}`,
`App.tsx`, `api.ts`, `registrylabels.ts`, `usagehistory.tsx`,
`orgaccounts.tsx`, `QuickChatBox.tsx`, `shell/templatepicker.tsx`,
`canvas/{musehire,quickstaff,staffingoptions}.ts`,
`themes.tsx`, `styles.css`. Engine, round 2: `domain/account_removal.rs`,
`runtime/prompt.rs` (the phone-link authority tests on the Muse lane). Round 3:
`domain/{account_removal,tree,ops}.rs`, `runtime/freeze.rs`,
`runtime/freeze/continuation.rs`, `providers/mod.rs`, `accounts.rs`,
`http/{nodes,mailbox}.rs`, `feed/mod.rs`; the renderer's
`canvas/{modals,accountsregistry}.tsx` and tests `musequeued`, `museremoval`. Rig:
`tools/rig/fakecli/src/muse.rs`,
`proofs/muse-{lane,visual,real,r1,routes,placement,r2,ui-logins,r4-removal,r4-routes,held-replay,tool-silence}.mjs`,
`desktop/muse-{visual,effort,theme,logins}.cjs`, `up --real-muse`, `up --quiet-log`.
The tool-call stop: `runtime/{actor,muse}.rs`; the fake host's `task/stop`,
`task/list` and silent tool steps.
