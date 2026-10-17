# Codex state isolated from the desktop application

Codex agents previously used the native or selected account's Codex home. The
normal Codex desktop application could consequently list their threads. Agent
launches, model discovery and usage probes now use private homes inside the
engine's existing data root.

## Storage and accounts

- Subscription profiles use `<data>/codex-home/<source-path-sha256>`. The native
  login is treated as a source profile too. Windows slash/case variants map to
  the same directory; source path strings cannot become directory traversal.
- API-key and OpenRouter agents retain their existing separate homes under
  `<data>/profiles`. They never receive the native account's copied credentials.
- Both `CODEX_HOME` and `CODEX_SQLITE_HOME` are set on the individual child
  process. Command-line `sqlite_home` and `log_dir` overrides beat explicit paths
  in copied configuration. No user-wide or Windows-wide variable is changed.
- Account identity, usage-cache keys, account marks and admission bindings still
  refer to the selected source account. Private storage creates no new provider
  account and adds no usage allowance.

## Bootstrap and sign-in

`runtime/codexhome.rs` creates the private home before starting the CLI. It copies
`config.toml` and global Codex instruction files only when the destination file
does not exist. They are independent files, not links to the source. Subsequent
configuration changes in either home do not overwrite the other home's settings.

The existing file-based sign-in cache is copied from the selected source profile.
An `auth-source.sha256` marker detects a changed source login; the next launch or
probe adopts that new source cache. While the source is unchanged, the private
copy's refreshed credentials are preserved. Copies are published through temporary
siblings, and token values are never passed to logged helpers or written to the
repository. On Unix, copied files are private to the owner.

The source profile is read only. A redirected private directory or a linked
private profile file is refused. Existing file-based provider detection remains
the contract; this does not add export of credentials stored only in an OS
keychain.

## Existing conversations and cache

Only an agent's matching rollout is copied when its current thread needs to be
resumed. The original rollout and the normal desktop's old conversation remain
untouched. Account switches search private homes as well as existing profiles,
so a thread's latest private history can follow the agent.
The newest private rollout by modification time wins, including when the target
already has an older copy. Source profiles are fallback inputs only until a
private copy exists; later desktop edits cannot replace the private conversation.

Startup fingerprints use the same private home as the actual CLI. The fingerprint
is recomputed after copying initial instruction files. Changing startup inputs
can change the prompt prefix and its cache compatibility; retaining a thread or
replacing a local process does not guarantee a provider cache hit. If resume fails,
the existing fresh-session handoff behavior still applies.

## Hosted launches and usage

The private home and SQLite/log overrides also apply when the sign-in helper
hosts Codex in a Windows user session and when the scoped tool catalog is probed.
Usage keeps the new HTTPS-first path; its app-server fallback still uses a private
home and exits gracefully. Language-server Codex homes join the private rollout
search when an agent changes accounts or harnesses.
