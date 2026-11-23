-- USER 2026-11-23 20:44Z (U1): the user's own import or duplicate of a team is one entry of the
-- undo history, undone and redone as a whole (docs/rust-engine/agent-export.md, "Undo").
ALTER TABLE ot.undo_entries DROP CONSTRAINT undo_entries_kind_check;
ALTER TABLE ot.undo_entries ADD CONSTRAINT undo_entries_kind_check
  CHECK (kind IN ('move', 'hire', 'retire', 'retool', 'logo', 'import'));
