# Orgtree 2.1.2

One fix since 2.1.1. The installer is unsigned, as every Orgtree release before it
has been.

## Start Menu

- Upgrading no longer leaves the old "Orgtree v2" Start Menu entry sitting beside
  the current one. 2.1.1 already tried to remove it, but an all-users install only
  cleaned the all-users Start Menu, and on most machines that entry is in the
  installing user's own Start Menu instead, so it survived. The cleanup now names
  each Start Menu scope explicitly and removes the old entry from both, whether
  the installation is for all users or for one.
- Only that one legacy name is removed. Your current Orgtree shortcut is left
  alone, no other shortcut is touched, no Start Menu folder is scanned, and
  side-by-side development builds are unaffected.
