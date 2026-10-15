---
name: orgtree-tool-continue-on
description: Move a live descendant to an eligible account of the same provider and release its freeze with held work preserved.
---
Up: [orgtree-accounts](../SKILL.md)

# orgtree_continue_on

Use this tool when authorized to move a frozen descendant to another eligible account of the same provider and continue its held work. It changes account/session configuration and can start a new provider-cache namespace. It does not grant accounts, clear account marks, change provider/model, or release a halt.

The short tool description emphasizes frozen recovery, but the implementation also accepts an unfrozen live descendant. That case performs the account switch and queues a wake, returning `switched_nothing_to_release`. Do not use it as a harmless eligibility probe or a routine balancing read.

## Access and parameters

Requires the inherited **runtime** tool group. Both top-level and nested callers can target only their strict descendants in their own org, including descendants beyond direct reports. You cannot move yourself, a peer, a superior, or an unrelated agent with this tool. A user audience does not change that rule.

| Parameter | Required behavior |
| --- | --- |
| `node` | Nonempty agent name in the caller's org; an optional leading `@` is accepted. The target must be live and strictly below the caller. There is no batch form. |
| `account` | Nonempty exact registered account ID, or a native-primary alias. The destination must belong to the target's current provider. Labels/email are not account-ID selectors here. |

Both fields are required; there are no default target or account values. Strings are trimmed. Minimal call, assuming `worker` is your live descendant and the account is allowed and eligible:

```json
{"node":"worker","account":"openai-1"}
```

`primary`, `default`, or the matching `<provider>/primary` select the provider's native sign-in and store an unbound native account. Supported native providers are Claude (`claude`), OpenAI (`openai`), Google (`google`), and Muse (`muse`). A primary alias naming a different provider refuses. OpenRouter has peer `openrouter-N` key IDs and no native primary; language servers have no native primary for this operation.

## Destination checks

Before changing the binding, freeze, queued account or wake mail, the engine validates:

- The registered account exists with permitted origin and matches the target provider.
- The org account list allows the destination lane, and provider/account activation permits it.
- The destination is not known unauthenticated; a native sign-in also needs an installed/connected CLI and no current cached reauthentication requirement.
- Applicable active marks and full usage windows do not exclude this tier. Native aliases share their physical login's marks/auth/usage evidence: `primary` is not an escape from a marked native-home registry row.
- For Muse, the destination login's own catalog offers the exact model, including a pinned version. Another login's catalog does not establish entitlement; an unknown catalog refuses.

The generic eligibility resolver reads published snapshots, not a fresh quota probe. Muse additionally refreshes the target login's catalog before the transaction, subject to its ordinary bounded/recent-read rules. A successful manual continuation is not a new measurement of remaining quota, nor does missing usage establish proven room. The automatic fallback policy has its own stricter room-proof and opt-in rules; this explicit command is not that fallback process.

## What success changes

The transaction stores the destination binding, clears `pending_account`, clears `frozen`, resets `limit_locked`, records the switch event, and queues wake mail together. That mail includes the request preserved by the previous freeze when one exists. After commit, the runtime is told to reconfigure and wake. Account marks are left intact; a halt is left intact.

The returned object includes:

| Field | Interpretation |
| --- | --- |
| `switched` | `true` after the committed operation. |
| `resumed` / `status` | `true` / `resumed` describe the release/wake operation; they do not prove a model turn has begun or overcome a separate halt. |
| `state` | `continued` if a freeze existed; otherwise `switched_nothing_to_release`. |
| `account` | Destination registry ID or native lane. |
| `cache_namespace_changed` | Whether the previous and destination canonical account lanes differ. A changed lane starts a new cache namespace. |

Do not promise a cache hit from an unchanged lane or a resumed process. Other session/prefix/TTL conditions can still matter. Avoid gratuitous switching to balance an existing seat; place new work appropriately when possible.

## Refusals and recovery

- `` `node` is required `` / `` `account` is required ``: supply nonempty strings.
- `you cannot move yourself` or `you can only move your reports and their reports`: ask the appropriate superior; top-level callers have the same descendant restriction.
- `no agent named ... in this organization` / `that agent is not live`: verify the current name and lifecycle state.
- `no account ...` or `... is a ... account; this agent runs on ...`: use a permitted exact ID of the same provider.
- `... has no native primary account`: choose a supported explicit destination instead of a primary alias.
- An org-account exclusion, `... is inactive; nothing changed`, sign-out/reauthentication, `... is itself limited ...`, or `... is at its limit ...`: fix or choose an already-authorized eligible destination. Do not clear marks just to force a switch.
- Muse's model-not-offered or catalog-unknown refusal: use a login that actually offers the exact model/version, or explain the missing entitlement. Do not infer it from a bundled model name.

On a timeout or uncertain engine error, inspect current state before repeating a mutating call. Repetition can queue another wake. Use [usage](../tool-usage/SKILL.md) for read-only quota evidence and [account-mark](../tool-account-mark/SKILL.md) for stored marks. Releasing a freeze on the same account is covered by [unstick](../../runtime/tool-unstick/SKILL.md).

## See also

- [orgtree-account-lanes](../account-lanes/SKILL.md)
- [orgtree-usage-windows](../usage-windows/SKILL.md)
- [orgtree-usage-freezes](../usage-freezes/SKILL.md)
- [orgtree-cache-continuity](../cache-continuity/SKILL.md)
