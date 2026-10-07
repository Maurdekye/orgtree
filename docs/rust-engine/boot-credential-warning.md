# Windows boot credential warning

## Diagnosis

Verified from current Rust and `origin/dev` 3.x source on 2026-10-07:
`tools/boot-engine-task.ps1` uses BootTrigger and S4U under the operator account
in both versions. The Python service host and Rust host preserve that logon
context. This is an inherited gap, not a conversion from an interactive task.
The old `tools/boot-task-probe.ps1` explicitly expected prior-context DPAPI
decryption to fail under S4U. PLAN section 10 A2 retained boot behavior.

Read-only task inventory found the Background Engine task running with S4U.
A read-only Win32 probe in the engine-launched tool process measured session 0,
logon type 4 (batch), and a signed-in console session 1. A narrowly filtered
Credential Manager query returned NOT_FOUND, meaning the API was reachable.
That is **not proof that saved interactive credentials can decrypt**. No secret
names, usernames or blobs were read; no gh/git auth commands were run. The
outside organization's exact failure remains reported, not independently reproduced.

## This stage: warning only

`credential_context.rs` records only session IDs, presence of a signed-in user,
logon type, vault reachability/error code and warning text. Sensitive Win32
helpers use `#[nolog]`; no credential structures leave them. Non-Windows hosts
have no warning. Session 0, missing interactive user or network/batch/service
logons produce a warning; unavailable session/vault facts also warn.

The engine probes at startup and `ensure_proc` (before reuse or launch).
Every 30 seconds a cheap WTS check refreshes the probe if session facts change.
Signing in cannot upgrade an existing process token, so isolation keeps the
warning active. Changes are logged, not repeatedly emitted on unchanged ticks.
Identity and desktop status expose safe warning metadata. The app displays a
persistent alert and the existing tray poll maintains a warning menu entry and
tooltip. Failed polls retain a known warning; only a successful explicit clear
removes it. This does not hold turns, restart processes, alter credentials or
change the boot task.

User 12:33Z chose warn-only. At 12:40Z the user separately requested access
through a signed-in credential bridge without an engine restart. That stage
requires its own agreed design; it is not implemented by this warning patch.
The current restart advice describes the available recovery until then.

## Verification

Measured: cargo check --offline -j 2 using the agent's E: target directory;
TypeScript typecheck; isolated Chromium rendering the actual React alert;
actual Engine.stats with synthetic responses. Both UI and desktop controls
show, retain on failure, and clear on explicit success. Read-only Win32 probe
as above. Tray menu wiring was source-inspected, not exercised in live Electron.
No live data writes, task changes, engine build/install/restart or reboot.
