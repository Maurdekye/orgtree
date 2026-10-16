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
- Git gets a native `GIT_ASKPASS` executable alias and process-local
  `credential.sanitizePrompt=true`; no helper reset or gitconfig edit. All existing
  helpers retain precedence. The adapter parses only recognized HTTPS prompts,
  preserving encoded host/path/username, and asks the same bridge endpoint.
  A bridge miss or unknown prompt falls through to the original GIT_ASKPASS,
  core.askPass, then SSH_ASKPASS, including explicit empty overrides. Terminal
  prompting stays disabled. `credential.interactive=false/never` deliberately
  prevents bridge lookup too. Store/erase remain with Git's configured helpers;
  measured get/store calls are identical to the former appended bridge helper.
  Desktop runs its real git credential fill with its normal helper configuration
  from its home directory, removing recursive adapter/askpass overrides. Only
  username/password are returned. Orgtree never persists credentials. Native
  askpass avoids the MSYS signal-pipe failure inside the Codex Windows sandbox;
  existing helpers can still print MSYS diagnostics before askpass succeeds.
  See [sandbox Git evidence](sandbox-git-credentials.md).
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

Since decision 68 (2026-10-10) the sign-in credential helper (below) serves the
bridge from Windows sign-in, whether or not the app runs and whatever "Start at
login" says; the desktop still serves it whenever the helper does not. Before
that, the desktop alone served it and the user had to open Orgtree. No engine
restart or turn hold is introduced. Before a broker is available, adapters preserve native
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

## Sign-in credential helper (decision 68, 2026-10-10)

The bridge used to need the desktop app running; with the app quit or crashed
every bridged git/gh request answered `[no-desktop]` (measured 2026-10-10: a
Hubchat push was blocked that way). `orgtree-credential-broker.exe` closes
that gap.

- **Binary:** `engine/rs/orgtree-engine/src/credential_broker.rs`, a second
  `[[bin]]` of the engine crate, GUI subsystem (no window, no console, no tray).
  Self-contained: no tracing, every function `#[nolog]`. Its only log is
  `credential-broker.log` in the data root, secret-free state changes
  (started, attached to engine pid N, holding / standing by, refused with the
  HTTP status), capped at 256 KiB. Measured idle (debug build): 6.7 MB working
  set, 1.1 MB private, 16 ms CPU per minute, 3 threads; 1.3 MB file.
- **Attach:** the desktop's rules. The descriptor's write boundary first
  (owner this user, SYSTEM or Administrators; no foreign write on the file or
  its folder; no foreign replace right on any ancestor; inherit-only ACEs
  skipped), then its bytes, then `/api/desktop/identity` must echo protocol 1,
  the descriptor's engine pid and the same data root. A data root under a
  folder other users can modify (for example the stock `E:\` with
  Authenticated Users: Modify) is refused, exactly as the desktop refuses it.
- **Serve:** a random pipe (`\.\pipe\orgtree-credentials-<pid>-<hex>`, first
  instance, remote clients rejected) and a memory-only 32-byte secret; the
  desktop broker's protocol, lookups (`gh auth token --hostname`, `git
  credential fill` from the user's home with prompts off and bridge variables
  stripped), limits (16 concurrent, 8 s per connection, 6 s per tool, 64 KiB)
  and failure codes. The reply is written and the handle dropped, never
  `DisconnectNamedPipe`d, which would discard what the engine has not read.
- **Lease:** registers every 5 s with the descriptor's desktop token. The
  engine keeps one broker: a live lease whose broker process (pid plus
  creation time) still runs keeps the slot and a different broker gets
  `409 [held]`; the holder may send `release: true` with its pipe and secret
  (the desktop does on quit); a holder that died is replaced at the next
  registration. Measured: takeover 58 ms after the holder died, 3.5 s after a
  release (one poll).
- **Start:** "Orgtree Credential Helper" scheduled task from
  `tools/boot-engine-task.ps1`: logon trigger for the operator SID, principal
  the operator with `InteractiveToken`, least privilege, ACL like the boot task,
  no time limit, restart on failure. Register creates/updates and runs it (a
  failed Run waits for the next sign-in); Stop/Prepare disables it and ends its
  process before the boot tree stops (the broker runs from
  `resources\engine` and would hold the install open); Remove deletes it. The
  upgrade page's install-tree check leaves the broker image to that step.
- **Not covered:** before the user signs in to Windows after a reboot there is
  no access (no interactive token exists). A second Windows session of the
  same user starts its own broker; the hold rule keeps the first.
- **Agents in the signed-in session (decision 84, which replaced decision 79's
  sign-in engine):** the engine always starts at boot, and while the helper
  runs it starts every agent's CLI through it in the operator's session (below,
  "Every agent's CLI in the user's session"). The helper task follows "Run on
  boot", and its run level follows "Run Orgtree as administrator". See
  [run-on-boot.md](run-on-boot.md).

Proof: `tools/rig/proofs/credential-broker.mjs` (run with `ORGTREE_RIG_HOME`
under your profile, see its header). The broker and a stand-in desktop start
through one temporary per-user interactive task, because an agent's own
processes may carry the boot task's BATCH token, which the engine rightly
refuses. Measured 2026-10-10: synthetic git credential through engine and
broker, gh and github.com lookups reaching the user's store, git ls-remote,
handover both ways, idle cost, `[no-desktop]` without a broker, task deleted.

### Codex launches in the user's session (decision 68, phase 2, 2026-10-10)

In Session 0 (the boot task) Codex's Windows sandbox cannot start its command
runner (openai/codex#46412), so the engine runs Codex there without it
(`codexrt::sandbox`). While the sign-in helper is up, it starts sandboxed
Codex seats in the user's session instead, where the sandbox works.

- **Who is hosted:** in Session 0, a seat whose sandbox is `read-only` or
  `workspace-write`, when the independent Codex host registered `role: "host", caps: ["spawn"]` (only
  the helper does; the desktop broker never hosts) and its process is alive
  (`Bridge::can_host`, `codexrt::seat_sandbox`). A `bypassPermissions` seat
  stayed in Session 0, so no unsandboxed agent ran beside the user's sign-ins
  (ruling Q1; since decision 84 bypass seats and every other harness are hosted
  too).
- **A launcher, not a relay:** the engine creates the child's three stdio
  pipes (`\.\pipe\orgtree-codex-<hex>-in|out|err`, first instance, one
  instance, remote clients rejected) and sends `{kind:"spawn", exe, args, cwd,
  env, pipes}` over the bridge pipe. The helper starts only an absolute path
  named `codex.exe` (since decision 84 any of the five harness CLIs), opens the pipes as a client after checking that the
  attached engine serves them, starts the child suspended with those three
  handles as its only inherited ones, puts it in a kill-on-close job, resumes
  it, and answers `{pid, created}`. The engine checks that the helper is the
  client of all three pipes. JSON-RPC then flows engine ↔ Codex directly.
  The request carries the child's environment (its API key and credential
  capability), so neither side logs more than pids and fixed codes.
- **Ending:** stop/halt asks the helper to `kill` (pid plus creation time),
  which ends the job: Codex and everything it started. If the helper is gone
  the engine ends the process itself when Windows lets it. The helper ends
  every hosted child of an engine that has exited (pid plus creation time,
  checked each 5 s tick),
  and its jobs close with it: signing out ends hosted seats, whose next turn
  starts in Session 0 without the OS sandbox.
- **Fallback:** if the helper cannot start a hosted seat (gone, busy, refused,
  pipe check failed), the engine logs `the sign-in helper could not start
  Codex` with the code and starts it itself with the Session 0 sandbox.
- **Logs:** `Codex started by the sign-in helper in the user's session` per
  hosted launch; the Session 0 launches keep their `Codex OS sandbox
  disabled` line. The helper's log notes `hosting N Codex process(es)`.

Proof: `tools/rig/proofs/codex-host.mjs` (real Codex, fake model, `--session0
1`, helper through the temporary interactive task). Measured 2026-10-10: a
hosted write seat's Codex is the helper's child in session 1, told
workspace-write, its sandboxed shell write and apply_patch land; a hosted
read-only seat's write is denied by the sandbox; a bypass seat is the engine's
child; halting a hosted seat ends its Codex; killing the helper ends the
hosted Codex and the seat's next turn runs in Session 0 mode. Not measured in
the rig: an engine really in Session 0 (that rig engine ran in session 1 with
Session 0 forced), the helper's sweep after an engine exit, and whether the
engine's own job could be nested on a hosted child.


### Desktop credentials and standby Codex hosting (2026-10-11)

The desktop can hold the credential lease while a sign-in helper holds a
separate Codex host lease. Previously the desktop's normal ownership prevented
the standby helper from hosting, leaving sandboxed seats on the Session 0
fallback path whenever the window was open.

Registrations without a `role` retain the credential behavior. The helper now
renews `role: "host"` (requiring `caps: ["spawn"]`) and `role: "credentials"`
every tick, independently. Each slot uses the same desktop-token check,
pipe-server PID, same-SID interactive proof, secret-authenticated ping,
20-second lease and compare-and-swap publication. A live holder keeps its role;
release affects only that role. An unknown role or a host without the capability
is refused. A standby helper never displaces the desktop's credential holder.

`can_host`, the helper PID check and spawn/kill requests use the host slot;
credential grants, lookups, readiness and availability events still use the
credential slot. Host expiry, process death or PID reuse disables hosting.
Without a host, the existing direct-launch fallback and single sandbox-disabled
log line apply. A warm seat changes placement on its next restart/turn according
to the existing runtime policy. No desktop or installer change is needed.

Validation for this delta is recorded in the docket. `codex-host.mjs` now keeps
an interactive desktop-like broker registered throughout, supplies only synthetic
git/gh credentials, and proves sandboxed helper children, independent leases,
helper-death fallback and continued credential ownership. Set
`ORGTREE_RIG_EVIDENCE_HOME` to a D: rig directory when the descriptor trust check
requires the separately authorized run state under an owner-only profile path.
No live credential lookup is needed for this coexistence proof.

### Every agent's CLI in the user's session (decision 84, 2026-10-16)

The user, 2026-10-16 09:37Z: "agents always start at boot, and then
automatically get upgraded when signed in". Phase 2's hosted launch now serves
every harness (`runtime/session_host.rs`, shared by Claude, Codex, Muse,
Antigravity and OpenCode):

- **Who is hosted:** while the helper holds the host role, every agent's next
  CLI, bypassPermissions seats included (the user 09:43Z: "Yes, all agents";
  `session_host::HOST_BYPASS_SEATS`). Codex keeps choosing its sandbox per
  launch (`codexrt::seat_sandbox`); Muse drops `--disable-sandbox` when hosted;
  the Claude keepalive CLI stays in Session 0.
- **What the helper starts:** an absolute path whose file name is `claude.exe`,
  `codex.exe`, `agy.exe`, `opencode.exe` or `muse-bin-<version>.exe`
  (`credential_broker_host::hostable`), nothing else. The stdio pipes are
  `\.\pipe\orgtree-cli-<hex>-in|out|err`; the pipe checks, the suspended start
  in a kill-on-close job, the kill by pid plus creation time and the sweep of a
  dead engine's children are phase 2's. The request carries the child's whole
  environment, so neither side logs more than pids and fixed codes.
- **When:** at a turn's start, never during a turn ([run-on-boot.md](run-on-boot.md)
  covers the moves, the session notices and sign-out).
- **Logs:** `CLI started by the sign-in helper in the user's session` per hosted
  launch (Codex keeps its own line), `the sign-in helper could not start the
  CLI; starting it in Session 0` with the code on a fallback, and the helper's
  `hosting N agent CLI process(es)`. A hosted CLI that ends with the user's
  session under a turn gets a `codex-session-ended` line in the engine's kill
  record (decision 85).

Proof: `tools/rig/proofs/session-upgrade.mjs` (fake CLIs, `--session0 1`, the
helper through the temporary interactive task, as `codex-host.mjs`), and
`session-query.mjs` for `orgtree_session` and the sign-out resume.

Since decision 86 the host role is one lease per Windows session of the
engine's user (`HostLeases`): helpers in different sessions host side by
side, a second helper in the same session is held off until the first's
lease ends, and the first helper is the core's helper member. Spawn and
kill requests go to the helper of the CLI's session (`host_in`). Proof:
`session-choice.mjs`.
