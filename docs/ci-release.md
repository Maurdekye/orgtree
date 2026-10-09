# Releasing Orgtree with GitHub Actions

Orgtree's published builds come from GitHub Actions, not from anyone's PC. Pushing
a version tag builds the release on GitHub's free Windows runner and leaves a
**draft** release. A person checks the draft and publishes it. Nothing is ever
published automatically.

`release.yml` runs:

1. **resolve**: checks in seconds that the tag matches the version everywhere and
   that the release notes exist.
2. **windows** (`build-windows.yml`, windows-2025): builds and packages the release
   exactly as `npm run release:windows` does, with the same toolchain versions. It
   then runs the release tool's own artifact gates and a launch smoke on the runner.
   - The gates come from `tools/release-windows.mjs` itself: build provenance, the
     packaged and installer-payload runtime checks, latest.yml, and the canonical
     asset set.
3. **stage**: checks the asset set and writes `SHA256SUMS.txt`.
4. **draft**: `gh release create --draft` with the assets.

The draft holds the same six assets as every 4.0.x release, plus `SHA256SUMS.txt`:

| Asset | What it is |
|---|---|
| `Orgtree-Setup-<v>.exe` | the installer (not code-signed, like every release so far) |
| `Orgtree-Setup-<v>.exe.blockmap` | lets the updater download only what changed |
| `latest.yml` (`beta.yml` for a beta) | the updater feed: version, size and SHA-512 of the installer |
| `build-info.json` | version, commit, mail hub commit and input hashes of the build |
| `engine-hashes.json`, `packaged-hashes.json` | hashes of the engine sources and of the packaged runtime |
| `SHA256SUMS.txt` | the SHA-256 of every file above |

Orgtree needs no signing keys: the installer isn't code-signed, and the updater
checks the installer against the SHA-512 in `latest.yml`. GitHub's own per-run
token creates the draft.

## The test gate stays on the release PC

`npm run release:windows` starts with a test gate (`tools/release-verification.mjs`).
It compares the test suites against `docs/test-baseline.json`, and it refuses a
baseline recorded on another machine. A GitHub runner is always another machine,
so the gate can't run in CI. It runs on the release PC before the tag is pushed,
and CI does everything after it.

## Cutting a release

1. Bump the version in one engine commit and one app commit
   (docs/rust-engine/HANDOFF.md, "Building an alpha", step 1):
   - `Rust engine: version X`: `engine/rs/orgtree-engine/Cargo.toml` and `engine/rs/Cargo.lock`;
   - `Orgtree X`: `package.json` and both version fields of `package-lock.json`.
2. Add `docs/release-notes-X.md`; it becomes the draft's text.
3. On the release PC, from the release commit, run the test gate. If the baseline
   is older than 7 days, re-record it first (`node tools/test-baseline.mjs record`,
   then commit `docs/test-baseline.json`).
   ```
   node tools/release-verification.mjs
   ```
4. Push the release commit to `main`, then tag it and push the tag:
   ```
   git tag vX <commit>
   git push origin refs/tags/vX
   ```
5. The **release** workflow starts (about 15 minutes with a cold cache).
   - It refuses at once if the tag differs from `package.json`,
     `package-lock.json` or the engine's `Cargo.toml`, or if the notes file is
     missing.
   - Tags take the form `v4.1.0`, or `v4.1.0-beta.1` / `v4.1.0-alpha.1` for a
     prerelease. An `-RC` label is refused, as it is by the release tool.
6. A draft release `vX` appears. The run's summary lists each file's size and
   SHA-256.

## Checking and publishing the draft

```
gh release download vX -R Maurdekye/orgtree -D check-vX
cd check-vX && sha256sum -c SHA256SUMS.txt
```

- `build-info.json` must name the tag's commit, `channel: release` and
  `dirty: false`.
- Optionally install `Orgtree-Setup-X.exe` on a test machine first. Installing
  stops a running Orgtree.

Publish it:

```
# a stable release: it becomes "latest", which every installed Orgtree updates to
gh release edit vX -R Maurdekye/orgtree --draft=false --latest
# a beta: public, but not offered to stable installs
gh release edit vX -R Maurdekye/orgtree --draft=false --prerelease --latest=false
```

Publishing starts the **verify-release** workflow. It downloads every public asset as an installed app would and checks it against `SHA256SUMS.txt`, the updater feed and the tag, and it checks that GitHub's "latest" release is the right one. A red run means: roll back (below). To check a release again: `gh workflow run verify-release.yml -f tag=<tag>`.

## Rolling back

- **Before publishing**: delete the draft and the tag, fix, and tag again.
  ```
  gh release delete vX -R Maurdekye/orgtree --yes
  git push origin :refs/tags/vX
  ```
- **After publishing**: mark the previous release as latest. New update checks are
  then offered the previous version again:
  ```
  gh release edit v<previous> -R Maurdekye/orgtree --latest
  ```
  Installs that already updated stay on the new version (the updater doesn't
  downgrade); the fix for them is a new patch release.
- Never replace an asset of a published release: `latest.yml`, `packaged-hashes.json`
  and `SHA256SUMS.txt` would no longer match the installer.

## Test runs

A push to the branch `ci-test/orgtree-release` runs the whole pipeline as a test.
No release is created; the staged assets are the run's artifact.
`build-windows.yml` also runs on its own from a push to `ci-test/orgtree-windows`.
Once the workflows are on `main`, a manual run can test any tag or commit:

```
gh workflow run release.yml -R Maurdekye/orgtree -f ref=vX
```

## If GitHub disappears

The release tool is unchanged and still builds everything locally.

1. On a Windows PC with the pinned toolchains below, run the one-time
   provisioning:
   - `python tools/provision-runtime.py`, with
     `PIP_CONSTRAINT=.github/ci/windows/runtime-constraints.txt` so the Python
     runtime gets the same package versions;
   - `python tools/provision-postgres.py`.
2. Build the engine and the mail hub:
   ```
   cd engine/rs && ORGTREE_RELEASE_BUILD=1 ORGTREE_BUILD_COMMIT=<short sha> cargo build --release
   cd engine/mailhub && cargo build --release
   ```
3. Run `npm run release:windows -- X`. It writes the six assets to `release/upload`.
   Add `--publish` only when a GitHub repository exists to publish to.

## Toolchain pins

These are the versions the hand-built 4.0.x releases were built with. The CI uses
them exactly:

| Tool | Version | Where it's pinned |
|---|---|---|
| Rust | nightly-2025-12-12 (rustc 1.94.0-nightly f52090008) | `build-windows.yml` |
| Node / npm | 24.12.0 / 11.6.2 | `build-windows.yml` |
| Python (host, for provisioning) | 3.10.11 with pip 26.0.1 | `build-windows.yml` |
| Python runtime packages | the exact versions of the 4.0.1 runtime | `.github/ci/windows/runtime-constraints.txt` |
| Embedded Python / PostgreSQL | 3.13.15 / 18.6-4, by SHA-256 | `tools/provision-runtime.py`, `tools/postgres-runtime-pin.json` |
| Electron / electron-builder | from `package-lock.json` | `package-lock.json` |
| GitHub Actions | official `actions/*` only, pinned by commit SHA | every workflow |

The runner image is pinned by name (`windows-2025`). GitHub updates its contents
weekly; the toolchains above are installed explicitly.

## How a CI build compares with the hand-built 4.0.1

Run 37926248008 rebuilt the tag `v4.0.1` in CI and compared every file with the
published release. Its report is that run's `orgtree-windows-compare` artifact.

- `engine-hashes.json` is byte-identical.
- 13 of the 15 files in the installer are byte-identical. The other two are the app
  payload and the uninstaller, which the installer generates on every build.
- 3683 of the 3705 files in the app payload are byte-identical. No file is extra, and
  none is missing except two empty `REQUESTED` markers.

The 22 payload files that differ, and why:

| Files | Why they differ |
|---|---|
| `orgtree-engine.exe`, `pg-custodian.exe` | Rust embeds the builder's source and registry paths (inferred, not disassembled) |
| `postgres-runtime-manifest.json` | it records `pg-custodian.exe`'s hash |
| `app.asar`, `build-info.json`, `Orgtree.exe` | the build time (`builtAt`) is packed into `app.asar`; `Orgtree.exe` embeds the archive's integrity hash (inferred) |
| 5 Python launchers (`site-packages/bin/*.exe`) and their `RECORD` files | each launcher names the provisioning machine's `python.exe`; the app never runs them |
| `RECORD` of psycopg-binary and tzdata, `runtime-manifest.json` (order only) | the published runtime was provisioned with those two packages named explicitly, which the committed provisioning script doesn't do. Same 23 packages at the same versions and hashes |
| `engine/mailhub/.git` | a git pointer file that 4.0.x packages by accident; from 4.1.0 the packaging leaves the folder out |

The published metadata files differ only where their inputs differ. In
`build-info.json` that is `builtAt` and three hashes. In `packaged-hashes.json` it is
the hashes above and the installer's own hash.

Re-provisioning the Python runtime locally today gives CI's runtime, not the published
one: the provisioning script no longer produces the two `REQUESTED` markers.
