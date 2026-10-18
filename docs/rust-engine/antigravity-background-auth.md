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
Only exit zero with either empty output or exactly one stdout line starting
`Already authenticated as ` (and empty stderr) authorizes the requested command:
that line is the measured signed-in reply of AGY 1.3.5. Any other exit-zero
output never authorizes. Refusal is shown as signed out **or sign-in could not
be validated**: expired credentials and validation failures are not
distinguishable from this exit code. A hung check is unavailable, never success. Agent warm reuse also checks sign-in; a
credential timestamp change replaces the old process.

An auth refusal or recognizable OAuth/code prompt records a latch in
`diagnostics/agy-auth-latch.json` holding only the credential timestamp and the
refusal kind, clears connected state and publishes signed-out usage. The latch
survives engine restart; its file time is when it was written.

- `refused`: the measured clean signed-out answer (non-zero exit, no output).
  The silent check alone (never the requested command) may run again on a
  user's forced read at least 30 s after the latch, and otherwise once the
  latch is five minutes old (the usage loop and agent starts then check).
  This is needed because AGY refreshes its hourly token in place: the user's
  own AGY can make the stored credential valid again without a sign-in that
  would change its timestamp.
- `untrusted`: an OAuth/code prompt, or output the check is not known to
  produce. No CLI runs again until the credential timestamp changes.
- A bare-number latch from 4.3.0-alpha.3 or earlier counts as `refused`. A ten-second
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

## Transient wake checks (2026-10-17)

An inconclusive silent check must not require a second user message when a
brief retry can recover. Agent admission and process launch each retry at most
once after 500 ms for `Unavailable` or `Timeout`. Both attempts perform the full
guard again on the same account; the delay holds neither the guard mutex nor a
database transaction. Metadata-only gates defer transient failures to that
full check. A known signed-out or not-isolated account still stops immediately,
and output-limit failures do not retry. Background usage and identity reads
keep their previous single-check behavior and cadence.

If both admission attempts fail, the error remains visible and the mail stays
unclaimed. No transient failure writes a sign-out latch or becomes signed-out
usage evidence. The existing check/use race and prompt protections still apply.
Each subprocess keeps its eight-second bound; this change does not authorize
an interactive sign-in or infer that an unavailable account is authenticated.

Warnings contain fixed stage names and failure classes only: spawn, pipe/read,
wait, timeout, credential metadata before/after the check, a changed stamp, or
profile identity validation. They never contain stdout, stderr, an email, a
token or an OS error string. The retry warning records its fixed 500 ms delay.

`agy-auth-wake` uses a disposable fake fixture whose first check hangs and
whose next check succeeds. Red `6a2175f` against pre-fix engine `6f98248` had
three expected recovery failures and four passing timeout/signed-out controls.
Focused AGY units at `a3f723f` passed 40/40, including both transient classes,
success, hard refusals and the two-attempt ceiling. Those units and the original
red used `RUST_MIN_STACK=16777216` while a separate tool-catalog stack fix was
pending. After that fix landed, the debug engine at `910e200` passed
`agy-auth-wake` 10/10, `agy-auth` 38/38 and `agy-profile-accounts` 16/16 with
`RUST_MIN_STACK` absent. Production stack settings are unchanged.

The wider `agy-lane` proof initially passed 25/27 on both the retry candidate
and the unmodified integration baseline `b2b4fbd`. Its two old countdown
expectations contradicted the current fresh-reset rule. The separate test-only
correction `8500a4f` passed 27/27 against that same baseline engine with the
default stack. This is baseline attribution, not an additional run of the
corrected lane against the retry candidate. All runs used synthetic data and
fake CLIs; they do not establish real-provider behavior. Exact receipts are in
the docket; the combined hardening round owns release-profile checks.

## Version query (the one unchecked launch)

Settings → Harnesses needs the installed version whatever the sign-in state, so
discovery runs `agy --version` through `agy_auth::version` **without** the
silent check: still windowless, updater-disabled, closed stdin, 8 s bound and
prompt-watched. Only one short line starting with a digit is shown; anything
else is no version. Measured on AGY 1.3.5 (2026-10-14, one approved query):
exit 0 in 94 ms, stdout `1.3.5`, no CLI log written (no language server or auth
stack started), credential untouched. Builds up to 4.3.0-alpha.3 read the
version only after a passing check, so signed-out or latched installs showed
"unknown". No other AGY command may skip the check.

## Measured evidence and limits

Installed AGY 1.3.5 scratch probes showed that headless environment flags and
CREATE_NO_WINDOW with closed piped stdin **do not prevent OAuth**. Static code
orders OAuth startup before printing the auth prompt. Output interception alone
therefore cannot guarantee that a browser never opens.

The approved no-argument check-mode probe exited 1 in 94 ms with empty output
and no OAuth indication. A second approved probe, signed in (2026-10-14), exited
0 in 589 ms printing `Already authenticated as <account>` and a newline, with empty
stderr, and did not rewrite the credential. Builds up to 4.3.0-alpha.3 required
empty output, so they latched every valid sign-in. Static analysis follows main → RunLogin(CheckOnly) →
stored-credential validation, without interactive acquisition. The fake CLI's default
check answer reproduces the measured signed-in reply; these two real probes do
not prove every network-error case. This environment action is **undocumented**
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
