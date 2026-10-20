-- A small directory for the retired picker, not full node/feed records.
-- Live turns have no directory row to lock. The only turn trigger is on a
-- new turn or a changed time; token/accounting updates do not invoke it.
CREATE TABLE ot.retired_picker (
  agent_id bigint PRIMARY KEY REFERENCES ot.agents(id) ON DELETE CASCADE,
  org_id bigint NOT NULL,
  parent_key bigint NOT NULL,
  name text NOT NULL,
  sibling_order double precision NOT NULL,
  turn_id bigint NOT NULL DEFAULT 0,
  touched bigint NOT NULL DEFAULT 0
);
CREATE INDEX retired_picker_page ON ot.retired_picker
  (org_id,parent_key,touched DESC,sibling_order DESC,agent_id DESC);

CREATE FUNCTION ot.retired_picker_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('archived','unrecoverable') THEN
    INSERT INTO ot.retired_picker(agent_id,org_id,parent_key,name,sibling_order,turn_id,touched)
      SELECT NEW.id,NEW.org_id,coalesce(NEW.parent_id,0),NEW.name,NEW.sibling_order,
        coalesce(t.id,0),coalesce((extract(epoch FROM coalesce(t.ended_at,t.started_at))*1000000)::bigint,0)
      FROM (SELECT 1) seed LEFT JOIN LATERAL
        (SELECT id,ended_at,started_at FROM ot.turns WHERE agent_id=NEW.id ORDER BY id DESC LIMIT 1) t ON true
    ON CONFLICT(agent_id) DO UPDATE SET org_id=excluded.org_id,parent_key=excluded.parent_key,
      name=excluded.name,sibling_order=excluded.sibling_order,turn_id=excluded.turn_id,touched=excluded.touched;
  ELSE
    DELETE FROM ot.retired_picker WHERE agent_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retired_picker_agent_insert AFTER INSERT ON ot.agents
  FOR EACH ROW WHEN (NEW.state IN ('archived','unrecoverable')) EXECUTE FUNCTION ot.retired_picker_agent();
CREATE TRIGGER retired_picker_agent_change AFTER UPDATE OF state,parent_id,name,sibling_order ON ot.agents
  FOR EACH ROW WHEN ((OLD.state,OLD.parent_id,OLD.name,OLD.sibling_order)
    IS DISTINCT FROM (NEW.state,NEW.parent_id,NEW.name,NEW.sibling_order)
    AND (OLD.state IN ('archived','unrecoverable') OR NEW.state IN ('archived','unrecoverable')))
  EXECUTE FUNCTION ot.retired_picker_agent();

CREATE FUNCTION ot.retired_picker_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Never lock ot.agents, orgs, or the revision row. For a live agent this
  -- indexed UPDATE matches zero rows and takes no row lock.
  UPDATE ot.retired_picker SET turn_id=NEW.id,
    touched=(extract(epoch FROM coalesce(NEW.ended_at,NEW.started_at))*1000000)::bigint
    WHERE agent_id=NEW.agent_id AND turn_id<=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER retired_picker_turn_insert AFTER INSERT ON ot.turns
  FOR EACH ROW EXECUTE FUNCTION ot.retired_picker_turn();
CREATE TRIGGER retired_picker_turn_time AFTER UPDATE OF started_at,ended_at ON ot.turns
  FOR EACH ROW WHEN ((OLD.started_at,OLD.ended_at) IS DISTINCT FROM (NEW.started_at,NEW.ended_at))
  EXECUTE FUNCTION ot.retired_picker_turn();

-- One-time backfill. Each last-turn lookup is an indexed LIMIT 1.
INSERT INTO ot.retired_picker(agent_id,org_id,parent_key,name,sibling_order,turn_id,touched)
SELECT a.id,a.org_id,coalesce(a.parent_id,0),a.name,a.sibling_order,coalesce(t.id,0),
  coalesce((extract(epoch FROM coalesce(t.ended_at,t.started_at))*1000000)::bigint,0)
FROM ot.agents a LEFT JOIN LATERAL
  (SELECT id,ended_at,started_at FROM ot.turns WHERE agent_id=a.id ORDER BY id DESC LIMIT 1) t ON true
WHERE a.state IN ('archived','unrecoverable');
