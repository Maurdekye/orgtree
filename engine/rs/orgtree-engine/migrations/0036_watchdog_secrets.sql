-- MQTT watchdogs (docs/rust-engine/mqtt-watchdogs.md; user 2026-10-19
-- 17:43:37Z): a dog's inline broker credentials, sealed with AES-256-GCM
-- under the data root's watchdog key (src/mqtt/seal.rs), never plaintext.
-- Kept apart from ot.watchdogs so no list, feed, card or import reads them.
-- A dog that is removed or spent loses them at once: nothing can use them.
CREATE TABLE ot.watchdog_secrets (
  watchdog_id bigint PRIMARY KEY REFERENCES ot.watchdogs (id) ON DELETE CASCADE,
  sealed      bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION ot.drop_watchdog_secret() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM ot.watchdog_secrets WHERE watchdog_id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER drop_watchdog_secret AFTER UPDATE OF state ON ot.watchdogs
  FOR EACH ROW WHEN (NEW.state IN ('removed', 'spent') AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION ot.drop_watchdog_secret();
