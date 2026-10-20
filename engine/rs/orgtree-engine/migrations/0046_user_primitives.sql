-- User-side project primitives (docket let-the-user-manually-hold-a-number-of-a-project;
-- USER 2026-10-20 13:03Z-13:22Z): the user holds concurrency slots, registers
-- project event listeners and listener watches, and joins a project's mail
-- queue, as agents do with watchdogs. A user registration is an ordinary
-- `ot.watchdogs` row (or `ot.slot_leases` row) with NO agent owner: the
-- owner/holder columns become nullable and a kind column says which it is,
-- the two agreeing by CHECK. The user's data name is the reserved word
-- "user" (an agent cannot be named it); the desk shows it as "you".
--
-- Queries that inner-join `ot.agents` on the owner/holder do not see user
-- rows: they fail closed (the owner of a user dog is never scanned, armed,
-- paused or reclaimed as an agent's is). Every place the user must COUNT or
-- appear (slot capacity, the FIFO line, listener counts, queue
-- round-robin, listener presence) reads the kind explicitly.
ALTER TABLE ot.watchdogs ALTER COLUMN owner_agent_id DROP NOT NULL;
ALTER TABLE ot.watchdogs ADD COLUMN owner_kind text NOT NULL DEFAULT 'agent';
ALTER TABLE ot.watchdogs ADD CONSTRAINT watchdogs_owner_kind
    CHECK (owner_kind IN ('agent', 'user') AND ((owner_kind = 'user') = (owner_agent_id IS NULL)));
-- (owner_agent_id, uid) is unique per agent owner (0016); a NULL owner is
-- always distinct there, so the user's own ids are unique per org
CREATE UNIQUE INDEX watchdogs_user_uid ON ot.watchdogs (org_id, uid)
    WHERE owner_kind = 'user' AND state IN ('armed', 'paused', 'exited');

ALTER TABLE ot.slot_leases ALTER COLUMN holder_agent_id DROP NOT NULL;
ALTER TABLE ot.slot_leases ADD COLUMN holder_kind text NOT NULL DEFAULT 'agent';
ALTER TABLE ot.slot_leases ADD CONSTRAINT slot_leases_holder_kind
    CHECK (holder_kind IN ('agent', 'user') AND ((holder_kind = 'user') = (holder_agent_id IS NULL)));
