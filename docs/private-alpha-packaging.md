# 3.0.0-alpha.0 Windows packaging

`3.0.0-alpha.0` is reserved for direct private delivery. It must never be a
public tag, GitHub release, or updater-feed entry. The ordinary
`release:windows` and release preflight refuse this version; other stable and
beta versions retain their existing behavior.

On the private `v3/3.0.0-alpha.0` branch, `package.json` and both
`package-lock.json` version fields are exactly `3.0.0-alpha.0`. Stable main
keeps its own 2.x version. Setting the branch version closes the public paths
on this branch, not just for one command:

- `release:windows` refuses `3.0.0-alpha.0` itself, and refuses any stable 2.x
  target because the target must equal the package version. So v3 source
  cannot be released as a stable update from this branch.
- An ordinary `npm run build` records `3.0.0-alpha.0` on the release channel,
  so the `package:win` / `package:dir` preflight refuses to package it. Those
  paths would otherwise produce the stable identity (`com.maurdekye.orgtree`,
  `Orgtree v2` data, updater on).
- `package:dev` refuses, because a development version needs a plain `x.y.z`
  base. This branch has no dev-channel installer. The private packager is the
  only installer path.

The private build also stamps exactly `3.0.0-alpha.0` into the packed
`package.json` and `build-info.json`. `tests/private-alpha-identity.test.mjs`
drives every guard above with the real repository version.

## Inspect the plan without building

```powershell
npm run package:private-alpha
```

This prints the build configuration and commands. It writes nothing, packages
nothing, and does not run Git or contact a release service. `--publish`, tags,
version overrides, and arbitrary builder arguments are rejected.

## Final build gate

Do not run the build until the integrated candidate has passed the program's
independent combined review, migration/rollback checks, and qualification. This
preparation change is not that approval. The coordinator records the review in
a JSON file outside tracked source, using this schema:

```json
{
  "schema": "orgtree.private-alpha-approval/v1",
  "candidate": "<full 40-character integrated commit SHA>",
  "version": "3.0.0-alpha.0",
  "approved": true,
  "reviewer": "<independent reviewer>",
  "evidence": ["<combined-review receipt or docket evidence reference>"]
}
```

The approval is an operator record, not a cryptographic signature or an
automated re-evaluation of the cited evidence. Its candidate must match both
the explicit command argument and the clean checkout's HEAD. Existing
canonical source verification runs as an additional check.

Use a dedicated linked worktree with its own real `node_modules`, initialized
mailhub submodule at the reviewed pin, and a provisioned `engine/runtime`
validated by the existing runtime staging tools. Upward dependency resolution
is sufficient for the preparation tests, but the final package requires its
own dependency directory. `release-private-alpha` must not exist; the command
refuses to overwrite previous artifacts or partial results.

Only after integration approval:

```powershell
npm run package:private-alpha -- --build --candidate <full-SHA> --approval <approval.json>
```

The command builds a Windows x64 NSIS installer. It never executes the
installer, starts Orgtree, changes a running installation, publishes, creates
tags, or installs anything. Runtime import probes run the extracted Python
interpreter with the existing read-only import checks.

## Identity: the first v3 build replaces 2.1.12

The user decided on 2026-09-28 that the first v3 build REPLACES 2.1.12. The
user runs its installer by hand over the installed 2.1.12. It installs as the
normal "Orgtree" and uses 2.1.12's data folder. The earlier separate
"Orgtree Private Alpha" identity (its own appId, product name and
`Orgtree v3 Alpha` data folder) is gone.

The packager takes these values from `package.json` and refuses to package if
any of them differs from 2.1.12's (`RELEASE_IDENTITY` in
`tools/private-alpha-policy.mjs`). A different appId is a different NSIS
GUID, which would mean a second app beside 2.1.12 instead of an upgrade.

| Field | 2.1.12 (tag `v2.1.12`) | Private alpha, before | 3.0.0-alpha.0, now |
| --- | --- | --- | --- |
| appId | `com.maurdekye.orgtree` | `com.maurdekye.orgtree.private-alpha` | `com.maurdekye.orgtree` |
| NSIS GUID (install and uninstall registry key) | `21991930-a33d-57f0-b948-692a56fc3ca7` | a different GUID | `21991930-a33d-57f0-b948-692a56fc3ca7` |
| productName | `Orgtree` | `Orgtree Private Alpha` | `Orgtree` |
| Start-menu shortcut / folder | `Orgtree` / `Orgtree` | `Orgtree Private Alpha` | `Orgtree` / `Orgtree` |
| NSIS include | `build/installer.nsh` | `build/installer-dev.nsh` (per-user only, no boot task) | `build/installer.nsh` |
| perMachine / oneClick / change folder / keep app data | false / false / true / kept | same | same |
| Install folder | wherever 2.1.12 is (`%LOCALAPPDATA%\Programs\Orgtree` per-user, `%ProgramFiles%\Orgtree` all users) | `...\Orgtree Private Alpha` | reuses 2.1.12's |
| Electron userData (`app.setName`) | `Orgtree v2` | `Orgtree v3 Alpha` | `Orgtree v2` |
| Backend data root | `%APPDATA%\Orgtree v2\data` | `%APPDATA%\Orgtree v3 Alpha\data` | `%APPDATA%\Orgtree v2\data` |
| AppUserModelID / display name | `com.maurdekye.orgtree` / `Orgtree` | the private ones | `com.maurdekye.orgtree` / `Orgtree` |
| Updater | on (stable channel) | off | **off** |
| Launch at the Finish page | on | off | off |
| Version | 2.1.12 | 3.0.0-alpha.0 | 3.0.0-alpha.0 |
| Installer file | `Orgtree-Setup-2.1.12.exe` | `Orgtree-Private-Setup-3.0.0-alpha.0.exe` | `Orgtree-Setup-3.0.0-alpha.0.exe` |

The build still carries its compiled marker (`__ORGTREE_PRIVATE_ALPHA__`). The
marker is what keeps the updater off even if `build-info.json` is missing or
damaged. It also keeps every public release path refusing this build.
Because the installer uses the stable `build/installer.nsh`, an all-users
2.1.12 is upgraded the way a stable update would upgrade it. That includes
its boot-engine task, which the installer re-registers and starts at the end
of the install (see "First launch" below). With `runAfterFinish: false`,
electron-builder defines `HIDE_RUN_AFTER_FINISH`, and `installer.nsh`
compiles out the Run control and the upgrade relaunch.

`ORGTREE_V2_DATA` (a development override) is accepted by this build only when
it is unset or names `%APPDATA%\Orgtree v2\data` itself (any spelling of it,
including a junction). Any other value stops startup with "Orgtree could not
start its engine." before any engine is started or attached, and the message
names both folders. Stable, dev and unpackaged builds keep the override as
before. See `resolveDataRoot` in `apps/desktop/main/policy.ts`.

Updates stay off. Nothing about this build is published, and a stable 2.x
installation accepts stable releases only, so 2.1.12 is never offered it. It
cannot update itself back to 2.1.x either.

## First launch: the automatic conversion

On the first v3 start, a 2.1.12 data folder that is still on SQLite is
converted to PostgreSQL automatically (user decision 38, 2026-09-28). The
engine does the conversion (`engine/pg_process.py`, owned by
p03-ws1-pgservice). It runs in whichever process starts the engine first:

- the boot host, when 2.1.12 was an all-users install with the boot task. The
  installer starts it straight after installing, so the conversion begins
  before the user opens Orgtree;
- otherwise the desktop app, when the user first opens it.

The desktop's part (`apps/desktop/main/engine.ts`, `policy.ts`,
`conversion-window.ts`):

- **Visible.** While the engine reports a `database-convert` phase, a small
  window says that Orgtree is converting the data once, and shows the current
  step. When the desktop is waiting to attach to a boot host that is
  converting, it reads the same information from
  `<data>\conversion\current.json`.
- **Waits long enough.** The readiness window between checkpoints is 15
  minutes during a conversion phase, instead of 60 seconds. The attach wait
  keeps going for as long as `current.json` says `running` and its process is
  alive.
- **Fails clearly.** A `conversion-failed` refusal is never retried. Its
  reason, which names the log folder, is shown in the "Orgtree could not
  start its engine." dialog. A failure recorded in `current.json` during the
  attach wait is shown the same way.

A fresh install (no data folder) starts on PostgreSQL from the beginning
(user decision 2026-09-26).

## Publication and payload checks

Publish configuration is explicitly `null` at the root, Windows, and NSIS
levels, and the builder receives `--publish never`. Simply omitting a publish
setting would allow credentials in the environment to select a provider.
The output is scanned for stable, beta, alpha, and app-update YAML files;
finding one fails verification. Nothing stages an upload directory.

Verification checks the clean candidate, build-input hashes, exact packaged
package.json/build-info versions, and the compiled private marker. It compares
the installer ProductVersion text to `3.0.0-alpha.0`; Windows' numeric
FileVersion cannot carry a semver prerelease. It extracts the installer's
`app-64.7z` without executing the installer, verifies its actual ASAR and
build-info against the built output, checks the complete Python runtime tree,
and performs the existing runtime import probes. Extraction remains in the
private output directory for inspection.

## Rollback

Rollback is running 2.1.12's own installer (`Orgtree-Setup-2.1.12.exe`, from the GitHub release v2.1.12) over v3. `build/installer.nsh` has no version check that would refuse it. Nothing was verified by running an installer. After the first-launch conversion, the data has to be rolled back too (move `pre-postgres\orgs` back into `orgs` and remove `store-backend.json`); see the cutover runbook. Uninstall keeps `%APPDATA%\Orgtree v2` (`deleteAppDataOnUninstall: false`, as in 2.1.12).

## Delivery evidence

Only the files named by `private-alpha-receipt.json` are for direct delivery:

- `Orgtree-Setup-3.0.0-alpha.0.exe`
- `engine-hashes.json`
- `source-verification.json`
- `private-alpha-manifest.json`
- `private-alpha-receipt.json`

The manifest and receipt record the exact source commit, filename, byte size,
SHA-256, approval, source-verification fingerprint, and payload verification.
JSON uses sorted keys, two-space indentation, CRLF, and a final newline.
Identical artifact bytes and evidence produce identical manifests; this does
not claim independently rebuilt Windows installers are byte-identical.
`verifyPrivateDelivery(directory)` rechecks the delivered file hashes and
manifest identity without building or installing anything.

The coordinator must attach the integrated MVP's migration/rollback
instructions and precise remaining differences from the requested MVP when
delivering the installer. Source and payload checks do not prove the app's
integrated behavior. This preparation slice does not bundle a future Rust or
PostgreSQL runtime: that payload contract must be supplied and reviewed when
the integrated candidate is ready.
