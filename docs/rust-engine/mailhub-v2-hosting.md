# Hosting mail hub v2 in Orgtree 4.0.2

Status: BUILT on branch `mailhub-opus/4.0.2-hub-v2` (mail hub v2.0.0 Phase 2,
slice 8; docket item `mail-hub-v2-0-rewrite-in-rust-with-postgres-stor`). The
proposal below was approved as written on 2026-10-08 (coordinator, 16:17Z);
"As built" at the end records what was built and every place it differs.

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

## As built (Orgtree 4.0.2)

Rulings of 8 October that changed the proposal: mail is kept until its owners
delete it unless the user chose a number of days, and an idle address stays
listed. So the engine never passes `HUB_ORG_RETENTION_DAYS`, and passes
`HUB_RETENTION_DAYS` only when the user picked a number of days in App settings
→ Mail hub (the 36500-day "forever" is gone). Client scope for 4.0.2: reply_to
both ways (the org inbox panel's Reply and an optional `reply_to` on
`orgtree_message`), the person kind, long `@net:` mail fetched whole, and (user
request) the hub's version shown; not the directory search, not resumable
uploads (that waits for the transfers item).

**Engine** (`src/mailhub.rs`, `src/net.rs`, `src/domain/orginbox.rs`,
`src/domain/mail.rs`, `src/tools/`, `src/runtime/envelope.rs`):

- `mailhub::prepare_database` runs before the hub's first start: the role and
  database `orgtree_mailhub` (role password in `credentials.json`, made once and
  re-set if the role exists without it), `REVOKE CONNECT ON DATABASE
  orgtree_engine FROM PUBLIC`. A failure is shown on the settings page as the
  hub's error and never stops the engine.
- `hub_binary()`: `ORGTREE_HUB_BIN`, else `orgtree-mailhub.exe` beside the
  engine, else the submodule's own `target/release` build. The child gets the
  v1 variables plus `HUB_DATABASE_URL`, `HUB_DATABASE_PASSWORD` (environment
  only) and `HUB_DB_POOL=8`. `hosting()` adds `v2_import` (the hub's
  `v2-import-report.json`) and `status.hub_version`.
- Replies. `orgtree_message` takes `reply_to`: the id of mail the agent received
  or sent (every mail's FROM line now ends `· id <uid>`; `orgtree_inbox` lists
  them too) or of an outside message it sent. Internal recipients get the
  existing `↩ IN REPLY TO` quote and the typed `reply.mail` link; `@org:`
  recipients get the quote; over a hub the payload's `reply_to` is the answered
  message's hub id, when that message came over a hub (otherwise the agent is
  told the reply goes without a link). `POST /api/orgs/{slug}/org_inbox/send`
  takes `reply_to` (an org-inbox row id) for the panel's Reply. Inbound hub
  mail with `reply_to` is quoted from this org's own record of that message
  (`ot.org_inbox`, sent or received; two index-backed lookups), else kept as
  the bare reference; holders read "↩ IN REPLY TO your message …" when they
  wrote it. New column `ot.org_inbox.reply_to` (migration 0014).
- Long mail. When a v2 hub's poll gives a preview with `body_bytes`, the
  engine fetches `GET /api/messages/{id}/body` (the id as an encoded path
  segment): up to 64 KiB the whole text replaces the preview; above that it is
  attached as `message.txt` beside the 20,000-character preview. A failed fetch
  is noted in the body.
- The limit is per message on a v2 hub (`max_message_bytes`): a send whose
  text and files together exceed it is refused at once instead of retrying at
  the hub for ever.
- The hub's version: read from every answer that names a hub (register, poll,
  roster); shown per hub in the Connections data, by the address probe, and
  per remote peer in `orgtree_list_orgs` (`hubs`: address, name, version;
  "unknown" for a v1 hub).
- Rig: `ORGTREE_RIG_HUB=1` (`rig up --hub [exe]`) hosts the hub inside a rig
  run on a free loopback port; the run's network mail, the address probe and
  org deletion's unregister reach that hub and no other. Without it a rig run
  stays offline as before, and the probe answers "not reachable" without
  asking anything.

**Desktop:** the person kind labelled; the hub's version in Connections, the
mailservers tab, the status bar chip and App settings → Mail hub; the org
inbox's Reply on inbound outside mail, and the quote on rows that answer
something; the v2 import report and "Until it is deleted" retention wording.

**Packaging (needs the submodule pin moved to the v2 commit, the
coordinator's call):** `package.json` ships
`engine/mailhub/target/release/orgtree-mailhub.exe` as
`resources/engine/orgtree-mailhub.exe` and no longer copies the submodule's
sources; `package-preflight.mjs` requires that binary; `build.mjs` hashes it
into build-info; the submodule probes (`preflight-lib.mjs`,
`tests/test_mailhub_repo.py`) look for v2's files. Inferred, not run: no
package was built.

**Proof:** `tools/rig/proofs/mailhub-v2.mjs` (in `docs/rust-engine/test-rig.md`).
