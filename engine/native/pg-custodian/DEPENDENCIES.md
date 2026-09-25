# pg-custodian dependencies

Every third-party crate this crate pulls from crates.io, pinned exactly in
`Cargo.toml`. Transitive crates are recorded in `Cargo.lock`. Authorized by
the P03 plan's Q2 ruling (Rust crates from crates.io, each listed here).

| Crate | Version | Licence | Purpose |
|---|---|---|---|
| `serde` (+ `serde_derive`) | 1.0.228 | MIT OR Apache-2.0 | Derive the on-disk JSON records: the prototype-root marker, `instance.json`, `runtime.json`. |
| `serde_json` | 1.0.150 | MIT OR Apache-2.0 | Read and write those records, and the CLI's JSON output. |
| `windows-sys` | 0.61.2 | MIT OR Apache-2.0 | Raw Win32 declarations (Microsoft): free-commit reading (`GlobalMemoryStatusEx`), process snapshot and exit waits for the owned-process-family check, `BCryptGenRandom` for passwords and tokens. Windows only. |

In-repo path dependency (not from crates.io): `orgtree-op-receipt-codec`
(`../op-receipt-codec`, and through it `../backend-codec`), for its
dependency-free sha256. It is the same implementation WS2's
`orgtree-store-schema` uses for migration checksums, so the runner and WS2
cannot disagree about a hash because of the hash code itself.

Not a Rust crate, but a runtime dependency: the EDB PostgreSQL 18.6-4 Windows
x64 binaries zip, SHA256
`1df55002afe95b945d934c078b13e82c1603fa546731e511d068aa983b4ead28`, 382,815,572
bytes (`docs/state-system/postgresql-qualification.md`). It is fetched by
`tools/p03/fetch-postgresql.ps1` into the ignored `artifacts/` folder and is
never committed. Its redistribution licence gate stays open until P10.
