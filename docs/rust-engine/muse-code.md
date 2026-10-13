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
(`session/resume`) and re-applies the seat's posture.

**Turns.** `turn/start` with the text, image parts (base64, capped as for
Claude) and the effort; mail that arrives mid-turn goes into the exact running
turn (`turn/steer` with `expectedTurnId`); an interrupt is `turn/interrupt`; a
turn Orgtree did not start is cancelled; a subagent the scope does not allow
is stopped (`subagent/stop`); `/compact` is `session/compact`. Items become
the conversation: agent messages, reasoning, tool calls (orgtree tools on
their chips), the todo list as the checklist chip.

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
its own reading. The user's own login is not a registry row (as for
Antigravity), so it is never an automatic target; `orgtree_continue_on` moves
an agent back to it. Then, only while "fall
back to Muse API-key accounts" is on (off by default, the same switch every
provider has), an API key whose own catalog offers that model; a key is
metered, so it needs no room proof, as for every provider. Room
(`usage::room_in`): an account-wide window from a login's metadata read counts
for every tier the login offers; a window observed under another model never
does. Each read is limited to 5 s (a real metadata read took about 0.4 s).
The agent then continues on that login (`continue_on`, the step every
provider uses): its host restarts in the new login's roots and asks to resume
its session; Muse keeps sessions under the login's own data root, so on
another login the session is expected to be missing, and the agent starts a
new one with Orgtree's handoff note (inferred: the fake shares one session
store, so the rig resumes). `orgtree_continue_on` also takes `muse/primary`.

**UI.** A Muse family in every hire surface, the agent settings model list,
quick chat and templates; the Providers row with its tiers and seats; a
Muse Code card in Usage; Muse in the usage title, glow and history. Colours:
`--prov-muse` `#afe5ff` (11.28:1 on `--panel`), rebound on the light surfaces
to the same hue at 34.6 % lightness, `#0077b0` (4.56:1 or more on every light
and solarized panel and background), with `--prov-muse-ink` for text on accent
fills. Tier colours: Wonder `#97edd0`, Wonder Full `#da8181`, Spark `#ffff7a`
(measured; see the stylesheet). Kept collisions, by decision: `#afe5ff` is
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

All on branch `muse-code-opus/muse-harness`, output under the agent's own build
root, every build/test inside the machine build lock and a kernel Job limit.

| What | Result |
|---|---|
| `cargo check --all-targets`; engine and fake CLI builds | 0 warnings |
| Engine unit tests (Muse, effort, staffing, usage incl. Muse room, accounts, identity, startup incl. granted folders' notes, tool definitions, catalog) | 66 passed |
| The identity group test `prompt_follows_every_combination_of_group_switches` | fails the same way on the exact bases `9fc30fb` and `67fc92e` as on this branch (measured); not caused here, so left out of the 66 |
| Renderer tests touching providers, accounts, usage, effort, tiers, themes (78 files) | 551 passed |
| Root tests: `providerlogin` (sign-in door), `themes` (presets), `icon-assets` (tray eyes) | 51 passed |
| Rig `muse-lane.mjs` on the fake `muse serve`, fallback and API-key fixtures included | 48 checks passed; red controls below |
| Rig `muse-visual.mjs`, the real renderer: cards in charcoal and light, Providers, Usage, the Muse Cyan theme in all four contrast themes, effort names | 24 checks passed; screenshots inspected |
| Rig `effort-selects.mjs` (existing effort UI) | 12 checks passed |
| Rig `muse-real.mjs` on the REAL Muse Code 1.4.6, the user's own login | see below |

**Red controls** (the same proof, run against an engine without the change):
without the Muse fallback five checks fail (the move to the profile, its
roots, the key seat's own roots, `muse/primary`, the key fixtures); without
the key's own-catalog check an agent is moved onto a key that lacks its model
and stranded there ("does not offer wonder"); without the pin a Spark 1.2
seat is moved onto a login that offers only Spark 1.3 and stranded the same
way. A first version of the pin fixture passed its red control too (that
login had no room for Spark anyway) and was replaced by one only the pin can
refuse.

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
Fallback, API keys and a second account were not run on the real binary
(one real account, no key: a key would be paid).

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
| Account fallback on limits | opt-in per agent; registered Muse logins only; each must offer the seat's exact model (pin included) and show room; keys only with the key switch, on their own catalog; the user's own login never an automatic target | same mechanism; the own login is a target once registered as an account | same as Claude Code | measured (fake, with red controls); real untested (one account) |
| Continue on another login, `muse/primary` | host restarts in that login's roots; session resumed if that login has it, else a new one with a handoff note | same | same (new conversation) | measured (fake); the real session store per login inferred |
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
7. **The user's own Muse login is never an automatic fallback target** (vs
   both: Claude Code's and Codex's own logins become targets once their
   default home is registered as an account; Antigravity is like Muse). A
   Muse login is two roots Muse lays out itself, so it cannot be registered
   as a folder. Impact: an agent on a profile at its limit does not move back
   to the user's own login by itself; `orgtree_continue_on` with
   `muse/primary` moves it. Class: adapter limitation. Closes with a ruling
   to offer the native login in the pick, or a registry row for it.
8. **The org account-list move's last resort does not ask a Muse login's
   catalog.** When an org switches a lane off (`org_accounts::leave`), the
   pick above runs first; its fallback steps ("any account that will take
   it", then the provider's own login) are the existing generic ones. A Muse
   seat moved there onto a login without its model is refused at launch with
   a clear error and its mail waits. Class: adapter limitation, left narrow.
9. **Untested here**: API-key accounts and a second real subscription account
   (missing credentials; a key would be paid), fallback on the real binary,
   images, real quota/auth/retry paths, subagents allowed by scope,
   compaction on the real binary, the real sign-in, each network mode.
   Class: unverified. Closes with authorized tests.
10. **Wonder Full shares the F letter with Flash and Fable** in the header's
   agent summary, told apart there by colour (as Fable and Flash already
   are). Class: existing design. Cards also carry the family rail.

## Files

Engine: `providers/{mod,muse_models,catalog,codex_models}.rs`,
`runtime/{muse,actor,identity,recovery,startup,freeze}.rs`,
`runtime/freeze/continuation.rs`, `usage.rs`, `accounts.rs`,
`account_marks.rs`, `org_accounts.rs`, `domain/{staffing,ops,templates}.rs`,
`http/{accounts,settings,nodes,mod}.rs`, `tools/{defs,usage}.rs`. Desktop:
`apps/desktop/main/{providerlogin,index}.ts`, `packages/contracts/{index,visual-theme}.ts`,
`tools/generate-icon.mjs` and `apps/desktop/assets/orgtree-eye-tray-muse.ico`, the
renderer's `canvas/{shared,OrgCanvas,cards,modals,desk,accounts,accountsregistry,effortbar,effortlevels}`,
`App.tsx`, `api.ts`, `registrylabels.ts`, `usagehistory.tsx`,
`orgaccounts.tsx`, `QuickChatBox.tsx`, `shell/templatepicker.tsx`,
`themes.tsx`, `styles.css`. Rig: `tools/rig/fakecli/src/muse.rs`, `proofs/muse-{lane,visual,real}.mjs`,
`desktop/muse-{visual,effort,theme}.cjs`, `up --real-muse`.
