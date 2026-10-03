-- Trusted engines share verification keys through the runtime app database.
-- Providers receive only the signed per-run credential, never this secret.
CREATE TABLE orgtree.turn_signing_keys (
  instance_id bigint PRIMARY KEY REFERENCES orgtree.engine_instances(id),
  secret bytea NOT NULL CHECK (octet_length(secret) = 32)
);
