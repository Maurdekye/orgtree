# Windows desktop credential bridge

The S4U boot engine cannot inherit a later interactive logon token. The approved
bridge leaves that engine and its CLIs running, while future git HTTPS and gh
commands ask signed-in Electron main for the user's configured credentials.

## Mechanism and trust boundary

- Electron main owns a random named pipe and memory-only broker secret. It
  registers/renews a 20-second lease through the existing local desktop token
  channel on the existing five-second tray poll. No renderer IPC carries secrets.
- Engine verifies loopback origin, desktop authentication and the actual pipe
  server PID (GetNamedPipeServerProcessId). The process token must have the same
  SID as the engine operator and interactive/cached-interactive/remote-interactive
  logon type in a nonzero Windows session. PID alone or console presence is not
  authority. Every credential lookup rechecks this pipe ownership.
- Each launched CLI receives a random credential-only capability in its process
  environment. Engine keeps one grant per agent, binds its generation/org and
  provider PID plus OS creation time, and checks live ownership before and after
  lookup. Replacing, closing, killing or exiting the CLI revokes the capability.
  No desktop/admin token enters an agent. A warm CLI retains its grant and can
  obtain access when the desktop later becomes available.
- Helpers request through a dedicated loopback HTTP endpoint. Both bridge routes
  bypass generic request/response/header tracing completely, including failures.
  Secret-bearing functions use nolog, no secret structures derive Serialize or
  Debug, and no credential is stored in Orgtree files or databases. The endpoint
  allows 16 concurrent requests, bounds bodies/results to 64 KiB and lookup time
  to ten seconds. Broker commands have six-second timeouts and no interactive
  credential prompts. Failures never echo tool stderr or credential bytes.
- Git gets process-local GIT_CONFIG_* entries resetting credential.helper to the
  Orgtree adapter; no gitconfig edit. The adapter supports HTTPS get only; store
  and erase do nothing. Desktop runs its real git credential fill with the exact
  host/path/username and its own normal helper configuration, from its home
  directory, removing recursive adapter/askpass overrides. Only username/password
  are returned. The user's credential manager may manage its own existing store;
  Orgtree itself never persists a credential.
- PATH puts gh.exe (a hardlink, or complete atomic copy, of the engine adapter)
  ahead of the original absolute gh executable. On each invocation it selects the
  host from GH_HOST, repository origin or explicit hostname/repository arguments,
  requests gh auth token for that host, and sets the corresponding token only in
  that command child's environment. Explicit GH_TOKEN/GITHUB_TOKEN or enterprise
  equivalents keep precedence. Tokens never go in argv. Static adapters contain
  no secret and live in a per-engine-boot directory.

## Availability and limits

Desktop startup at sign-in is already on by default. When disabled, the user must
open Orgtree. No new startup registration, scheduled-task edit, engine restart or
turn hold is introduced. Before a broker is available, requests fail with an
instruction to sign in and open Orgtree. Lease expiration restores the warning.
The app reports restored git/GitHub access separately from the general Windows
vault, which stays isolated. This applies to all orgs on the same engine.

Not covered: SSH keys/ssh-agent, absolute-path gh bypassing PATH, arbitrary apps
calling Credential Manager/DPAPI, or missing/expired credentials in the user's
normal store. A healthy broker proves reachability, not validity at GitHub.
These limits are part of the coordinator-approved design. Adapters take effect
when this build launches a CLI; they do not modify an old process's environment.
Installing the build naturally replaces old engine processes; thereafter a
sign-in or desktop open requires no engine/agent restart.

## Verification

Measured: cargo check with the agent's E: target and -j 2, TypeScript typecheck,
and an isolated real named-pipe desktop broker smoke with a synthetic credential
store (no real git/gh credential commands). It exercises authenticated ping,
wrong capability rejection, host newline rejection, exact git target preservation,
gh lookup, recursion stripping and unsupported-operation rejection. The warning
component is separately exercised with synthetic bridge readiness transitions.

An isolated Rust executable compiled the actual source capability comparison,
target validators and process-stamp function against Win32. It passed stable live
PID/creation identity and dead/nonexistent PID refusal without touching the engine.

Source-checked: Windows pipe server PID/SID/interactive proof, process creation
identity, bounded same-agent/generation SQL, launch/reuse/revocation seams for
Claude/Codex/Antigravity, and total bypass of wire tracing. A real interactive
credential round trip is not claimed: the development agent runs in session 0;
no live engine, Windows tasks or real credentials were changed for verification.
