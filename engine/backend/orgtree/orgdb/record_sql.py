"""Generated revision door and scope resolution for the org record feed.

``migration_sql`` is the source of the committed org migration. Capture reads
transition rows only; every cross-table query below runs AFTER the revision row
is taken. The generated file and this source must match byte for byte.
"""
from __future__ import annotations

from typing import Mapping

from .record_derivations import SOURCES, Source, Window, capture_sql, with_windows, window_resolution


SCHEMA = '''CREATE TABLE orgtree.changes (
  xid xid8 NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  PRIMARY KEY (xid, entity, entity_id)
);
CREATE TABLE orgtree.revisions (
  rev bigint PRIMARY KEY,
  xid xid8 NOT NULL UNIQUE,
  at timestamptz NOT NULL
);
CREATE INDEX revisions_retention ON orgtree.revisions(at,rev);
CREATE INDEX record_archived_parent ON orgtree.agents(parent_id,name)
WHERE NOT tombstone AND state='archived' AND NOT state_misfit AND NOT parent_misfit;
CREATE TABLE orgtree.record_time_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  watermark timestamptz NOT NULL
);
INSERT INTO orgtree.record_time_state(singleton,watermark) VALUES (true,clock_timestamp());
CREATE TABLE orgtree.record_detail_versions (
  agent_id bigint PRIMARY KEY,
  version bigint NOT NULL
);
ALTER TABLE orgtree.org_revision ADD COLUMN floor bigint NOT NULL DEFAULT 0 CHECK(floor>=0);
'''


RESOLVE = '''CREATE FUNCTION orgtree.resolve_scopes() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,orgtree AS $fn$
DECLARE scope_row record; partition_key text; named_count bigint; pile_parent bigint;
BEGIN
  PERFORM set_config('orgtree.pending_scopes','',true);
  -- Snapshot is taken AFTER the revision singleton by the caller. Reads below
  -- never lock another writer's source row; writes use ONLY this transaction's xid.
  FOR scope_row IN SELECT entity_id FROM orgtree.changes
      WHERE xid=pg_current_xact_id() AND entity='~scope' ORDER BY entity_id
  LOOP
    partition_key := substring(scope_row.entity_id FROM position(':' IN scope_row.entity_id)+1);
    IF scope_row.entity_id LIKE 'name:%' THEN
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'agent',id::text FROM orgtree.agents
        WHERE name=partition_key AND NOT tombstone ON CONFLICT DO NOTHING;
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'~scope','detail:'||id::text FROM orgtree.agents
        WHERE name=partition_key AND NOT tombstone ON CONFLICT DO NOTHING;
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'~scope','lineage:'||id::text FROM orgtree.agents
        WHERE name=partition_key AND NOT tombstone ON CONFLICT DO NOTHING;
    ELSIF scope_row.entity_id LIKE 'references:%' THEN
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'agent',id::text FROM orgtree.agents
        WHERE parent_id=partition_key::bigint OR predecessor_id=partition_key::bigint
           OR successor_id=partition_key::bigint ON CONFLICT DO NOTHING;
    ELSIF scope_row.entity_id LIKE 'refname:%' THEN
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'agent',id::text FROM orgtree.agents
        WHERE parent=partition_key OR predecessor=partition_key OR successor=partition_key
        ON CONFLICT DO NOTHING;
    ELSIF scope_row.entity_id LIKE 'tools:%' THEN
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'agent',id::text FROM orgtree.agents
        WHERE tool_list_id=partition_key::bigint ON CONFLICT DO NOTHING;
    ELSIF scope_row.entity_id LIKE 'ask:%' THEN
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'agent',a.id::text FROM orgtree.asks q
        JOIN orgtree.agents a ON a.name=q.node AND NOT a.tombstone
        WHERE q.id=partition_key::bigint ON CONFLICT DO NOTHING;
    ELSIF scope_row.entity_id LIKE 'request:%' THEN
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'agent',a.id::text FROM orgtree.scope_requests q
        JOIN orgtree.agents a ON a.name=q.node AND NOT a.tombstone
        WHERE q.id=partition_key::bigint ON CONFLICT DO NOTHING;
    ELSIF scope_row.entity_id LIKE 'turn:%' THEN
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'agent',agent_id::text FROM orgtree.agent_turns
        WHERE id=partition_key::bigint ON CONFLICT DO NOTHING;
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'~scope','detail:'||agent_id::text FROM orgtree.agent_turns
        WHERE id=partition_key::bigint ON CONFLICT DO NOTHING;
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'~scope','lineage:'||agent_id::text FROM orgtree.agent_turns
        WHERE id=partition_key::bigint ON CONFLICT DO NOTHING;
    ELSIF scope_row.entity_id LIKE 'delivery:%' THEN
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'agent',agent_id::text FROM orgtree.delivery_batches
        WHERE id=partition_key::bigint ON CONFLICT DO NOTHING;
    ELSIF scope_row.entity_id LIKE 'chain:%' THEN
      WITH RECURSIVE chain(id,parent_id,path) AS (
        SELECT id,parent_id,ARRAY[id] FROM orgtree.agents WHERE id=partition_key::bigint
        UNION ALL SELECT a.id,a.parent_id,c.path||a.id FROM chain c
        JOIN orgtree.agents a ON a.id=c.parent_id WHERE NOT a.id=ANY(c.path))
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'agent',id::text FROM chain ON CONFLICT DO NOTHING;
    ELSIF scope_row.entity_id LIKE 'lineage:%' THEN
      -- Body lineage follows predecessor links, including inconsistent legacy
      -- successor pointers. Resolve every dependent successor, not just one edge.
      WITH RECURSIVE lineage(id,path) AS (
        SELECT id,ARRAY[id] FROM orgtree.agents WHERE id=partition_key::bigint
        UNION ALL SELECT a.id,c.path||a.id FROM lineage c
        JOIN orgtree.agents a ON a.predecessor_id=c.id WHERE NOT a.id=ANY(c.path))
      INSERT INTO orgtree.changes(xid,entity,entity_id)
        SELECT pg_current_xact_id(),'agent',id::text FROM lineage ON CONFLICT DO NOTHING;
    ELSIF scope_row.entity_id LIKE 'window:%' THEN
      -- WINDOW_CASES
      RAISE EXCEPTION 'undeclared record window scope: %', scope_row.entity_id;
    END IF;
  END LOOP;
  -- Name scopes can add a lineage scope while the cursor above is already
  -- open. Walk the complete final set here, including those newly added rows.
  WITH RECURSIVE lineage(id,path) AS (
    SELECT split_part(entity_id,':',2)::bigint,
           ARRAY[split_part(entity_id,':',2)::bigint] FROM orgtree.changes
    WHERE xid=pg_current_xact_id() AND entity='~scope' AND entity_id LIKE 'lineage:%'
    UNION ALL SELECT a.id,c.path||a.id FROM lineage c
    JOIN orgtree.agents a ON a.predecessor_id=c.id WHERE NOT a.id=ANY(c.path))
  INSERT INTO orgtree.changes(xid,entity,entity_id)
    SELECT pg_current_xact_id(),'agent',id::text FROM lineage ON CONFLICT DO NOTHING;
  -- Distinct parents, not one read per touched child. n counts the transaction's
  -- distinct pile scopes; it covers both removed and added children and P itself.
  FOR pile_parent,named_count IN
    SELECT split_part(entity_id,':',2)::bigint,count(*) FROM orgtree.changes
    WHERE xid=pg_current_xact_id() AND entity='~scope' AND entity_id LIKE 'pile:%'
    GROUP BY split_part(entity_id,':',2)::bigint ORDER BY 1
  LOOP
    INSERT INTO orgtree.changes(xid,entity,entity_id)
      SELECT pg_current_xact_id(),'agent',id::text FROM (
        (SELECT a.id FROM orgtree.agents a LEFT JOIN orgtree.agents s ON s.id=a.successor_id
         WHERE NOT a.tombstone AND a.state='archived'
           AND a.parent_id IS NOT DISTINCT FROM nullif(pile_parent,0)
           AND (a.successor_id IS NULL OR s.name='')
         ORDER BY coalesce(a.ui_order,0),orgtree.foreground_time(a.created,a.created_text),a.ord,a.name COLLATE "C"
         LIMIT named_count+1)
        UNION
        (SELECT a.id FROM orgtree.agents a LEFT JOIN orgtree.agents s ON s.id=a.successor_id
         WHERE NOT a.tombstone AND a.state='archived'
           AND a.parent_id IS NOT DISTINCT FROM nullif(pile_parent,0)
           AND (a.successor_id IS NULL OR s.name='')
         ORDER BY coalesce(a.ui_order,0) DESC,orgtree.foreground_time(a.created,a.created_text) DESC,
                  a.ord DESC,a.name COLLATE "C" DESC LIMIT named_count+1)
      ) edges ON CONFLICT DO NOTHING;
  END LOOP;
END
$fn$;
CREATE FUNCTION orgtree.record_stamp_details(r bigint) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  -- Called under the revision singleton, never from statement capture. No FK
  -- here: taking an agent's source-row lock at commit would reverse the order.
  INSERT INTO orgtree.record_detail_versions(agent_id,version)
    SELECT split_part(entity_id,':',2)::bigint,r FROM orgtree.changes
    WHERE xid=pg_current_xact_id() AND entity='~scope' AND entity_id LIKE 'detail:%'
    UNION SELECT id,r FROM orgtree.agents
      WHERE current_setting('orgtree.record_invalidated',true)='1'
    ON CONFLICT(agent_id) DO UPDATE SET version=excluded.version;
END
$fn$;
'''


FLUSH = '''CREATE FUNCTION orgtree.record_flush() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE r bigint;
BEGIN
  r := nullif(current_setting('orgtree.record_revision',true),'')::bigint;
  IF r IS NULL THEN
    IF NOT EXISTS(SELECT 1 FROM orgtree.changes WHERE xid=pg_current_xact_id()) THEN
      RETURN NULL;
    END IF;
    UPDATE orgtree.org_revision SET rev=rev+1,
      floor=CASE WHEN current_setting('orgtree.record_invalidated',true)='1'
                 THEN greatest(floor,rev+1) ELSE floor END RETURNING rev INTO r;
    PERFORM set_config('orgtree.record_revision',r::text,true);
    -- O1 owns the transaction-local roots and the read-only cycle kernel.
    -- No pending roots on pre-O1 databases: do not require its function there.
    IF current_setting('orgtree.graph_pending',true)='1' THEN
      PERFORM orgtree.graph_assert_final_cycles();
    END IF;
    PERFORM orgtree.resolve_scopes();
    PERFORM orgtree.record_stamp_details(r);
    INSERT INTO orgtree.revisions(rev,xid,at) VALUES(r,pg_current_xact_id(),clock_timestamp());
    PERFORM pg_notify('org_rev',(SELECT slug FROM orgtree.org_identity)||':'||r::text);
  ELSE
    -- A forced early flush can be followed by more graph statements. The O1
    -- deferred guard also covers later writes that name only existing keys.
    IF current_setting('orgtree.graph_pending',true)='1' THEN
      PERFORM orgtree.graph_assert_final_cycles();
    END IF;
    -- An explicit constraint check can make the transaction's revision before
    -- a later bulk rewrite. We already hold the singleton; raise its floor
    -- without making a second revision, including after savepoint rollback.
    IF current_setting('orgtree.record_invalidated',true)='1' THEN
      UPDATE orgtree.org_revision SET floor=greatest(floor,r);
      PERFORM orgtree.record_stamp_details(r);
    END IF;
    IF current_setting('orgtree.pending_scopes',true)='1' THEN
      PERFORM orgtree.resolve_scopes();
      PERFORM orgtree.record_stamp_details(r);
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER record_flush AFTER INSERT ON orgtree.changes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.record_flush();

-- A caller forcing constraints must not flush before a source statement's
-- AFTER STATEMENT capture. Re-defer ONLY this trigger, leaving unrelated checks.
CREATE FUNCTION orgtree.record_defer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  SET CONSTRAINTS orgtree.record_flush DEFERRED;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER record_defer BEFORE INSERT ON orgtree.changes
  FOR EACH STATEMENT EXECUTE FUNCTION orgtree.record_defer();

CREATE FUNCTION orgtree.invalidate_cursors() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
BEGIN
  PERFORM set_config('orgtree.record_invalidated','1',true);
  INSERT INTO orgtree.changes(xid,entity,entity_id)
    VALUES(pg_current_xact_id(),'reset','*') ON CONFLICT DO NOTHING;
END
$fn$;
'''


def migration_sql(sources: Mapping[str, Source] = SOURCES, windows: tuple[Window, ...] = ()) -> str:
    resolver = RESOLVE
    cases = []
    for window in windows:
        prefix = f'window:{window.name}:'
        cases.append(f"      IF scope_row.entity_id LIKE '{prefix}%' THEN\n"
            f"        partition_key := substring(scope_row.entity_id FROM {len(prefix)+1});\n"
            '        SELECT count(*) INTO named_count FROM orgtree.changes '
            f"WHERE xid=pg_current_xact_id() AND entity='{window.name}:'||partition_key;\n"
            '        ' + window_resolution(window) + '\n        CONTINUE;\n      END IF;')
    resolver = resolver.replace('      -- WINDOW_CASES', '\n'.join(cases))
    return ('-- GENERATED by orgdb.record_sql.migration_sql; edit the declaration, not this file.\n'
            '-- Record feed, step-6 addendum rev 3.\n\n' + SCHEMA + '\n' + resolver + '\n'
            + FLUSH + '\n' + capture_sql(with_windows(sources, windows)))
