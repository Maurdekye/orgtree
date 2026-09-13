# Orgtree 2.1.3-RC3

This is the third release candidate for Orgtree 2.1.3, and it replaces
2.1.3-RC2. The installer is unsigned, as earlier Orgtree releases have been.

## Why this candidate replaces RC2

RC2 was built before the optional blocked-ticket reminder setting landed.
RC3 includes that setting while retaining the installer upgrade fix delivered
in RC2.

Anyone testing the latest 2.1.3 candidate should install RC3. RC2 and earlier
candidates are obsolete and should not be used.

## Changes since RC2

- App Settings now includes `Remind me when all work is blocked`.
- The option is off by default. When it is off, docket reminders behave exactly
  as before.
- When enabled, ordinary reminders for actionable tickets remain unchanged. If
  every nonterminal ticket across the organization is blocked, eligible agents
  are additionally reminded about their own blocked tickets.
- An actionable ticket anywhere in the organization prevents blocked-ticket
  reminders for everyone. Terminal and backlogged tickets do not affect that
  organization-wide check.

## Retained from RC2

The one-click installer upgrade path uses a Windows PowerShell 5.1-compatible
graceful-close helper. It does not force-kill Orgtree or its engine; a failed or
timed-out close leaves the installed application intact and offers Retry or
Cancel.

The `-RC3` suffix identifies this candidate in the application version,
installer filename, update metadata, and release handoff. Later candidates
will increment the `RC` number; the final 2.1.3 release will omit the suffix.
