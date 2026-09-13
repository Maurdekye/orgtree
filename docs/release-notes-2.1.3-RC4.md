# Orgtree 2.1.3-RC4

This is the fourth release candidate for Orgtree 2.1.3, and it replaces
2.1.3-RC3. The installer is unsigned, as earlier Orgtree releases have been.

## Why this candidate replaces RC3

RC3 was built before six interface fixes and before the installer's
Upgrade-path hardening. It is not being replaced because it was broken.

Anyone testing the latest 2.1.3 candidate should install RC4. RC3 and earlier
candidates are obsolete and should not be used.

## About the Upgrade-path failure, which was an RC1 defect

RC1's Upgrade action could not close a running Orgtree. Its graceful-close
helper failed with `Argument types do not match` under Windows PowerShell 5.1
on every invocation, before it inspected a single process. RC2 fixed that and
RC3 carried the fix; neither is known to fail.

RC4 does not repair that defect again. It adds two things the episode showed
were missing, and both are preventative:

- **The helper now says where it failed.** The RC1 dialog named no step, and the
  helper wrote nothing to disk, so three accurate words were all anyone had to
  work from. Every stage now names itself, both in the message shown and in a
  log file, so an unexpected failure is answerable from a single screenshot.
- **It can no longer report a close it has not verified.** An installer is about
  to replace the files an application is running from, so "nothing was found" is
  not treated as proof that nothing is running — a search that cannot read
  anything also finds nothing. The processes are identified before the close is
  requested, and the upgrade proceeds only once those exact processes are
  confirmed gone. Anything that cannot be verified counts as still running and
  produces Retry or Cancel, leaving the installation untouched.

The installer still never force-kills Orgtree or its engine.

## Lifecycle logging

An installer-requested shutdown is now recorded on both sides. The installer
writes each step and the outcome to `%TEMP%\orgtree-installer-upgrade.log`. The
application records the request arriving, the shutdown beginning, its engine
stopping, and whether it completed or was refused, alongside its other update
state; each run also records how it started, so an upgrade that closed the
application can be matched to whatever started it again.

## Interface changes since RC3

- The account serving an agent's running inference is shown on its card.
- A divider marks where queued chat messages begin.
- Far-zoom agent nodes render a single enlarged state icon.
- Pop-out modal minimum sizes match their pinned forms, and the Agents list
  width is reconciled.
- The Docket badge counts actionable owned work correctly.
- `orgtree_staff` transcript entries carry docket links.

The `-RC4` suffix identifies this candidate in the application version,
installer filename, update metadata, and release handoff. Later candidates will
increment the `RC` number; the final 2.1.3 release will omit the suffix.
