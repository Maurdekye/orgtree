---
name: orgtree-engine-start-mode
description: How Orgtree's two engine start modes on Windows ("At boot, before sign-in" in Session 0, and "At sign-in, in my session") change what an agent can do, how to tell which one you are in, and when to suggest the other one to the user. Use when a task needs the user's desktop (GUI automation, real screenshots, cursor or keyboard input, interactive apps, the user's own sign-ins) or keeps failing on a Session 0 limit, or when someone asks whether agents keep working across reboots or while the user is signed out.
---

# Engine start mode

Every agent runs as a child of Orgtree's engine, so it lives wherever the engine
lives. On a Windows installation for all users, with "Run on startup" on, the user
chooses where the engine starts, in Orgtree's Settings › Desktop:

- **At boot, before sign-in** (the default). The engine starts when the machine
  boots, in Windows Session 0, before anyone signs in.
- **At sign-in, in my session.** The engine starts when the user signs in to
  Windows, inside their own session, with their own sign-in.

Per-user installations, macOS and Linux have no such choice: their engine already
runs in the user's own session. With "Run on startup" off the choice does nothing:
nothing starts by itself, and opening Orgtree starts its engine in the user's
session.

## Which one am I in?

Session 0 means the boot mode. In PowerShell:

```powershell
[System.Diagnostics.Process]::GetCurrentProcess().SessionId
```

`0` is the boot mode. Any other number is the user's own session.

## What each mode means for you

**At boot (Session 0)**
- You keep working before the user signs in, while they're signed out, and across
  reboots, with nobody at the machine.
- There's no interactive desktop. You can't see or drive the user's windows. Real
  input fails: `GetCursorPos` errors, and sent keystrokes and clicks reach nothing.
  The display is a 1024x768 stand-in, so screenshots aren't the user's screen.
- The user's own sign-ins aren't directly there: Windows Credential Manager, and
  apps the user signed in to on their desktop. git and GitHub credentials reach
  you through Orgtree's sign-in helper, and only while the user is signed in.
- Codex's own sandbox can't start in Session 0. While the user is signed in, the
  helper starts sandboxed Codex agents in the user's session instead. Otherwise
  Codex runs without its sandbox. Muse's sandbox is off there for agents that
  may write.

**At sign-in (the user's session)**
- You have the full desktop: the real cursor, keyboard, screen and its size, the
  user's apps and windows, and their sign-ins. Codex's and Muse's sandboxes work
  directly.
- You run only while the user is signed in to Windows. Signing out stops the
  engine and every agent. After a reboot nothing runs until they sign in again.

## When to suggest a change

Suggest **"At sign-in, in my session"** when the work needs any of these:
- GUI automation or anything that drives windows;
- real screenshots, cursor positions or input;
- interactive apps;
- the user's desktop sign-ins;
- or when it keeps failing because of a Session 0 limit above.

Suggest **"At boot, before sign-in"** when the user wants agents to keep working
unattended: across reboots, before sign-in, or while they're signed out.

## Who changes it

Never change it yourself, and don't try to work around it. The setting belongs to
the user: Windows asks them for permission (a UAC prompt) every time it changes.
Explain the trade-off above and ask the user, or your superior if you don't talk
to the user. Name the setting: Orgtree Settings › Desktop, "engine starts", under
"run on startup".

The running engine isn't moved by the change itself. Orgtree offers to restart
the engine at once, which interrupts every running turn, including yours.
Otherwise the new mode takes effect at the next sign-in or boot.
