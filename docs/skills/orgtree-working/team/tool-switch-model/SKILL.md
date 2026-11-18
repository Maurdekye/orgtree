---
name: orgtree-tool-switch-model
description: Change a descendant's tier while accounting for queued turns, seat prices and provider-session boundaries.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_switch_model

Requires `team`. Required parameters are `node` (an agent below you) and `tier` (the desired catalog tier). Optional `model_version` is `"latest"` or an offered version key of that tier to pin. A seat's model version is **latest** or **pinned** (4.6.3, user 2026-11-18): latest, stored as no version, follows the tier's newest version, and a release that adds a newer one moves the seat at its next turn; a pin never changes. Without `model_version`, a move to another tier starts on its latest. No separate account, effort or harness parameter is exposed by this tool; use [retool](../tool-retool/SKILL.md) for its supported configuration fields. Top-level callers still cannot switch themselves, peers or other top-level seats.

Use [list tiers](../tool-list-tiers/SKILL.md) for identifiers and seat costs, then check current eligibility. Unknown/disabled/provider-ineligible tiers and account/catalog incompatibilities are refused. A higher live seat price needs additional free credits; allocation cascade can raise descendant grants only within the acting agent's budget. An archived seat can change tier without a live reservation; admission and its price apply when restored.

If a turn is running, the result has `queued: true`, `pending_switch` and any `replaced` intent. The current model does not change mid-call. A newer choice replaces the older one; choosing the currently active tier with no `model_version`, or with the version setting it already has, cancels a pending switch and returns `unchanged: true`. The same tier with a different `model_version` changes the seat's version: it applies at the turn boundary like a tier switch (queued behind a running turn) and the result names `model_version`, `resolved_version` and `model_id`. Applying a queued choice revalidates its authority/eligibility; failure can leave the old configuration and record a dropped intent. Inspect the resulting state before claiming the switch applied.

To apply a pending switch promptly, use `orgtree_interrupt` with `queued:true`
and `restart:true` on that descendant agent. It waits for a completion boundary; asynchronous
harnesses may cut off the next step near its start. Read the
[interrupt boundary table](../../runtime/tool-interrupt/SKILL.md).

Within one provider/harness, the saved session is retained when resumable. Crossing providers, or changing language model server harnesses, starts a fresh session with a summary and saved conversation file; the agent identity, scratch files and docket remain. Open questions from the replaced asking session become moot. A same-provider change normally retains account binding; a provider crossing selects the new provider's own login under ordinary admission rules. Preserved history does not guarantee a provider cache hit; model/provider/session changes affect the cache namespace.

```json
{"node":"draft-checker","tier":"sol"}
{"node":"sync-astra","tier":"astra","model_version":"latest"}
```

This assumes an authorized descendant and currently eligible Sol tier. Read returned `cascaded` and `warnings` for an applied change, or pending state for a queued one. This tool configures a seat; it is not a task message or permission to change the user's provider settings.

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-delegating](../delegating/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-charters](../charters/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
