# Compact Orgtree tool cards (4.4.0)

Agents receive a short call contract and an `orgtree-tool-<name>` glossary pointer
for each permitted Orgtree tool. The guide owns procedures and extended examples.
Cards retain the immediate constraints: mail metadata before body, recipient and
attachment authority, explicit hire fields, docket ownership/attention rules,
watchdog execution authority, and document/file delivery distinctions. Input
schemas, property order, required fields and tool handlers keep their existing
behavior. Both split and Antigravity flat mail shapes remain supported.

`tools::defs::deferred` explicitly selects 23 less frequent lifecycle, placement,
account-recovery, Logo, transfer and request tools. Their
`_meta["anthropic/alwaysLoad"]` hint is false; the other 22 cards remain eager.
The Claude SDK server definition no longer forces every card eager. Native tool
search may discover the rare tools when the receiving Claude client supports
this metadata and enables search. The tools remain callable and keep the same
permission checks. Scope-denied groups are still omitted altogether.

This is an advertisement policy, not an instruction to use another account or
harness. Other harnesses receive the compact cards; no native deferral capability
is claimed for Codex, Antigravity, Muse or OpenCode. Client thresholds, wrappers,
tool-name listings and native prompts can change actual provider input. A hint
does not prove the client deferred a schema or that the model can find it.

## Focused evidence

Before implementation, exact `d53ddd5` produced ten canonical JSON measurements
(five harnesses, all groups and all groups off). Split mail: 45 cards, 55,285
bytes, including 21,598 description bytes. Flat mail: 45 cards, 54,658 bytes,
including 21,417 description bytes. All groups off: four cards, 3,074 bytes.
The description/pointer and rare-card tests failed at their intended assertions;
the measurement test passed.

The compact candidate measured these canonical byte counts; final focused checks
and full per-harness receipts accompany the exact-SHA hand-in:

| Shape/profile | Before | Compact | Compact descriptions | Eligible eager cards/bytes |
| --- | ---: | ---: | ---: | ---: |
| Split, all groups (Claude/Codex/Muse/OpenCode) | 55,285 | 44,468 | 10,733 | 22 / 32,661 |
| Flat, all groups (Antigravity) | 54,658 | 43,841 | 10,552 | 22 / 32,034 |
| Either, all groups off | 3,074 | 2,218 | 1,058 | 4 / 2,218 |

Split-card bytes fall by 10,817 (19.6%); descriptions fall by 10,865 (50.3%).
The four always-available cards remain when every optional group is denied.
Eligible eager totals are conditional hint budgets, not measured native input.

The unit guard caps each description at 900 UTF-8 bytes and the combined set at
12,000, verifies every guide exists, and checks common/rare metadata plus denied
groups. Saved before/after card JSON permits exact comparison after removing
only top-level descriptions and metadata. This preserves schema descriptions,
required fields, names and ordering too. Token figures use inferred `ceil(bytes/2)`
for the requested comparison; they are not provider-token measurements. The
separate live startup audit showed that this estimate overstates that sample.
