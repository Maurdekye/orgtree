# Releasing Orgtree with GitHub Actions

Orgtree's published builds come from GitHub Actions, not from anyone's PC. Pushing
a version tag builds Windows, macOS and Linux on GitHub's free runners and leaves a
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
3. **macos** (`build-macos.yml`, macos-15) and **linux** (`build-linux.yml`,
   ubuntu-22.04): the unsigned macOS and Linux prototypes, each with a launch smoke
   on its runner. See [macOS and Linux](#macos-and-linux-prototypes).
4. **stage**: checks the whole asset set and writes `SHA256SUMS.txt`. Every
   platform must build; a release never goes out with one silently missing.
5. **draft**: `gh release create --draft` with the assets.

The draft holds the same six Windows assets as every 4.0.x release, the macOS and
Linux files, and `SHA256SUMS.txt`:

| Asset | What it is |
|---|---|
| `Orgtree-Setup-<v>.exe` | the Windows installer (not code-signed, like every release so far) |
| `Orgtree-Setup-<v>.exe.blockmap` | lets the updater download only what changed |
| `latest.yml` (`beta.yml`/`alpha.yml` for a prerelease) | the updater feed: version, size and SHA-512 of the installer |
| `build-info.json` | version, commit, mail hub commit and input hashes of the build |
| `engine-hashes.json`, `packaged-hashes.json` | hashes of the engine sources and of the packaged runtime |
| `Orgtree-<v>-arm64.dmg`, `Orgtree-<v>-arm64.zip` | macOS (Apple Silicon), the same app as a disk image and as a zip |
| `Orgtree-<v>.AppImage`, `orgtree_<v>_amd64.deb` | Linux (x86_64): a portable AppImage and an Ubuntu/Debian package |
| `build-info-macos.json`, `build-info-linux.json` | the macOS and Linux builds' `build-info.json` |
| `SHA256SUMS.txt` | the SHA-256 of every file above |

Orgtree needs no signing keys: the installer isn't code-signed, and the updater
checks the installer against the SHA-512 in `latest.yml`. The macOS app is only
ad-hoc signed and the Linux packages are unsigned. GitHub's own per-run token
creates the draft. The Windows log still prints `signing with signtool.exe` for every
file: electron-builder 26 logs that line before it finds there's no certificate, so
nothing is signed (inferred from its source; measured: the CI installer's files
match the unsigned 4.0.1, see the comparison below).

## What the Windows launch smoke proves

After the release tool's gates, the Windows job installs and starts the build on the
runner (measured in every green run since 37934531288):
- The installer installs silently, per user.
- The installed engine starts as a throwaway standard user on an empty data root,
  creates its PostgreSQL cluster and answers.
- The installed desktop app starts under a non-admin token, starts its own engine,
  mail hub and PostgreSQL, and stays up. Its engine answers, token-guarded as it
  should be.

The smoke avoids admin rights because PostgreSQL refuses to start under an elevated
token, and GitHub's Windows runners are elevated.

It doesn't prove anything about the UI, sign-in or agent turns, upgrading from an
older version, auto-update or uninstalling.

Open finding: the desktop app started as a separate standard user, not the
installing user, exits with code 1 within about 3 seconds and prints nothing
(measured in every Windows run since 37929303118). A likely cause is that a process started with other
credentials from the runner's service session can't use the interactive desktop
(inferred, unverified). A real install runs as the user who installed it, so this
is probably a limit of the test setup.

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
5. The **release** workflow starts. It takes as long as the slowest platform plus
   about a minute to stage: about 15 minutes. Measured with warm caches in run
   37952302570: Windows 12.6 minutes, macOS 9.9, Linux 9.8. With cold caches, allow
   about 16 minutes per platform (measured: Windows 14.9, macOS 13.3, Linux about 16).
   - It refuses at once if the tag differs from `package.json`,
     `package-lock.json` or the engine's `Cargo.toml`, or if the notes file is
     missing.
   - Tags take the form `vX.Y.Z`, or `vX.Y.Z-beta.N` / `vX.Y.Z-alpha.N` for a
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
- The macOS and Linux files are prototypes. Their launch smokes passed on the
  runners; opening them on a real Mac or Ubuntu PC is optional.

If one platform's build fails, "Re-run failed jobs" on the run; stage and draft
follow once it passes. To release without a platform, remove its job and its file
names from `stage` in `release.yml` in a commit, and tag that commit. Never add or
remove assets of a draft by hand: `SHA256SUMS.txt` would no longer match.

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

## macOS and Linux (prototypes)

The macOS and Linux builds are "untested builds, but builds nonetheless". On GitHub's
runners the app builds, starts its engine and its bundled PostgreSQL, and answers; the
background engine starts under launchd or systemd; and hired agents on all three CLI
lanes use their Orgtree tools, with the rig's fake CLI standing in for each CLI.
Nobody has run them on a real Mac or Ubuntu PC yet.

**macOS** (`Orgtree-<v>-arm64.dmg` or `.zip`): Apple Silicon only. The app is ad-hoc
signed and not notarized, because notarization needs a paid Apple Developer account.
- On first open, macOS says it can't verify that Orgtree is free of malware.
  - macOS 15 and later: click Done, open System Settings → Privacy & Security, click
    "Open Anyway" (it asks for an administrator password), then open Orgtree again.
  - Older macOS: right-click the app → Open.
  - Or, after copying the app to Applications, run
    `xattr -dr com.apple.quarantine /Applications/Orgtree.app` once.
- Data folder: `~/Library/Application Support/Orgtree v2` (Electron's default,
  inferred).

**Linux** (x86_64): Ubuntu 22.04 or newer, or Debian 12 or newer. It is built against
Ubuntu 22.04's glibc 2.35 (inferred).
- `.deb`, the recommended install: `sudo apt install ./orgtree_<v>_amd64.deb`, then
  start Orgtree from the app menu. This is how the runner installs it: apt pulls in
  its dependencies, and the installed app ran with Chromium's sandbox on (measured on
  Ubuntu 22.04). `chrome-sandbox` is not setuid, so the sandbox uses unprivileged user
  namespaces. On Ubuntu 24.04 the package installs the AppArmor profile that allows
  them (inferred, not run).
- AppImage: `chmod +x Orgtree-<v>.AppImage`, then run it. It needs FUSE 2:
  `sudo apt install libfuse2` (Ubuntu 22.04) or `libfuse2t64` (24.04). Without it,
  run `./Orgtree-<v>.AppImage --appimage-extract-and-run`. The runner used
  extract-and-run, so the FUSE route is inferred. On Ubuntu 24.04 the AppImage
  probably also needs `--no-sandbox`, since it can't bring an AppArmor profile
  (inferred); use the `.deb` there.
- For a prerelease such as `X.Y.Z-beta.N`, Debian's version inside the package reads
  `X.Y.Z~beta.N`; the file name keeps the hyphen.
- Data folder: `~/.config/Orgtree v2`, or under `$XDG_CONFIG_HOME` if that is set
  (measured on the runner).
- No 3.x data import: the Linux build ships no Python runtime, which the import
  needs.

**Agents' Orgtree tools** (both platforms): Claude Code and Codex agents get them over
the CLI's own stdio, as on Windows. Antigravity agents reach them through the tool
bridge (`orgtree-engine mcp-bridge`), which here is a Unix socket in a private folder
(0700, the socket 0600): `<data>/bridge`, or a folder under `$XDG_RUNTIME_DIR` or
`$TMPDIR` when that path is too long for a socket address (decision 66). Antigravity
runs its hooks through a shell; a hook path a shell would split (the data folder is
`Orgtree v2`) runs from a 0700 copy in a space-free private folder. Each CLI runs in
its own process group: killing, interrupting or retiring an agent's CLI signals the
whole group (SIGTERM, then SIGKILL 3 s later), and so does letting go of a closed CLI,
as dropping its job does on Windows. `orgtree-engine serve` stops cleanly on SIGTERM,
SIGINT or SIGHUP, as the background host does: its agents settle, their CLIs end, and
its hosted mail hub stops.

**Background engine** (both platforms): the installed app registers it at every launch
(`apps/desktop/main/unixboot.ts`): a LaunchAgent
(`~/Library/LaunchAgents/com.maurdekye.orgtree.engine.plist`) on macOS; a systemd user
unit (`~/.config/systemd/user/orgtree-engine.service`) on Linux, or an XDG autostart
entry where `systemctl --user` doesn't answer. It runs `orgtree-engine host`, and the
desktop attaches to it. Its PATH is the user's login-shell PATH (`$SHELL -ilc` and
`$SHELL -ic`, read with a clean environment) ahead of `~/.local/bin`,
`/opt/homebrew/bin` (macOS), `/usr/local/bin` and the system folders, so CLIs installed
with nvm, volta, an npm prefix, bun or Linuxbrew are found. A changed PATH or app
location rewrites the registration at the next launch and restarts the engine onto it
(inferred from code). If registration fails, the app starts its own engine as before,
with the PATH it was opened with; a macOS app opened from Finder gets a minimal one
(inferred).

**What every macOS and Linux build proves** (after packaging, on the packaged engine):
- Engine unit tests: `cargo test --release -p orgtree-engine --bin orgtree-engine --
  bridge:: runtime::agy:: winproc::`; each of the three areas must run a test.
- Background engine (`.github/ci/boot-engine-smoke.mjs`): register, start, answer for
  its data folder, stop. A stand-in `codex` that only the login shell's PATH finds
  (`~/.npm-global/bin`, set in the shell's profile by `.github/ci/unix/login-shell-cli.sh`)
  must show as installed at that path. Linux runs it for the `.deb` layout and the
  AppImage. On the runner `systemctl --user` answers once lingering is on, so the
  autostart fallback is not exercised.
- Agents (`.github/ci/unix/agent-tools-smoke.sh`, data folder `<tmp>/Orgtree v2`): one
  hired agent per CLI lane (Claude on haiku, Codex on luna, Antigravity on flash; the
  rig's fake CLI found the way the engine finds the real ones) makes a real
  `orgtree_status` call. A lane passes only if the tool answered and the engine then
  reports that status. Without the Unix bridge the Antigravity lane fails (measured:
  "the tool bridge needs Windows named pipes").
- An Antigravity agent without shell rights has `run_command` denied by its
  PreToolUse hook.
- A child that a CLI starts is gone within 20 s when its agent is retired mid-turn, when
  its idle agent's process is stopped, and when the engine gets SIGTERM mid-turn.
- The hosted mail hub answers `/healthz` (a failure there is a warning). After SIGTERM
  the engine exits by itself, its hub is gone and its port free, and a second start on
  the same data folder hosts the hub again.
- Every app smoke (AppImage, `.deb`, the macOS app) ends with SIGTERM to the engine
  (macOS: `launchctl bootout` of the background engine first) and requires no hub left
  running and port 7370 free (`.github/ci/unix/hub-gone.sh`).

**Not there yet** (both platforms):
- No automatic updates. The app doesn't offer them on macOS or Linux; download each
  new version by hand.
- No Git credential bridge: the exchange answers "unavailable" outside Windows. Agents
  run as the user and use the user's own Git credential helper (inferred).
- No Claude usage readings on macOS: `usage.rs` reads the token from
  `~/.claude/.credentials.json`, and Claude Code on macOS keeps it in the Keychain
  (inferred). Hiring is unaffected: the account email in `~/.claude.json` counts as
  signed in.
- No phone setup: it opens a Windows firewall rule, so macOS and Linux leave it out.
- Linux, from its port's list: also no "Run as administrator", tray left-click list,
  taskbar attention icons, `pid:N` process watchdogs, or memory floor for warming
  CLIs. These are gated off, not deleted.
- macOS only: if the engine is killed, its PostgreSQL keeps running until the next
  start. Linux stops it with the engine (measured).

## Test runs

A push to the branch `ci-test/orgtree-release` runs the whole pipeline as a test.
No release is created; the staged assets are the run's artifact.
Each `build-<platform>.yml` also runs on its own from a push to
`ci-test/orgtree-windows`, `ci-test/orgtree-macos` or `ci-test/orgtree-linux`.
Once the workflows are on `main`, a manual run can test any tag or commit:

```
gh workflow run release.yml -R Maurdekye/orgtree -f ref=vX
```

A manual run is always a test, even one started from a tag: only a pushed tag
makes a release.

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
4. macOS and Linux: on an Apple Silicon Mac, or an Ubuntu 22.04 PC, follow the steps
   of `build-macos.yml` or `build-linux.yml` in order. They use only the pinned
   toolchains below and the scripts in `.github/ci/macos` or `.github/ci/linux`.

## Toolchain pins

These are the versions the hand-built 4.0.x releases were built with. The CI uses
them exactly:

| Tool | Version | Where it's pinned |
|---|---|---|
| Rust | nightly-2025-12-12 (rustc 1.94.0-nightly f52090008) | `build-windows.yml`, `build-macos.yml`, `build-linux.yml` |
| Node / npm | 24.12.0 / 11.6.2 | the same three |
| Python (host, for provisioning) | 3.10.11 with pip 26.0.1 | `build-windows.yml` |
| Python runtime packages | the exact versions of the 4.0.1 runtime | `.github/ci/windows/runtime-constraints.txt` |
| Embedded Python / PostgreSQL (Windows) | 3.13.15 / 18.6-4, by SHA-256 | `tools/provision-runtime.py`, `tools/postgres-runtime-pin.json` |
| PostgreSQL (macOS) | EDB's 18.6-4 binaries zip, by SHA-256 | `.github/ci/macos/postgres-pin.json` |
| PostgreSQL (Linux) | 18.6, built from the upstream source tarball, by SHA-256 | `.github/ci/linux/build-postgres.sh` |
| Electron / electron-builder | from `package-lock.json` | `package-lock.json` |
| GitHub Actions | official `actions/*` only, pinned by commit SHA | every workflow |

The runner images are pinned by name (`windows-2025`, `macos-15`, `ubuntu-22.04`).
GitHub updates their contents weekly; the toolchains above are installed explicitly.
The Linux build uses Ubuntu 22.04, the oldest supported runner, so the AppImage
should run on Ubuntu 22.04 and newer (it needs at least 22.04's glibc; inferred).

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
