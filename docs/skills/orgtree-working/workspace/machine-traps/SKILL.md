---
name: orgtree-machine-traps
description: "Windows shell escaping, CRLF, encodings, Git Bash paths and file-edit pitfalls on the development machine."
---

Up: [orgtree-workspace](../SKILL.md)

# Machine traps and safe commands

This is the authoritative machine-traps page for agents developing Orgtree on
Windows. These are machine and harness working practices, not additional tool
permissions. Follow the current assignment for branches, output folders and
build authorization; old checkout defaults and historical test commands can be
wrong for the assigned release line.

## Write scripts to files before running them

The shell tool's surrounding transport has damaged backslashes even inside a
quoted Bash heredoc. Python and JavaScript string escapes became real newlines,
regexes broke, and Windows paths acquired control characters. Quoting the
heredoc delimiter does not protect against a layer outside Bash.

Write scripts containing backslash escapes (Python, JavaScript, Rust, regexes or
Windows paths) with the Write/file-edit tool or `apply_patch`, then run the saved
file. Do not send those scripts through a Bash heredoc, `-c` or `-e`. Write args
files with a file tool too: `printf` can interpret path fragments as escapes.
Use forward slashes in paths passed to PowerShell, Python and Node where supported.

Shell command text is executable code. Backticks and `$()` can execute even in
apparently quoted text; JSON stringification is not shell escaping. Never put
backticks in `git commit -m` from Bash. Write complex commit messages to a UTF-8
file and use `git commit -F <file>`. Avoid heredocs nested in command substitution.

The Edit tool has also been observed decoding a literal `\uXXXX` sequence in
`new_string` into the actual character, including invisible U+200B; `\n` remained
escaped in that incident. This is a reported harness quirk, not JSON's general
contract or a promise about every editor. When source needs a literal escape,
inspect the resulting bytes/code points and diff before staging it. A visually
unchanged line is not proof of identical bytes.

## CRLF and Unicode: inspect bytes

This repository's `.gitattributes` uses `* text=auto eol=crlf`, with LF for
`*.sh`. Existing working-tree endings still need checking. Git Bash text-tool
output (`grep`, `sed`, `od`) has hidden CR in past runs; it is not reliable
evidence of the original bytes. `sed -i` has silently converted CRLF to LF.

Use a byte read to count CRLF and bare LF before editing. Preserve the existing
ending using a file-edit tool, or read bytes, normalize for the edit, then restore
the original ending. Assert that the expected replacement count is nonzero.
Do not use `sed -i` on CRLF files. Python `newline=""` disables translation;
writing LF text that way does not preserve CRLF. Use explicit CRLF when normalizing
a known CRLF file, rather than normalizing every file indiscriminately.

For example, save this probe with a file tool, then run `python probe.py <path>`:

```python
from pathlib import Path
import sys
data = Path(sys.argv[1]).read_bytes()
print({"crlf": data.count(b"\r\n"),
       "bare_lf": data.count(b"\n") - data.count(b"\r\n"),
       "utf8_bom": data.startswith(b"\xef\xbb\xbf")})
```

After editing, inspect `git diff --stat`, `git diff` and `git diff --check`,
then recheck bytes. A passing whitespace check alone does not prove endings or
Unicode are preserved. Historical vector anchors hash CRLF bytes, whereas
migration checksums are LF-normalized; do not infer byte identity from a checksum
whose normalization you have not checked.

| Encoding trap | Safe way |
| --- | --- |
| Windows PowerShell 5.1 `>` and `Out-File` default to UTF-16. Default reads can misdecode UTF-8 without a BOM. | Read UTF-8 text with `Get-Content -Encoding UTF8`. Prefer a program's output-file option; for text use `[IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))`. |
| PowerShell 5.1 loads UTF-8 `.ps1` without a BOM using the legacy codepage. | Keep script source ASCII (construct a needed character with `[char]0x203A`), or explicitly load UTF-8/use a BOM where that script's consumer requires it. Built-in skill pages remain UTF-8 without a BOM. |
| `python -I` ignores `PYTHONIOENCODING`; redirected output can use cp1252. | In the saved script use `sys.stdout.reconfigure(encoding="utf-8")`, or write UTF-8 files directly. |
| Conflict text can become mojibake and be reused later. | Write resolutions as explicit UTF-8 bytes, then search for `â€` and `Â` and inspect each match before staging. |

## Choose the executable and path dialect explicitly

`bash` from PowerShell may resolve to `C:/Windows/system32/bash.exe` (WSL).
WSL does not share Git Bash's `/d/` and `/e/` drive mounts. Check `Get-Command bash`
and invoke Git Bash explicitly when that is intended:

```powershell
& 'C:/Program Files/Git/bin/bash.exe' tools/example.sh
```

Always set the command's working directory. An elevated shell can have a different
PATH, account and cwd; verify them there. Do not rely on a prior shell call's cwd.
Use `rg`, `rg --files` or `git ls-files` for scoped searches (fall back to native
tools when unavailable). Avoid recursive searches from a root containing hundreds
of worktrees. Filter `git worktree list` before printing it. Git on E: can take
minutes; allow time and do not kill it merely for being slow.

| Path or shell trap | Safe way |
| --- | --- |
| MSYS rewrites Windows slash arguments, including `cmd /c` and `/usage`. | Run Windows CLIs from PowerShell, or set `MSYS_NO_PATHCONV=1` for that Bash command. Check the actual argument list before paid commands. |
| Rig `step.sh` adapters convert the executable and workdir, but `/d/...` inside other arguments has become `D:\d\...`. | Pass every path inside adapter arguments in Windows form, `D:/...`. Do not assume all arguments receive `cygpath` conversion. |
| A quoted executable-plus-arguments string breaks at spaces in paths. | Invoke the executable with a separate argument array. For an explicitly assigned legacy P03 run, use its `-Run @('python', 'C:/path with spaces/probe.py', '--flag')` or `-Run 'python' -RunArgs @(...)` form. |
| Git Bash `/tmp` differs from Python's temp directory; a stray `os.py` shadows imports. | Use `tempfile.TemporaryDirectory()`/`tempfile.gettempdir()` in Python and `$env:TEMP` in PowerShell. Use a private subfolder and avoid standard-library filenames. |
| `%TEMP%` may contain an 8.3 short path that causes an unanswerable headless permission prompt. | Resolve it to its long absolute spelling before passing it to a permission-checked tool. |
| Windows has a 32,767-character process command-line limit. | Put large settings and payloads in files. |

Use one shell end-to-end for Windows filesystem changes. Resolve and check targets
before recursive removal or moving; never pipe enumerated paths into another shell
for deletion. Dependency junctions are especially dangerous: follow
[worktree and dependency safety](../worktrees-and-git/SKILL.md), including its
authorized removal checks, rather than deleting through a link.

### Watchdogs use a different shell environment

Command and stream watchdogs use the engine's PATH and the owner's scratch cwd,
not the current shell session. On Windows their default native shell is `cmd.exe`;
`find` means FIND.EXE, and `$VAR`, `/tmp`, `grep` and `$(...)` are not cmd syntax.

Unlike a bare shell invocation, the current Windows watchdog resolver already
prefers Git for Windows' fixed installation locations and skips the System32
PATH entry (`runtime/watchdogs.rs::resolve_bash`, verified at 4.3.1). Thus the
historical WSL watchdog trap is already addressed in source; no new fix is needed.
Use `shell: "bash"` for its `-lc` invocation. On older engines, a native-shell
target can explicitly invoke the quoted full Git Bash path with properly cmd-quoted
arguments, preferably a saved script. The `shell` enum cannot hold an executable
path. Read creation's smoke output: it must see the intended filesystem and
expected output. An armed watcher alone proves neither.

For watcher parameters and smoke diagnostics, see
[orgtree-tool-watchdog](../../watchdogs/tool-watchdog/SKILL.md). For the build slot
and owner-file handover, see [builds under the lock](../builds-under-the-lock/SKILL.md).

## Git resolutions and trustworthy command results

The shared repository may enable rerere implicitly through its existing rr-cache.
A bad resolution, including mojibake, can silently recur in another worktree.
Use `git -c rerere.enabled=false rebase ...` and
`git -c rerere.enabled=false cherry-pick ...`; inspect resolved text before staging.
Commit first, as described in [worktrees and git](../worktrees-and-git/SKILL.md).

| Result trap | Safe way |
| --- | --- |
| PowerShell 5.1 can turn native stderr into an error under `ErrorActionPreference=Stop`. | Preserve both streams and the child's actual exit code; stderr alone is not failure. The legacy P03 argument-list launcher inherited streams directly, but is not the current Rust build lock. |
| PowerShell `-match` ignores case; `@(...) + $null` adds an empty argument. | Use `-cmatch` for case-sensitive conditions, structured JSON for status, and construct argument arrays without null entries. |
| `DateTime.Parse('...Z')` converts to local time; this machine uses UTC+3 while org timestamps are UTC. | Use `DateTimeOffset` and explicit UTC when comparing deadlines. |
| `exec_command` returned a `session_id`. | The command is still running. Drain it with `write_stdin` and record its final exit before claiming completion. Keep long work in the foreground and finish owned children before ending the turn. |
| One Cargo target shared across source worktrees can report `Finished` while retaining another checkout's binary. | Prefer the assigned per-agent target. When intentionally switching checkouts in a target, under the authorized build phase clean the affected package (`cargo clean -p orgtree-engine`) and verify `Compiling orgtree-engine (<intended worktree>)` and the resulting binary. |
| Ambient Python paths import the installed 3.x app instead of the checkout. | Historical 3.x verification used `tools/run-python-verification.py`, `import_provenance` and the `tools/assert_repo_import.py` guard. These are retired for Rust 4.x work; use the assigned Rust/source checks. `python -I` alone did not fix the packaged runtime's `python313._pth`. |
| Windows `pg_ctl start` can leave PostgreSQL holding a captured pipe, hanging Python's `subprocess.run(capture_output=True)` even after readiness or during timeout cleanup. | Send launcher stdout/stderr to `DEVNULL` and use PostgreSQL's own `-l` log. Stop only the disposable cluster you own and verify it stopped before deleting it. |

The historical P03 slot queue, `artifacts/machine-test-run`, its `-Small` two-slot
mode, TTL/`-Dequeue` behavior and 15/10 GB commit-memory floors describe 3.x tooling.
They do not replace the current Rust machine lock, memory limits or output rules;
those have one home in [builds under the lock](../builds-under-the-lock/SKILL.md).
Disposable PostgreSQL clusters must run unelevated; a skipped or empty test run
is not a pass. Keep raw exit status, signal and spawn errors in the evidence.

## See also

- [orgtree-worktrees-and-git](../worktrees-and-git/SKILL.md)
- [orgtree-builds-under-the-lock](../builds-under-the-lock/SKILL.md)
- [orgtree-tool-watchdog](../../watchdogs/tool-watchdog/SKILL.md)
