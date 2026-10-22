-- Project wrappers are transparent at every depth. A stable-row UNION ends
-- malformed cycles; stop as soon as the nearest eligible agent is reached.
CREATE OR REPLACE FUNCTION ot.superior_of(node bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up(id,parent_id,kind,org_id) AS (
    SELECT id,parent_id,kind,org_id FROM ot.agents WHERE id=node
    UNION
    SELECT p.id,p.parent_id,p.kind,p.org_id FROM ot.agents p JOIN up ON p.id=up.parent_id
     WHERE (up.id=node OR up.kind<>'agent') AND p.org_id=up.org_id AND p.id<>node)
  SELECT id FROM up WHERE id<>node AND kind='agent' LIMIT 1
$$;

CREATE OR REPLACE FUNCTION ot.live_superior_of(node bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up(id,parent_id,kind,state,org_id) AS (
    SELECT id,parent_id,kind,state,org_id FROM ot.agents WHERE id=node
    UNION
    SELECT p.id,p.parent_id,p.kind,p.state,p.org_id FROM ot.agents p JOIN up ON p.id=up.parent_id
     WHERE (up.id=node OR up.kind<>'agent' OR up.state<>'live')
       AND p.org_id=up.org_id AND p.id<>node)
  SELECT id FROM up WHERE id<>node AND kind='agent' AND state='live' LIMIT 1
$$;
