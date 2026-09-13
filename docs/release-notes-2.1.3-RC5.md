# Orgtree 2.1.3-RC5

This is the fifth release candidate for Orgtree 2.1.3, and it replaces
2.1.3-RC4. The installer is unsigned, as earlier Orgtree releases have been.

## Why this candidate replaces RC4

**RC4's Upgrade action did not work.** Run on a real installation, it closed
Orgtree cleanly and then stopped on the `Installing` page at about 3% and stayed
there. It never recovered, and it never wrote a single file — the existing
installation was left exactly as it was. Behind the frozen window was a second
`Orgtree Setup` window, which is what the installer had actually been waiting
for.

RC5 fixes that. Unlike the previous candidate, this one is not preventative
work: it repairs a failure that happened.

RC4 is obsolete and should not be used. Anyone testing the latest 2.1.3
candidate should install RC5.

## What went wrong, and what changed

**Administrator rights were requested too late, from the wrong place.** An
all-users upgrade has to replace files in `C:\Program Files`, which needs
elevation. RC4 asked for it from inside the step that copies files. Asking there
starts a whole second Setup wizard and blocks the first one until that second
one finishes — and the first window was never hidden, so what the user saw was
an installer frozen at 3% with another Setup window behind it.

RC5 asks for elevation when the install mode is chosen, before any files are
touched, and hides its own window first — which is what every other all-users
install path already did. The elevated copy inherits the Upgrade choice, so the
wizard is not shown a second time, and it does not re-detect the installation,
so it cannot end up pointed somewhere other than what was shown. If elevation is
declined or fails, Setup says so and stops. It never continues without the
rights it needs.

**"Orgtree is closed" only ever meant the visible application.** The helper that
waits for Orgtree to close matched `Orgtree.exe` and nothing else. Orgtree's
engine runs from a different program inside the installation folder and starts
its own subprocesses; none of them is called `Orgtree.exe`, so none was waited
for. Windows will not let an installer replace a program that is still running,
so this was a real hazard even though it is not what stalled RC4 — Setup never
reached the point of copying files.

RC5 waits for the whole installation to be quiet before anything is replaced:
every program running from the installation folder, and everything those
programs started. Three details make that a real check rather than an optimistic
one.

- **It refuses when it cannot see.** The list of running programs is read two
  independent ways, and if neither can be read, the upgrade stops and says so
  instead of treating "nothing found" as "nothing running".
- **It looks before it asks.** The installation's programs are written down
  before Orgtree is asked to close, and every one of them has to be seen to
  exit — not merely to be missing from a later look.
- **It does not lose track of children.** If a program inside the installation
  starts a helper and then exits, that helper is still recognised as part of the
  installation and still has to finish, whether it was started before or after
  that first look.

The installer still never force-kills Orgtree or its engine. If something is
still running, or cannot be verified, the upgrade names what is holding it and
offers Retry or Cancel, and the installed application and your data are left
untouched.

## Lifecycle logging

Unchanged from RC4, and it is worth knowing where it is if an upgrade does
misbehave. The installer writes each step and the outcome to
`%TEMP%\orgtree-installer-upgrade.log`, and the application records the request
arriving, the shutdown beginning, its engine stopping, and whether it completed
or was refused. A log that cannot be written is never itself a reason for an
upgrade to fail.

## Everything else

No interface changes since RC4. Fresh installs, uninstalls, the advanced setup
path, install location and scope, and the finish-page launch behaviour are all
unchanged.

The `-RC5` suffix identifies this candidate in the application version,
installer filename, update metadata, and release handoff. Later candidates will
increment the `RC` number; the final 2.1.3 release will omit the suffix.
