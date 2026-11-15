-- Trusted engines share verification keys through the runtime app database.
-- Providers receive only the signed per-run credential, never this secret.
CREATE TABLE orgtree.turn_signing_keys (
  instance_id bigint PRIMARY KEY REFERENCES orgtree.engine_instances(id),
  secret bytea NOT NULL CHECK (octet_length(secret) = 32)
);

-- A verified-dead owner can release machine capacity even when its org
-- cannot be opened. This fence survives host restart, Retry and restore.
-- Remove it only AFTER the org's old requests commit lost with new epochs.
CREATE TABLE orgtree.turn_recovery (
  org_id bigint NOT NULL REFERENCES orgtree.orgs(org_id) ON DELETE CASCADE,
  instance_id bigint NOT NULL REFERENCES orgtree.engine_instances(id),
  fenced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, instance_id)
);
CREATE TRIGGER turn_recovery_notify AFTER INSERT OR UPDATE OR DELETE
  ON orgtree.turn_recovery FOR EACH STATEMENT
  EXECUTE FUNCTION orgtree.turn_queue_notify();
