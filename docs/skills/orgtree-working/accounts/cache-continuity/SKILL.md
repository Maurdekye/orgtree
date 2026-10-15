---
name: orgtree-cache-continuity
description: Explain cache namespaces, prefix changes, receipt lifetimes and the limits of cache forecasts.
---
Up: [orgtree-accounts](../SKILL.md)

# Provider cache continuity

A warm local CLI and a provider prompt cache are different. Restarting the local process alone proves neither a miss nor a hit. Treat any provider, account/auth lane, model or session switch as a new cache namespace. A provider change can also lose provider-specific context/session continuity.

## Prefix changes versus new turn data

Rewriting already-sent system/startup text, charters, scope, tool/MCP definitions, startup instruction files or conversation history changes the prompt prefix. Avoid unnecessary changes, and explain the cache cost of necessary ones.

Append-only turns, dynamic org state, mail/notices, usage/status/checkup facts, attachments, live counts and an effort-only control change do not by themselves invalidate an unchanged earlier prefix. This does not mean appending content is free; it means the earlier prefix was not rewritten.

## Receipts and estimates

| Route | Continuity guidance |
| --- | --- |
| Claude subscription authentication | One-hour guidance; actual receipt metadata can distinguish one-hour and five-minute writes. |
| Claude API-key authentication | Five-minute guidance. |
| Codex subscription authentication | Fixed 30-minute estimate; not a guaranteed retention period. |
| Muse | Cache reads can be observed, but no published TTL or prices; expiry/cost remain unknown. |
| OpenCode custom providers and language servers | No verified cache lifetime in this integration; unsupported/unobserved stays unknown. |

The forecast compares the sent fingerprint and current plan, then considers positive cache-read/write receipt and expiry. It distinguishes no completed fingerprint, changed prefix, no positive receipt, unsupported capability, expired entry and compatible observed entry. Read its actual cause and receipt time. Matching unexpired local evidence demonstrates compatibility, never a promised future provider hit.

Native startup-file edits are included in launch fingerprints and can replace a parked process for the next turn while preserving session identity. Session identity alone does not make the prefix unchanged. Org/team shared notes have their own session-start copy behavior; use the relevant instruction-sharing leaf rather than assuming every edit reaches a warm CLI immediately.

## Compaction and account moves

Known-cold forecasts can participate in the configured automatic cheap-compact policy when measured context occupancy qualifies. Unknown forecasts do not justify a reset. See [context and compaction](../../runtime/context-and-compaction/SKILL.md) for lifecycle mechanics, and [account lanes](../account-lanes/SKILL.md) before proposing a move for capacity.

When explaining a proposed change, name what changes—account namespace, model/session or startup prefix—and what is actually observed. Do not turn “process warm,” “same account,” or “resumed” into a cache-hit claim.

## See also

- [orgtree-context-and-compaction](../../runtime/context-and-compaction/SKILL.md)
- [orgtree-account-lanes](../account-lanes/SKILL.md)
