# Orgtree 2.1.3

This is the final Orgtree 2.1.3 release. It replaces every 2.1.3 release
candidate, and the version no longer carries an `RC` suffix. The installer is
unsigned, as earlier Orgtree releases have been.

Most of this release is about one thing: making **Upgrade** work. Upgrading an
existing installation took four attempts to get right, each one failing in a
different place, and the sections below describe the finished behaviour rather
than the history. The interface changes that arrived alongside it are listed at
the end.

## Why this release replaces RC5

**RC5 upgraded the installation correctly and then appeared to do nothing.**
Run on a real installation, it closed Orgtree properly, replaced the files,
and left the machine running the new version — all of which is what it was
supposed to do. But after the Windows administrator prompt was approved, no
Setup window was ever shown again: no `Installing` page, no final page, and no
offer to start Orgtree. Orgtree did not come back on its own, and had to be
started by hand.

The cause was inside the installer. An all-users upgrade runs a second, elevated
copy of Setup to do the actual work, and RC5 made that second copy treat itself
as an automatic background update — which means no window at all. The first
copy had already hidden itself, correctly, so that it would not look like a
frozen installer. Between them, nothing was left on screen.

The final page is also the only place an Orgtree upgrade offers to start the
application again, so losing the window lost the relaunch with it. RC5's notes
said the finish-page launch behaviour was unchanged; that was wrong, and this is
the correction.

2.1.3 keeps the second copy visible. After the administrator prompt is approved
the upgrade continues on screen — `Installing`, then the final page with **Run
Orgtree** offered as usual — and automatic background updates, which are meant
to be silent, are still silent and still restart the application by themselves.

## Upgrading an existing installation

Running Setup over an existing Orgtree installation offers to **Upgrade** it.
Upgrade reuses the install location and the scope already recorded for that
installation, so there is nothing to re-choose and no risk of a second copy
landing somewhere else. **Advanced setup** is still there if you want the full
wizard.

**Administrator approval is asked for once, up front.** An all-users upgrade has
to replace files in `C:\Program Files`, which requires it. Setup asks when the
install mode is settled, before anything is touched, and if approval is declined
or fails it says so and stops. It never continues without the rights it needs,
and it never leaves the existing installation half-replaced.

**Orgtree is closed gracefully, and never force-killed.** Setup asks Orgtree to
shut down and then waits for it. If something is still running, or cannot be
verified as closed, Setup names what is holding it and offers Retry or Cancel —
it does not kill anything, and the installed application and your data are left
untouched.

**"Closed" means the whole installation, not just the visible window.**
Orgtree's engine runs from a separate program inside the installation folder and
starts subprocesses of its own, none of which is called `Orgtree.exe`. Windows
will not let an installer replace a program that is still running, so all of
them have to be accounted for. Three details make that a real check rather than
an optimistic one.

- **It refuses when it cannot see.** The list of running programs is read two
  independent ways, and if neither can be read the upgrade stops and says so,
  instead of treating "nothing found" as "nothing running".
- **It looks before it asks.** Everything running from the installation is
  written down before Orgtree is asked to close, and each one has to be seen to
  exit — not merely to be missing from a later look.
- **It does not lose track of children.** If a program inside the installation
  starts a helper and then exits, that helper is still recognised as part of the
  installation and still has to finish, whether it appeared before or after that
  first look.

## Lifecycle logging

If an upgrade ever does misbehave, it leaves a record. The installer writes each
step and its outcome to `%TEMP%\orgtree-installer-upgrade.log`, and Orgtree
itself records the shutdown request arriving, the shutdown beginning, its engine
stopping, and whether it completed or was refused. A log that cannot be written
is never itself a reason for an upgrade to fail.

This is not incidental. The RC5 problem above was diagnosed entirely from that
log and the installer's own source, without touching the running installation.

## Interface changes in 2.1.3

- The account serving an agent's running inference is shown on its card.
- A divider marks where queued chat messages begin.
- Far-zoom agent nodes render a single enlarged state icon.
- Pop-out modal minimum sizes match their pinned forms, and the Agents list
  width is reconciled.
- The Docket badge counts actionable owned work correctly.
- `orgtree_staff` transcript entries carry docket links.

## Everything else

Fresh installs, uninstalls, the advanced setup path, install location and scope,
and automatic background updates are unchanged from the 2.1.3 candidates.

The release candidates 2.1.3-RC1 through 2.1.3-RC5 are superseded and should not
be used. Their notes are kept alongside this file as a record of how the Upgrade
path was arrived at.
