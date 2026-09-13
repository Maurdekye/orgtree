# Orgtree 2.1.3-RC2

This is the second release candidate for Orgtree 2.1.3, and it replaces
2.1.3-RC1. The installer is unsigned, as earlier Orgtree releases have been.

## Why this candidate replaces RC1

RC1's one-click upgrade path could not close a running Orgtree. The installer
starts `tools/installer-upgrade.ps1` through Windows PowerShell 5.1, and the
helper used a construction that throws there before it inspects any process, so
every invocation failed immediately with `Argument types do not match`. The
upgrade never reached the point of asking the application to quit. RC2 fixes
the helper so it runs under the interpreter the installer actually uses.

Anyone running RC1 should install RC2. RC1 is obsolete and should not be used.

## Changes since RC1

- The installer's graceful close now runs. `tools/installer-upgrade.ps1`
  constructs its collection through the type itself rather than through
  `New-Object` on a quoted generic type name, which is not supported in Windows
  PowerShell 5.1. It also no longer assigns to `$matches`, an automatic
  variable.
- A new regression, `tools/test-upgrade-close-boundary.mjs`, exercises the
  place where a new installer meets an already-running installed application.
  It builds a disposable packaged copy of a process double with its own
  application name, user-data path, and single-instance identity, starts it,
  and runs the real helper against it. Nothing it does can reach or disturb an
  installed Orgtree.
- The boundary test records two facts about closing an application that does
  not understand the private upgrade control argument, both measured rather
  than assumed. `WM_CLOSE`, which is what `taskkill` without `/F` sends, only
  hides the window to the tray and leaves the application and its engine
  running. An end-session message does end the process, but runs none of its
  shutdown handlers, so window layout is not persisted and the managed engine
  is left holding installed files. Neither is used.
- `docs/windows-release.md` documents how to run the boundary test, what it
  pins down, and the 8.3 short-path trap that prevents an Electron application
  started from a short path from receiving second-instance notifications.

## Unchanged in this candidate

The upgrade detection rules, the wizard's `Upgrade` and `Advanced setup`
actions, scope and directory reuse, the skipped setup pages, the timeout,
retry, and cancel behaviour, and the fresh-install and uninstall paths are
exactly as they were in RC1. `build/installer.nsh` is unchanged. The installer
still never force-kills Orgtree or its engine: a failed or timed-out close
leaves the existing installation untouched.

## Known limitation

Outside the upgrade path, an all-users installation still gets no running-app
check. Wiring in electron-builder's stock check would force-kill the running
application, which this upgrade path deliberately does not do.

The `-RC2` suffix identifies this candidate in the application version,
installer filename, update metadata, and release handoff. Later candidates
will increment the `RC` number; the final 2.1.3 release will omit the suffix.
