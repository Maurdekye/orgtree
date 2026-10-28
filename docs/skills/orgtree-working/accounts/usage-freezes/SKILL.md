---
name: orgtree-usage-freezes
description: Explain usage holds, reset recovery and the separate effects of unstick, continuation and account marks.
---
Up: [orgtree-accounts](../SKILL.md)

# Usage freezes and recovery

A freeze is a durable hold with a reason, not an ordinary idle agent or a lack of a turn slot. Quota refusal, credential/authentication rejection, balance refusal, connection recovery and account-list exclusion can require different remedies. Read the actual cause and retained request before advising recovery.

## Reset recovery

A valid quota deadline schedules reset recovery with a 60-second grace. A timer belongs to the exact freeze it was scheduled for; it cannot erase a replacement freeze. Pure connection retry uses no quota grace and can bypass auto-resume when it is not also a limit freeze. Authentication/balance causes do not gain automatic quota recovery simply because a timestamp exists.

For a qualifying quota refusal on the shared non-Muse path, no parseable future
reset produces a one-hour fallback deadline; it does not invariably require
manual release. Muse keeps its typed quota reset authoritative and leaves
untyped generic errors on their own recovery path. A fallback is a retry
schedule, not evidence of newly available allowance.

Reset evidence can be a reported relative duration, an ISO timestamp with
offset/UTC, or a clock in the CLI host's local zone. A clock already passed
rolls to the next day; an unknown named zone is not guessed. A new refusal's
relative duration reanchors then. Applicable future deadlines are not shortened
to a retry floor. A successful same-account usage observation at or after that
refusal, in the matching/applicable full window, may extend the hold; stale,
failed or unrelated-window cache data cannot shorten or manufacture recovery.

Quota auto-resume follows the org's effective policy. If it is off when a deadline is due, the engine retains the hold and rechecks the setting every 30 seconds; changing the setting does not require restarting the engine. A passed deadline is not a guarantee the provider will accept the next request. A separate halt still prevents work.

A Codex request-rate 429 (`exceeded retry limit, last status: 429 Too Many Requests`) is not a quota refusal. With no usage-limit words, no `usageLimitExceeded` tag and no known-exhausted window it freezes for a short retry instead: the provider's `Retry-After` when relayed, else 60 s doubling to 300 s, five attempts, then the failure is reported to the agent and its superior. The badge says rate-limited with the retry time, and the org chart says `frozen (rate-limited, retrying)`. Other lanes keep their quota reading.

The freeze can retain the request refused before it received an answer. Recovery queues wake text with that held request rather than silently dropping it.

## Choose the remedy

| Situation | Relevant operation |
| --- | --- |
| Release the freeze and retry the current account, with authorization | [unstick](../../runtime/tool-unstick/SKILL.md). Read its scope and release behavior. |
| Explicitly move to an eligible same-provider account and release the freeze | [continue-on](../tool-continue-on/SKILL.md). Read its destination gates and transaction effects. |
| Inspect or remove an obsolete recorded account-pool mark | [account-mark](../tool-account-mark/SKILL.md). A clear resumes nobody. |
| Need current saved quota evidence before deciding | [usage](../tool-usage/SKILL.md). Unknown values are not room. |

Clearing a mark and releasing a seat's freeze are separate. An account may retain another applicable mark, and an apparently resumed seat may still be halted. Do not repeatedly clear/retry a still-exhausted provider. Authentication requires sign-in repair and a balance failure requires its stated billing remedy; neither is proven fixed by removing a local record.

Automatic account fallback is governed by [account lanes](../account-lanes/SKILL.md), not by blanket permission to switch providers or bill a key. At a qualifying turn-end quota freeze, the engine reloads the agent's fallback setting and tries eligible destinations after settling the turn. Native Claude/Codex logins can follow registered subscriptions even without registry rows; existing native-login, org, quota and fresh-room gates still apply. With no eligible destination the agent stays frozen and retains its reset/manual-recovery paths. For the user's auto-resume control, see `orgtree-org-autonomy` (orgtree-app › org-settings).

## See also

- [orgtree-tool-unstick](../../runtime/tool-unstick/SKILL.md)
- [orgtree-tool-continue-on](../tool-continue-on/SKILL.md)
- [orgtree-tool-account-mark](../tool-account-mark/SKILL.md)
- See `orgtree-org-autonomy` (orgtree-app › org-settings).
