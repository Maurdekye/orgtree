# Tray harness setup

The tray Harness setup submenu uses the authenticated engine harness registry,
refreshed alongside the existing shell status poll. Names and relative order
come from the registry. Detected harnesses precede one separator and missing
harnesses; every entry opens setup, even when missing. An empty group adds no
separator. It does not install, authenticate or launch any harness.

Offline, old or malformed engine responses use the shell's presence-only
fallback for Claude Code, Codex, OpenCode (ACP), Antigravity and Muse Code.
Existing desktop IPC IDs (`claude`, `codex`) stay compatible. Registry IDs are
mapped only for joining the menu. Partial older registries are supplemented
with missing fallback entries. Muse's currently null registry install URL uses
the official installation guide already linked by README. Only HTTPS setup
URLs without embedded credentials are accepted from the engine. Registry
results from a changed endpoint or credential are discarded.

Detection does not imply successful login or, for fallback opencode presence,
verified ACP compatibility. The engine's installed result is authoritative when
available. No tray click, startup preference or native menu-open rule changes.

Focused verification: `node --test tests/tray-harnesses.test.mjs tests/desktop.test.mjs tests/startup-tray.test.mjs`.
Use the shared batch runner and normal typecheck; tests bundle to its assigned
TEMP root and use only fake files/fetch, never providers or the installed app.
