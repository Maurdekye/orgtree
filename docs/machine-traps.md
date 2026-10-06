# Machine traps and safe commands

> **Orgtree 4.0.0 (2026-10-06):** the shell traps in the table still apply to everyone. The
> *Test slot and queue* section (the P03 run lock) and the `PYTHONPATH` / import-provenance row
> are for the 3.x Python engine and its test suites; 4.0.0 prototype work runs no unit-test suites
> ([DECISIONS 8, 33](rust-engine/DECISIONS.md)). See [AGENTS.md](../AGENTS.md#orgtree-400-rust-engine-read-this-first).

Use an explicit working directory for every command. Work in your own worktree
under the repository's `.worktrees` folder; dependencies resolve upward. Never
junction, symlink, or copy `node_modules`. Scope searches to tracked directories:
`rg`, `rg --files`, or `git ls-files`; filter `git worktree list` before printing it.

| Trap | Safe way |
| --- | --- |
| Long Bash heredocs, especially JavaScript with backticks and backslashes, can be damaged by shell quoting. | Write scripts with the file-edit tool or `apply_patch`. Run the saved file with its interpreter. Do not write JavaScript through a Bash heredoc. |
| `.gitattributes` requires CRLF for most text. Python `newline=""` disables translation and can turn the entire file into LF. | Preserve the existing ending, or open with `newline="\r\n"` when writing normalized text. Inspect `git diff --stat` and `git diff --check` afterward. Shell scripts use LF. |
| Git Bash `/tmp` and Python's temporary directory can be different; a stray `os.py` in a temp directory can shadow imports. | Use `tempfile.TemporaryDirectory()` or `tempfile.gettempdir()` in Python, and `$env:TEMP` in PowerShell. Use a private subfolder and avoid standard-library filenames. |
| Windows PowerShell 5.1 can treat native stderr as an error under `ErrorActionPreference=Stop`. | Use the tracked `tools/p03-run.ps1` argument-list launcher, which inherits both streams directly. Judge the child's exit code. |
| PowerShell 5.1 `>` writes UTF-16 rather than UTF-8. | Prefer a tool's `--json-output`. For text, use `[IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))`. |
| MSYS rewrites Windows slash arguments, including `cmd /c` and `/usage`. | Run the Windows CLI from PowerShell, or set `MSYS_NO_PATHCONV=1` for that Bash command. Check the final argument list before running a paid command. |
| Elevated shells can inherit different PATH, account, and working-directory settings. `Get-Command bash` may find WSL. | Specify the working directory and executable path, and verify identity in that shell. Use Git Bash's explicit executable path when Git Bash is intended. |
| A quoted `-Run` string breaks when executable/script paths contain spaces. | From PowerShell, pass an array: `& tools/p03-run.ps1 -Agent example -Wait -Run @('python', 'C:\path with spaces\probe.py', '--flag')`. Or use `-Run 'python' -RunArgs @('C:\path with spaces\probe.py', '--flag')`. |
| PowerShell `-match` ignores case, which can make retry conditions match unrelated output. | Use `-cmatch` for case-sensitive matching; prefer structured JSON status to text matching. |
| Ambient `PYTHONPATH` can import the installed app instead of the checkout. | Use `python tools/run-python-verification.py tests/test_name.py` and read `import_provenance`. Tests import `import_provenance`; scratch Python probes start with `tools/assert_repo_import.py`'s guard. |

## Test slot and queue

The tracked source is `tools/p03-run.ps1`. Its default lock directory is the
shared `artifacts/machine-test-run` directory, so it respects existing holders.
Do not replace an active wrapper during a release. `-LockDirectory` is for
disposable wrapper tests; real test runs use the default shared directory.

`-Wait` registers or resumes the caller's agent/candidate queue entry and waits
in the caller until its FIFO turn and the required slots and memory are free.
Waiters refresh their entry's TTL. `-Status` prints JSON with slots, active
holders, last-holder history, baseline processes, free commit memory, and queue.
An entry is consumed only after successful child process creation; a launch or
job setup failure preserves it for retry. A child that starts and exits nonzero
has used its turn. `-Dequeue -Agent example` cancels that agent's entries.

Heavy runs hold both slots; `-Small` permits two small runs. The default memory
floor is 15 GB, with the existing second-slot floor checked as well. The wrapper
stops a continuing run if free commit drops below 10 GB. Child processes belong
to a Windows kill-on-close job, so wrapper death kills the covered process tree.
Legacy single-string `-Run` commands remain supported for existing callers;
argument lists are preferred and bypass shell interpretation.
