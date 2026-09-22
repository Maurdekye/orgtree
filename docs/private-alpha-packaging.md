# Private Windows alpha packaging

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

## Private identity and checks

The package uses `com.maurdekye.orgtree.private-alpha`, product name
`Orgtree Private Alpha`, and runtime data directory `Orgtree v3 Alpha`.
The private identity is compiled into the main bundle, so absent or damaged
build-info cannot send it back to the stable application's data or updater.
Updates are disabled even if an update-fixture flag is requested. The builder
refuses update-fixture composition and uses the existing per-user installer
guard, which excludes machine-wide boot-task changes and stable shortcut
cleanup. Launch-after-install is disabled. The custom NSIS Finish page honors
electron-builder's `HIDE_RUN_AFTER_FINISH` flag: it compiles out the Run
control, upgrade relaunch callback, helper preparation, launch claims and
dispatch code. The stable and dev defaults retain their existing launch paths.

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

## Installation, user data and rollback

What the packaging configuration decides is tested at the config level: it
is checked through electron-builder's own GUID rule and the compiled
build-channel source, and no installer is run. The rest is stated as expected
behavior and remains open until the integrated candidate is qualified on a
real machine.

| Aspect | Private alpha behavior | Evidence |
| --- | --- | --- |
| Installed program | Per-user NSIS install named `Orgtree Private Alpha`, with its own Start-menu shortcuts. | Tested: product and shortcut names, `perMachine: false`. |
| Uninstall entry | Separate. The appId `com.maurdekye.orgtree.private-alpha` gives a different NSIS GUID, and so a different uninstall and install registry key from stable Orgtree. | Tested: GUIDs derived by electron-builder's rule differ. |
| Stable installation | Not replaced, upgraded, relaunched or uninstalled by the private installer. Both can be installed together. | Follows from the separate GUID and product name. Not exercised: the installer is never executed here. |
| Default install folder | electron-builder's per-user default, a folder named after the product (normally `%LOCALAPPDATA%\Programs\Orgtree Private Alpha`). | Not exercised. |
| Electron user data | `%APPDATA%\Orgtree v3 Alpha`, compiled into the private bundle, so missing build-info cannot fall back to stable. | Tested: compiled identity. |
| Backend data | `%APPDATA%\Orgtree v3 Alpha\data`. Stable data in `%APPDATA%\Orgtree v2` is not read or written by default. Nothing is imported from stable, so the private alpha starts with empty data. | Path derivation read from source. Not exercised. |
| Stable boot-task engine | Not adopted. The attach descriptor (`engine-attach.json`) is read from the app's own data root, so the private alpha attaches only to an engine serving `Orgtree v3 Alpha\data`. The private installer also leaves out the machine-wide boot-task changes (see above). | Read from source. Not exercised. |
| `ORGTREE_V2_DATA` override | **Refused for the private alpha.** The private build accepts this environment variable only when it is unset or names its own `%APPDATA%\Orgtree v3 Alpha\data` folder (any spelling of that same folder, including a junction to it, is accepted). Any other value, including stable's `Orgtree v2\data`, an empty value or a relative path, stops startup with "Orgtree could not start its engine." and a message naming both folders, before any engine is started or attached. Stable, dev-channel and unpackaged builds keep the override exactly as before. The rule is `resolveDataRoot` in `apps/desktop/main/policy.ts`, called from the engine options in `apps/desktop/main/index.ts`. | Tested: the rule with the real compiled identities, the real `index.ts` data-root expression, and a control showing the previous expression handed the private build stable's folder. The installed build is not exercised. |
| Updates | None. The updater is compiled off, no feed metadata is produced, and a stable 2.x installation accepts stable releases only. | Tested: identity, no-YAML scan, stable prerelease rule. |
| Later private alpha | A newer private installer with the same appId installs over the previous private alpha. Moving v3 data between alpha builds is not qualified. | Not exercised. |
| Running both at once | Separate names and single-instance locks. Running stable and private alpha at the same time is not qualified. | Not exercised. |
| Rollback | Uninstall `Orgtree Private Alpha` from Windows Apps. Stable Orgtree is untouched throughout. Uninstall keeps `%APPDATA%\Orgtree v3 Alpha` (`deleteAppDataOnUninstall: false`, as for stable); delete that folder by hand to discard alpha data. | Setting tested; uninstall not exercised. |

## Delivery evidence

Only the files named by `private-alpha-receipt.json` are for direct delivery:

- `Orgtree-Private-Setup-3.0.0-alpha.0.exe`
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
