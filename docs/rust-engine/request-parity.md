# Request parity: P18–P20, P29, P31–P32

Restored against Python baseline `4ddbfb13c66ebd5ddb1cc061357fee90384b1d41`
(`engine/backend/orgtree/ledger.py`). The baseline file in this checkout has no diff
from that commit. Behavior comparison is source inspection, not live-data testing.

- **P18 — fixed.** A question call accepts one to four tabs. Re-asking the same text
  amends its position; other questions append, up to eight accumulated. Overflow refuses
  before any write, leaving questions, credits and scope tabs unchanged.
- **P19 — fixed.** Credit totals round to hundredths, then upward to whole credits.
  Non-finite totals refuse. A requested total already covered by the grant removes only
  the credit tab, even without a reason; a credit-only card becomes withdrawn. Larger
  requests require a reason and refuse at zero headroom. Headroom follows the top-level
  cap, or the parent's floored free credits with cascading off; cascading on sums floored
  ancestor free credits plus top-level cap slack. No cap means unbounded growth.
- **P20 — fixed.** Scope requests require a reason and accept at most eight input and
  accumulated items. Path, tool, MCP server and permission mode are the merge identities;
  newer modes amend an existing identity. Existing duplicate identities consolidate as
  in Python's merge map. Already-held items are removed before routing or card mutation,
  using effective scope folded from org through every ancestor. An entirely satisfied
  call leaves any pending batch alone. The permission rank includes `plan` as in 3.x.
- **P29 — fixed.** Every question's docket attachment passes `docket::agent_get` with
  the asker's identity before any card write or superior mail. This uses the same read
  policy as a normal agent docket read, rejects missing/unreadable items, and stores the
  canonical slug. Per-tab links override the call-level default.
- **P31 — fixed.** Batch and single-credit decisions retain the locked request row
  through grant changes, scope changes, resolution and durable answer-mail insertion.
  Credit allocation reuses `ops::run_in_tx`; scope edits share the direct-user scope
  mutation path. A failure rolls back the entire decision. Actor reconfiguration,
  feed notifications and answer wakes follow the commit. The selected request is never
  unlocked and replaced by a second read during resolution. Absolute grants lock the
  agent before calculating their delta, and use the same whole-credit rounding.
- **P32 — fixed.** Every pending component requires its matching revision. Questions
  require exactly one answer slot each (null means an explicit skip); credits require
  an explicit grant, deny or skip; scope requires exactly one valid decision per item.
  Validation precedes all mutations. Legacy single-part endpoints refuse mixed cards
  rather than closing other tabs unseen.

Amendments retain the existing request-row transaction. New ancestor reads are bounded
at 1,025 rows and refuse a chain deeper than that; they add no global locks and mutate
neither grants nor scope. Approval mutations share the existing allocation and user-scope
rules through transaction-aware entry points. Folder approval merges exact paths and only
raises ro to rw; MCP approval respects an existing wildcard.

Verification: `cargo check -p orgtree-engine -j 2` with the worktree's manifest and
`CARGO_TARGET_DIR=E:\cargo-target\desk-astra`. No unit suite, live database mutation,
engine build, install or restart is part of this hand-in. Runtime scenarios for a later
prototype smoke: append question 5 then 9; withdraw credits from a mixed card; request
20.5 credits; ask with zero headroom; amend the same folder from ro to rw; request an
already-held tool; attach an owned item, an unreadable peer item, and a missing item;
submit a missing revision or answer slot; race an amendment with a grant; force a later
scope/mail failure and confirm neither the earlier credit grant nor resolution commits.
The transaction guarantees above are source-inspected, not a measured concurrent database
rehearsal. No live request was answered during verification.
