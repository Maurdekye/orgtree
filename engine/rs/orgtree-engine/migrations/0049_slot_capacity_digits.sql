-- User 2026-10-21: seven digits fit the actual project-card held/total badge
-- at near zoom; eight wrap. Keep this aligned with slots::MAX_CAPACITY.
ALTER TABLE ot.slot_leases DROP CONSTRAINT slot_leases_slot_count_check;
ALTER TABLE ot.slot_leases ADD CONSTRAINT slot_leases_slot_count_check
    CHECK (slot_count BETWEEN 1 AND 9999999);
