# Continue a frozen agent on its native primary account

`orgtree_continue_on` and the user's `/nodes/{node}/continue-on` route resolve
`primary`, `default`, and the target provider's `<provider>/primary` identifier.
Whitespace is trimmed. The native providers are Claude, OpenAI and Google.
A qualified identifier must match the target's current tier provider. Empty,
unknown and mismatched targets are refused before any continuation write.
OpenRouter and language servers retain their explicit key/server targets; this
change does not introduce native primary aliases for them.

Primary means the provider's ambient sign-in and stores `account = NULL`.
It does not inherit the old secondary binding or the org's hiring default.
Registry IDs still store their existing binding and remain the response/audit
identifier. Automatic account fallback remains registry-only.

The shared resolver checks origin visibility and the org lane allowlist, provider
activation, the account's active switch, published native CLI/sign-in state or
registered authentication state, tier-specific account marks and cached usage
windows. Recent negative native authentication evidence is also refused; its
cache expires at 900 seconds. Missing or stale authentication/usage evidence is
unknown, never a zero-percent reading or permission to erase a capacity mark.
Manual continuation retains the existing unknown-usage policy: a signed-in,
active target is allowed unless there is positive evidence that it is exhausted.
Automatic fallback continues to require proven room.

Marks on ambient registry rows also constrain primary aliases. Continuation
never deletes account marks or writes a usage reading, and performs no provider
request or credential read. The frozen secondary's mark survives moving away.

The runtime locks the live agent row in its org, validates its current tier,
and commits its binding, cleared pending account/freeze/limit lock, audit event
and pending system replay mail in one short transaction. A failed audit or mail
write rolls everything back. Reconfiguration, record/mail notifications and
the wake happen after commit. The replay preserves the held request. An actual
lane change records `cache_namespace_changed` and explains the new provider
cache namespace in the wake; this is not a claim of a measured cache miss.
The actor's existing account fingerprint and native-home launch paths apply.

The backend-generated frozen-agent UI list includes an eligible primary lane
when the agent currently has a separate account binding. Each selected entry
is revalidated at execution; stale UI choices cannot bypass eligibility.
The tool retains its existing self/downward authorization gate.

## Focused verification

`tools/rig/proofs/continue-primary.mjs` drives tool and user routes on disposable
PostgreSQL and fake Codex homes/CLIs. It covers aliases, native binding and real
fake-CLI replay, candidate visibility, provider/permission/activation/org refusals,
session and weekly exhaustion, recent negative auth evidence, preserved marks,
registered continuation and transactional audit/mail fault injection.
Its `--signed-out` mode removes only the run's fake native login before discovery.
`continuation_auth_tests::cached_auth_is_tristate_and_expires_at_boundary` checks
absent flags, explicit flags and the 900-second boundary without a provider call.

Use explicit existing engine and fake-CLI paths with the supported rig; the rig's
default cargo target guard predates the current C-build-output ruling. This fix
does not change that unrelated shared helper. Actual measured results belong in
the ticket evidence, not inferred from these proof definitions.
