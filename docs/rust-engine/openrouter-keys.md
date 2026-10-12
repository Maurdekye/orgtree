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

Global for every key: favorites and the Claude Code/Codex harness choice.

## API

All key endpoints are secret-free on the way out; a key crosses the wire once, inward.

| Method and path | What it does |
|---|---|
| `GET /api/openrouter` | The panel document. The top-level fields describe the original key, as before. `keys[]` lists every key (`id`, `lane`, `original`, `label`, `name`, `key_label`, `enabled`, `connected`, `reason`, `limits`, `observed_at`) and `any_key` says whether any is stored. |
| `PUT` / `DELETE /api/openrouter/key` | Unchanged: sets or forgets the original key. |
| `POST /api/openrouter/keys {key, label?}` | Adds a key and answers the document plus `added` and `added_lane`. With no original stored, the new key becomes the original. A secret already stored on another row is refused. |
| `PUT /api/openrouter/keys/{id or lane} {key?, label?}` | Renames a key (an empty label clears the name) and/or replaces its secret. |
| `DELETE /api/openrouter/keys/{id or lane}` | Removes a key. An added key goes through `account_removal`, so its agents, queued intents and defaults move to the original key first. Removing the original is the old `clear_key`. |
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

## Limits (inferred, not measured)

- Removing the original key while added keys remain leaves unbound seats with nothing to bill. Their
  next launch says the original was removed and asks for a move. New hires are placed on an added
  key. No automatic rebind happens, because the ruling keeps fallback opt-in.
- The cache forecast treats a key switch as an account change: a new cache namespace.
