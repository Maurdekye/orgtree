# Development storage in desktop agent subprocesses

Desktop agent children retain the engine transport required by authorized tools.
They also carry the parent data directory and the legacy `~/orgtree` directory
as accidental-access guards. Importing the repository's `store` without choosing
independent storage fails before storage is opened. The engine itself is not
tagged and continues to use its own authorized storage.

For a development script, choose a fresh absolute directory **before importing
store or modules that import it**, for example in PowerShell:

```powershell
$env:ORGTREE_DATA = Join-Path ([System.IO.Path]::GetTempPath()) ('orgtree-dev-' + [guid]::NewGuid())
python your_test_script.py
```

The chosen directory must not overlap the parent installation data or the
legacy data directory. Unset, relative, inherited live and legacy fallback
paths refuse; canonical paths account for Windows case and resolved aliases.
Existing focused tests that choose fresh temporary roots before imports remain
valid. Do not remove the guard variables to make a test pass.

Claude's orgtree MCP uses the explicit engine port and scoped token from its
MCP configuration. Codex's orgtree tool calls are dispatched by the engine;
neither needs to open generic child storage. This guard is not a security
sandbox: it does not prohibit intentional filesystem access, replace tool
authorization, or block coordinator-owned live operations. Old already-running
agent processes receive the guard only when a new child is started.
