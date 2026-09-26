# Building the bundled PostgreSQL runtime

The Windows v3 package carries its own PostgreSQL server and Python driver.
It does not download anything on first launch. A fresh installation creates
its database under the selected data root's `pg` directory; existing stores
stay on their current backend until an external cutover.

## Build inputs and assembly

Run these in the release checkout before building the desktop:

```powershell
git submodule update --init engine/mailhub
npm run runtime:provision
npm run postgres:provision
```

Python provisioning installs the binary psycopg wheel. PostgreSQL provisioning
downloads the pinned EDB 18.6-4 Windows x64 ZIP at build time, verifies its byte
count and SHA-256, extracts only `bin`, `lib`, `share` and the two supplied
license/notice files, and compiles the custodian with `cargo build --release
--locked --no-default-features`. Rust build products remain in ignored
`artifacts/postgres-provision/cargo`, outside the engine payload. No cluster,
service, desktop or installer is started by either provisioning command.

For an offline build with the already downloaded pinned ZIP:

```powershell
npm run postgres:provision -- --archive E:\path\postgresql-18.6-4-windows-x64-binaries.zip
```

An existing PostgreSQL tree is reused only if every file matches the archive.
An altered tree is refused, not merged or silently repaired. Reprovision after
native source changes: packaging compares the custodian's recorded source
hashes with the current checkout. The archive pin is in
`tools/postgres-runtime-pin.json`; its provenance is recorded in
`postgresql-qualification.md`. The hash is the reviewed archive fingerprint,
not a claim of an independently published vendor signature.

## Installed layout

| Path under `resources` | Contents |
|---|---|
| `engine/runtime` | Embedded Python and binary psycopg driver |
| `engine/postgresql` | PostgreSQL runtime and redistribution notices |
| `engine/pg-custodian.exe` | Custodian built without qualification features |
| `engine/postgres-runtime-manifest.json` | Archive pin, native source hashes and every payload file's size/hash |
| `tools/pypg/pgimport.py` | Offline import tool, used only by an external agent |

Package preflight verifies the manifest and refuses a missing, changed or
stale payload. The private-alpha and release verification paths also check
the packaged files and extracted installer payload. Build metadata includes
the PostgreSQL manifest, custodian and importer hashes. No PostgreSQL binary
is committed to Git.

The desktop always sets `ORGTREE_PG_CUSTODIAN`, `ORGTREE_P03_PG_BIN` and
`ORGTREE_PG_BOOTSTRAP=1` for a packaged launch. PG-1 owns backend selection,
fresh-root classification, product binding, cluster lifecycle and connection
details. Development can opt into executable locations with
`ORGTREE_DESKTOP_PACKAGED_PG=1`; that does **not** enable fresh-root bootstrap.

On every packaged launch the desktop records its selected installation/data
paths in `<userData>/engine-paths.json`. It contains no credentials or
connection string. The external cutover runbook uses this descriptor and the
packaged importer, so it needs neither a source checkout nor persistent
environment variables.

## Measured size and delivery boundary

The selected PostgreSQL tree is 148,180,024 bytes across 1,585 files. The first
custodian build adds 1,239,552 bytes. Psycopg and timezone files add 16,337,315
bytes, excluding bytecode caches: about 158.08 MiB combined installed.
The PostgreSQL files occupy 52,772,742 compressed bytes in the vendor ZIP;
this is not an NSIS installer-size measurement. The coordinator builds the
installer and measures that final difference. Source-side assembly and tests
do not install, restart or migrate the user's app.
