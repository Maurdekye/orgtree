# Python removal

Orgtree carries no Python since 4.6.1. Phase 1 (2026-11-15) removed the
retired 3.x Python engine, tools and legacy tests. Phase 2 (2026-11-16) ported
or retired everything that was still live and dropped the bundled Python
runtime from the Windows installer and from CI. The Rust engine's and the
desktop's behaviour is unchanged, except where noted below.

## What replaced what

| Was | Now |
| --- | --- |
| `tools/installer-relaunch.py` under the bundled `pythonw.exe` | `orgtree-installer-relaunch.exe` (`engine/rs/orgtree-installer-relaunch`), a GUI-subsystem Rust helper shipped in `resources/engine` and run by `build/installer.nsh` from `$INSTDIR` |
| `engine/process_lifetime.py`, `engine/startup_progress.py` and the generated `launch.py` fixtures | the test-only `tools/test-native` crate's engine stub (`tests/engine-stub.mjs`), which the desktop supervisor tests hand `Engine` as its binary |
| `python -c` ctypes probes in tests (lock holders, alive checks, window hit tests, shell properties, dialog capture) | `tools/test-native` subcommands, located by `tools/native-test-bins.mjs` |
| `tools/worktree.py` | `tools/worktree.mjs` (+ `tests/worktree.test.mjs`) |
| `tools/provision-postgres.py` (+ `pg-custodian.exe`) | `tools/provision-postgres.mjs`; the PostgreSQL manifest is schema v2, and `pg-custodian.exe` is neither built nor shipped. `--rewrite-manifest` converts a v1 payload without re-downloading |
| `tools/source-audits.py --rust-only` | `node tools/project-reporting-guard.mjs --self-test [--json-output PATH]` |
| `tests/test_mailhub_repo.py` | `node tools/check-mailhub-repo.mjs` (by hand; the pinned hubtool suites are Python and stay with orgtree-mailhub) |
| `tests/fixtures/fake_*_login.py` | `.cjs` doubles; `providerlogin.ts` runs a `.cjs` double under `node` |
| `agentdrawerwidth_probe.py` (Playwright + Edge) | `apps/desktop/renderer/tests/agentdrawerwidth.capture.cjs` (Session 0 Electron capture) |
| `python3 -c` JSON one-liners in macOS/Linux CI | `node -e`/`node -p`, and `.github/ci/unix/smoke-json.mjs` |

## Retired without replacement

- The Python launch branch of `apps/desktop/main/engine.ts`: a managed start
  needs the Rust engine binary (`ORGTREE_ENGINE_BIN` in development).
- `tools/verification-receipt.py` with `engine/backend/orgtree/workevidence.py`
  and `workfields.py`, `tools/run-python-verification.py`, the `python-backend`
  suite of `tools/test-baseline.mjs`, `tools/provision-runtime.py`,
  `tools/verify-installed-runtime.py`, `tools/assert_repo_import.py`,
  `tools/test-startup.py`, the `tests/` Python package helpers, and
  `engine/__init__.py`.
- The 3.x acceptance harness (`tests/acceptance/`, `docs/v2-acceptance.md`,
  `tests/w07-acceptance-isolation.test.mjs`) and the paired boot probe
  (`tests/probe-boot-paired-root-only.ps1` and its preparation script and
  test), which needed the deleted Python engine.

## Kept on purpose

The 3.x process and task names in `tools/boot-engine-task.ps1` (the `$legacy`
`runtime\python.exe` + `service_host.py` matcher) and in
`tools/installer-upgrade.ps1` (`PYTHON.EXE`/`PYTHONW.EXE` in
`$script:TreeAmbiguousNames`) stay unchanged. They are string constants that
let a new installer recognise and stop an old 3.x Scheduled Task or engine
when it upgrades a 3.x install; no Python is involved.

The legacy SQL migrations live in `tools/rig/fixtures/pg_migrations_32/` for
the 3.2 rig; they are no longer packaged.

Historical guidance under `docs/agents/` still names some Python tools. Those
entries are hash-preserved records of the 3.x procedures, not instructions.

[decided: user 2026-11-15 (both phases); coordinator 2026-11-16 (Rust
test-native crate, relaunch helper in `$INSTDIR`, acceptance retirement,
pg-custodian removal)]
