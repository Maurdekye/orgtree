-- Durable turn admission. 0001 supplied the tickets and admission row.
-- The small org ring preserves first-arrival order without reading finished
-- ticket history. It is removed with the org, like that org's tickets.
CREATE TABLE orgtree.turn_queue_orgs (
  org_id bigint PRIMARY KEY REFERENCES orgtree.orgs(org_id) ON DELETE CASCADE,
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);
ALTER TABLE orgtree.engine_instances ADD COLUMN dead_at timestamptz;
CREATE INDEX engine_instances_live_heartbeat ON orgtree.engine_instances (heartbeat_at, id)
  WHERE dead_at IS NULL;
-- Distinguishes a caller's uncertain admission from another caller of the
-- same durable request, even when both callers belong to the same process.
ALTER TABLE orgtree.turn_tickets ADD COLUMN claim_token uuid;
ALTER TABLE orgtree.turn_admission DROP CONSTRAINT turn_admission_slot_limit_check;
ALTER TABLE orgtree.turn_admission ADD CHECK (slot_limit BETWEEN 0 AND 512);
-- A closed gate (0) is useful internally; the existing user setting still
-- accepts only 1..512. Lowering a limit never preempts a running turn.
CREATE INDEX turn_tickets_fifo ON orgtree.turn_tickets (org_id, id)
  WHERE state = 'waiting';
CREATE INDEX turn_tickets_occupied ON orgtree.turn_tickets (id)
  WHERE state IN ('running', 'stopping');
CREATE INDEX turn_tickets_waiting_owner ON orgtree.turn_tickets (lease_owner)
  WHERE state = 'waiting';

CREATE FUNCTION orgtree.turn_queue_notify() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify('turn_tickets', 'changed');
  RETURN NULL;
END
$fn$;
CREATE TRIGGER turn_tickets_notify AFTER INSERT OR UPDATE OR DELETE
  ON orgtree.turn_tickets FOR EACH STATEMENT
  EXECUTE FUNCTION orgtree.turn_queue_notify();
CREATE TRIGGER turn_admission_notify AFTER UPDATE
  ON orgtree.turn_admission FOR EACH STATEMENT
  EXECUTE FUNCTION orgtree.turn_queue_notify();
