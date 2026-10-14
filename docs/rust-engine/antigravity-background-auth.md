# Antigravity background authentication

Orgtree must not turn a background usage read, model listing or agent start into
an interactive sign-in. The user signs in through Antigravity themselves; there
is no Orgtree Sign in button (user, 2026-10-14).

## Guard

`providers::agy_auth` is shared by discovery, usage and runtime launches. Model
listing also consumes its `checked_output(engine, exe, command, timeout)` API.
The executable's presence means installed, not connected.

On Windows, `CredEnumerateW` reads only presence and LastWritten for the exact
`gemini:antigravity` target. No credential blob or username is inspected, copied
or logged. Missing metadata prevents any AGY launch. An enumeration error is
reported as unavailable, not evidence that the user signed out.

Each permitted launch first runs **no arguments**, with
`AGY_CLI_CDE_AUTH_ACTION=check`, updater disabled, hidden window, closed piped stdin
and bounded captured output. Arguments would bypass this mode in AGY 1.3.5.
Only exit zero with empty output authorizes the requested command. Refusal is
shown as signed out **or sign-in could not be validated**: expired credentials
and validation failures are not distinguishable from this exit code. A hung
check is unavailable, never success. Agent warm reuse also checks sign-in; a
credential timestamp change replaces the old process.

An auth refusal or recognizable OAuth/code prompt records a timestamp-only
latch in `diagnostics/agy-auth-latch.json`, clears connected state and publishes
signed-out usage. Further Windows launches, including forced reads, stop until
the credential timestamp changes. The latch survives engine restart. A ten-second
usage-loop metadata observation notices external sign-in; a successful usage
read wakes waiting account mail. The admission gate holds mail without starting
repeated turns. No provider/account/session switching is performed.

Output is monitored in chunks, including prompts without newlines. An auth
prompt is suppressed from normal trace/transcript output and the process is
terminated. Agent refusal is posted before process EOF so it is not mistaken
for a network retry. Ordinary model JSON discussing sign-in is not an auth
signal. Native child Jobs are used where available.

Non-Windows has no verified credential metadata detector in this change. It
still performs the silent check before every launch. After refusal, it permits
only silent revalidation after at least five minutes; actual usage/model/turn
commands remain forbidden until a check succeeds (coordinator, 2026-10-14).
This platform path is source-reviewed, not measured against a real CLI here.

## Measured evidence and limits

Installed AGY 1.3.5 scratch probes showed that headless environment flags and
CREATE_NO_WINDOW with closed piped stdin **do not prevent OAuth**. Static code
orders OAuth startup before printing the auth prompt. Output interception alone
therefore cannot guarantee that a browser never opens.

The approved no-argument check-mode probe exited 1 in 94 ms with empty output
and no OAuth indication. Static analysis follows main → RunLogin(CheckOnly) →
stored-credential validation, without interactive acquisition. Successful check
behavior is covered by the fake CLI; the real signed-out control does not prove
every success or network-error case. This environment action is **undocumented**
and may change in future AGY releases. Public documentation describes OS-keyring
authentication and headless operation but does not document this action:
[authentication](https://antigravity.google/docs/cli/install),
[headless](https://antigravity.google/docs/cli/headless/).

There remains a check/use race: a valid credential can be revoked after checking.
The prompt monitor stops and latches the first observed refusal, but OAuth may
have started before its text. Already-running concurrent CLIs can each race;
this is **not** a global guarantee of at most one popup. New launches are blocked
after the latch is recorded. The coordinator explicitly accepted this residual
and the platform distinction; do not present metadata or pipe flags as proof
that a token is valid or that OAuth is impossible.

## Verification contract

The guard's public async boundaries and subprocess capture are heap-owned,
type-erased futures; pipe buffers live on the heap too. Keep these boundaries:
round 434 reproduced a stack overflow on the original debug actor launch path.
The inline-size regression constructs (never polls) capture and caps its inline
state at 64 bytes. The original unchanged lane and auth proofs must also pass;
increasing thread stack sizes or relaxing compiler lints is not the fix.

`cargo test --locked -j 2 -p orgtree-engine agy_auth_ -- --test-threads=1`
checks output classification, signed-out/unknown reporting and command options.
Build the engine and fake CLI in the shared batch, then run:

```
node tools/rig/rig.mjs run tools/rig/proofs/agy-auth.mjs
node tools/rig/rig.mjs run tools/rig/proofs/agy-lane.mjs
```

The auth proof uses only a disposable rig metadata file and fake subprocesses.
It checks absent/invalid/changed credentials, durable refusal across a rig
restart, external recovery with waiting mail, unsupported check behavior,
bounded hangs, split unterminated OAuth prompts and agent-runtime refusal.
The lane proof checks existing tools, steering and process behavior. These are
verification commands, not a claim that they passed; the batch receipt records
actual results. No real account is signed in/out and no inference call is needed.
