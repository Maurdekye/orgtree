-- Watchdog ids are readable slugs (decision 67): a new dog's id is the slug
-- of its name, unique among one owner's dogs that hold an id (armed, paused
-- or exited). A removed or spent dog frees its id for the next dog of that
-- owner, and two owners may both keep a `build-watch`, so the id is no longer
-- unique across the table: the engine keys dogs by their row id instead.
-- Older dogs keep their random ids.
ALTER TABLE ot.watchdogs DROP CONSTRAINT watchdogs_uid_key;
CREATE UNIQUE INDEX watchdogs_owner_uid ON ot.watchdogs (owner_agent_id, uid)
  WHERE state IN ('armed', 'paused', 'exited');
--   a pause, resume or remove names a dog by its id within one org
CREATE INDEX watchdogs_org_uid ON ot.watchdogs (org_id, uid);
