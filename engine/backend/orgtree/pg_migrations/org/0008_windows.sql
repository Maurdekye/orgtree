-- A6 round 2: every bounded window reads a bounded number of rows through an index, in the
-- legacy order exactly, however long the archive grows (umbrella acceptance 7).
--
-- A window's selecting value and its ordering text are stored generated columns, computed by
-- the legacy text rules from the typed columns and from a value of another shape kept in
-- extra. So one index range scan yields the legacy order, no JSON is read to decide which rows
-- a window returns, and every writer (the compatibility view, the converter's COPY, a later
-- native writer) keeps them with no code of its own.

-- A JSON value every json and jsonb operator can read. A json column accepts two escapes no
-- operator does, not even to read another of the value's keys (measured on PostgreSQL 18):
-- \u0000 ("unsupported Unicode escape sequence") and a UTF-16 surrogate that is not half of a
-- pair, as in text cut inside an emoji ("invalid input syntax for type json"). Legacy fails on
-- such a record only when a statement reads it (each casts the record to jsonb); a kept column
-- computed from it would fail the row's write. Here each such escape becomes \ufffd (U+FFFD).
-- Escaped backslashes and valid pairs are set aside first (as U+0001 and U+0002, which JSON text
-- never holds raw), and a value with neither escape comes back as it is.
CREATE FUNCTION orgtree.json_readable(v json) RETURNS json
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE WHEN v::text !~ E'\\\\u(0000|[dD][89a-fA-F])' THEN v
   ELSE replace(replace(
          regexp_replace(
            replace(
              regexp_replace(replace(v::text, E'\\\\', E'\x01'),
                             E'\\\\u([dD][89abAB][0-9a-fA-F]{2})\\\\u([dD][c-fC-F][0-9a-fA-F]{2})',
                             E'\x02\\1\x02\\2', 'g'),
              E'\\u0000', E'\\ufffd'),
            E'\\\\u[dD][89a-fA-F][0-9a-fA-F]{2}', E'\\ufffd', 'g'),
          E'\x02', E'\\u'), E'\x01', E'\\\\')::json END
$fn$;

-- One key of a JSON object (extra, detail), read whatever else the object holds.
CREATE FUNCTION orgtree.json_field(v json, k text) RETURNS json
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT orgtree.json_readable(v) -> k
$fn$;

-- The json_extract / ->> text of a JSON value (pg_migrations/0001's json_extract over jsonb):
-- a string as itself, JSON null as NULL, anything else as its jsonb text.
CREATE FUNCTION orgtree.legacy_text(v json) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE jsonb_typeof(w) WHEN 'string' THEN w #>> '{}'
        WHEN 'null' THEN NULL ELSE w::text END
 FROM (SELECT orgtree.json_readable(v)::jsonb AS w) x
$fn$;

-- COALESCE(json_extract(val,'$.at'),'') of a record: its typed timestamp's text (0006's
-- foreground_time: the kept text, else the canonical form), else the text of a value of
-- another shape kept in extra, else ''.
CREATE FUNCTION orgtree.window_at(at timestamptz, at_text text, extra json) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE WHEN at IS NOT NULL THEN orgtree.foreground_time(at, at_text)
        ELSE coalesce(orgtree.legacy_text(orgtree.json_field(extra, 'at')), '') END
$fn$;

-- The legacy log_d.at of an owner's record (store._at_of): its `at` when that is a string,
-- else ''. A value of another shape orders as '' here, unlike in window_at.
CREATE FUNCTION orgtree.owner_at(at timestamptz, at_text text, extra json) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT CASE WHEN at IS NOT NULL THEN orgtree.foreground_time(at, at_text)
        WHEN json_typeof(orgtree.json_field(extra, 'at')) = 'string'
          THEN orgtree.legacy_text(orgtree.json_field(extra, 'at'))
        ELSE '' END
$fn$;

-- a node's notices, newest first (store._pg_node_history_rows)
ALTER TABLE orgtree.notice_log
  ADD COLUMN win_node text
    GENERATED ALWAYS AS (coalesce("node", orgtree.legacy_text(orgtree.json_field(extra, 'node')))) STORED,
  ADD COLUMN win_at text COLLATE "C"
    GENERATED ALWAYS AS (orgtree.window_at("at", "at_text", extra)) STORED;
CREATE INDEX notice_log_window ON orgtree.notice_log (win_node, win_at DESC, id DESC);

-- the user mail log by sender, newest first
ALTER TABLE orgtree.user_mail_log
  ADD COLUMN win_from text
    GENERATED ALWAYS AS (coalesce("from", orgtree.legacy_text(orgtree.json_field(extra, 'from')))) STORED,
  ADD COLUMN win_at text COLLATE "C"
    GENERATED ALWAYS AS (orgtree.window_at("at", "at_text", extra)) STORED;
CREATE INDEX user_mail_log_window ON orgtree.user_mail_log (win_from, win_at DESC, id DESC);

-- A sender's newest mail across every recipient's archive (the Sent tail), and an owner's newest
-- archive rows by position (the inbox's delivered tail: 0002's unique (agent_id, idx) index). The
-- Sent tail's legacy order is the `at` text, then the recipient's first archive row, then the row,
-- all descending (pg_migrations/0007_mail_sent_index: mail_sent.owner_pos is the recipient's
-- MIN(log_d.seq), kept through inserts, deletes and moves between recipients). Ids follow legacy's
-- row order: the converter numbers mail_log rows by log_d.seq (convert.legacy.row_order), an
-- append takes the next id, and a moved row keeps its id as legacy's keeps its seq. So owner_pos is
-- the smallest id among the owner's rows, kept on every row, and the index below holds the whole
-- key: the Sent tail is one index scan with LIMIT.
ALTER TABLE orgtree.mail_log
  ADD COLUMN win_from text
    GENERATED ALWAYS AS (coalesce("from", orgtree.legacy_text(orgtree.json_field(extra, 'from')))) STORED,
  ADD COLUMN win_at text COLLATE "C"
    GENERATED ALWAYS AS (orgtree.window_at("at", "at_text", extra)) STORED,
  ADD COLUMN owner_pos bigint;

-- One row per owner that has mail_log rows: the smallest id among them. A row arriving at an owner
-- (inserted, or moved there) can only lower it, which costs one upsert; that upsert takes this row's
-- lock, and the commit-time settling takes it too, so writers of one owner's archive keep its keys
-- one after the other, outside org_tx too (inside it, the (dict log, owner) lock already orders
-- them, so this lock is never waited for there). A row lock, not an advisory one: a conversion
-- writing thousands of owners takes no entry in the shared lock table.
CREATE TABLE orgtree.mail_log_first (
  agent_id bigint PRIMARY KEY REFERENCES orgtree.agents (id) ON DELETE CASCADE,
  first_id bigint NOT NULL
);
INSERT INTO orgtree.mail_log_first (agent_id, first_id)
  SELECT agent_id, min(id) FROM orgtree.mail_log GROUP BY agent_id;
UPDATE orgtree.mail_log m SET owner_pos = f.first_id
  FROM orgtree.mail_log_first f WHERE m.agent_id = f.agent_id;
ALTER TABLE orgtree.mail_log ALTER COLUMN owner_pos SET NOT NULL;
CREATE INDEX mail_log_owner_pos ON orgtree.mail_log (agent_id, owner_pos);
CREATE INDEX mail_log_sent ON orgtree.mail_log (win_from, win_at DESC, owner_pos DESC, id DESC);

-- A row arriving at an owner: the owner's lock, its smallest id lowered to this row's if that is
-- smaller, and this row's owner_pos from it. The owner's other rows are made right at commit.
CREATE FUNCTION orgtree.mail_log_owner_pos_arrive() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE first bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.agent_id = OLD.agent_id AND NEW.id = OLD.id THEN
    RETURN NEW;
  END IF;
  INSERT INTO orgtree.mail_log_first AS f (agent_id, first_id) VALUES (NEW.agent_id, NEW.id)
    ON CONFLICT (agent_id) DO UPDATE SET first_id = EXCLUDED.first_id
    WHERE EXCLUDED.first_id < f.first_id;
  SELECT f.first_id INTO first FROM orgtree.mail_log_first f WHERE f.agent_id = NEW.agent_id;
  NEW.owner_pos := least(first, NEW.id);
  RETURN NEW;
END
$fn$;
CREATE TRIGGER mail_log_owner_pos_insert BEFORE INSERT ON orgtree.mail_log
  FOR EACH ROW EXECUTE FUNCTION orgtree.mail_log_owner_pos_arrive();
CREATE TRIGGER mail_log_owner_pos_move BEFORE UPDATE OF agent_id, id ON orgtree.mail_log
  FOR EACH ROW EXECUTE FUNCTION orgtree.mail_log_owner_pos_arrive();

-- The owners a statement gave rows to or took rows from, noted in a transaction-local setting (a
-- savepoint rollback discards its notes with its rows); at commit, mail_log_owner_pos_settle makes
-- each one's keys right once, whatever the transaction did in between: a row the compatibility
-- view rewrites is deleted and inserted again, which leaves the keys as they were.
CREATE FUNCTION orgtree.mail_log_owner_pos_note(ids text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE had text;
BEGIN
  IF ids IS NULL OR ids = '' THEN RETURN; END IF;
  had := coalesce(current_setting('orgtree.mail_log_touched', true), '');
  PERFORM set_config('orgtree.mail_log_touched',
                     CASE WHEN had = '' THEN ids ELSE had || ',' || ids END, true);
END
$fn$;

CREATE FUNCTION orgtree.mail_log_owner_pos_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE ids text;
BEGIN
  IF TG_OP = 'INSERT' THEN SELECT string_agg(DISTINCT agent_id::text, ',') INTO ids FROM new_rows;
  ELSE SELECT string_agg(DISTINCT agent_id::text, ',') INTO ids FROM old_rows; END IF;
  PERFORM orgtree.mail_log_owner_pos_note(ids);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER mail_log_owner_pos_inserted AFTER INSERT ON orgtree.mail_log
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.mail_log_owner_pos_touch();
CREATE TRIGGER mail_log_owner_pos_deleted AFTER DELETE ON orgtree.mail_log
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.mail_log_owner_pos_touch();

-- a row moved between owners, or renumbered: both owners (a trigger naming columns cannot have
-- transition tables, so this one is per row; no writer of today moves rows)
CREATE FUNCTION orgtree.mail_log_owner_pos_moved() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  IF NEW.agent_id <> OLD.agent_id OR NEW.id <> OLD.id THEN
    PERFORM orgtree.mail_log_owner_pos_note(OLD.agent_id::text || ',' || NEW.agent_id::text);
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER mail_log_owner_pos_moved AFTER UPDATE OF agent_id, id ON orgtree.mail_log
  FOR EACH ROW EXECUTE FUNCTION orgtree.mail_log_owner_pos_moved();

-- At commit, each noted owner in id order: its lock; its smallest id, which is the kept one while
-- that row is still the owner's (whatever arrived since could only have lowered it, at its arrival)
-- and is otherwise looked for among the owner's rows (the first row left: every other row's key
-- changes too, as legacy rewrites every mail_sent row of that owner); then only the rows whose
-- owner_pos differs from it, found by the (agent_id, owner_pos) index. An owner left with no rows
-- loses its mail_log_first row.
CREATE FUNCTION orgtree.mail_log_owner_pos_settle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE ids text; a bigint; kept bigint; first bigint;
BEGIN
  ids := coalesce(current_setting('orgtree.mail_log_touched', true), '');
  IF ids = '' THEN RETURN NULL; END IF;
  PERFORM set_config('orgtree.mail_log_touched', '', true);
  FOR a IN SELECT DISTINCT x::bigint FROM unnest(string_to_array(ids, ',')) AS x ORDER BY 1 LOOP
    SELECT f.first_id INTO kept FROM orgtree.mail_log_first f WHERE f.agent_id = a FOR UPDATE;
    first := NULL;
    IF kept IS NOT NULL THEN
      SELECT m.id INTO first FROM orgtree.mail_log m WHERE m.id = kept AND m.agent_id = a;
    END IF;
    IF first IS NULL THEN
      -- the owner's rows themselves (OFFSET 0: through an index on agent_id, never a walk of the
      -- primary key past other owners' rows)
      SELECT min(s.id) INTO first FROM (SELECT m.id FROM orgtree.mail_log m
                                        WHERE m.agent_id = a OFFSET 0) s;
    END IF;
    IF first IS NULL THEN
      DELETE FROM orgtree.mail_log_first WHERE agent_id = a;
      CONTINUE;
    END IF;
    INSERT INTO orgtree.mail_log_first AS f (agent_id, first_id) VALUES (a, first)
      ON CONFLICT (agent_id) DO UPDATE SET first_id = EXCLUDED.first_id
      WHERE f.first_id <> EXCLUDED.first_id;
    UPDATE orgtree.mail_log SET owner_pos = first
      WHERE agent_id = a AND (owner_pos < first OR owner_pos > first);
  END LOOP;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER mail_log_owner_pos_settle
  AFTER INSERT OR UPDATE OF agent_id, id OR DELETE ON orgtree.mail_log
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.mail_log_owner_pos_settle();

-- A caller may force deferred checks (SET CONSTRAINTS ALL IMMEDIATE) before its next write. The
-- settling must stay deferred: run at the end of a statement, it would come before that statement's
-- note (row events fire before statement events) and miss it (as 0012 keeps its archive count).
CREATE FUNCTION orgtree.mail_log_owner_pos_defer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  SET CONSTRAINTS mail_log_owner_pos_settle DEFERRED;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER mail_log_owner_pos_defer BEFORE INSERT OR UPDATE OF agent_id, id OR DELETE
  ON orgtree.mail_log FOR EACH STATEMENT EXECUTE FUNCTION orgtree.mail_log_owner_pos_defer();

-- a truncated archive leaves no owner (as legacy's mail_sent_truncate)
CREATE FUNCTION orgtree.mail_log_first_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  DELETE FROM orgtree.mail_log_first;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER mail_log_first_truncate AFTER TRUNCATE ON orgtree.mail_log
  FOR EACH STATEMENT EXECUTE FUNCTION orgtree.mail_log_first_truncate();

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
 FROM (SELECT coalesce(orgtree.json_readable(detail),
                       orgtree.json_field(extra, 'detail'))::jsonb AS d) x
 CROSS JOIN LATERAL unnest(ARRAY[
          coalesce(actor, orgtree.legacy_text(orgtree.json_field(extra, 'actor'))),
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

-- the flush stays deferred when a caller forces checks, for the same reason as the mail keys'
CREATE FUNCTION orgtree.events_count_defer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  SET CONSTRAINTS events_count_flush DEFERRED;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER events_count_defer BEFORE INSERT OR DELETE ON orgtree.events
  FOR EACH STATEMENT EXECUTE FUNCTION orgtree.events_count_defer();
