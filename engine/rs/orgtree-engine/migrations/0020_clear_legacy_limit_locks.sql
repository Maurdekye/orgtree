-- limit_locked belonged to the removed Fable policy lock in 3.x. A normal
-- usage freeze owns its own recovery and must not acquire that legacy lock.
-- Earlier 4.x turn settlement set it for every usage refusal; clear those
-- stale flags once, preserving the freeze and any explicit halt record.
UPDATE ot.agents SET limit_locked = false WHERE limit_locked;
