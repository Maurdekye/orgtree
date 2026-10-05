"""Mailbox capture and read-only resolution after the org revision lock."""
from . import record_derivations as D
from .record_mail import KEEP


def dependencies(base):
    result = dict(base)
    def add(table,*names):
        result[table] = D.Source((*result[table].names,*names))
    def direct(folder,table):
        return D.Name("'agent_mail:'||r.agent_id",f"r.agent_id||'/{folder}:{table}:'||r.id")
    add('mail',direct('pending','mail'),D.scope('mail_owner','r.agent_id'))
    size = "CASE WHEN json_typeof(r.mail)='array' THEN json_array_length(r.mail) ELSE 0 END"
    add('delivery_batches',D.Name("'agent_mail:'||r.agent_id",
        "r.agent_id||'/pending:delivery:'||r.id||':'||generate_series(0,("+size+")-1)"),
        D.scope('mail_owner','r.agent_id'),
        D.scope('mail_pending_size',"r.agent_id||':'||r.id||':'||("+size+")"))
    add('mail_log',direct('delivered','mail_log'),D.scope('mail_owner','r.agent_id'),
        D.scope('mail_recipient','r.agent_id'),D.scope('mail_sender','r.win_from'),
        D.Name("'~mail_sent:'||r.win_from","'mail_log:'||r.id"))
    for table,sender in (('user_inbox',"coalesce(r.\"from\",r.extra->>'from')"),('user_mail_log','r.win_from')):
        add(table,D.scope('mail_sender',sender),D.Name("'~mail_sent:'||("+sender+")",repr(table+':')+'||r.id'))
    for table,parent in (('mail_log_attachments','mail_log_id'),('mail_log_attachments_missing','mail_log_id'),
                         ('user_inbox_attachments','user_inbox_id'),('user_mail_log_attachments','user_mail_log_id')):
        add(table,D.scope('mail_child',repr(parent[:-3]+':')+f'||r.{parent}'))
    add('agents',D.scope('mail_identity','r.id',changed=('name','tombstone')),
        D.scope('mail_recipient','r.id',changed=('name','tombstone')))
    return result


# The same indexed algorithm as compat.sql::_sent_ids. This function returns
# only IDs. The caller supplies its snapshot and cap; it never locks a row.
PREPARE = r'''
CREATE INDEX record_mail_owner_sender ON orgtree.mail_log(agent_id,win_from,win_at DESC,id DESC);
CREATE FUNCTION orgtree.record_sent_ids(sender text, cap integer) RETURNS SETOF bigint
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,orgtree AS $fn$
DECLARE head bigint[]; edge text; kept bigint[]; owner_row record; extra_ids bigint[];
BEGIN
  IF cap<=0 THEN RETURN; END IF;
  SELECT array_agg(n.id ORDER BY n.win_at DESC,k.first DESC,n.id DESC) INTO head
    FROM (SELECT m.id,m.win_at,m.agent_id FROM orgtree.mail_log m
          WHERE m.win_from=sender ORDER BY m.win_at DESC LIMIT cap+1) n
    CROSS JOIN LATERAL (SELECT f.id AS first FROM orgtree.mail_log f
      WHERE f.agent_id>=n.agent_id ORDER BY f.agent_id,f.id LIMIT 1) k;
  IF coalesce(cardinality(head),0)<=cap THEN RETURN QUERY SELECT unnest(head); RETURN; END IF;
  SELECT m.win_at INTO edge FROM orgtree.mail_log m WHERE m.id=head[cardinality(head)];
  IF (SELECT count(*) FROM orgtree.mail_log m WHERE m.id=ANY(head) AND m.win_at=edge)=1 THEN
    RETURN QUERY SELECT unnest(head[1:cap]); RETURN;
  END IF;
  SELECT coalesce(array_agg(x.id ORDER BY x.ord),ARRAY[]::bigint[]) INTO kept
    FROM unnest(head) WITH ORDINALITY x(id,ord) JOIN orgtree.mail_log m ON m.id=x.id
    WHERE m.win_at<>edge;
  FOR owner_row IN
    WITH RECURSIVE owners(agent_id) AS (
      (SELECT m.agent_id FROM orgtree.mail_log m WHERE m.win_from=sender AND m.win_at=edge
       ORDER BY m.agent_id LIMIT 1)
      UNION ALL SELECT (SELECT m.agent_id FROM orgtree.mail_log m
        WHERE m.win_from=sender AND m.win_at=edge AND m.agent_id>o.agent_id
        ORDER BY m.agent_id LIMIT 1) FROM owners o WHERE o.agent_id IS NOT NULL)
    SELECT o.agent_id FROM owners o CROSS JOIN LATERAL
      (SELECT f.id AS first FROM orgtree.mail_log f WHERE f.agent_id>=o.agent_id
       ORDER BY f.agent_id,f.id LIMIT 1) k
    WHERE o.agent_id IS NOT NULL ORDER BY k.first DESC
  LOOP
    EXIT WHEN cardinality(kept)>=cap;
    SELECT array_agg(x.id ORDER BY x.id DESC) INTO extra_ids FROM
      (SELECT m.id FROM orgtree.mail_log m WHERE m.win_from=sender AND m.win_at=edge
       AND m.agent_id>=owner_row.agent_id AND m.agent_id<=owner_row.agent_id
       ORDER BY m.agent_id DESC,m.id DESC LIMIT cap-cardinality(kept)) x;
    kept := kept||coalesce(extra_ids,ARRAY[]::bigint[]);
  END LOOP;
  RETURN QUERY SELECT unnest(kept);
END
$fn$;
'''

AFTER = r'''
  -- Resolve child rows through their current parent, never in their capture.
  INSERT INTO orgtree.changes(xid,entity,entity_id)
    SELECT pg_current_xact_id(),'agent_mail:'||m.agent_id,
      m.agent_id||'/delivered:mail_log:'||m.id
    FROM orgtree.changes c JOIN orgtree.mail_log m ON
      m.id=CASE WHEN c.entity_id LIKE 'mail_child:mail_log:%' THEN split_part(c.entity_id,':',3)::bigint END
    WHERE c.xid=pg_current_xact_id() AND c.entity='~scope' ON CONFLICT DO NOTHING;
  INSERT INTO orgtree.changes(xid,entity,entity_id)
    SELECT pg_current_xact_id(),'~mail_sent:'||m.win_from,'mail_log:'||m.id
    FROM orgtree.changes c JOIN orgtree.mail_log m ON
      m.id=CASE WHEN c.entity_id LIKE 'mail_child:mail_log:%' THEN split_part(c.entity_id,':',3)::bigint END
    WHERE c.xid=pg_current_xact_id() AND c.entity='~scope' ON CONFLICT DO NOTHING;
  INSERT INTO orgtree.changes(xid,entity,entity_id)
    SELECT pg_current_xact_id(),'~mail_sent:'||m."from",'user_inbox:'||m.id
    FROM orgtree.changes c JOIN orgtree.user_inbox m ON
      m.id=CASE WHEN c.entity_id LIKE 'mail_child:user_inbox:%' THEN split_part(c.entity_id,':',3)::bigint END
    WHERE c.xid=pg_current_xact_id() AND c.entity='~scope' ON CONFLICT DO NOTHING;
  INSERT INTO orgtree.changes(xid,entity,entity_id)
    SELECT pg_current_xact_id(),'~mail_sent:'||m.win_from,'user_mail_log:'||m.id
    FROM orgtree.changes c JOIN orgtree.user_mail_log m ON
      m.id=CASE WHEN c.entity_id LIKE 'mail_child:user_mail_log:%' THEN split_part(c.entity_id,':',3)::bigint END
    WHERE c.xid=pg_current_xact_id() AND c.entity='~scope' ON CONFLICT DO NOTHING;
  -- Any change in a recipient archive can move its first-row tie key. Dirty
  -- each sender's bounded recipient tail and its complete selection boundary.
  FOR scope_row IN SELECT entity_id FROM orgtree.changes
    WHERE xid=pg_current_xact_id() AND entity='~scope' AND entity_id LIKE 'mail_recipient:%'
  LOOP
    partition_key := substring(scope_row.entity_id FROM length('mail_recipient:')+1);
    INSERT INTO orgtree.changes(xid,entity,entity_id)
      SELECT pg_current_xact_id(),'~scope','mail_sender:'||x.win_from FROM
      (SELECT DISTINCT win_from FROM orgtree.mail_log WHERE agent_id=partition_key::bigint
       ORDER BY win_from LIMIT 2001) x WHERE x.win_from IS NOT NULL ON CONFLICT DO NOTHING;
    INSERT INTO orgtree.changes(xid,entity,entity_id)
      SELECT pg_current_xact_id(),'~mail_sent:'||s.win_from,'mail_log:'||m.id
      FROM (SELECT DISTINCT win_from FROM orgtree.mail_log WHERE agent_id=partition_key::bigint
            ORDER BY win_from LIMIT 2001) s CROSS JOIN LATERAL
      (SELECT id FROM orgtree.mail_log WHERE agent_id=partition_key::bigint AND win_from=s.win_from
       ORDER BY win_at DESC,id DESC LIMIT __KEEP__) m LIMIT 2001 ON CONFLICT DO NOTHING;
    IF (SELECT count(*) FROM orgtree.changes WHERE xid=pg_current_xact_id())>2000 THEN
      INSERT INTO orgtree.changes(xid,entity,entity_id) VALUES(pg_current_xact_id(),'reset','mail-bound') ON CONFLICT DO NOTHING;
      RETURN;
    END IF;
  END LOOP;
  -- Every captured old/new pending size contributes to the boundary allowance,
  -- including a batch removed entirely in this transaction.
  SELECT count(*)+coalesce(sum(CASE WHEN entity='~scope' AND entity_id LIKE 'mail_pending_size:%'
    THEN split_part(entity_id,':',4)::bigint ELSE 0 END),0) INTO named_count
    FROM orgtree.changes WHERE xid=pg_current_xact_id();
  IF named_count>2000 THEN
    INSERT INTO orgtree.changes(xid,entity,entity_id) VALUES(pg_current_xact_id(),'reset','mail-bound') ON CONFLICT DO NOTHING;
    RETURN;
  END IF;
  FOR scope_row IN SELECT entity_id FROM orgtree.changes
    WHERE xid=pg_current_xact_id() AND entity='~scope' AND entity_id LIKE 'mail_owner:%'
  LOOP
    partition_key := substring(scope_row.entity_id FROM length('mail_owner:')+1);
    INSERT INTO orgtree.changes(xid,entity,entity_id)
      SELECT pg_current_xact_id(),'agent_mail:'||partition_key,
        partition_key||'/delivered:mail_log:'||m.id FROM orgtree.mail_log m
      WHERE agent_id=partition_key::bigint ORDER BY idx DESC
      LIMIT __KEEP__+40+named_count+
        (SELECT count(*) FROM orgtree.mail WHERE agent_id=partition_key::bigint)+
        (SELECT coalesce(sum(CASE WHEN json_typeof(mail)='array' THEN json_array_length(mail) ELSE 0 END),0)
         FROM orgtree.delivery_batches WHERE agent_id=partition_key::bigint)
      ON CONFLICT DO NOTHING;
  END LOOP;
  FOR scope_row IN SELECT entity_id FROM orgtree.changes
    WHERE xid=pg_current_xact_id() AND entity='~scope' AND entity_id LIKE 'mail_sender:%'
  LOOP
    partition_key := substring(scope_row.entity_id FROM length('mail_sender:')+1);
    INSERT INTO orgtree.changes(xid,entity,entity_id)
      SELECT pg_current_xact_id(),'~mail_sent:'||partition_key,'mail_log:'||id
      FROM orgtree.record_sent_ids(partition_key,(__KEEP__+named_count)::integer) id
      ON CONFLICT DO NOTHING;
    INSERT INTO orgtree.changes(xid,entity,entity_id)
      SELECT pg_current_xact_id(),'~mail_sent:'||partition_key,'user_inbox:'||id
      FROM orgtree.user_inbox WHERE "from"=partition_key LIMIT 2001 ON CONFLICT DO NOTHING;
    INSERT INTO orgtree.changes(xid,entity,entity_id)
      SELECT pg_current_xact_id(),'~mail_sent:'||partition_key,'user_mail_log:'||id
      FROM orgtree.user_mail_log WHERE win_from=partition_key ORDER BY win_at DESC,id DESC
      LIMIT __KEEP__+named_count ON CONFLICT DO NOTHING;
    IF (SELECT count(*) FROM orgtree.changes WHERE xid=pg_current_xact_id())>2000 THEN
      INSERT INTO orgtree.changes(xid,entity,entity_id) VALUES(pg_current_xact_id(),'reset','mail-bound') ON CONFLICT DO NOTHING;
      RETURN;
    END IF;
  END LOOP;
  INSERT INTO orgtree.changes(xid,entity,entity_id)
    SELECT pg_current_xact_id(),'agent_mail:'||a.id,a.id||'/sent:'||c.entity_id
    FROM orgtree.changes c JOIN orgtree.agents a
      ON a.name=substring(c.entity FROM length('~mail_sent:')+1) AND NOT a.tombstone
    WHERE c.xid=pg_current_xact_id() AND c.entity LIKE '~mail_sent:%' ON CONFLICT DO NOTHING;
'''.replace('__KEEP__',str(KEEP))
