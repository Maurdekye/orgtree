-- Runtime cards need a recipient who can act. Structural reporting and
-- authorization still use superior_of; only delivery skips inactive agents.
CREATE OR REPLACE FUNCTION ot.live_superior_of(node bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up(id, parent_id, kind, state, org_id, depth) AS (
    SELECT a.id, a.parent_id, a.kind, a.state, a.org_id, 0
      FROM ot.agents a WHERE a.id = node
    UNION ALL
    SELECT p.id, p.parent_id, p.kind, p.state, p.org_id, up.depth + 1
      FROM ot.agents p JOIN up ON p.id = up.parent_id AND p.org_id = up.org_id
     WHERE up.depth < 1024)
  SELECT id FROM up WHERE depth > 0 AND kind = 'agent' AND state = 'live'
   ORDER BY depth LIMIT 1
$$;

-- Old retool cascades replaced project scope with the parent's agent scope.
-- Restore transparency once, including archived projects that may be rehired.
-- Keep every surviving setting (including keys unknown to this version).
-- Missing policy or Summary text cannot be reconstructed from agent scope;
-- do not invent values or replay stale settings over newer choices.
UPDATE ot.agents
   SET scope = (CASE WHEN jsonb_typeof(scope) = 'object' THEN scope ELSE '{}'::jsonb END)
               || '{"transparent":true}'::jsonb,
       row_version = row_version + 1
 WHERE kind = 'project' AND scope->'transparent' IS DISTINCT FROM 'true'::jsonb;
