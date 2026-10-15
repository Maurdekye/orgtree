---
name: orgtree-engine-start-mode
description: How Orgtree's two engine start modes on Windows ("At boot, before sign-in" in Session 0, and "At sign-in, in my session") change what an agent can do, how to tell which one you are in, and when to suggest the other one to the user. Use when a task needs the user's desktop (GUI automation, real screenshots, cursor or keyboard input, interactive apps, the user's own sign-ins) or keeps failing on a Session 0 limit, or when someone asks whether agents keep working across reboots or while the user is signed out.
---

Up: [orgtree-app-settings](../SKILL.md)

> Source status: independently approved at `23100ea` and integrated on local `rust-engine` at `7b7dd2e`. This guide preserves the approved author's content. Source integration does not establish that an installed build includes it.

The control uses `bridge:setEngineStart`; the installation records its mode as `StartupMode` under `HKLM\SOFTWARE\Orgtree\BootEngine`. This protected engine-mode record differs from the desktop window-restoration preference also called startupMode. Agents explain the choice; the user changes it.

# Engine start mode

Agents run as children of Orgtree's engine, so they normally live where the
engine lives. There is one exception at boot: while the user is signed in,
Orgtree's sign-in helper starts sandboxed Codex agents in the user's session,
and the engine stays in Session 0. On a Windows installation for all users, with
"Run on startup" on, the user chooses where the engine starts, in Orgtree's
Settings › Desktop:

- **At boot, before sign-in** (the default). The engine starts when the machine
  boots, in Windows Session 0, before anyone signs in.
- **At sign-in, in my session.** The engine starts when the user signs in to
  Windows, inside their own session, with their own sign-in.

Per-user installations, macOS and Linux have no such choice: their engine already
runs in the user's own session. With "Run on startup" off the choice does nothing,
because nothing starts by itself. An engine that is already running keeps running
until it stops. Once none is running, opening Orgtree starts its engine in the
user's session.

## Where am I running?

What you can reach depends on your own process's session. In PowerShell:

```powershell
[System.Diagnostics.Process]::GetCurrentProcess().SessionId
```

`0` means your process runs in Session 0, with no desktop and no real input. Any
other number is a signed-in user's session.

That number describes your process, not the engine's mode: a Codex agent the
sign-in helper started runs in the user's session even in the boot mode. To learn
the mode, check for `orgtree-engine-host`, the launcher the sign-in mode runs:
`Get-Process orgtree-engine-host -ErrorAction SilentlyContinue` returns it when the
engine started at sign-in. You can also ask the user.

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

## Upsides and downsides

| At boot (Session 0) | At sign-in (the user's session) |
| --- | --- |
| **Upsides:** starts before sign-in, the earliest of these two automatic triggers; agents can work unattended while signed out and after reboots. The boot engine does not depend on who is currently signed in; the data-root lock still permits only one engine for that data root. | **Upsides:** access to the real desktop, input and screen, the user's apps and their sign-ins. Codex and Muse sandboxes work directly in the user's session. |
| **Downsides:** no interactive desktop, real input or real screen; the display is a 1024×768 stand-in. Desktop sign-ins are not directly available. git/GitHub credentials reach agents through the helper only while the user is signed in. Codex's sandbox needs the helper while signed in; otherwise it runs without its sandbox. Muse's sandbox is off for writers in Session 0. | **Downsides:** work runs only while the user is signed in. Signing out stops the engine and every agent; PostgreSQL recovers at the next start. After reboot, automatic work waits for sign-in. Switching modes requires a Windows permission prompt and a subsequent engine start to apply it. |

Changing either mode requires the user's Windows approval. A running engine stays in its current session until it restarts: use the offered restart, which interrupts running turns, or wait for the next sign-in or boot. These trade-offs follow decisions 79/80 and `docs/rust-engine/engine-start-mode.md`; an installer stop request is separate from merely ending a boot task.

Choose boot for unattended work before or without sign-in; choose sign-in when the task needs the user's interactive desktop, sign-ins or directly working sandboxes.

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

## See also

- [orgtree-app-runtime-desktop](../app-runtime-desktop/SKILL.md).
