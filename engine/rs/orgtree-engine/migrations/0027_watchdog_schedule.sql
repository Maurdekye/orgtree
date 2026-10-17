-- 0025/0026 belong to the 4.4.0 line. Migrations are identified by name,
-- so this additive migration can ship on 4.3.2 and merge into that line.
ALTER TABLE ot.watchdogs ADD COLUMN next_check_at timestamptz;
ALTER TABLE ot.watchdogs ADD COLUMN next_silence_at timestamptz;

-- Keep actual check/fire evidence intact. A never-run dog is due once now;
-- existing progress supplies its phase, including already overdue slots.
UPDATE ot.watchdogs SET
  next_check_at = CASE WHEN kind IN ('file','command','process') THEN
    coalesce(last_check + greatest(interval_s,15) * interval '1 second', created_at) END,
  next_silence_at = CASE WHEN fire_mode='silence' THEN
    coalesce(silence_since,created_at) + greatest(coalesce(quiet_period_s,600),1) * interval '1 second' END;
