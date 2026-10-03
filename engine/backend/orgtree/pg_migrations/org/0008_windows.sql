-- A6 round 2: every bounded window reads a bounded number of rows through an index, in the
-- legacy order exactly, however long the archive grows (umbrella acceptance 7).
--
-- A window's selecting value and its ordering text are stored generated columns, computed by
-- the legacy text rules from the typed columns and from a value of another shape kept in
-- extra. So one index range scan yields the legacy order, no JSON is read to decide which rows
-- a window returns, and every writer (the compatibility view, the converter's COPY, a later
-- native writer) keeps them with no code of its own.

-- The json_extract / ->> text of a JSON value (pg_migrations/0001's json_extract over jsonb):
-- a string as itself, JSON null as NULL, anything else as its jsonb text.
CREATE FUNCTION orgtree.legacy_text(v json) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE jsonb_typeof(v::jsonb) WHEN 'string' THEN v::jsonb #>> '{}'
        WHEN 'null' THEN NULL ELSE v::jsonb::text END
$fn$;

-- COALESCE(json_extract(val,'$.at'),'') of a record: its typed timestamp's text (0006's
-- foreground_time: the kept text, else the canonical form), else the text of a value of
-- another shape kept in extra, else ''.
CREATE FUNCTION orgtree.window_at(at timestamptz, at_text text, extra json) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE WHEN at IS NOT NULL THEN orgtree.foreground_time(at, at_text)
        ELSE coalesce(orgtree.legacy_text(extra -> 'at'), '') END
$fn$;

-- The legacy log_d.at of an owner's record (store._at_of): its `at` when that is a string,
-- else ''. A value of another shape orders as '' here, unlike in window_at.
CREATE FUNCTION orgtree.owner_at(at timestamptz, at_text text, extra json) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE WHEN at IS NOT NULL THEN orgtree.foreground_time(at, at_text)
        WHEN jsonb_typeof((extra -> 'at')::jsonb) = 'string' THEN (extra -> 'at')::jsonb #>> '{}'
        ELSE '' END
$fn$;

-- a node's notices, newest first (store._pg_node_history_rows)
ALTER TABLE orgtree.notice_log
  ADD COLUMN win_node text
    GENERATED ALWAYS AS (coalesce("node", orgtree.legacy_text(extra -> 'node'))) STORED,
  ADD COLUMN win_at text COLLATE "C"
    GENERATED ALWAYS AS (orgtree.window_at("at", "at_text", extra)) STORED;
CREATE INDEX notice_log_window ON orgtree.notice_log (win_node, win_at DESC, id DESC);

-- the user mail log by sender, newest first
ALTER TABLE orgtree.user_mail_log
  ADD COLUMN win_from text
    GENERATED ALWAYS AS (coalesce("from", orgtree.legacy_text(extra -> 'from'))) STORED,
  ADD COLUMN win_at text COLLATE "C"
    GENERATED ALWAYS AS (orgtree.window_at("at", "at_text", extra)) STORED;
CREATE INDEX user_mail_log_window ON orgtree.user_mail_log (win_from, win_at DESC, id DESC);

-- A sender's newest mail across every recipient's archive (the Sent tail), and an owner's newest
-- archive rows by position (the inbox's delivered tail). The Sent tail's legacy order is the `at`
-- text, then the recipient's first archive row, then the row (pg_migrations/0007_mail_sent_index:
-- mail_sent.owner_pos), so that first row is kept on every row as owner_pos, as legacy keeps it:
-- an append takes its owner's first row (one indexed lookup), and only a write that removes or
-- moves an owner's rows repairs that owner's keys. An owner's rows are in the same order by idx
-- (their position: conversion numbers them, an append takes its own id) as by id, so the unique
-- (agent_id, idx) index of 0002 serves the first-row lookups and the owner's newest rows; an
-- ORDER BY id would let the planner walk the primary key past every other owner's rows.
ALTER TABLE orgtree.mail_log
  ADD COLUMN win_from text
    GENERATED ALWAYS AS (coalesce("from", orgtree.legacy_text(extra -> 'from'))) STORED,
  ADD COLUMN win_at text COLLATE "C"
    GENERATED ALWAYS AS (orgtree.window_at("at", "at_text", extra)) STORED,
  ADD COLUMN owner_pos bigint;
UPDATE orgtree.mail_log m SET owner_pos = f.first
  FROM (SELECT agent_id, min(id) AS first FROM orgtree.mail_log GROUP BY agent_id) f
  WHERE m.agent_id = f.agent_id;
ALTER TABLE orgtree.mail_log ALTER COLUMN owner_pos SET NOT NULL;
CREATE INDEX mail_log_owner_pos ON orgtree.mail_log (agent_id, owner_pos);
CREATE INDEX mail_log_sent ON orgtree.mail_log (win_from, win_at DESC, owner_pos DESC, id DESC);

CREATE FUNCTION orgtree.mail_log_owner_pos_new() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE first bigint;
BEGIN
  SELECT id INTO first FROM orgtree.mail_log WHERE agent_id = NEW.agent_id
    ORDER BY idx LIMIT 1;
  NEW.owner_pos := CASE WHEN first IS NULL OR NEW.id < first THEN NEW.id ELSE first END;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER mail_log_owner_pos_new BEFORE INSERT ON orgtree.mail_log
  FOR EACH ROW EXECUTE FUNCTION orgtree.mail_log_owner_pos_new();

-- one owner's keys made right again: only rows whose owner_pos differs from the first row's id are
-- touched (the (agent_id, owner_pos) index finds them), so an append that changed nothing costs
-- three index probes
CREATE FUNCTION orgtree.mail_log_owner_pos_fix(owner_id bigint) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE first bigint;
BEGIN
  SELECT id INTO first FROM orgtree.mail_log WHERE agent_id = owner_id
    ORDER BY idx LIMIT 1;
  IF first IS NULL THEN RETURN; END IF;
  UPDATE orgtree.mail_log SET owner_pos = first
    WHERE agent_id = owner_id AND (owner_pos < first OR owner_pos > first);
END
$fn$;

CREATE FUNCTION orgtree.mail_log_owner_pos_repair() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE a bigint;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    FOR a IN SELECT DISTINCT agent_id FROM new_rows ORDER BY 1 LOOP
      PERFORM orgtree.mail_log_owner_pos_fix(a);
    END LOOP;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    FOR a IN SELECT DISTINCT agent_id FROM old_rows ORDER BY 1 LOOP
      PERFORM orgtree.mail_log_owner_pos_fix(a);
    END LOOP;
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER mail_log_owner_pos_insert AFTER INSERT ON orgtree.mail_log
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.mail_log_owner_pos_repair();
CREATE TRIGGER mail_log_owner_pos_delete AFTER DELETE ON orgtree.mail_log
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.mail_log_owner_pos_repair();
-- (a trigger with transition tables cannot name columns, so the repair's own UPDATE fires this once
-- more; that pass finds every key already right, updates nothing, and the recursion ends)
CREATE TRIGGER mail_log_owner_pos_update AFTER UPDATE ON orgtree.mail_log
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION orgtree.mail_log_owner_pos_repair();

-- an owner's newest steered and turn-error records (store.log_owner_tail)
ALTER TABLE orgtree.steer_records
  ADD COLUMN win_at text COLLATE "C"
    GENERATED ALWAYS AS (orgtree.owner_at("at", "at_text", extra)) STORED;
CREATE INDEX steer_records_tail ON orgtree.steer_records (agent_id, win_at DESC, id DESC);
ALTER TABLE orgtree.agent_turn_errors
  ADD COLUMN win_at text COLLATE "C"
    GENERATED ALWAYS AS (orgtree.owner_at("at", "at_text", extra)) STORED;
CREATE INDEX agent_turn_errors_tail ON orgtree.agent_turn_errors (agent_id, win_at DESC, id DESC);

-- one presentation by its id (read_document); a value of another shape never equals the id asked
CREATE INDEX documents_public_id ON orgtree.documents (public_id);

-- Events: the gallery's evictions, and the events touching a node. A node is touched by an
-- event as its actor, or as the node, recipient, grantee or sender in the event's detail
-- (legacy: j->>'actor', j#>>'{detail,node}' ...). That relation is many-to-many, so it is a
-- link table, kept by statement triggers from each event's own columns for every writer.
ALTER TABLE orgtree.events
  ADD COLUMN win_at text COLLATE "C"
    GENERATED ALWAYS AS (orgtree.window_at("at", "at_text", extra)) STORED;
CREATE INDEX events_evicted ON orgtree.events (id) WHERE op = 'present_evicted';

CREATE FUNCTION orgtree.event_refs_of(actor text, detail json, extra json) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT coalesce(array_agg(DISTINCT r), '{}')
 FROM (SELECT coalesce(detail, extra -> 'detail')::jsonb AS d) x
 CROSS JOIN LATERAL unnest(ARRAY[
          coalesce(actor, orgtree.legacy_text(extra -> 'actor')),
          d #>> '{node}', d #>> '{to}', d #>> '{grantee}', d #>> '{from}']) AS r
 WHERE r IS NOT NULL
$fn$;

CREATE TABLE orgtree.event_refs (
  ref text NOT NULL,
  win_at text COLLATE "C" NOT NULL,
  event_id bigint NOT NULL REFERENCES orgtree.events (id) ON DELETE CASCADE,
  UNIQUE (event_id, ref)
);
CREATE INDEX event_refs_window ON orgtree.event_refs (ref, win_at DESC, event_id DESC);

CREATE FUNCTION orgtree.event_refs_keep() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM orgtree.event_refs r USING old_rows o WHERE r.event_id = o.id;
  END IF;
  INSERT INTO orgtree.event_refs (ref, win_at, event_id)
    SELECT x.ref, n.win_at, n.id
    FROM new_rows n CROSS JOIN LATERAL unnest(orgtree.event_refs_of(n.actor, n.detail, n.extra)) AS x(ref);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER event_refs_insert AFTER INSERT ON orgtree.events
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.event_refs_keep();
CREATE TRIGGER event_refs_update AFTER UPDATE ON orgtree.events
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION orgtree.event_refs_keep();

INSERT INTO orgtree.event_refs (ref, win_at, event_id)
  SELECT x.ref, e.win_at, e.id
  FROM orgtree.events e CROSS JOIN LATERAL unnest(orgtree.event_refs_of(e.actor, e.detail, e.extra)) AS x(ref);

-- The number of events, kept at commit as 0006 keeps its counters: statement triggers add each
-- statement's net rows to a transaction-local setting (a savepoint rollback discards it), and
-- one deferred trigger adds it to the revision singleton, whose lock is still taken last. A
-- reader adds its own transaction's pending count (orgdb.compat.sql._events_total).
ALTER TABLE orgtree.org_revision ADD COLUMN events_count bigint NOT NULL DEFAULT 0;
UPDATE orgtree.org_revision SET events_count = (SELECT count(*) FROM orgtree.events);

CREATE FUNCTION orgtree.events_count_accumulate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE n bigint; previous bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN SELECT count(*) INTO n FROM new_rows;
  ELSE SELECT -count(*) INTO n FROM old_rows; END IF;
  IF n = 0 THEN RETURN NULL; END IF;
  previous := coalesce(nullif(current_setting('orgtree.pending_events_count', true), ''), '0')::bigint;
  PERFORM set_config('orgtree.pending_events_count', (previous + n)::text, true);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER events_count_insert AFTER INSERT ON orgtree.events
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.events_count_accumulate();
CREATE TRIGGER events_count_delete AFTER DELETE ON orgtree.events
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.events_count_accumulate();

CREATE FUNCTION orgtree.events_count_flush() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE n bigint; touched bigint;
BEGIN
  n := coalesce(nullif(current_setting('orgtree.pending_events_count', true), ''), '0')::bigint;
  IF n = 0 THEN RETURN NULL; END IF;
  PERFORM set_config('orgtree.pending_events_count', '0', true);
  UPDATE orgtree.org_revision SET events_count = events_count + n WHERE singleton;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN RAISE EXCEPTION 'the revision singleton is missing'; END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER events_count_flush AFTER INSERT OR DELETE ON orgtree.events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.events_count_flush();
