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
  SID as the engine operator, an enabled well-known INTERACTIVE group, and a
  nonzero Windows session. This queries the process token directly and does not
  require cross-logon LsaGetLogonSessionData access. PID alone or console presence is not
  authority. Every credential lookup rechecks this pipe ownership.
- Only an engine with an isolated/unavailable credential context injects adapters.
  A normal signed-in engine returns an empty environment delta before creating
  any adapter or grant: no helper override, PATH shim, or Codex override.
- Each adapted CLI receives a random credential-only capability in its process
  environment. Engine keeps one grant per agent, binds its generation/org and
  provider PID plus OS creation time, and checks live ownership before and after
  lookup. Replacing, closing, killing or exiting the CLI revokes the capability.
  No desktop/admin token enters an agent. A warm CLI retains its grant and can
  obtain access when the desktop later becomes available.
- Helpers request through a dedicated loopback HTTP endpoint. Both bridge routes
  bypass generic request/response/header tracing completely, including failures.
  Secret-bearing functions use nolog, no secret structures derive Serialize or
  Debug, and no credential is stored in Orgtree files or databases. The endpoint
  allows 16 concurrent requests, waits at most two seconds for a slot, bounds
  bodies/results to 64 KiB and the whole request to ten seconds. Windows pipe
  opens retry ERROR_PIPE_BUSY every 25 ms for at most one second. Busy exhaustion
  and the desktop's explicit saturation response never withdraw broker readiness. Broker commands have six-second timeouts and no interactive
  credential prompts. Failures never echo tool stderr or credential bytes.
- Git gets one process-local GIT_CONFIG_* helper entry appended to its normal
  helper chain; no empty helper reset and no gitconfig edit. Existing helpers
  retain precedence. An unavailable broker returns an empty successful helper
  answer, allowing later helpers to continue; it never disables native helpers. The adapter supports HTTPS get only; store
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
  equivalents keep precedence. When no broker answers, the original gh executes
  without an injected token and uses its normal authentication. Real-executable
  lookup skips all credential-adapters directories, including an inherited outer
  shim, preventing recursive shim launch. A missing executable produces an explicit installation/
  PATH-refresh error. Tokens never go in argv. Static adapters contain
  no secret and live in a per-engine-boot directory. Startup removes only known
  static files in old UUID boot folders, bounded to 256 folders/files per scan,
  without following symlinks or recursive deletion. Locked executables wait for
  the next startup. PATH is changed only when a real gh executable exists.
  Malformed or >=128 inherited GIT_CONFIG_COUNT values are left untouched;
  Git bridging is skipped instead of overwriting the user's entries.

## Availability and limits

Desktop startup at sign-in is already on by default. When disabled, the user must
open Orgtree. The warning says exactly that. No new startup registration, scheduled-task edit, engine restart or
turn hold is introduced. Before a broker is available, adapters preserve native
credential behavior while the app/tray warning asks the user to sign in and open
Orgtree. Lease expiration restores the warning.
The app reports restored git/GitHub access separately from the general Windows
vault, which stays isolated. This applies to all orgs on the same engine.

Not covered: SSH keys/ssh-agent, absolute-path gh bypassing PATH, arbitrary apps
calling Credential Manager/DPAPI, or missing/expired credentials in the user's
normal store. A healthy broker proves reachability, not validity at GitHub.
These limits are part of the coordinator-approved design. Adapters take effect
when this build launches a CLI; they do not modify an old process's environment.
Installing the build naturally replaces old engine processes; thereafter a
sign-in or desktop open requires no engine/agent restart.

The capability is delegation within the same Windows user, not an OS sandbox
between that user's agents: same-user processes may read another process's
capability. Grants still fence agent identity, generation, CLI PID/creation and
revocation; they never grant the desktop administrative token.

Codex gets the environment-only capability as ORGTREE_CREDENTIAL_AUTH and
explicit shell_environment_policy.set.GIT_CONFIG_KEY_n overrides for the
nonsecret Git key names. No secret is put into CLI arguments and default secret
filtering is not disabled. This keeps helper key/count pairs intact even on Codex
versions that apply the usual KEY/TOKEN/SECRET exclusions.

All registration, failed-ping and lease-expiry notifications pass through
credential_bridge::publish_availability. Only a readiness boolean is published;
watchdog event hooks can attach there without receiving broker or grant data.

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

Measured review correction checks (2026-10-07):
- Actual-source Windows identity proof, executed by the session-0 worker, accepts
  the existing same-user session-1 desktop; rejects the worker's own batch token
  and an invalid PID. The old cross-session LSA call returned success on this
  machine, so the review's suspected LSA access failure was not reproduced.
- Actual-source environment builder and gate: normal mode adds nothing; isolated
  mode adds one nonempty helper entry, AUTH/URL/agent capability context and PATH.
  Real Git credential fill with synthetic helpers confirms native helpers remain
  intact and an empty adapter answer allows a later helper to fill credentials.
- Actual-source gh command builder: no broker gives the installed real gh the same
  exit/stdout/stderr for --version; explicit tokens win; only a successful lookup
  adds a token; malformed synthetic token data is refused. Outer shim paths are
  excluded from executable resolution.
- Installed Codex was driven with a local synthetic Responses server (no remote
  model or credential access) through its real exec_command tool, not standalone
  command/exec. Both its default and explicit-key-override launches preserved
  GIT_CONFIG_KEY_0, GIT_CONFIG_COUNT and synthetic AUTH/TOKEN variables. The
  suspected filtering failure is therefore not reproduced on this installed CLI;
  the narrow key override protects versions/configurations with default filters.
- Agent-route token and agent-ID headers are checked with an O(1) grant lookup
  before acquiring a request slot or reading a body. AgySpec's entire environment
  is redacted; Claude's redaction includes credential-prefixed names.

Source-checked: bounded same-agent/generation SQL, launch/reuse/revocation seams
for Claude/Codex/Antigravity, and total bypass of wire tracing. A real interactive
credential round trip remains a post-install user check, per coordinator ruling
2026-10-07 13:24Z. The attempted same-user interactive smoke launch was refused by
Windows (1314); no task, privilege, live data or desktop state was changed. A local
bare push is not accepted as credential-helper evidence. The meaningful local
Git check above uses credential fill with synthetic credentials only.

## Alpha.9 follow-ups (2026-10-07)

- Measured actual production pipe-open retry loop (awaited sleep replaced with
  blocking sleep only in the isolated harness) against a real single-instance
  Windows named pipe: initially busy then released succeeded at 126 ms; held busy
  returned Busy at 1012 ms. Busy is distinct from unavailable both on lookup and
  the follow-up ping. The desktop's saturation path sends an explicit Busy marker.
- Measured source-extracted host/config helpers: missing -R/--hostname, underscore
  and IPv6 targets skip brokerage and invoke real gh unchanged; malformed/huge
  Git counts preserve inherited entries; no installed gh means no PATH shim.
- Orchestration ensure_proc/ensure_codex/ensure_agy use normal impl logging again.
  Secret-valued work remains in nolog helpers; Ctx and OrRoute Debug mask keys.
- Antigravity limitation: source confirms AgyProc::spawn applies all spec.env
  entries after provider cleanup, so KEY/count/AUTH reach the CLI. Installed agy
  --help exposes no environment-policy control. Its proprietary terminal's later
  filtering has NOT been verified; no claim of Antigravity terminal credential
  compatibility is made until an actual terminal invocation is observed. No
  speculative unsupported option is passed to it.

## Failure reasons and lookup status (alpha.10 follow-up, 2026-10-07)

The alpha.10 incident (every bridged git/gh request returned 503) came down to
gh not being signed in on the desktop. The bridge itself worked, but no layer
said why it failed. Now:

- The desktop broker classifies a failed lookup as a fixed code
  (`gh-empty`, `git-empty`, `gh-exit-N`, `git-exit-N`, `gh-timeout`,
  `gh-missing`, `git-missing`, `invalid-request`, `broker-failed`). It returns
  `orgtree-credential-error <code>` only to an authenticated engine request
  carrying `diagnostics: 1`. Tool stdout, stderr and messages never leave the
  broker. Older engines get the old silent close.
- The engine validates the code (`[A-Za-z0-9-]`, at most 40 bytes), logs a warn
  line with the kind, the host and the code, and answers 503 with one
  actionable sentence ("…ask the user to run `gh auth login`… [gh-empty]").
  Engine-side refusals have their own codes: `denied`, `busy`, `no-desktop`.
- The git helper and the gh shim print that sentence as one stderr line, then
  continue as before: git falls through to the next helper, and gh runs with
  its own sign-in. A missing or broken engine prints `[no-engine]`.
- `/api/desktop/identity` → `credentialContext.bridge_lookup` =
  `{status: untested|succeeded|failed, kind, reason, message, at_ms}`. Only a
  real git/gh lookup through the desktop sets it, never a ping or a
  registration. It is diagnostic only: the user ruled on 2026-10-07 at 16:12Z
  that there is no credential UI, and agents relay the stderr line instead.
