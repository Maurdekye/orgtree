# The mail hub: one source, two distributions

Orgtree's mail hub and the standalone `orgtree-mailhub` service are ONE
implementation. This document is the synchronization design: who is
authoritative, how a change flows into both distributions, how versions and
compatibility are represented, and how an emergency fix travels. It exists so
the two can never silently diverge the way the V1 and V2 hubs did.

## The authoritative source

**[github.com/Maurdekye/orgtree-mailhub](https://github.com/Maurdekye/orgtree-mailhub)
is the sole authoritative repository for shared mail-hub implementation and
contracts** — the server (`mailhub/`), the session-client tool
(`hubtool.py`), the wire protocol, the storage schema, the Docker assets,
and the characterization suites that define the contract
(`tests/test_hub.py`, `tests/test_hubtool.py`,
`tests/test_hubtool_migration.py`). Its provenance back to the Orgtree V1
baseline, and every intentional deviation from that baseline, are recorded
in its own `docs/PROVENANCE.md`.

Orgtree consumes it as a **Git submodule at `engine/mailhub`, pinned to an
exact reviewed commit**. What Orgtree keeps locally is only the thin adapter
the extraction ticket allows: `engine/mailhub_runtime.py` (settings storage,
desktop-engine lifecycle, V2-data migration), the org-side client
`engine/backend/orgtree/net.py` (the V1 client with two itemized integration
seams), and the UI.

Inside Orgtree the hub runs NATIVELY — the engine spawns the same
`python -m mailhub.serve` entrypoint the Docker image runs, configured by the
same `HUB_*` environment variables (user ruling 2026-09-15). Docker applies
only to the standalone distribution.

## How a change flows

1. A shared hub change lands in `orgtree-mailhub` first, with its suites
   green there (`test_hub.py`, `test_hubtool.py`, Docker verification via
   `tools/verify-docker.py` when transport or lifecycle changed).
2. Orgtree adopts it in a SEPARATE reviewed commit that moves only the
   submodule pointer (plus any adapter/UI work the change needs). A new
   upstream commit never changes an existing Orgtree build: the pin is the
   review boundary.
3. `tests/test_mailhub_repo.py` enforces the whole arrangement in Orgtree's
   own test run: the submodule must be present, clean, and exactly at the
   pin; no second tracked copy of hub-server logic may exist; and the PINNED
   product's own characterization suites are executed against the embedded
   checkout, so drift between "the hub upstream" and "the hub Orgtree ships"
   fails the build rather than shipping.

Manual source copying and build-time fetching of an unpinned revision are
not synchronization paths. There is nothing to copy: the submodule IS the
source, and packaging refuses anything else (below).

## Versioning, provenance, compatibility

- `npm run build` records BOTH revisions in `dist/build-info.json`: the
  Orgtree commit and `mailhubCommit`, the exact submodule revision packaged.
- Packaging preflight (`tools/package-preflight.mjs` →
  `assertMailhubSubmodule`) refuses an absent, uninitialized, dirty, or
  drifted submodule, and refuses a build whose recorded `mailhubCommit`
  differs from the checkout. Electron-builder ships `engine/**` wholesale,
  so the pinned files ride the installer with no fetch step.
- Wire compatibility is defined by the hub's own suites (the V1
  characterization baseline: 61 server checks + 36 client checks). The
  protocol is deliberately V1's: owned addresses (`X-Org-Auth`
  slug:secret pairs, sha256 fingerprints server-side), at-least-once custody,
  hub-clock ordering. Orgtree's org-side client suites
  (`tests/test_net_identity.py`, `tests/test_net_transport.py`) drive the
  REAL client against the REAL pinned hub app in-process, so both halves of
  the contract are exercised on every run.

## Emergency fixes

Same two steps, faster: fix and verify in `orgtree-mailhub` (its suites +
`tools/verify-docker.py`), then land the Orgtree pointer update. If Orgtree
cannot wait for upstream review, the fix STILL lands upstream first —
the pin move is one commit and `test_mailhub_repo.py` refuses local edits
under the pin (`+` or dirty submodule states fail), so there is no faster
path that leaves the two distributions consistent, which is the point.

## Clean clones

- `git clone --recurse-submodules` (or `git submodule update --init` after
  a plain clone) is part of the documented setup; a checkout without the
  submodule fails `test_mailhub_repo.py` and packaging preflight with
  instructions rather than building a hubless app.
- The standalone repository clones and runs independently:
  `docker compose up` per its README, verified end to end by its own
  `tools/verify-docker.py` (24 lifecycle checks including restart
  persistence and the public-listener split).
