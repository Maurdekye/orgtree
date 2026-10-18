-- DND belongs to one turn, never to a permanent agent preference. Pending mail
-- already has durable custody in ot.mail; ending any turn (including recovery,
-- halt and failure) releases its still-unread mail in the same transaction.
ALTER TABLE ot.turns ADD COLUMN do_not_disturb boolean NOT NULL DEFAULT false;

CREATE FUNCTION ot.agent_dnd(agent bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT t.ended_at IS NULL AND t.do_not_disturb
                   FROM ot.turns t WHERE t.agent_id = agent
                   ORDER BY t.id DESC LIMIT 1), false)
$$;

CREATE FUNCTION ot.release_dnd_mail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.do_not_disturb AND (NEW.ended_at IS NOT NULL OR NOT NEW.do_not_disturb) THEN
    NEW.do_not_disturb := false;
    UPDATE ot.mail SET extra = extra || '{"dnd_released":true}'::jsonb
      WHERE recipient_agent_id = NEW.agent_id AND state = 'pending' AND NOT urgent;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER release_dnd_mail BEFORE UPDATE OF ended_at, do_not_disturb ON ot.turns
  FOR EACH ROW EXECUTE FUNCTION ot.release_dnd_mail();
