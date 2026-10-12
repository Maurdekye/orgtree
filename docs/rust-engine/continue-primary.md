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

All unexpired observations of the physical native login constrain continuation:
the canonical native cache key and each ambient registry row's explicit home
key are inspected for quota and negative authentication evidence. A quieter or
missing alias reading cannot erase another alias's positive exhaustion evidence.
The same rule applies to an explicit ambient account ID and to primary aliases.

Claude authentication evidence is dated separately from retained last-good
usage bars. Production result processing and isolated canned results share the
same helper. A failed authentication is remembered without refreshing either
the bars' insertion age or their `observed_at`; cooldown and transient failures
do not clear or re-date it. A genuine successful read replaces the negative
evidence. Authentication flags remain tri-state and expire at 900 seconds.

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
The production-result tests cover recent and stale good bars followed by negative
authentication, independent evidence age, transient/cooldown preservation and
later successful authentication. Route checks include explicit native-home
exhaustion with a quieter canonical cache and no capacity mark.

Use explicit existing engine and fake-CLI paths with the supported rig; the rig's
default cargo target guard predates the current C-build-output ruling. This fix
does not change that unrelated shared helper. Actual measured results belong in
the ticket evidence, not inferred from these proof definitions.

Measured 2026-10-11: scoped `cargo build --locked -j2 -p orgtree-engine --bins
--tests` passed (6m58s); the focused cached-auth test passed 1/1. The supported
rig passed 38/38 continuation checks and 3/3 signed-out checks, including replay
turns completing without errors on all three native providers. Both runs were
stopped and deleted. No live provider, credentials or hierarchy were exercised.
The compiler's sole warning was a now-removed unused import in `tools/control.rs`;
that one-line import deletion happened after the measured build and proofs,
without changing their executable behavior or rebuilding the binary.

Round-1 review found two gaps in that first proof: ambient explicit-home cache
readings were bypassed, and production Claude last-good fallback did not store
negative authentication. Measured predecessor controls on 2026-10-12 reproduced
all three ambient quota route failures and the production-result unit failure
(expected `Some(true)`, got `None`). The corrections and expanded proofs require
new green receipts before review; the earlier counts do not establish them.

Measured correction verification 2026-10-12 at runtime source `110c2fe`:
scoped engine build passed in 1m17s without warnings; all 3 focused auth tests
passed. The expanded supported continuation proof passed 46/46, including the
three formerly failing ambient quota refusals, both production-result Claude
auth refusals and explicit ambient auth aliases. Signed-out proof passed 3/3.
Every refusal checks binding, freeze, pending state and audit/mail counts remain
unchanged. Both runs stopped and were deleted; no live provider/auth data used.
Receipts: `continue-primary-20261012T001354/result.json` and
`continue-primary-signed-out-20261012T001451/result.json` under the author's
isolated rig evidence folder. The red production-result control at `9205997`
failed exactly on the missing cached negative auth, before the fix.

The usage-query owner will compose `cached_reauth_required` into its safe query
projection during checked integration; this branch supplies the independently
dated helper and continuation guard, and does not change the query tool.
Combined multi-key OpenRouter regression remains a separate integration gate.
