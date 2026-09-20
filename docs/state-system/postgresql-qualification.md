# PostgreSQL candidate: source research and static archive inspection

Recorded 2026-09-20. The candidate for disposable qualification is PostgreSQL
18.6, EDB build 18.6-4, Windows x86-64. **It is not an adopted dependency or a
qualified runtime.** No archive executable was run; no driver, service, registry,
PATH, profile, deployment or release was changed.

## Release and distribution

The official support table lists stable 18.6 and support for major 18 through
2030-11-14. PostgreSQL 19 remains a development release in the captured pages.
Recheck minor/security status before adoption. [Version policy](https://www.postgresql.org/support/versioning/)

The official Windows page links EDB's binary archive route specifically for
including PostgreSQL in another application's installer. This supports the
approved private app-managed service approach. The general EDB installer's
administrator/Windows-service flow is a different deployment mechanism.
[Windows downloads](https://www.postgresql.org/download/windows/),
[EDB binaries](https://www.enterprisedb.com/download-postgresql-binaries)

The authorized listing URL
https://sbp.enterprisedb.com/getfile.jsp?fileid=1260566 redirected over HTTPS to:

https://get.enterprisedb.com/postgresql/postgresql-18.6-4-windows-x64-binaries.zip

| Observed archive fact | Value |
|---|---|
| HTTP response | 200; application/zip |
| SHA256 | 1df55002afe95b945d934c078b13e82c1603fa546731e511d068aa983b4ead28 |
| Download bytes | 382,815,572 |
| Files / uncompressed bytes | 20,502 / 1,004,378,762 |
| Binary architecture inspected | AMD64 PE, machine 0x8664 |
| Core executable version resources | 18.6 |

The observed hash pins the bytes inspected. It is **not an independently
authenticated vendor checksum**. An upstream detached signature/published
checksum has not been independently located in this inspection.

The complete archive includes pgAdmin and StackBuilder. Its full size is not a
claim about the eventual required runtime package. Do not silently adopt those
products or remove files before proving the chosen runtime/tool/data closure.

## Static signatures, dependencies and licenses

All 20,502 file contents were hashed through Python's ZIP reader, which checked
member CRCs while reading. FileVersionInfo and Get-AuthenticodeSignature inspected
219 extracted .exe/.dll PE candidates without loading or executing their code:
206 reported NotSigned, 13 Valid under this machine's trust state. This scope
excludes .pyd and other extension formats. Core postgres/initdb/pg_ctl/backup
executables report NotSigned; signed ancillary binaries do not sign the server.
Resolve the artifact verification policy before dependency adoption.

postgresql-qualification.json pins every pgsql/bin PE file's hash, version
resource, architecture, signature observation, normal and delay import names.
Static imports expose ICU, libintl, libxml2, LZ4, OpenSSL, Zstandard and Microsoft
runtime/system dependencies. Versions observed include ICU 77.1, OpenSSL 3.5.8,
LZ4 1.10.0 and Zstandard 1.5.7. A PE import table does not prove runtime
LoadLibrary/extension/data dependencies or that an OS DLL will resolve safely.
No imported dependency was executed or adopted.

The archive's server_license.txt contains the PostgreSQL license and is
separately hashed. PostgreSQL's published license permits redistribution under
its notice/disclaimer conditions. [PostgreSQL License](https://www.postgresql.org/about/licence/)

The archive's command-line third-party notice additionally identifies Zstandard
(BSD), gettext/libiconv/pthreads (LGPL 2.1), OpenSSL (Apache), LZ4, libpq,
libxml2/libxslt and zlib notices. This is evidence of obligations to inspect,
not blanket redistribution clearance. Map every file in the eventual selected
closure—including ICU and runtime redistributables—to its applicable notices,
source/redistribution requirements and supplied version. The selected-closure
license gate is still open. No binaries or third-party license bundle are added
to the repository by this package.

## Feed and lifecycle implications

18.6 documents output_plugin_libraries; explicitly permitting pgoutput only
concretizes the approved plugin allowlist. Protocol version 1 with streaming off
is a candidate for the initial committed-group consumer. Decoder compatibility
is untested. Keep the readiness assertions for logical WAL, publication/roles,
slot budget, protocol settings and max_prepared_transactions=0.
[18.6 release notes](https://www.postgresql.org/docs/18/release-18-6.html),
[Logical replication protocol](https://www.postgresql.org/docs/18/protocol-logical-replication.html)

max_slot_wal_keep_size defaults to unlimited and its finite limit is enforced at
checkpoints. idle_replication_slot_timeout defaults to disabled and addresses
inactive replication connections; it cannot alone bound connected stalled
consumers or snapshots. Keep checkpoint overshoot, projection-generation fencing,
slot drop, cancelled-snapshot cleanup and healthy-interval rebuild qualification.
[Replication settings](https://www.postgresql.org/docs/18/runtime-config-replication.html)

Minor upgrades normally avoid dump/reload but still require release-note actions;
major upgrades need a supported upgrade/export path. Required verified backups
before migration/upgrade and manual backups remain the chosen policy; no
periodic schedule is introduced.

## Platform and operational gates still open

The official Windows page lists Server 2025/2022 as tested for 18 and describes
comparable desktop support generally. This is not Orgtree desktop qualification.
EDB's non-ASCII warning concerns its installer; test actual ordinary-user,
Unicode/space-path archive behavior rather than imposing a new restriction.
[Windows installation guide](https://www.enterprisedb.com/docs/supported-open-source/postgresql/installing/windows/)

No latency, idle-memory, startup, crash, restore, upgrade, schema, native lock,
pgoutput, package minimization or supported-platform gate passed here. The v6
performance hypotheses still require measured adoption: eight-agent small
command/read p95 <=250ms, p99 <=1s; tree p95 <1s/p99 <3s; commit-to-paint p95
<=1s/p99 <=3s. Retain 1/4/8/11/16 concurrency, fixed offered demand,
10x unrelated-history and churn-then-settle controls. WAL/slot/snapshot/pool and
rebuild budgets must be chosen from P03 measurements, not inferred from archive
size or PostgreSQL's concurrency model.

The user has named the eventual combined PostgreSQL + Rust prototype
v3.0.0-alpha0. That is a future build identity, not permission to package,
install, publish or restart. state-io is reserved for its combined review.

## Evidence custody

The JSON record pins archive provenance, per-file manifest and PE observation
file hashes. These three detailed files and the static inspection scripts are
retained with this package's docket artifacts. Earlier immutable artifacts r6,
r7 and r8 on rearchitect-data-access-so-reading-one-thing-doe preserve the
pre-download research memo and dated primary-page captures; their “not
downloaded” statements describe that earlier research stage.

Source-page fingerprints are not binary hashes. Runtime census and conversion
authorization remain false independently of successful static inspection.
