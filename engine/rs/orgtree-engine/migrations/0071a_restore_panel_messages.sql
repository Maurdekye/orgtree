-- Gives back the names 0070 set aside before the shipped 0071 (4.5.0 high
-- D14): each kept row is a message again under its own name, with its seq,
-- payload, actor and time unchanged. A database that had 0071 before 0070
-- existed has no holding table, and nothing changes.
DO $$
BEGIN
  IF to_regclass('ot.upgrade_0070_panel_messages') IS NOT NULL THEN
    UPDATE ot.custom_panel_events e SET name = k.name, kind = 'message'
      FROM ot.upgrade_0070_panel_messages k WHERE e.seq = k.seq;
    DROP TABLE ot.upgrade_0070_panel_messages;
  END IF;
END $$;
