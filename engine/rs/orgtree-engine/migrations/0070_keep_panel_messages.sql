-- Panel messages named like the old lifecycle rows survive the History
-- upgrade (4.5.0 high D14, review alpha4 99517050d4d6 F2). Before 0071 the
-- event action and orgtree.emit stored any name, so a message could carry a
-- lifecycle name. 0071 (shipped in 4.5.0-alpha.4, never edited) deletes rows
-- by name alone and files event.fired, panel.started and panel.stopped as
-- History. Before it runs, this sets aside every row under one of those names
-- whose payload is not the exact shape the engine itself wrote for it (domain/
-- apps storage.rs, runtime.rs and events.rs before 0071), so 0071 keeps it and
-- marks it a message; 0071a gives it back its name. A message that matches the
-- engine's shape exactly cannot be told apart and goes the engine's way.
-- A database that already has 0071's kind column is left as it is.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'ot.custom_panel_events'::regclass AND attname = 'kind' AND NOT attisdropped) THEN
    CREATE TABLE ot.upgrade_0070_panel_messages (seq bigint PRIMARY KEY, name text NOT NULL);
    INSERT INTO ot.upgrade_0070_panel_messages (seq, name)
      SELECT seq, name FROM ot.custom_panel_events
       WHERE name IN ('panel.opened', 'panel.created', 'panel.changed', 'panel.duplicated', 'state.changed',
                      'event.fired', 'panel.started', 'panel.stopped')
         AND NOT coalesce(CASE name
               WHEN 'panel.duplicated' THEN jsonb_typeof(payload->'source') = 'string'
                    AND payload = jsonb_build_object('source', payload->'source')
               WHEN 'state.changed' THEN jsonb_typeof(payload->'rev') = 'number'
                    AND payload = jsonb_build_object('rev', payload->'rev')
               WHEN 'panel.stopped' THEN payload IN ('{}', '{"reason": "code changed"}', '{"reason": "stop all"}')
               WHEN 'event.fired' THEN jsonb_typeof(payload->'event') = 'string' AND jsonb_typeof(payload->'id') = 'string'
                    AND jsonb_typeof(payload->'subscribers') = 'number'
                    AND payload = jsonb_build_object('event', payload->'event', 'id', payload->'id', 'subscribers', payload->'subscribers')
               ELSE payload = '{}'
             END, false);
    UPDATE ot.custom_panel_events e SET name = 'upgrade-0070-message'
      FROM ot.upgrade_0070_panel_messages k WHERE e.seq = k.seq;
  END IF;
END $$;
