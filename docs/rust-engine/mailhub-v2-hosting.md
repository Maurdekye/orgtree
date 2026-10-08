# Hosting mail hub v2 in Orgtree 4.0.2 — proposal

Status: PROPOSAL (mail hub v2.0.0 Phase 1, docket item
`mail-hub-v2-0-rewrite-in-rust-with-postgres-stor`). Nothing here is wired yet;
the item says to propose the hosting and leave it at that until Phase 1 is
reviewed. Branch: `mailhub-opus/4.0.2-hub-v2`.

## The problem

Orgtree 4.x hosts the mail hub as a child process: `python -m mailhub.serve`
from a bundled Python runtime (`resources/engine/runtime/python.exe`) and the
pinned `engine/mailhub` package, with its store in `<data>/mailhub`
(`hub.sqlite3` + `blobs/`), configured through `HUB_*` variables
(`engine/rs/orgtree-engine/src/mailhub.rs`). Mail hub v2.0.0 is one Rust
binary, `orgtree-mailhub`, that keeps its records in PostgreSQL and needs
`HUB_DATABASE_URL`. Orgtree already runs a PostgreSQL cluster of its own.

## The proposal

Host v2 the way v1 is hosted, on the engine's own cluster:

1. **The binary.** The installer ships `orgtree-mailhub.exe` beside the engine
   (`resources/engine/orgtree-mailhub.exe`), built in release mode from the
   pinned `engine/mailhub` submodule commit (`cargo build --release -p
   orgtree-mailhub` in the submodule; same toolchain as the engine).
   `mailhub::hub_runtime()` looks for it instead of `python.exe` + the
   package: next to the engine in a package, the submodule's cargo output in
   development, or `ORGTREE_HUB_BIN`. In the Rust engine only the hub hosting
   uses the bundled Python runtime (measured: `python.exe` appears only in
   `mailhub.rs`), so the packaging could drop that runtime — confirm nothing
   in the desktop or packaging scripts still needs it before removing it.

2. **Its own database and role.** Before the hub's first start the engine
   (which holds the cluster's admin role) creates, once:

   ```sql
   CREATE ROLE orgtree_mailhub LOGIN PASSWORD '<random 32 bytes hex>';
   CREATE DATABASE orgtree_mailhub OWNER orgtree_mailhub
       TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
   REVOKE CONNECT ON DATABASE orgtree_engine FROM PUBLIC;
   ```

   The password is stored with the cluster's other secrets
   (`pg/cluster/secrets/credentials.json`, key `orgtree_mailhub`). The hub
   cannot read or write the engine's database; the engine never needs the
   hub's. (The `REVOKE` is worth doing regardless: today any login role may
   connect to `orgtree_engine`.)

3. **The child process.** `start_now` spawns `orgtree-mailhub.exe serve`
   with exactly today's variables (`HUB_DATA=<data>/mailhub`, `HUB_PORT`,
   `HUB_BIND`, `HUB_NAME`, `HUB_RETENTION_DAYS` — 36500 for "keep forever",
   `HUB_ORG_RETENTION_DAYS`, `HUB_MAX_FILE_BYTES`,
   `HUB_RUNTIME_CONFIG_FILE=<data>/mailhub-upload-limit.json`, `HUB_PUBLIC`)
   plus:

   | variable | value |
   |---|---|
   | `HUB_DATABASE_URL` | `postgres://orgtree_mailhub@127.0.0.1:<cluster port>/orgtree_mailhub` |
   | `HUB_DATABASE_PASSWORD` | the role's password — environment only, never argv, never logged |
   | `HUB_DB_POOL` | `8` (the cluster runs with `max_connections=200`; the engine's pool keeps the rest) |

   `PYTHONPATH` goes away. Job object, log file (`mailhub/hub.log`, rotated
   at 5 MB), health wait, restart-on-settings and the error texts stay as they
   are; the hub's stdout lines are byte-compatible with v1's.

4. **The first start imports the v1 store.** With `HUB_DATA` unchanged, v2
   finds `<data>/mailhub/hub.sqlite3` and, because its database is empty,
   imports it in one transaction, keeps the SQLite file untouched, and writes
   `<data>/mailhub/v2-import-report.json`. Blobs are used in place. Org
   clients notice nothing: same addresses, fingerprints, queued mail, receipt
   states and attachment rights. `hosting()` should surface the report as a
   second line beside today's `data_migration` (`v2_import`: counts and any
   anomalies, e.g. NUL characters removed).

5. **Order and lifetime.** Already right: the cluster starts before
   `mailhub::start` and stops after `mailhub::stop`. Safe start keeps not
   hosting the hub. Settings, `/api/desktop/hub` and the tray line are
   unchanged.

6. **Rollback.** If v2 cannot start (binary missing, database error) the
   settings page shows the error as today. Because the v1 store is never
   changed, installing the previous Orgtree build brings v1 hosting back with
   its data as it was at the upgrade (mail that reached v2 afterwards is not
   in it).

7. **Backups.** Whatever backs up the cluster should include
   `orgtree_mailhub`; the blobs stay in `<data>/mailhub/blobs` as before.

8. **A real end-to-end proof.** The rig keeps `@net:` offline (safe start), so
   no rig proof has ever sent hub mail. With v2 hosted from the cluster, add a
   rig option that hosts the v2 hub inside the rig run and lets `net.rs`
   reach only that loopback hub, plus a proof: two rig orgs exchange `@net:`
   mail through it (register, long poll, ack, receipts in both directions,
   an attachment up and down, the 401 re-registration after a pruned roster).
   That is the "real Orgtree client against v2" check Phase 1 could only
   approximate (Phase 1 ran the exact request shapes `net.rs` sends, the v1
   comparison suite, and `hubtool.py` itself).

## Changes in Orgtree, by phase

**Phase 1 (this proposal).** No code. The hub branch is
`mailhub-opus/v2.0.0` in the orgtree-mailhub repository; the submodule pin is
not moved.

**Phase 2 (after review), on this branch, Orgtree 4.0.2:**

- the hosting above (binary lookup, database and role, environment, import
  report in the settings document, packaging), with the rig option and proof;
- the client side, as Orgtree uses each hubchat feature:
  - `reply_to` both ways, shown with the existing "↩ IN REPLY TO" quote;
  - the `person` client kind shown in rosters and `orgtree_list_orgs`;
  - long `@net:` messages without the 20,000-character cut (v2 Phase 2
    streams long bodies like attachments; Orgtree sends and receives them
    through the same streaming path as files);
  - the directory: `orgtree_list_orgs` and the compose picker search across
    every hub an org uses, server-side and paged, instead of whole rosters;
  - resumable transfers on agy-astra's transfer records (coordinated through
    the coordinator);
  - read receipts are already restored (`hub-mail-parity`).
- Orgtree stays a shared-secret v1 client: it does not become a "device" in
  the per-device key scheme unless asked.
