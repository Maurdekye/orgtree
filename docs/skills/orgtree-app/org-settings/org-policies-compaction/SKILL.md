---
name: orgtree-org-policies-compaction
description: Explain the org's known-cold-session reset policy and occupancy threshold.
---

Up: [orgtree-org-settings](../SKILL.md)

# Reset before a known-cold turn

**Org settings > Policies > Cache-protective cheap compaction** contains two
org settings. Agents explain/suggest; the user changes them with the shared
footer Save in [orgtree-org-basic](../org-basic/SKILL.md).

| Control | Key | Default | Range/effect |
| --- | --- | --- | --- |
| reset a session before a known-cold turn | `org:auto_cheap_compact.enabled` | Off | Allows a fresh session with a summary before an eligible turn whose cache forecast is known cold. |
| only above a context occupancy of | `org:auto_cheap_compact.occ` | 25% | Shown while enabled; UI 5–95%, step 5. Stored as fraction 0.05–0.95. The endpoint clamps numeric values to this interval, refuses a non-number, and refuses a non-boolean enabled value. |

The runtime threshold comparison is **at or above**, despite the UI's "above"
label. Reset also needs measured context usage and window size, an existing
session, and a live eligible agent. An unknown cache forecast does not reset
the session. Agent-level overrides merge key by key over the org policy;
otherwise the effective org policy applies. A partial org save preserves the
other current policy value. An object naming neither value makes no change.

The switch does not reset a session when clicked: it changes eligibility for
later turn admission. It is distinct from the CLI's ordinary compaction
threshold in Basic. Cache expiry is not an editable timer here. Exact forecast,
cache-lane and handoff rules live in `orgtree-context-and-compaction`
(orgtree-working › runtime).

Suggest enabling it when the user prefers summarized continuity to sending a
large old conversation into a known-cold cache. Suggest a higher threshold to
retain more history before reset, or lower to reset smaller contexts. A summary
does not preserve every detail: durable working notes still matter. A local
process replacement alone is not proof of a cold provider cache.

## See also

- `orgtree-context-and-compaction` (orgtree-working › runtime).
- [orgtree-org-basic](../org-basic/SKILL.md).
