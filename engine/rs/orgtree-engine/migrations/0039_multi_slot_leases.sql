-- One lease owns all requested capacity units. Existing leases held one slot.
ALTER TABLE ot.slot_leases
    ADD COLUMN slot_count integer NOT NULL DEFAULT 1
    CHECK (slot_count BETWEEN 1 AND 64);

COMMENT ON COLUMN ot.slot_leases.slot_count IS
    'Capacity units reserved atomically by this lease; release/reclaim ends all units together.';
