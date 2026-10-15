-- User 2026-10-15: autonomous Logo changes join the existing bounded history.
ALTER TABLE ot.undo_entries DROP CONSTRAINT undo_entries_kind_check;
ALTER TABLE ot.undo_entries ADD CONSTRAINT undo_entries_kind_check
  CHECK (kind IN ('move', 'hire', 'retire', 'retool', 'logo'));
