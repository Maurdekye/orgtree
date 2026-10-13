# Several OpenRouter keys at once

Docket: `use-several-openrouter-keys-at-once`.

Rulings:
- User, 2026-10-11 22:35Z: the multi-key package.
- User, 2026-10-11 22:50Z: every key can be switched off on its own.
- Coordinator: compatibility of ids and lanes.

## Model

Each OpenRouter key is a hidden registry row in `ot.accounts`: provider `openrouter`, kind
`apikey`. Its secret is in `ot.account_secrets`.

| | Original key | Added key |
|---|---|---|
| registry id | `openrouter-key` (unchanged) | `openrouter-N`, N ≥ 2, never reused (`ot.removed_accounts`) |
| lane (allowlist, usage board, usage cache/history) | `openrouter` (unchanged) | its id |
| how a seat binds to it | `account` NULL or `primary` | `account = openrouter-N` |
| account pickers | `default` (`openrouter/primary`) | a row in `GET /api/accounts` |

Helpers:
- `openrouter::lane(id)` and `openrouter::id_of_lane(lane)`.
- `openrouter::seat_key(engine, account)`: the key a seat bills.
- `org_accounts::lane_of(&AccountInfo)`: the canonical lane of any registry row.
- `org_accounts::seat_lane(engine, tier, account)` and `org_accounts::default_lane(provider)`.

Global for every key: favorites. Each key has its own harness (below).

## API

All key endpoints are secret-free on the way out; a key crosses the wire once, inward.

| Method and path | What it does |
|---|---|
| `GET /api/openrouter` | The panel document. The top-level fields describe the original key, as before. `keys[]` lists every key (`id`, `lane`, `original`, `label`, `name`, `key_label`, `enabled`, `connected`, `reason`, `limits`, `observed_at`, `harness`, `harness_installed`, `pinned_seats`) and `any_key` says whether any is stored. `harness` is the machine's options (the registry's) and `stored`, the harness a new key gets. |
| `PUT` / `DELETE /api/openrouter/key` | Unchanged: sets or forgets the original key. |
| `POST /api/openrouter/keys {key, label?, harness?}` | Adds a key and answers the document plus `added` and `added_lane`. With no original stored, the new key becomes the original. A secret already stored on another row is refused. |
| `PUT /api/openrouter/keys/{id or lane} {key?, label?, harness?}` | Renames a key (an empty label clears the name), sets its harness and/or replaces its secret. A harness must be installed (400 otherwise). |
| `GET /api/harnesses` | The harness registry: every harness, what it is, whether it is installed here, its providers and how to install it. |
| ~~`PUT /api/openrouter/harness`~~ | Gone (2026-10-13): the harness is each key's own. |
| `DELETE /api/openrouter/keys/{id or lane}` | Removes a key. An added key goes through `account_removal`, so its agents, queued intents and defaults move to the original key first. Removing the original (`clear_key` → `account_removal::remove_original`) moves every seat it bills (unbound, bound to it, queued intents naming it) to the first other key a continuation would accept, in key order; a live seat with none freezes (cause `account`) saying so; org and app defaults naming it are cleared. Its id is not retired: a key added with none original stored is the original again. |
| `PUT /api/accounts/{id}/enabled` | Now also accepts `openrouter-key`. Re-enabling the original wakes the unbound OpenRouter agents. |
| `GET /api/openrouter/keys/usage` | Every key's last reading by lane, cache-only. |

A key's name is the user's label; else the label openrouter.ai reports for it (`key_label`, from its
last reading); else "OpenRouter key N".

## Usage

- `usage::openrouter_key_usage(engine, id, force)` reads one key and caches and records it under
  that key's lane. The inner `openrouter_key_read` is where the usage tool's probe reservation wraps.
- `usage::openrouter(engine, force)` is unchanged; it reads the original key.
- The usage loop reads every key every 5 minutes and pushes `openrouter_usage` (the original) and
  `openrouter_keys_usage` (by lane, with `name`).
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
  default when it is an OpenRouter key; otherwise the seat stays unbound (the original key). When
  the original is switched off for the org, or no longer stored, `best_allowed` places the seat on
  an allowed added key.
- **Templates:** an OpenRouter slot balances its keys like logins (`primary` is the original).
- **Staffing options:** each OpenRouter tier lists its eligible added keys (with `label`).
  `default_ok` requires the original key to be stored and active.
- **Fallback:** `pick_fallback` and `continue_candidates` include OpenRouter keys, so the existing
  opt-in fallback applies between keys. Nothing switches automatically beyond that setting.
- **Launch:** `openrouter_route` reads the seat's own key and refuses an inactive key, a lane the
  org switched off, or a key that is no longer stored, each with its own message.
- **Fallback eligibility:** an OpenRouter key passes the shared `continuation::resolve` check like any
  registry account (org allowlist, per-key switch, limits). `continue_on` takes an unbound seat's
  previous lane as `org_accounts::default_lane`, so a move to the original key is not reported as a
  new cache namespace.
- **Usage reads:** `openrouter_key_usage` reserves the key's lane (one read per lane at a time);
  the usage tool's `refresh_permitted` already holds that permit and calls the inner reader with
  the key id (`openrouter::id_of_lane`).
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
  only seeds. A new key gets the harness named, else the original key's, else the
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
  edit, original and added keys); the language-server add form (Harness, and Custom's
  API style); the hire/staff `harness` argument (orgtree_hire, orgtree_staff, the hire
  op). The Runtime tab's global row is removed. Each UI selector links to App
  settings › Harnesses.
- **Model pickers (templates, Quick chat, hire menus, defaults):** they choose a model,
  not a harness; the harness follows the provider, key or server. Their one source,
  the staffing offers (`domain/staffing.rs`), offers an OpenRouter key only while its
  harness is installed, a hire naming no key only while the original key's is, and a
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
