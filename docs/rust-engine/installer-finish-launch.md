# Launch from the installer's Finish page

The 2026-10-19 report was a fresh **per-user** installation. Setup said roughly
that Orgtree could not start automatically and could still be opened from its
desktop shortcut. This matches `orgtreeFinishPageRun`'s shell-dispatch failure
message in `build/installer.nsh`; that message precedes any desktop or engine
startup. The original Windows/plugin result is not yet available, so an
Explorer timeout, antivirus delay or other specific cause is not established.

Previously this callback always used `StdUtils.ExecShellAsUser`. Even an
already unelevated Setup therefore depended on Explorer's shell dispatch.
The callback now uses native `Exec` (CreateProcess) when `UAC_IsAdmin` says
Setup is unelevated. It starts the same quoted GUI executable with the token
Setup already holds, without a shell response or application-readiness wait.
Dispatch success means process creation was accepted, not that the engine is
ready or the application remained healthy.

The **token**, not the per-user installation choice, determines this route:
a per-user Setup can itself have been run as administrator. Elevated Setup
keeps `ExecShellAsUser` and its existing `ok`/`fallback` result convention.
No failed or uncertain shell result is replayed with Setup's elevated token.

Both routes stay behind the existing exclusive `CREATE_NEW` launch claim.
An existing/unknown owner and an uncreatable claim still prevent a launch.
The upgrade helper's ownership, post-installer-exit wait and acknowledgement
protocol are unchanged. Failed native creation reaches the existing visible
failure and shortcut guidance, with `create-process-failed` in the installer
log. `finish-run-native` and `finish-run-as-user` identify the selected route.
The log is `orgtree-installer.log` beside Setup, falling back to `%TEMP%`.

`tests/installer-finish-launch.test.mjs` compiles the real Finish/claim
functions into isolated, silent NSIS fixtures. They write only to the explicit
test output directory. A delayed GUI probe verifies actual native creation;
the UAC observation and shell dispatch are controlled boundaries. Controls
cover busy-shell unelevated launch, both elevated success tokens, uncertain
elevated failure, competing/unavailable ownership and missing native target.
This is not a full installation, real UAC/Explorer test, or a reproduction on
the coworker's PC. No engine startup timeout is changed by this fix.
