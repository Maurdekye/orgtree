# pg-custodian (P03 WS1)

The one component allowed to create, start, stop and identify the private
PostgreSQL instance of the P03 prototype. Plan: `P03-PLAN.md` WS1; dev-cluster
interface: M1 interface contract §5 (p03-lead-opus55).

## Dev cluster (every P03 workstream)

```powershell
$env:CARGO_BUILD_JOBS = '4'
$env:CARGO_TARGET_DIR = "<your worktree>\artifacts\cargo-target"
powershell -File tools\p03\fetch-postgresql.ps1      # once per machine; verifies the pin
cargo run --manifest-path engine\native\pg-custodian\Cargo.toml -- dev up --agent <you>
cargo run ... -- dev env --agent <you> | Invoke-Expression   # sets P03_PG_*_URL
cargo run ... -- dev status --all
cargo run ... -- dev down --agent <you>                      # stop it when idle
```

- One cluster per agent at `<main checkout>\artifacts\p03-db\<agent>\`, a
  disposable prototype root (marker `orgtree-p03-prototype-root.json`).
- Port: FNV-1a of the agent name into 41000-48999. If it is occupied, `up`
  fails; it never connects to whatever is listening.
- Roles: `orgtree_admin` (superuser, migrations), `orgtree_runtime` (login
  only), `orgtree_repl` (login + replication). Database `orgtree`.
- URLs: `P03_PG_ADMIN_URL`, `P03_PG_RUNTIME_URL`, `P03_PG_REPL_URL`, of the
  form `postgresql://<role>:<password>@127.0.0.1:<port>/orgtree?sslmode=disable`.
  `pg_hba.conf` allows only `127.0.0.1/32` with `scram-sha-256`.
- Dev settings (not budgets): `shared_buffers` 64MB, `max_connections` 40,
  `max_prepared_transactions` 0, `wal_level` logical, 4 slots / 4 senders,
  `max_slot_wal_keep_size` 256MB.
- Starting and stopping needs no run lock; **running tests against it does**
  (`p03-run.ps1`).

## Safety properties

- **Root guard** (`src/guard.rs`): refuses any root without the marker, any
  root inside or containing live Orgtree data, `%APPDATA%\Orgtree v2`,
  `~/orgtree` or the installed app (checked on the typed path before any disk
  access and again after resolving junctions), UNC/device paths, and a marker
  copied from another folder.
- **Quarantined init**: the cluster is built in `pg/staging-<hex>/` and made
  current by one rename after `instance.json` is written. A kill before the
  rename leaves only debris that is never started.
- **Identity**: `identify` connects with `require_auth=scram-sha-256` and
  checks `system_identifier`, the `orgtree.instance_token` setting and
  `data_directory` against `instance.json`, then the readiness settings and
  role attributes.
- **Stop**: native `pg_ctl stop`, then waits on handles (opened before the
  stop) to the whole owned process family: postmaster, its descendants and
  the `cmd.exe` shim. Holding a handle pins the PID, so reuse cannot fake an
  exit.
- **Memory**: `init` and `start` refuse below 4 GB of free commit.

## Tests

- `cargo test` — guard and dev tests; no database.
- `cargo test --test smoke_cluster -- --ignored --test-threads=1 --nocapture`
  with `ORGTREE_P03_PG_BIN` set — real clusters; **run it under the P03 run
  lock**.
