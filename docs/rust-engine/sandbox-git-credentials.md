# Git credentials inside the Windows sandbox

Status (2026-10-11): host-slot and native askpass implementation are ready for source review. The user requires sandboxed Codex and working Git together before alpha.10. No sandbox or machine ACL changes have been made.

## Cause and grant options

Measured with installed Git 2.52.0.windows.1: sandboxed `git credential fill` starts MSYS `sh.exe`, which fails during startup with Win32 error 5 creating its signal pipe. A plain absolute executable path without spaces still invokes sh: Git appends the operation to one command string and sets `use_shell`. A short path or executable copy does not fix that. Evidence: `native-helper-launch.log` and the codex-host rig result from 12:55Z.

Source inspection: MSYS `sigproc_init` creates the signal pipe with an explicit user security descriptor (`sec_user_nih`), before executing the requested script. Restricted-token access must pass the restricting SID check as well as the ordinary user check. This explains the observed access denial; we have not traced the failing Windows syscall on this installation. A filesystem writable-root grant does not grant access to this kernel pipe. No documented per-pipe Codex grant was found. Adding the real user's SID to the unelevated restricting set would broaden writes beyond the workspace and is not acceptable. OpenAI's related upstream fix deliberately adds the dedicated sandbox user's SID only in the elevated runner, leaving the unelevated path unchanged. Switching implementations requires separate provisioning and testing; it is not a demonstrated local fix.

Sources: [MSYS signal initialization](https://github.com/msys2/msys2-runtime/blob/master/winsup/cygwin/sigproc.cc), [upstream Codex pipe fix](https://github.com/openai/codex/pull/20270), [reported Git Bash failure](https://github.com/openai/codex/issues/15016), [official sandbox modes](https://learn.chatgpt.com/docs/windows/windows-sandbox).

## Recommended route: native askpass

Git's `prompt.c` starts `GIT_ASKPASS` with executable and prompt as separate argv entries, without `use_shell`. Use a static native alias of the engine executable, dispatched before tracing, with the existing process capability and bridge endpoint. Return only the requested username or password; never cache credentials on disk. Keep all existing helpers ahead of it, preserve the previous askpass fallback on a bridge miss, and keep terminal prompting disabled as today. Existing helper failures can still print diagnostics inside the sandbox before askpass succeeds.

Git supplies a formatted prompt, not the helper's structured protocol. Process-local `credential.sanitizePrompt=true` is needed to encode fields unambiguously; decoding must preserve explicit port, path, username and percent characters, reject controls and unsupported protocols, and never infer one host from another. Each username/password invocation may do a fresh lookup. Store/erase remain with Git's configured helper chain; Orgtree's current helper already does nothing for those operations. No change to the independent gh adapter or explicit GH token precedence is needed.

Behavior approved by the coordinator (13:03Z): `credential.interactive=false/never` prevents askpass entirely, unlike the existing helper; behavior is to honor that explicit setting rather than override it. Sanitized prompt formatting is another visible but credential-preserving change. Existing custom askpass fallback must retain Git's precedence (GIT_ASKPASS, core.askPass, SSH_ASKPASS), including empty values, and must not recurse into the bridge.

Sources: exact installed-version [prompt.c](https://github.com/git-for-windows/git/blob/v2.52.0.windows.1/prompt.c), [credential.c](https://github.com/git-for-windows/git/blob/v2.52.0.windows.1/credential.c), [run-command.c](https://github.com/git-for-windows/git/blob/v2.52.0.windows.1/run-command.c).

## Alternatives and effort

An upstream MSYS/Codex compatibility fix would preserve every helper unchanged, but requires a dependency fix and broad sandbox regression testing. Replacing Git or proxying all Git commands through the helper is substantially wider and would risk running repository hooks outside the intended sandbox; reject that route. A native Git shim limited to credential operations still needs askpass for HTTPS authentication and adds PATH interception complexity.

Recommendation: askpass with strict target parsing and unchanged helper precedence, with the coordinator behavior approval at 13:03Z. Estimated work: 1–2 hours for implementation, unit checks and the requested six-case real CLI/bridge proof. The alpha.9 helper-only baseline reproduction and final outcomes will be added below. Real Session-0 fallback placement remains a next-alpha live check; the rig can measure fallback policy and direct parentage from its own Session 1.

## Measured acceptance (2026-10-11)

Engine commits a4334d5 and d795c5f, desktop recursion-filter commit 5c24d33.
Cargo check passed, workspace unit tests 75/75, renderer/desktop typecheck passed.
All CLI proofs used installed real Claude Code/Codex with a scripted loopback model
endpoint; no model generation was purchased. Brokers used their production code.

| Proof | Result | Evidence folder under the agent's D: rig evidence root |
| --- | --- | --- |
| Unmodified alpha.9 helper-only baseline | 29/29; reproduces MSYS pipe failure | codex-host-baseline-20261011T130857 |
| Native askpass protocol and precedence | 14/14 | git-askpass-20261011T131359 |
| Desktop credential holder + standby host, leases, sandbox, helper death | 39/39 | codex-host-20261011T131404 |
| Default network policy, explicit escalation | 38/38 | hosted-git-20261011T132045 |
| Rig-only network enabled, sandboxed Git OpenSSL | 38/38 | hosted-git-20261011T132303 |

Both matrices cover hosted Session-1 sandboxed Codex, direct bypass Codex and
Claude Code, first with the desktop owning credentials and then with only the
sign-in helper. Each passed synthetic and GitHub `git credential fill`, public
repository `git ls-remote`, and authenticated `gh auth status`. Credential values
were checked in memory and never recorded in evidence. The public ls-remote alone
does not establish authentication; credential fill and gh status provide that
separate evidence.

The default-policy proof explicitly requested require_escalated on the hosted
command. Captured real requests confirm its thread remained workspace-write.
The other matrix enabled network_access only in the isolated rig Codex profile.
With network allowed, this machine's Schannel TLS backend failed inside the
restricted token with SEC_E_NO_CREDENTIALS, before Git authentication. That matrix
therefore selects `git -c http.sslBackend=openssl` for the hosted test command,
with certificate verification still enabled. Neither workaround changes production:
network access still needs escalation, and default-policy escalated Git succeeds
with the machine's normal TLS backend.

The protocol proof uses synthetic credentials to compare old appended helper and
new askpass paths. The configured store receives exactly get,store in both cases;
there is no additional credential-store write. Actual user-store checks are read
only. Original GIT_ASKPASS and core.askPass both run on bridge misses, unknown
prompts reach the original without any bridge call, explicit empty overrides and
SSH_ASKPASS precedence are preserved, and encoded username/port/path round-trip.

The co-existence proof checks host replacement rejection, lease separation,
read-only denial, workspace writes, helper death, and one direct-fallback log line.
The rig engine itself runs in Session 1 and forces Session-0 policy selection;
actual boot-engine Session-0 fallback placement still needs the alpha.10 live check.
A configured MSYS helper can emit signal-pipe noise before native askpass succeeds.
No sandbox or ACL grants were changed. Temporary scheduled tasks were removed.
The authorized temporary profile rig-state folder was removed after the proofs;
build output and retained evidence stay on D:.
