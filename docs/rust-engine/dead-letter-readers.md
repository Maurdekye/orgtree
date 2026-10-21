# Dead-letter totals and paging

Migration `0051_dead_letter_readers` keeps the existing open/dropped semantics
and retained mail/history. The feed and shared dead-letter total readers use
one keyed row in `ot.project_dead_letter_counts`, so neither answered mail nor
dropped dead letters make ordinary refreshes scan history. A missing counter
means zero. The exact predicates remain `state = 'read'`, presence of
`extra.dead_letter`, and absence/presence of `extra.dead_letter_dropped`;
JSON null values still count as present, as before.

The migration backfills once while excluding mail writers in its transaction.
Afterwards a row trigger updates only changed membership, including insert,
retry, drop, state change, recipient move and delete. Counts and mail commit
or roll back together. Recipient moves acquire counter rows in id order;
ordinary successful mail and unchanged membership do not write counters.
Zero counters are removed. A statement trigger resets them on explicit mail
TRUNCATE, used by synthetic fixtures. The counter key preserves mail's existing
nullable/non-FK recipient model rather than adding a new deletion restriction.

Two partial `(recipient_agent_id, id DESC)` indexes match the shared OPEN and
ANY predicates. Default newest-first pages can seek open letters directly,
skipping unrelated answered and dropped history. Including dropped letters
uses the matching broader index when appropriate. Explicit offsets still
walk the requested prefix; this change does not alter pagination or impose
a different cap. PostgreSQL may choose the primary key for a dense newest
window; the sparse-history-tail control verifies the partial-index path.

## Focused synthetic proof

Under the current build permit, run:

```text
node tools/rig/check-dead-letter-indexes.mjs C:/orgtree-build/<agent>/<fresh-output> D:/orgtree-work/rig/<agent>/<fresh-cluster> <cached-postgres-bin> <unused-port>
```

The script creates a fresh private PostgreSQL cluster; it never starts an
engine or reads live credentials. It applies the actual embedded pre-0051
migration SQL, seeds historical mail, then applies 0051 in one transaction.
The reader queries come from the actual Rust source, including the shared
unread-state predicate. It records full `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
plans at 10k/20k retained rows and with a further 10k answered-only tail,
holding three open dead letters fixed. Membership-transition, rollback,
concurrent first-counter creation and TRUNCATE controls check exact totals.
The cluster stops in `finally`; all queries, plans and raw process verdicts
remain in the output directory. No live installation, provider or app session
is involved. Cargo's focused `domain::dead_letters::tests::` tests additionally
cover the unchanged summary and open predicates.

[verified: `migrations/0051_dead_letter_readers.sql`,
`src/domain/dead_letters.rs`, `src/feed/compute.rs`; 2026-10-21]
