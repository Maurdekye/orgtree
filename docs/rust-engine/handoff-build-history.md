# Historical build/testing notes from the 2026-10-07 handoff

Preserved from [HANDOFF](HANDOFF.md) during the 2026-10-22 operating-rule audit.
These are obsolete procedures, not runnable current instructions. The retired
file lock, historical parallelism/target paths and Downloads copy do not apply.
The SAFE_START isolation claim below was superseded: see the current
[test-rig isolation contract](test-rig.md#what-keeps-it-safe). Current authorization and
resource/delivery policy come from the [rule homes](../agents/development-and-verification.md#current-operating-rule-homes).

## Building an alpha (how the rust-engine session did it)

Who builds from now on is the user's call (DECISIONS 37-38 gave it to the rust-engine session);
ask before building. The steps were:

1. Bump the version in `engine/rs/orgtree-engine/Cargo.toml` (and `Cargo.lock`), then in
   `package.json` and both top-level `version` fields of `package-lock.json`; commit the engine
   bump and the app bump separately (`Rust engine: version X`, `Orgtree X`).
2. Announce the build to the org before delivery, so agents commit and end their turns.
3. `bash tools/alpha-build.sh X "Orgtree Setup X.exe"` does the rest on the D: SSD (since
   2026-10-10; E: is slow). It waits for the machine-wide build lock in queue order, checks out
   the committed tip in the detached build worktree `D:\orgtree-work\worktrees\coordinator-build`
   (created when missing; `npm ci` when `package-lock.json` changed; `engine/runtime` and the
   PostgreSQL payload are staged once from a provisioned checkout, each with its own checks),
   and builds `--release --locked -j 2` into `D:\orgtree-work\cargo-target\<name>`: the engine
   with `ORGTREE_RELEASE_BUILD=1` and `ORGTREE_BUILD_COMMIT=<short sha>`, then the mail hub from
   the pinned `engine/mailhub`. It copies both to the fixed paths the packager reads
   (`engine/rs/target/release`, `engine/mailhub/target/release`; emptied first), checks their
   versions and the commit stamp, and runs `npm run package:win -- --publish never` with
   `ELECTRON_RUN_AS_NODE` cleared. Then it checks that the package carries exactly those exes and
   copies the installer to `E:\Libraries\Downloads`, comparing hashes. The log markers and the
   settings are in the script's header; `DRY_RUN=1` stops after the package preflight.
   By hand, do not skip the hub: `package:win` packages whatever exe sits in
   `engine/mailhub/target/release`, and the preflight checks only that the hub's *source* is
   pinned (alpha.4 shipped hub 2.0.0 while the pin was 2.0.3).
4. Tell the user.

## Testing notes

- A scratch engine on a copy of live data runs with `ORGTREE_ENGINE_SAFE_START=1`: no auto-wake,
  no hub hosting, no reading another data folder's sign-ins, no CLI warming. A fresh root needs
  `ORGTREE_ENGINE_ALLOW_INITDB=1`. Copies of live data follow DECISIONS 40 (own scratch only,
  deleted when done).
- An engine started with an empty `ORGTREE_V2_TOKEN` serves the UI to a plain browser or an
  Electron probe; AGENTS.md has the Electron probe trap (pass URLs through the environment).
- Verbose logging is on by default in development builds and off in packaged ones.
