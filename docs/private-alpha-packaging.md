# Private Windows alpha packaging

`3.0.0-alpha.0` is reserved for direct private delivery. It must never be a
public tag, GitHub release, or updater-feed entry. The ordinary
`release:windows` and release preflight refuse this version; other stable and
beta versions retain their existing behavior. The repository version remains
on the stable development line. Only the explicit private build overrides the
embedded package version and build-info version to exactly `3.0.0-alpha.0`.

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
cleanup. Launch-after-install is disabled.

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
