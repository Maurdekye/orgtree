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

## Focused verification

Routine release checks use the bounded selector below:

```powershell
npm run verify:release
```

Release tooling, receipt, and release-fixture changes select the focused release
and receipt checks. Installer or upgrade changes select the installer checks plus
the release checks. Application, engine, package, build, or unknown changes
escalate to the full Node and renderer suites. The selector prints its profile,
changed paths, reason, safety escalation, and gate actions before any check runs.

Source, version, build, artifact, and publication are separate gates. A passing
source receipt may be reused only when its profile, exact commands, tested source
scope, and byte-level source fingerprint all match. The candidate must match too,
unless Git proves the new candidate is a version-only commit. A version-only
commit is identified by comparing the Git contents of each changed package
version surface; editing any other package content escalates. Explicit
changed-path lists must exactly equal the Git diff, so omitting an affected file
cannot under-select tests. Version metadata, packaging, and publication
advancement do not by themselves rerun unchanged source checks.
Receipts include each command, captured output, per-check duration, total
duration, and the immutable receipt fingerprint. A changed or malformed receipt
is ignored and the relevant check runs again.

The practical unchanged-code target is the focused profile's measured duration,
recorded in its receipt on the Windows machine. Do not substitute a guessed
threshold for that measurement; a profile regression is visible in the receipt.

## Produce a candidate

```powershell
npm run release:windows -- <version>
```

The command derives its changed-file set from Git and runs the selected source
profile before building. A prior receipt may be supplied with
`--verification-receipt <path>`; it is reused only when the Git diff, tested
source scope and bytes, exact commands, and receipt fingerprint agree. The
canonical manifest records the receipt, so an unrelated standalone green run
cannot satisfy the release gate.

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

## Upgrade an existing desktop installation

The assisted Windows installer recognizes an existing Orgtree V2 installation
only when the application registry record, the matching uninstall record, and
the recorded executable and uninstaller files agree. New installs write the
`OrgtreeUpgradeMetadata=1` marker in both registry records. An older V2 install
without that marker is not guessed or modified; the installer presents the
ordinary full setup flow instead. If both per-user and all-users records are
valid, the installer also avoids guessing and uses the full setup flow.

For one-click upgrades, the wizard shows `Upgrade` as the primary action and
`Advanced setup` as the opt-out. `Upgrade` restores the recorded install scope
and directory, skips the mode and directory choices, and keeps existing
shortcuts, boot registration, and user-data locations. It requests a graceful
close by starting the installed executable with the private
`--installer-upgrade` control argument. The running app handles that argument by
quitting through a dedicated bounded graceful-only engine shutdown path; the
helper waits for the exact recorded executable to exit before file replacement.

Waiting for `Orgtree.exe` is not on its own enough, and 2.1.3-RC4 is why. The
engine runs from `<InstallDir>\resources\engine\runtime\python.exe` and starts
its own agent and MCP subprocesses, none of which is named `Orgtree.exe`, so
none of them was detected, asked to close, or verified as gone — while a
running image is exactly what Windows will not let the installer replace. The
helper therefore also waits for the whole installation tree: every process
whose image lives under the install directory, and every descendant of one. It
reports which processes are holding the upgrade rather than naming them
generically.

Two things make that a real check rather than a hopeful one. First, the tree is
read by an enumeration that reports parentage — CIM, falling back to WMI — and
if neither can answer, the helper says so and refuses instead of reporting a
quiet tree it could not actually see. A reading that cannot see descendants can
never establish that there are none. Second, the tree is recorded once before
the application is asked to close, and that recording does two jobs afterwards.
Every process it named must be observed to exit, and every id it named also
stays an ancestry seed for each later scan, whether or not that process still
exists. An engine process that starts a helper whose own image lives elsewhere —
an agent CLI, `node`, `uv` — and then exits leaves a child that no later scan can
otherwise connect to the installation, because its parent id points at a process
that is gone. That holds whether the child was started before the recording or
after it. A seed is only a seed: it is never itself reported as holding the
installation unless a scan actually observed it.

The installer still does not force-kill a process. A timeout, a
path-verification failure, a tree that cannot be enumerated, or a tree that does
not go quiet leaves the installation untouched and offers `Retry` or `Cancel`.

Elevation for an all-users upgrade happens when the install mode is selected,
which is where electron-builder elevates for every other all-users install, and
the window is hidden first. 2.1.3-RC4 instead called `UAC_RunElevated` from
inside an install section: that starts a second complete wizard and blocks the
first one waiting for it, and because the first window was still visible the
upgrade appeared to freeze on `Installing` at 3% with a second `Orgtree Setup`
window behind it. The elevated instance inherits the Upgrade selection from the
outer one, so the user is not asked the same questions twice. If elevation is
declined or fails, Setup stops and says so; it never continues without the
rights it needs to replace files.

The ordinary advanced and fresh-install paths retain electron-builder's normal
setup and running-app behavior. Finish-page launch behavior is unchanged: when
the user leaves the launch option selected, the upgraded installation starts
once with the normal update handoff.

### Where an upgrade shutdown is recorded

An installer-requested shutdown is written down on both sides. 2.1.3-RC1 failed
with three anonymous words — `Argument types do not match` — and neither side
had recorded anything that said which step produced them, so reading that dialog
correctly took two release candidates. The cause is fixed; this is so the next
unexpected failure costs one screenshot instead.

- **The installer's side** is `%TEMP%\orgtree-installer-upgrade.log`, passed to
  the helper as `-LogPath`. It lives outside `$PLUGINSDIR`, which the installer
  deletes on exit, so it survives the run. It records the arguments it was
  given, every step it entered, how many matching processes it found, the
  control process it started, and the outcome. When the helper fails, the
  message the user sees is prefixed with the step — `[detect-running-processes]`
  and so on — and names this file.
- **The application's side** is the existing `update-log.json` beside the other
  desktop state, using the `installer-upgrade-*` stages: the request arriving,
  being deferred until the engine is ready, the shutdown beginning, the engine
  stopping, completion, and refusal. A `startup` entry records how each run
  began — directly, by startup registration, or relaunched by the updater — so
  an upgrade that closed the application can be matched to whatever started it
  again. Only the instance holding the single-instance lock writes this file; a
  control invocation that finds a running application stays silent, because both
  processes rewriting it at once would lose entries.

### Verifying the close against a real running application

`tools/test-upgrade-close-boundary.mjs` is the only test that exercises the
place where a new installer meets an already-running installed application.
Every other upgrade test reads source text or re-implements the detection rules,
and none of them can see a helper that fails at run time. This one materialises
a disposable packaged copy of `tests/fixtures/legacy-desktop` — a process double
with its own application name, userData path and single-instance identity, so it
can never join or disturb an installed Orgtree — starts it, and runs the real
`tools/installer-upgrade.ps1` against it.

It needs an Electron runtime. It resolves one from the `electron` dependency, or
from `ORGTREE_ELECTRON_EXE` when that dependency has no downloaded binary, and
prints `SKIP` when neither is available. Two facts it pins down, both measured
rather than assumed:

- Two mechanisms an installer might reach for are not graceful closes for an
  application that does not understand the control argument. `WM_CLOSE`, which
  is what `taskkill` without `/F` sends, only hides the window to the tray and
  leaves the application and its engine running. An end-session message does end
  the process, but runs none of its shutdown handlers, so window layout is not
  persisted and the managed engine is stranded holding installed files.
- The helper runs under Windows PowerShell 5.1, which the installer invokes
  directly. `New-Object` on a quoted generic type name throws there, and the
  test's positive case fails the moment that construct returns.

Run it from a path without 8.3 short components: an Electron application started
from a short path does not receive second-instance notifications from a copy
started through the long path.

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
