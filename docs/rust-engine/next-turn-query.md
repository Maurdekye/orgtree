# Self-only next-turn query

Agents need to inspect prefix changes and compaction evidence during their
turn. `orgtree_next_turn {}` is an always-available read, authenticated by
its caller. It names no target, rejects every argument and has no mutation,
inference, provider-probe or queued-intent application path.

## Contract

The latest user rulings on `agent-tool-is-my-prompt-cache-dirty-and-will-i-c`
(2026-10-16 12:17-12:19Z) supersede the initial timing proposal. Dirty means
only changed prefix or namespace. The answer contains no retention timing
fields, and never promises a provider cache hit. Dynamic envelopes, elapsed
time and effort-only edits do not themselves invalidate an unchanged prefix.

The actor compares its current plan against an independent delivered-prefix
record, with the existing aggregate cache fingerprint as legacy fallback.
The private record lives in `ot.agents.extra.next_turn_baseline`; recording
is at actual turn opening, independently of positive cache receipts, so
unsupported cache lanes also retain instruction evidence. Queries never
update it. A failed record write leaves evidence unknown without failing
the already-opened turn.

The fingerprint carries a per-file hash-only instruction manifest and the
native compaction setting used at launch. These metadata do not enter
fingerprint equality or alter existing process/reset policy. The tool-list
fingerprint now includes the actual scoped Orgtree definitions, covering
definition changes as well as group grants. Both this tool and the parallel
session-control tool are intended to ship together, for one prefix change.

Mirrored own/granted instruction text is read once for both the identity and
manifest. Personal globals reuse their existing deduplicated snapshot;
native file signatures reuse the launcher inventory. org.md, shared and
every held team's notes use the exact context text supplied to the plan.
Rows expose only path/source/status/effect. Missing historical manifests
and unreadable evidence remain unknown. Ordinary scratch files are excluded.
An absent current file is removed; a file that stops participating through
native override selection is also removed from this instruction inventory.

All file edits take effect at the next fresh/resumed process start, never
inside the current turn. Shared/team notes alone do not replace a warm
process: their changed rows can coexist with a clean immediate next turn.
Native startup edits keep their existing replacement rules. The independent
record preserves the old copy across an engine restart and process closure.

Compaction reuses the existing forecast and cold-turn policy, including its
measured-context/admission gates. Latest live input occupancy is preferred;
otherwise the last completed-turn observation is labeled explicitly.
Native thresholds are reported from the retained process's recorded launch
setting, or current settings for a replacement. A harness threshold crossing
is evidence of pressure, never a guaranteed timing claim. Unsupported
harnesses, active-turn growth and missing evidence stay unknown. A queued
provider/harness crossing is labeled fresh_session rather than cheap_compact.
No compaction policy or cache receipt lifetime is changed by this feature.

## Verification boundary

Initial committed red `e855f8d` was executed by rig-sol-b against retained
`ca9da88`, engine/rs tree identical to required base `705a12b`:
two checks executed, existing-status/fake-session control passed, new-tool
dispatch failed as expected, EXIT 1 in seven seconds. Later branches were
explicitly not executed. Raw log and result inspected by the author.

Production compilation, focused helper checks and full green fake-CLI proof
are pending independent rig execution. No live provider, installed app or
device behavior is claimed.
