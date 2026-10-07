# Credit cascade boundary and move conservation

User ruling: 2026-10-07 08:25Z, decision 50.

The 3.x reference is `origin/dev` (`4ddbfb1`), `Ledger._move` and
`Ledger._chain_acquire`. Moves release the moved seat plus grant up the old
parent path and acquire the same amount down the new path, excluding their
lowest common ancestor. Thus every existing agent keeps the same free credits.
Hires use free credits up to and including the acting agent; only a user action
can increase a top-level allocation, within its configured cap.

The Rust baseline reserved destination credits before releasing the moved seat.
A safe-start disposable engine reproduced two moves raising mover grant 32 to 40
and reducing its superior's free credits from 26 to 18. Its shared `ensure_room`
also wrote each child increase before reading its parent's free credits, then
requested that same increase again. Both inflated the ancestor's apparent need.

`ensure_room` now plans the full cascade against unchanged grants before writing.
It refuses at an agent actor's allocation, and all shared callers carry the actor,
including queued model switches. No fresh scope, credit or account bypass is added.

Single and batch moves use the same 3.x path transfer. Parent changes are staged
inside the caller's transaction in request order, while grant deltas stay in a
bounded map (at most 20 batch legs and existing bounded ancestry). Later legs use
already-planned effective grants. After all legs, SQL aggregates validate final
holds, nonnegative grants and top-level caps before grant writes. A failure rolls
back parent changes, grants, events and transactional notices together; deferred
runtime/feed effects publish only after commit. No new transaction or global lock.

Measured on 2026-10-07: `cargo check -j 2` passed. An authorized disposable
safe-start debug engine passed a brief scratch-database smoke:

- Reported batch: mover grant remains 32, superior free remains 26 (baseline 40/18).
- Single cross-manager move and moving a manager after an earlier batch leg
  preserve the common ancestor's grant/free and use its updated subtree stake.
- Unaffordable actor hire, rehire, reallocate and model upgrade leave complete
  agent rows, event count and mail count unchanged; each says insufficient credits.
- An affordable hire through two managers consumes exactly four actor credits,
  without changing actor/superior grants or counting the increase twice.
- Cascade disabled refuses an unaffordable immediate payer; moves still transfer
  their existing stake. A later invalid batch leg rolls back earlier moves/notices.
- A temporary cap excess that cancels in the batch succeeds; a final excess
  refuses atomically. User operations can still use existing credit headroom.

The scratch binary used the committed domain code with a temporary opt-in HTTP
adapter to supply a fixture Actor::Agent, gated by SAFE_START; no provider turn
was launched. The adapter was restored byte-for-byte and is not in the commit.
The disposable engine and PostgreSQL processes were stopped. This is measured
scratch behavior, not a live/deployment claim. Live data was not changed.

