# Installing in-development builds locally

`npm run package:dev` builds a Windows installer for the code currently in
your checkout — committed or not — without publishing anything. No GitHub
release is involved at any point, and the result is deliberately incapable of
replacing or impersonating the published Orgtree install.

## Build and install

```
npm run package:dev
```

This runs the ordinary build, rewrites `dist/build-info.json` as the `dev`
channel with a commit-stamped version, and packages with electron-builder
using a derived config (`dist/electron-builder-dev.json`). The installer lands
in `release-dev/` as `Orgtree Dev Setup <version>.exe`. Run it and choose an
install location; it refuses the "all users" scope (see below). The engine
runtime must be provisioned first (`npm run runtime:provision`), exactly as
for release packaging.

A dev build requires a git checkout: the version string is how the installed
build identifies its source. It looks like

```
2.0.9-dev.gab12cd34ef        built from commit ab12cd34ef, clean tree
2.0.9-dev.gab12cd34ef.dirty  same commit, uncommitted changes included
```

and is what the app reports everywhere a version appears (Settings, the
uninstall entry in Apps & Features, the installer filename).

## How it stays separate from the published install

The dev channel differs from the release in every identity the installed
application owns, so the two install side by side and can run at the same
time:

| | Published release | Dev build |
|---|---|---|
| Product / shortcuts | Orgtree | Orgtree Dev |
| appId / uninstall registry key | com.maurdekye.orgtree | com.maurdekye.orgtree.dev |
| Install directory | …\Programs\Orgtree | …\Programs\Orgtree Dev |
| Data directory | %APPDATA%\Orgtree v2 | %APPDATA%\Orgtree v2 Dev |
| Installer output | release/ | release-dev/ |
| Update feed | GitHub releases | none — updater disabled |

Additional guards:

- The dev installer **refuses an all-users installation** (exit code 2). The
  all-users path is where the published install registers the
  "Orgtree Background Engine" scheduled task and its HKLM uninstall entry; a
  dev build never gets near either.
- The dev build ships **no publish configuration and no `app-update.yml`**,
  and the app disables its updater for the dev channel outright — it cannot
  download a release over itself, and it never probes the release's install
  scope or registry.
- The **release preflight refuses a dev-channel `build-info.json`**
  (`npm run package:win` rebuilds it as `release` first; packaging a stale
  dev artifact by hand fails the preflight), so a local build cannot end up
  published as a release artifact.

Because the data directory differs, a dev build starts with its own empty
profile; it does not see (and cannot corrupt) the data of the installed
release. The tray menu shows "Updates are disabled in this development build",
and Settings' update check answers "unavailable"; the automatic-updates toggle
has no effect in a dev build.

## Rolling back to a published build

The published install is never modified, so "rollback" is just removal:

1. Quit Orgtree Dev (tray icon → Quit).
2. Uninstall **Orgtree Dev** from Windows Apps & Features (its uninstall
   entry is separate from Orgtree's). Uninstalling keeps its data directory,
   as the release uninstaller does; delete `%APPDATA%\Orgtree v2 Dev` if you
   want the dev profile gone too.
3. The published **Orgtree** install is exactly as it was — launch it, or
   install the [latest release](https://github.com/Maurdekye/orgtree/releases/latest)
   if it was never installed on this machine.

Uninstalling is not even required to go back: both builds coexist, so simply
launching the published Orgtree returns you to it.
