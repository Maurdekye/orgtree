# Rehearsing the in-app update, without installing anything

Orgtree can update itself: it notices a newer version, downloads it, shuts its
engine down and hands off to the installer. That last step is the part nobody
wants to test on their own machine, because testing it normally means actually
installing something.

This is how you exercise the whole route anyway. A **fixture** — a harmless
executable that records what it was given and installs nothing — stands in for
the installer, and an **isolated loopback feed** stands in for the release feed.
The app does everything it really does; only the thing it hands off to is
different.

## What it does and does not do

It **does**: build a separate app with its own identity, serve one directory on
`127.0.0.1`, launch that app in the background, let it find and download the
fixture, and let it hand off exactly once. Then it captures evidence, stops what
it started, deletes what it created, and compares the installed release before
and after.

It **does not**: install anything, ask for administrator rights, publish
anything, or touch the installed Orgtree, its data folder or its entry in
installed programs. Those limits are enforced by `tools/rehearsal-isolation.mjs`
and checked by `tests/update-rehearsal.test.mjs` — see
[The guards](#the-guards-and-why-each-one-exists).

## Running it

Three commands, from the repository root:

```sh
node tools/build-update-fixture.mjs     # the harmless stand-in installer
node tools/package-rehearsal.mjs        # the app to rehearse, dev identity
node tools/run-rehearsal.mjs            # the rehearsal
```

The fixture needs NSIS. `tools/build-update-fixture.mjs` looks for the copy
electron-builder caches; set `ORGTREE_MAKENSIS` if yours is elsewhere.

That first command also writes a small `…provenance.json` beside the fixture,
recording what was built and what it was built from. The rehearsal **requires**
it: an executable's location says nothing about what it is, and a real
installer handed to `--fixture` would really install. Pointing `--fixture` at
anything else is refused.

Close any development build running out of the rehearsal folder before you
start. The rehearsal refuses to run otherwise, because it identifies its own
processes by that folder and will not adopt ones it did not start.

### ⚠ Then leave the machine alone

The apply is the application's **own automatic path**, and that path requires:

- automatic updates enabled (the default),
- an idle organization — no agent mid-turn, and
- **sixty seconds with no keyboard or mouse input on this machine.**

The rehearsal will not fake that last condition; faking it would mean it no
longer exercised the thing it exists to exercise. So start it and stop touching
the computer. If the budget runs out first, it says the handoff never happened
rather than reporting a rehearsal that did not occur.

The default budget is five minutes. `--budget 600` gives it ten.

### Options

| flag | meaning |
|---|---|
| `--out <dir>` | where the rehearsal build was packaged (default `release-rehearsal`) |
| `--fixture <exe>` | the stand-in installer (default `dist/update-fixture/orgtree-update-fixture.exe`) |
| `--work <dir>` | where the feed, baseline and evidence go (default `dist/rehearsal`) |
| `--budget <seconds>` | how long to wait for the idle apply (default 300) |
| `--keep` | leave the rehearsal's data folder and updater cache in place for inspection |
| `--dry-run` | run every guard, the isolation checks and the baseline, then stop without launching anything |

Exit codes: `0` the fixture was applied (or the dry run passed) **and** the
installed release was compared and found unchanged; `3` nothing went wrong but
the apply never fired within the budget; `1` something was refused, a check
failed, or the comparison could not be made; `2` the build or the fixture is
missing.

`0` always means the installation was checked. A comparison that fails **and**
a comparison that could not be run both force a non-zero exit — an exit code
from this tool never means "nobody looked".

A run is only reported as applied when both halves are present: a handoff
recorded **after this run started**, and a fixture receipt written after the
launch whose terminal `[fixture-complete]` record matches the token it declares.
A log line alone is the app saying it launched something; the receipt is the
fixture saying it ran.

`--dry-run` is the one to reach for when the question is *"is this machine in a
state where rehearsing would be safe?"* — it answers that in a few seconds
without needing you to leave the keyboard alone for a minute.

## What a successful run looks like

The app's own update log, printed as it happens:

```
update-feed-private     checking an isolated loopback feed at [http://127.0.0.1:52217/]
updater                 Found version 9.9.9-fixture (url: orgtree-update-fixture.exe)
attempt                 automatic idle application
engine-shutdown         engine process observed gone
update-fixture-handoff  handing off to the update fixture instead of the downloaded installer
handoff                 installer launched
```

and then the fixture's own receipt, which is the contract both upgrade routes
target:

```
[fixture] orgtree update fixture ran; nothing was installed
[fixture-cmdline]  "…orgtree-update-fixture.exe" --updated /S --force-run /D=…\win-unpacked
[fixture-instdir]  …\release-rehearsal\win-unpacked
[fixture-token]    c96f6f8d-41a6-417d-b326-e57011cb8007
[fixture-silent]   yes
[fixture-complete] c96f6f8d-41a6-417d-b326-e57011cb8007
```

The token appears twice on purpose: the last line is written only after
everything else succeeded, and it carries *this attempt's* token, so a receipt
left over from an earlier run cannot be mistaken for proof of this one.

Everything is written to `dist/rehearsal/evidence.json`.

## The guards, and why each one exists

| guard | what it refuses |
|---|---|
| `assertRehearsalPaths` | every destination, **before the first byte is written** — the packaged output, the executable, the artifact and the `--work` directory |
| `assertRehearsalTarget` | packaging into, launching out of, **or wrapping around** Program Files, `%LOCALAPPDATA%\Programs\Orgtree`, or any location the uninstall registry reports. Junctions are resolved first, so an alias cannot launder a protected path |
| `assertFixtureProvenance` | serving anything but the fixture this repository built — the bytes are hashed and checked against the provenance the build wrote, and against `build/update-fixture.nsi` as it stands now |
| `assertRehearsalComposition` | a package whose **bundle** lacks the compiled fixture capability, whatever `build-info.json` says; or whose packaged feed config would share the release's updater cache or name a non-loopback URL |
| `assertNotElevated` | an administrator shell — and **an elevation probe that cannot answer**, which is treated as refusal rather than as "not elevated" |
| `isolationChecks` | starting when the *installed* build is itself fixture-capable, when a dev uninstall entry already exists, or when **anything is already running out of the rehearsal directory** |
| `isRehearsalProcessPath` | stopping any process not running out of the rehearsal directory — the real Orgtree shares its product name, so matching by name would kill it |
| `assertRemovable` | deleting anything but the rehearsal's own data folder and updater cache — and even those only when **this run created them** |
| `serveFeed` | binding anything but loopback |

Two rules about ownership are worth stating plainly, because they are what
stop cleanup doing harm:

- **Nothing is stopped or deleted unless this run actually launched something.**
  A refusal and a `--dry-run` both leave the machine exactly as they found it.
- **This run only owns what it created.** The pre-flight refuses to start if
  anything is already running from the rehearsal directory, which is what makes
  "every process in that directory is mine" true rather than hopeful. The dev
  data folder and updater cache are left alone if they existed beforehand —
  they may be somebody's ordinary dev build.

Two further rules are structural rather than checks:

- **The capability is compiled in, not configured.** `buildPermitsUpdateFixture`
  reads a string the bundler substitutes, so a released build has no
  substitution in it to enable. Setting the environment variable on a production
  build does nothing but get recorded.
- **The release preflight refuses a fixture-composed bundle**, by its own
  disclosure and by scanning the bundle for the marker. `tools/package-rehearsal.mjs`
  deliberately steps around that preflight and nothing it produces is publishable
  — `--dir` writes a directory, not an installer, and the dev packaging config
  carries no publish configuration at all.

## Two things that are not obvious

**A dev-channel build cannot download an update without an `app-update.yml`,
even when the feed is set at runtime.** `devPackagingConfig` deliberately writes
no publish configuration, so none is packaged; `setFeedURL` changes where the
manifest is *fetched* from but does not remove that read. `package-rehearsal.mjs`
writes a placeholder naming a loopback URL and the rehearsal's own updater cache
— so even the value about to be overridden could not reach off-machine.

**The version is derived, not taken from `package.json`.** `devVersion` requires
a plain `x.y.z` base and refuses a release candidate, so the packager strips to
the numeric core rather than loosening shipped code. The rehearsal reports
something like `2.1.5-dev.gfa9c6e1d3b.dirty`, which is unmistakably a
development build and is comfortably outranked by the `9.9.9-fixture` the feed
offers.

## What this does not establish

The **manual** upgrade route — a user running a real installer over an older
installed version — is a different path and is not exercised here. It needs a
machine with an older Orgtree actually installed on it.
