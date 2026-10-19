-- A slot lease remembers when its claim joined the line (the dog's
-- memo.queued_at at grant), so Recent holds can show how long each hold
-- waited before its grant (user 2026-10-19). Null on leases granted
-- before this column existed: those rows show no wait.
ALTER TABLE ot.slot_leases ADD COLUMN queued_at timestamptz;
