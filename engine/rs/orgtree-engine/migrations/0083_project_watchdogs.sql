-- Project watchdogs (docket project-watchdogs-a-watchdog-owned-by-a-project-f;
-- USER 2026-11-03 10:33Z). A watchdog may be owned by a project node
-- (owner_kind = 'project', owner_agent_id = the project's ot.agents id); its
-- fires become the project's event. The owner row's kind must agree with
-- owner_kind (spec D2), checked on insert and owner change.
ALTER TABLE ot.watchdogs DROP CONSTRAINT watchdogs_owner_kind;
ALTER TABLE ot.watchdogs ADD CONSTRAINT watchdogs_owner_kind
    CHECK (owner_kind IN ('agent','user','project') AND ((owner_kind = 'user') = (owner_agent_id IS NULL)));

CREATE OR REPLACE FUNCTION ot.watchdog_owner_kind_agrees() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_kind <> 'user' AND NOT EXISTS (
       SELECT 1 FROM ot.agents a WHERE a.id = NEW.owner_agent_id AND a.kind = NEW.owner_kind) THEN
    RAISE EXCEPTION 'watchdog owner_kind % does not match its owner row', NEW.owner_kind;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS watchdog_owner_kind_agrees ON ot.watchdogs;
CREATE TRIGGER watchdog_owner_kind_agrees BEFORE INSERT OR UPDATE OF owner_kind, owner_agent_id ON ot.watchdogs
  FOR EACH ROW EXECUTE FUNCTION ot.watchdog_owner_kind_agrees();

-- A pre-existing breach (none expected): an 'agent' dog owned by a project row is retired, not migrated.
UPDATE ot.watchdogs w SET state = 'removed',
       memo = w.memo || jsonb_build_object('reason','owner was a project row before migration 0083')
  FROM ot.agents a
 WHERE a.id = w.owner_agent_id AND w.owner_kind = 'agent' AND a.kind = 'project'
   AND w.state IN ('armed','paused','exited');

-- The source of a fire: NULL is a manual fire or a legacy row.
ALTER TABLE ot.project_fires ADD COLUMN IF NOT EXISTS source jsonb;
