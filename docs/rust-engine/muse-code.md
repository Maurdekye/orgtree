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
(`XDG_CONFIG_HOME` / `XDG_DATA_HOME`); an API-key account runs with
`META_API_KEY`; importing a folder is refused (a Muse login is two roots Muse
lays out itself). Sign-in runs Muse's own `muse login` (a code approved in the
browser) in a visible terminal the desktop opens, like Antigravity's, and the
user clicks Refresh; identity comes from `account/read`, never the auth file.
Automatic account fallback does not apply to Muse.

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

## Verification

All on branch `muse-code-opus/muse-harness`, output under the agent's own build
root, every build/test inside the machine build lock and a kernel Job limit.

| What | Result |
|---|---|
| `cargo check --all-targets`; engine and fake CLI builds | 0 warnings |
| Engine unit tests (Muse, effort, staffing, usage, accounts, identity, tool definitions, catalog) | 64 passed |
| Renderer tests touching providers, accounts, usage, effort, tiers, themes (77 files) | 545 passed |
| `tests/providerlogin.test.mjs` (the sign-in door) | 40 passed |
| Rig `muse-lane.mjs` on the fake `muse serve` | 39 checks passed |
| Rig `muse-visual.mjs`, the real renderer, charcoal and light | 20 checks passed; screenshots inspected |
| Rig `effort-selects.mjs` (existing effort UI) | 12 checks passed |
| Rig `muse-real.mjs` on the REAL Muse Code 1.4.6, the user's own login | see below |

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

## Parity with Claude Code and Codex

"Same" means Orgtree behaves for the user as it does on that harness.

| Feature | Muse lane | vs Claude Code | vs Codex | Evidence |
|---|---|---|---|---|
| Subscription sign-in, user's own login | yes | same | same | measured (real) |
| Isolated managed profiles | own config/data roots per account | same idea | same idea | inferred from code; no second real account |
| API-key accounts | `META_API_KEY` per account | same | same | untested (no key; paid) |
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
| Account fallback on limits | not offered | offered | offered (new conversation) | by design |
| UI parity (hire, settings, Providers, Usage, colours) | yes | same | same | measured (rendered) |
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
4. **No automatic account fallback** (vs both). Muse accounts are not switched
   on limits. Class: adapter omission by design (team rule: account fallback
   off). Closes with a ruling to add it.
5. **Read-only extra folders are approval-gated, not roots** (vs both, which
   pass them read-only). Muse gives every workspace root write access. Impact:
   reads there go through an approval the engine grants; Muse's own
   project-rule loading does not see them. Class: upstream unsupported.
6. **Only the primary root's AGENTS.md is loaded** (measured probe). Class:
   upstream behaviour. Workaround: the identity carries Orgtree's instructions.
7. **Untested here**: API-key accounts and a second real subscription account
   (missing credentials; a key would be paid), images, real quota/auth/retry
   paths, subagents allowed by scope, compaction on the real binary, the
   real sign-in. Class: unverified. Closes with authorized tests.
8. **Wonder Full shares the F letter with Flash and Fable** in the header's
   agent summary, told apart there by colour (as Fable and Flash already
   are). Class: existing design. Cards also carry the family rail.

## Files

Engine: `providers/{mod,muse_models,catalog,codex_models}.rs`,
`runtime/{muse,actor,identity,recovery}.rs`, `usage.rs`, `accounts.rs`,
`account_marks.rs`, `org_accounts.rs`, `domain/{staffing,ops,templates}.rs`,
`http/{accounts,settings,nodes,mod}.rs`, `tools/{defs,usage}.rs`. Desktop:
`apps/desktop/main/providerlogin.ts`, `packages/contracts/index.ts`, the
renderer's `canvas/{shared,OrgCanvas,cards,modals,desk,accounts,accountsregistry,effortbar,effortlevels}`,
`App.tsx`, `api.ts`, `registrylabels.ts`, `usagehistory.tsx`,
`orgaccounts.tsx`, `QuickChatBox.tsx`, `shell/templatepicker.tsx`,
`styles.css`. Rig: `tools/rig/fakecli/src/muse.rs`, `proofs/muse-{lane,visual,real}.mjs`,
`desktop/muse-{visual,effort}.cjs`, `up --real-muse`.
