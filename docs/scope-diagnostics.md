# Scope diagnostics and harness reproductions

The `engine.backend.orgtree.scope_diagnostics` module explains one attempted
operation using already-authoritative facts. It is read-only: it never grants a
folder, changes a provider setting, launches a command, or retries a refusal.

Each report separates four layers:

* `org_grant` is the effective scratch or directory grant. The own scratch
  directory is writable even when an ancestor was supplied read-only, but a
  symlink or junction that resolves outside that root is a `path_escape`.
* `provider` is an explicit provider/OS observation supplied by the caller.
  The diagnostic never infers a restriction from a provider name.
* `sandbox` records whether the target is mounted in the supplied sandbox
  roots. Host-only paths are not treated as container paths.
* `tool` records a missing shell or MCP grant. A failed command does not widen
  any of these layers.

## Minimal reproduction recipe

Run a focused Python fixture from the repository checkout:

```powershell
python -m unittest tests.test_scope_diagnostics -v
```

For a shell mismatch, capture the exact exit code and stderr and pass the
result to `shell_result`. For example, a Windows service shell reporting
`'grep' is not recognized` is a `command_failed` provider/OS result. The
diagnostic keeps the stderr and does not suggest switching shells as a way to
evade a genuine refusal.

For MCP mismatches, pass the active registry, the effective grant and the
runtime-observed tool list to `mcp_tool_names`. It uses the same grant/ceiling
intersection as the launcher and emits only exact `mcp__server__tool` names.
When runtime tools are unavailable it emits no fabricated tool names; use
`mcp_prefixes` only for names that were actually observed. MCP cards use the
wire field `inputSchema`; `schema_names` reports `ArtifactMetadata` only when
an active card declares that object.

Nested Git ownership is reported from the nearest `.git` marker, but the owner
must be supplied by the registered application map. A path, branch name, or
repository location never creates an owner claim by itself.

External faults remain blocked with the captured owner and reproduction
command. An empty nonzero result is called an in-flight external fault only
when the process started and no result boundary arrived; it is not silently
reclassified as an access grant or permission refusal.
