-- Cursor pages seek immutable ended times and break ties with the lease id.
CREATE INDEX slot_leases_ended_page ON ot.slot_leases (project_id, ended_at DESC, id DESC)
  WHERE ended_at IS NOT NULL;
