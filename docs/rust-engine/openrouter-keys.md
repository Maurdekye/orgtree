# Several OpenRouter keys at once

Docket: `use-several-openrouter-keys-at-once`.

Rulings:
- User, 2026-10-11 22:35Z: the multi-key package.
- User, 2026-10-11 22:50Z: every key can be switched off on its own.
- Coordinator: compatibility of ids and lanes (superseded below).
- User, 2026-10-14 18:00Z (docket `openrouter-keys-are-all-equal-no-unnumbered-prim`): every key
  is alike. No key is the original or the primary; every id is numbered. Migration 0021 renumbers
  the old first key.

## Model

Each OpenRouter key is a hidden registry row in `ot.accounts`: provider `openrouter`, kind
`apikey`. Its secret is in `ot.account_secrets`. Every key is alike:

| | Every key |
|---|---|
| registry id | `openrouter-N`, N from 1, never reused (`ot.removed_accounts`) |
| lane (allowlist, usage board, usage cache/history) | its id |
| how a seat binds to it | `account = openrouter-N`; a hire naming none is placed on a key and bound |
| account pickers | a row in `GET /api/accounts`, like every other key |

**The one symmetric default.** A seat with no OpenRouter key bound (`account` NULL, `primary`,
`default`, or a binding to another provider's login) bills the *first key in the key list*: the
registry order (`ord`, the order keys were added unless reordered), then the number in the id
(`openrouter::first_key`). Nothing depends on a key's id. New hires are not left unbound: a hire
naming no key (omitted, or the picker's `default`) is placed by the placement balancing
(`org_accounts::best_allowed`) and bound to the key it lands on.

**Migration 0021** (`migrations/0021_openrouter_numbered_keys.sql`, runs once, a no-op without an
`openrouter-key` row): the old first key `openrouter-key` (lane `openrouter`) becomes
`openrouter-1`, or the next number nobody used if 1 was taken. Every column of the row is copied
(its placeholder label "OpenRouter" dropped, it stays first in the key list) and its secret moves
with it. Every reference to either old name follows: agent bindings and queued intents
(`pending_account`, `pending_switch`), turns, usage history, marks and their audit, spend (merged),
org `default_account` and `disabled_accounts`, and the app default. Every OpenRouter seat that
billed it unbound is bound to it explicitly, so no agent changes key. The old names go into
`ot.removed_accounts`, so a stale reference to them is refused rather than stored.

Helpers:
- `openrouter::seat_key(engine, account)`: the key a seat bills; `openrouter::first_key(engine)`.
- `openrouter::keys(engine)`: every key in the key list's order.
- `org_accounts::lane_of(&AccountInfo)`: the canonical lane of any registry row (a key's id).
- `org_accounts::seat_lane(engine, tier, account)`.

Global for every key: favorites. Each key has its own harness (below).

## API

All key endpoints are secret-free on the way out; a key crosses the wire once, inward.

| Method and path | What it does |
|---|---|
| `GET /api/openrouter` | The panel document. `keys[]` lists every key alike in the key list's order (`id`, `lane` = the id, `label`, `name`, `key_label`, `enabled`, `connected`, `reason`, `limits`, `observed_at`, `harness`, `harness_installed`, `pinned_seats`) and `any_key` says whether any is stored. `connected` is whether any key is; `reason` is the first key's reason when none is; `credits` stays null (each key's standing is its row). Every key is read alike first: a `force` re-check reads them all at openrouter.ai, otherwise each reading is at most a minute old. `harness` is the machine's options (the registry's) and `stored`, the harness a new key gets. |
| `PUT /api/openrouter/key` | As before several keys, but only with no key stored: adds the key like `POST /api/openrouter/keys` (the 3.x import uses it). With keys stored it refuses (409): each key is edited by its id. |
| `DELETE /api/openrouter/key` | Removes every key, each through the same removal as `DELETE /api/openrouter/keys/{id}`. |
| `POST /api/openrouter/keys {key, label?, harness?}` | Adds a key as the next `openrouter-N` and answers the document plus `added` and `added_lane` (the same id). A secret already stored on another row is refused. |
| `PUT /api/openrouter/keys/{id} {key?, label?, harness?}` | Renames a key (an empty label clears the name), sets its harness and/or replaces its secret. A harness must be installed (400 otherwise). |
| `GET /api/harnesses` | The harness registry: every harness, what it is, whether it is installed here, its providers and how to install it. |
| ~~`PUT /api/openrouter/harness`~~ | Gone (2026-10-13): the harness is each key's own. |
| `DELETE /api/openrouter/keys/{id}` | Removes a key, any key alike (`account_removal::remove_key`; the registry's `DELETE /api/accounts/{id}` routes an OpenRouter key there too): every seat it bills (bound to it, unbound ones when it is the first key, queued intents naming it) moves to the first other key a continuation would accept, in key order; a live seat with none freezes (cause `account`) saying so; org and app defaults naming it are cleared. Its id is retired (`ot.removed_accounts`). |
| `PUT /api/accounts/{id}/enabled` | Switches one key. Re-enabling the first key also wakes the unbound OpenRouter agents (they bill it). |
| `GET /api/openrouter/keys/usage` | Every key's last reading by id, cache-only. |
| `GET /api/openrouter/usage` | Reads every key alike (cached unless `force`) and answers `{provider, available, keys: {id: reading}}`. |

A key's name is the user's label; else the label openrouter.ai reports for it (`key_label`, from its
last reading); else "OpenRouter key N".

## Usage

- `usage::openrouter_key_usage(engine, id, force)` reads one key and caches and records it under
  that key's lane. The inner `openrouter_key_read` is where the usage tool's probe reservation wraps.
- `usage::openrouter(engine, force)` reads every key alike (`refresh_openrouter`).
- The usage loop reads every key every 5 minutes and pushes `openrouter_keys_usage` (by id, with
  `name`) and `openrouter_usage_peek`, every key's cached limits together (whichever key is
  nearest a wall is what glows). No key has a reading of its own apart from the others.
- The prepaid balance (`total_credits − total_usage`) belongs to the OpenRouter *account*, so every
  key's row shows it labelled "account balance". Rows are not de-duplicated, because openrouter.ai
  does not say which keys share an account.
- For OpenRouter tiers, `reading_of`, `spends`, `at_limit`, `has_room` and `balance_reading` read
  the key's credit row. "At limit" means spend ≥ cap, or a spent prepaid balance (`is_active`).
  "Room" means not spent.
- The agents' PROVIDER USAGE board lists each key under its lane. The old duplicate roster entry
  "openrouter-key (API key, metered)" is gone.

## Placement

- **Hire:** an explicit key is validated against the org's lanes. An omitted account uses the org
  default when it is an OpenRouter key; otherwise (and for an explicit `default`/`primary`)
  `best_allowed` places the seat on the best key the org uses and binds it there. With none it is
  refused, saying so.
- **Templates:** an OpenRouter slot balances its keys like logins.
- **Staffing options:** each OpenRouter tier lists every eligible key alike (with `label`).
  `default_ok` (a hire naming no key) requires some key stored, active, used by the org and on an
  installed harness.
- **Fallback:** `pick_fallback` and `continue_candidates` include OpenRouter keys, so the existing
  opt-in fallback applies between keys. Nothing switches automatically beyond that setting.
- **Launch:** `openrouter_route` reads the seat's own key and refuses an inactive key, a lane the
  org switched off, or a key that is no longer stored, each with its own message.
- **Fallback eligibility:** an OpenRouter key passes the shared `continuation::resolve` check like any
  registry account (org allowlist, per-key switch, limits). `continue_on` takes an unbound seat's
  previous lane as the key it billed (`seat_lane`, the first key), so a move onto that key is not
  reported as a new cache namespace.
- **Usage reads:** `openrouter_key_usage` reserves the key's lane (one read per lane at a time);
  the usage tool's `refresh_permitted` already holds that permit and calls the inner reader with
  the key id (its lane).
- **Startup:** the 3.x import refreshes the providers' OpenRouter tiers itself, so a carried
  favorite is hireable before the first provider discovery finishes.

- **Secret replacement:** each replacement of a stored secret bumps the row's
  `extra.credential_gen` (never the secret). The actor's fingerprint `account` part carries
  `#credential-N` for the row the seat bills once N > 0, so a warm CLI (Claude Code or Codex
  harness) started on the old secret is replaced at the next turn boundary, never mid-turn. A usage
  read compares the generation before and after its request: an answer for a key replaced or
  removed meanwhile is never cached or recorded; it reads the stored key again (twice at most).
- **Duplicate secrets:** every key write locks the OpenRouter account rows (id order, bounded)
  and checks for a holder of the same secret inside its transaction, so two concurrent writes of
  one secret serialize and the second is refused (409).
- **Spent keys:** any OpenRouter credit row with `is_active` is at its limit, with or without a
  percent (a capped key whose account balance is zero reads under 100% of its cap).
- **Logging:** the readers (`openrouter`, `openrouter_key_usage`, `openrouter_key_read`),
  `GET /api/openrouter/keys/usage`, `keys_doc` and `openrouter::doc` are `#[nolog]`: a reading
  can carry the provider's own text. `openrouter_key_usage` logs one safe line (lane, available,
  whether an error/detail/re-auth is present) and `doc` one (key count, connected). The wire log
  omits the bodies of every `/api/openrouter` route but the catalog search (`/models`).
- **Shared paths:** the app feed (`AppFeed::set_value`, `AppFeed::snapshot`, the actor's
  `broadcast` and `snapshot`) and every HTTP handler serving a reading (`usage_*`, `peek_*`,
  `usage_all`/`one`/`registered`/`history`, the OpenRouter document's routes) are `#[nolog]` with
  safe lines (the value's key; a frame's type, seq and window count; "usage reading served" with
  the route). The wire log omits `/api/app/records` and every `/api` route with a `usage` segment.
  What windows receive is unchanged.
- **Startup:** the stored favorites become provider tiers before the first request on every start
  (`providers::refresh_openrouter` in `main.rs`), not only after the 3.x import.

## Harness per key

Rulings (docket `openrouter-choose-the-harness-claude-code-codex-p`): user 2026-10-13
19:04Z (per key), 19:08Z ("Agent's choice wins": a hire's harness pins the seat),
19:15Z (only installed harnesses, at every selector; App settings › Harnesses, placed
there by the coordinator).

- **Storage:** `ot.accounts.extra.harness` on each key row, a harness id (another
  harness is a registry entry, not a schema change). Every start, a key without one
  takes the old global `openrouter.harness` (`migrate_harnesses`); that setting now
  only seeds. A new key gets the harness named, else the first key's, else the
  seed (the first installed one when the seed is not installed).
- **Seats:** `ot.agents.extra.harness` is the harness the seat's session runs on;
  `extra.harness_pin` marks an explicit hire choice. `openrouter::seat_harness` is the
  single precedence point: pinned → the stamp, else the billed key's harness.
- **Turn boundary:** `start_turn`, under the agent row lock and before any mail is
  claimed, compares the stamp with `seat_harness`. A difference ends the session
  (`agent_sessions.end_reason = 'harness switch'`), sets `handoff_due` ("its OpenRouter
  key now runs on …"), moots its open asks, restamps, closes the CLI and retries
  admission; the next turn starts a fresh session with a summary. This is a new cache
  namespace. A running turn is never touched. Key moves (removal, fallback, an org
  switching a lane off) are covered by the same check.
- **Migration:** once (`ot.meta` `openrouter_harness_per_key_v1`), seats whose stamp
  differs from their key's harness are pinned, so the upgrade moves no seat.
- **Installed only:** `src/harnesses.rs` decides installed (the discovered file still
  exists, else the launch's lookup; nothing spawned). Key writes, the hire pin and
  language-server adds refuse a harness that is not installed. A saved choice since
  uninstalled is shown "not installed" and refuses its launch with that reason; the
  boundary does not cross to it, and nothing substitutes another harness.
- **Selectors (every place a harness is chosen):** the OpenRouter key dialog (add and
  edit, every key alike); the language-server add form (Harness, and Custom's
  API style); the hire/staff `harness` argument (orgtree_hire, orgtree_staff, the hire
  op). The Runtime tab's global row is removed. Each UI selector links to App
  settings › Harnesses.
- **What a UI picker lists (user 2026-10-13 22:20Z):** every supported harness, not
  only the installed ones: the installed ones first (registry order), then a disabled
  separator, then the ones not installed, greyed out and disabled, "(not installed)".
  One component, `HarnessOptions` in `canvas/harnesses.tsx`, draws every picker. A
  saved choice since uninstalled stays the select's value (in the second group) and
  is refused at launch; the engine still refuses a not-installed harness argument.
- **Model pickers (templates, Quick chat, hire menus, defaults):** they choose a model,
  not a harness; the harness follows the provider, key or server. Their one source,
  the staffing offers (`domain/staffing.rs`), offers an OpenRouter key only while its
  harness is installed, a hire naming no key only while some key it could be placed on has its harness installed, and a
  language-server model only while its server's harness is (registry check).

## Limits (inferred, not measured)

- The hire tools' `harness` enum stays static (claude-code, codex-cli) so the tool
  definitions do not change with what is installed; a pin naming one not installed is
  refused at the op with the reason. The new enum `description` changes the tool
  definitions once (a one-time prompt-prefix change for every agent).
- The first-key form (no key stored yet, `PUT /api/openrouter/key`) has no harness
  select: that key takes the seed, and its harness is changed in its settings dialog.
- A language server whose harness was uninstalled refuses its launch by source; the
  rig proof covers OpenRouter seats only.

- The private-text proof injects OpenRouter readings only; the Claude, Codex, Antigravity and
  Muse routes share the same `#[nolog]`/wire rule by source (inferred, not measured per provider).
- Original-key removal locks the key, then its seats, then the orgs whose default names it, like
  the registry's removal. Its late org scan is `FOR UPDATE NOWAIT`: an org-first writer (folder
  grants, settings) makes the attempt roll back whole and retry after 25/50/100 ms (55P03 with
  40001/40P01, four attempts); sustained contention refuses with nothing changed, never a wait
  while holding the key and seat rows. Eventual success under contention is not promised.

- The cache forecast treats a key switch as an account change: a new cache namespace.
