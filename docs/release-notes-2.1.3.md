# Orgtree 2.1.3

Most of this release is about one thing: making **Upgrade** work when you run
Setup over an installation you already have. The installer is unsigned, as
earlier Orgtree releases have been.

## Upgrading an existing installation

Running Setup over an existing Orgtree installation offers to **Upgrade** it.
Upgrade reuses the install location and the scope already recorded for that
installation, so there is nothing to re-choose and no risk of a second copy
landing somewhere else. **Advanced setup** is still there if you want the full
wizard.

**Administrator approval is asked for once, up front.** An all-users upgrade has
to replace files in `C:\Program Files`, which requires it. Setup asks when the
install mode is settled, before anything is touched. If approval is declined or
fails, Setup says so and stops: it never continues without the rights it needs,
and it never leaves the existing installation half-replaced.

**The upgrade stays on screen after you approve.** Approving the prompt hands
the work to a second copy of Setup running with administrator rights, and that
copy shows its own `Installing` page and then its final page. The first copy
hides itself so you are never looking at two Setup windows or at one that
appears frozen.

**The final page offers to start Orgtree, as usual.** Leaving **Run Orgtree**
ticked starts the application when you close Setup, and it starts without
administrator rights even though the upgrade needed them.

**Automatic background updates are unaffected.** When Orgtree updates itself
rather than being upgraded by hand, it installs silently and restarts on its
own, with no window and nothing to click.

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

Between them, these two records are usually enough to explain a failed or
surprising upgrade without needing to reproduce it.

## Interface changes

- The account serving an agent's running inference is shown on its card.
- A divider marks where queued chat messages begin.
- Far-zoom agent nodes render a single enlarged state icon.
- Pop-out modal minimum sizes match their pinned forms, and the Agents list
  width is reconciled.
- The Docket badge counts actionable owned work correctly.
- `orgtree_staff` transcript entries carry docket links.

## Everything else

Fresh installs, uninstalls, the advanced setup path, install location and scope
selection, and automatic background updates are otherwise unchanged.
