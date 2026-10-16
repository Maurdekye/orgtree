---
name: orgtree-tool-next-turn
description: Read your own next-turn prefix changes, instruction-file copies and compaction forecast.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_next_turn

Call with `{}` while planning the end of your turn. This is a read-only,
self-only tool, available with every Orgtree tool group switched off. It has
no arguments. A remembered `node`, refresh flag or any other argument is
refused: `orgtree_next_turn takes no arguments and reads only yourself`.
It never switches accounts, applies a queued request, starts inference,
compacts a session or probes a provider. All agents get the same behavior,
including top-level agents.

## Cache answer

`cache.dirty` is true for a known prefix or namespace change, false when the
recorded inputs are unchanged, and null when evidence is incomplete.
`reasons` names changed launch parts or queued namespace changes, without
auth details. Compatibility never promises a provider hit.

`instruction_files` lists the actual launch inventory: native instructions,
mirrored personal globals, own scratch AGENTS.md/CLAUDE.md, granted-folder
notes, org.md, all held team AGENTS.md files and the org's shared AGENTS.md.
Only files that participate in startup instructions count; ordinary scratch
files do not. Rows name `path`, `source`, `status` and `effective_at`.

Statuses are unchanged, changed, added, removed or unknown. Comparisons use
a private hash-only baseline recorded when opening a turn. No file text or
hash is returned. A session from before this baseline existed has unknown
file comparisons; the engine never invents its old copy. Unreadable evidence
also stays unknown.

`effective_at: next_session_start` means the next fresh or resumed process
start. An edit never rewrites the current turn. Shared and team notes alone
leave a warm process on its old copy; an immediate next turn on that process
can stay clean while `instruction_changes_at_next_session_start` is true.
Native startup edits retain their existing process-replacement behavior.

Dirty covers prefix/namespace changes only. The answer has no retention
timing fields. Time passing, turn-envelope updates and an effort-only change
do not themselves make the prefix dirty.

## Compaction answer

`compaction.will_compact` is true when the current admission policy selects
a cheap compact or a queued crossing requires a fresh session. `kind`
distinguishes those cases. Null means unknown, including a harness-owned
compaction boundary: crossing its configured threshold does not prove when
the harness will compact. False means no compaction is selected from the
current evidence.

`occupancy`, `context_window`, `measured` and `occupancy_source` distinguish
current-turn input observations from the last completed turn. Token counts
are context input, never cumulative thread spend or output. Known policy
thresholds are fractions of the context window. A running process retains
its launch-time native threshold; a replacement uses the new setting.
Unsupported harnesses and absent readings remain unknown. The rest of this
turn or a later setting change can change the answer.

If the runtime is stopping or does not answer within 30 seconds, the tool
fails with an explicit unavailable/unknown message. It never turns that
failure into a clean cache or a no-compaction promise.

## See also

- [Cache continuity](../../accounts/cache-continuity/SKILL.md)
- [Context and compaction](../context-and-compaction/SKILL.md)
