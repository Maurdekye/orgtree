# Third-party dependencies of the P03 store crates

Every P03 crate locks the **same** version of each shared dependency (lead ruling, M1 §2 row 1). The versions below are the ones in `engine/native/store/Cargo.lock`. `orgtree-store-schema` has no third-party dependencies (it uses `op-receipt-codec`'s SHA-256).

Direct dependencies of `orgtree-store`:

| Crate | Version (locked) | Licence | Purpose |
|---|---|---|---|
| `tokio` | =1.52.3 (features `sync`, `time`, `rt`, `macros`; tests add `rt-multi-thread`) | MIT | async runtime: fair semaphore for the pool, timers for backoff, the driver's connection task |
| `serde` | =1.0.228 (`derive`) | MIT OR Apache-2.0 | command outputs are stored in and replayed from `operation_receipts.result` |
| `serde_json` | =1.0.150 | MIT OR Apache-2.0 | JSON value for receipts and `jsonb` columns |
| `uuid` | 1.26.1 (`v4`, `std`, `serde`) | Apache-2.0 OR MIT | immutable ids; minted operation keys (E4) |
| `tokio-postgres` | 0.7.18 (`runtime`, `with-uuid-1`, `with-serde_json-1`; no TLS: loopback only) | MIT OR Apache-2.0 | the PostgreSQL driver behind `Session`; SCRAM authentication |
| `bytes` | 1.12.1 | MIT | `ToSql` buffer type required by the driver's parameter trait |

Transitive dependencies are recorded exactly in `Cargo.lock` (notably `postgres-protocol` 0.6.12 and `postgres-types` 0.2.14, MIT OR Apache-2.0). The reviewer checks that other P03 crates lock the same versions of `tokio`, `serde`, `serde_json`, `uuid` and `tokio-postgres`.

In-repo path dependencies added by WS4 (no third-party code): `orgtree-funding-core` (`../funding-core`, the reviewed pure funding planner; the decide half of `reallocate`, the credit decision and preview, r7 C6), which brings `orgtree-backend-codec` and `orgtree-work-name-codec` by path.
