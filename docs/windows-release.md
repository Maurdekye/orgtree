# Windows release workflow

Windows releases used to depend on scratch scripts and remembered filenames.
The repository-owned `release:windows` command now builds one exact candidate,
derives the two release manifests, stages the updater names, and records the
installation handoff. The default command is local-only. It never tags, pushes,
publishes, installs, launches, stops, restarts, or deploys Orgtree.

## Prerequisites

Run the command from a clean private Git worktree based on the intended `main`
commit. The worktree must have its own real `node_modules`; do not run `npm ci`
or `npm install` through a junction to another checkout. The following must be
available before the command starts:

- Node.js and npm, with the lockfile dependencies installed in that worktree.
- A provisioned app-local Windows runtime under `engine/runtime/`. The embedded
  runtime must include `python.exe`, `python313.zip`, `python313._pth`, and
  `runtime-manifest.json`. Provision it with `npm run runtime:provision`, or
  copy the already-provisioned runtime into this private worktree without
  creating a link.
- A checked-in `docs/release-notes-<version>.md` file with non-empty content.
- A package version and both `package-lock.json` version surfaces that already
  equal the explicit target version. This command does not edit `package.json`
  or `package-lock.json`; make and commit the version/release-notes change
  separately first. The target may be a final `MAJOR.MINOR.PATCH` version or a
  release candidate in the exact `MAJOR.MINOR.PATCH-RCn` form, with `n` a
  positive integer without leading zeroes.
- A reachable `origin` remote and public GitHub API access. The command checks
  remote tag and release collisions and fails closed when it cannot establish
  that the target is unused.

The normal release remains unsigned. No signing credentials or signing step are
introduced by this workflow.

## Produce a candidate

```powershell
npm run release:windows -- <version>
```

The version is required and must be a final `x.y.z` semantic version or an
`x.y.z-RCn` release candidate. Before building, the command refuses a dirty
tree, version drift, missing release notes, a local or remote tag collision, a
public release collision, and missing runtime or packaging prerequisites.

Release candidates use `MAJOR.MINOR.PATCH-RCn` exactly, for example
`2.1.3-RC1`; successive candidates increment `n`. Final releases remove the
suffix and use `MAJOR.MINOR.PATCH`. The version is carried unchanged through
the application/build metadata, installer source name, hyphenated updater
asset name, manifests, and installation handoff. Do not use an ad-hoc filename
counter such as `-2` or `-3` as a candidate identity.

The build uses the existing `npm run package:win` path and always forwards
`--publish never` to electron-builder. Credentials in `GH_TOKEN`, a logged-in
`gh` CLI, or the package's GitHub configuration do not change this default.
The existing package preflight still checks the complete engine/runtime/UI
input set, release channel, build commit, clean tree, and build input hashes.

Successful output is under the ignored `release/` directory:

```text
release/
  Orgtree Setup <version>.exe
  Orgtree Setup <version>.exe.blockmap
  latest.yml
  win-unpacked/resources/
  engine-hashes.json
  packaged-hashes.json
  upload/
    build-info.json
    engine-hashes.json
    latest.yml
    Orgtree-Setup-<version>.exe
    Orgtree-Setup-<version>.exe.blockmap
    packaged-hashes.json
  release-manifest.json
  installation-handoff.json
```

`Orgtree Setup <version>.exe` and its blockmap are the untouched
electron-builder outputs. The files in `release/upload/` are byte-for-byte
copies. In particular, the spaced installer is not renamed in place: the
updater-facing copies use `Orgtree-Setup-<version>.exe`, exactly as `latest.yml`
references them.

The command verifies every staged file's size, SHA-256, and SHA-512. It also
checks `latest.yml`'s version, updater path, installer size, and base64 SHA-512
against the staged installer. It verifies the packaged resource hashes and the
build identity before writing the candidate manifest.

## Manifest rules

`engine-hashes.json` is a flat object containing every tracked
`engine/**/*.py` path except `engine/runtime/**`. Values hash the on-disk bytes
(including the repository's CRLF line endings), not Git's normalized blob. It
is serialized with sorted keys, two-space indentation, CRLF line endings, and a
final newline. Therefore, when no engine source bytes change, the generated
manifest is byte-identical to the predecessor's manifest; this invariant is
fixture-tested.

`packaged-hashes.json` has this exact top-level order and schema:

```json
{
  "commit": "<full 40-character SHA>",
  "version": "<version>",
  "files": {
    "app.asar": "<sha256>",
    "build-info.json": "<sha256>",
    "engine/runtime/python.exe": "<sha256>",
    "engine/runtime/runtime-manifest.json": "<sha256>"
  },
  "installerSha256": "<sha256>"
}
```

It uses two-space indentation, CRLF line endings, and a final newline. The
resource values hash the actual files under `release/win-unpacked/resources`.
Both manifests are generated by `tools/release-windows.mjs`; no scratch-only
derivation script is needed.

`release/release-manifest.json` has schema
`orgtree.windows-release/v1`. It records the full commit, version, `v<version>`
tag, checked-in notes path, all six staged asset names and paths, byte sizes,
SHA-256/SHA-512 values, the spaced source installer name, and the hyphenated
updater name. `release/installation-handoff.json` has schema
`orgtree.windows-installation-handoff/v1` and carries the same identity plus
the installer hash and the read-only verifier command for the coordinator.

## Explicit publication

Only the explicit flag enters publication:

```powershell
npm run release:windows -- <version> --publish
```

The candidate is built and fully verified before any tag or GitHub mutation.
Publication then:

1. Rechecks that the local tag, remote tag, and public release are absent.
2. Creates the lightweight `v<version>` tag at the exact candidate commit and
   pushes only that tag.
3. Creates a GitHub draft release from the checked-in release notes and uploads
   the complete six-file canonical asset set.
4. Promotes the draft to a normal, non-prerelease Latest release.
5. Downloads every uploaded asset through its public release URL and verifies
   the names, metadata sizes, bytes, SHA values, build identity, updater
   `latest.yml`, tag target, release state, and `/releases/latest` result.

The public verifier does not treat `target_commitish: "main"` as the commit
proof. It resolves the public tag reference and requires its final commit SHA
to equal the candidate SHA. It also requires exactly the six canonical assets;
an installer uploaded with spaces or an omitted `latest.yml` fails verification.

The GitHub release configuration comes from `package.json` and must name the
`Maurdekye/orgtree` repository. A GitHub token or logged-in `gh` CLI is required
only for this explicit phase. The command never replaces an existing release
or silently accepts a partial asset set. It does not auto-delete a GitHub
release after a failed CLI call: a network or process error can be ambiguous
about whether a draft was created, so deleting by tag could remove a
pre-existing private draft. If a failure occurs after the tag push, inspect the
remote tag and any draft before retrying. If public verification fails after
promotion, treat the release as unverified and do not claim that installation
is safe until the coordinator resolves the reported mismatch.

## Installation and live verification boundary

The command stops after candidate production or public verification. It does
not run the installer, answer UAC, start or stop the desktop, restart the
engine, or inspect live user data. The installation owner should use
`installation-handoff.json` to carry the exact version, commit, installer hash,
and staged/public installer name into those separate actions.

The handoff's verifier command is intentionally read-only:

```powershell
python tools/verify-installed-runtime.py `
  --repo-root <checkout> `
  --data-root <isolated-data-root> `
  --runtime-root <installed-resources-engine-runtime> `
  --json-output <receipt.json>
```

For a desktop-owned engine, the endpoint and token must come from the desktop
launch handshake. A persisted port file is not an identity proof. A successful
package or public-release check is not live runtime evidence.
