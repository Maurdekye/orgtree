# Bundled mail hub 2.1.1

The alpha.11 installer at Orgtree `cedbe0d` still bundled mail hub 2.1.0 at
`fea34725c815840b404c3e7b2216afa161ad2f83`. This adoption moves only the hub pin
and the hosting proof's expected version, without changing Orgtree's adapter.
The already-delivered alpha.11 artifact remains unchanged.

## Canonical release and compatibility

The stable public [v2.1.1 release](https://github.com/Maurdekye/orgtree-mailhub/releases/tag/v2.1.1)
was published on 2026-10-11 at 09:52:46Z. Its annotated tag object
`87958fda2c36dd7f8aae0ac4598549f315008c5e` resolves to
`2c22e3d241169aac06f60ca90821bafe7b81131d`, confirmed against the canonical
remote. That is the new gitlink, not a floating branch reference.

The five-commit delta verifies recovered finalization bytes before publication,
protects active writers from expiry, and removes unpublished moved blobs on
cancel/expiry. Schema remains 9; there are no new routes or settings, and the
Cargo lockfile change is only the hub's own version. Upgrade from 2.0.x retains
the existing one-way schema-9 boundary and Orgtree's recorded no-automatic-backup
ruling. Upgrade from 2.1.0 needs no migration.

Orgtree's existing resumable client treats status GET 404/410 as a new upload,
and a 409 as a transient retry that probes the saved session again. A PATCH 410
is a held failure until explicit retry; that retry probes the now-absent session
and starts again. This pin does not change those existing client controls or
claim every damaged upload restarts automatically.

## Evidence and limits

New adoption checks verify the exact staged/committed gitlink, clean submodule,
crate version, and the production packaging pin guard. The guard must accept the
new exact pin and refuse a stale recorded 2.1.0 revision or a drift marker.
The hosted mail proof now requires 2.1.1 everywhere it checks a version.

Existing upstream release evidence was inspected and reused, not rerun here:
recovery tests 5/5, version responses 1/1, and same-database 2.1.0 to 2.1.1 and
back 18/18. The stable release also records full protocol and transfer checks.
Its Docker suite reached 50/57 before the v1-import health check timed out;
resource pressure is an inference, not a resolved failure. Linux directory
fsync after publication remains an upstream power-loss limitation. Neither is
hidden by this pin correction.

No new installer or live restart was performed for adoption. A subsequent
assigned build must rebuild the pinned hub and verify its packaged hash/version;
alpha.11's existing package receipt proves 2.1.0 only. The bounded source/pin
checks do not substitute for a new installed-package receipt.