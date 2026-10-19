-- Agent relations contract project-only edges. parent_id remains structural:
-- placement, project membership and the signed physical-sibling mail policy.
-- Lifecycle state is deliberately NOT folded into authority/top-level tests.
-- Runtime delivery alone uses the separate live_superior_of helper.
CREATE VIEW ot.agent_reporting AS
  SELECT a.id, a.org_id, a.name, a.state, ot.superior_of(a.id) AS superior_id
    FROM ot.agents a WHERE a.kind = 'agent';

-- First agents below a superior, traversing only intervening projects. NULL
-- means the user's agent frontier, including agents inside root projects.
-- Callers choose live/archived filtering without turning an inactive agent
-- into a transparent wrapper. Bounded like the existing structural walkers.
CREATE FUNCTION ot.reports_of(org bigint, superior bigint) RETURNS SETOF bigint
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE down(id, kind, depth) AS (
    SELECT a.id, a.kind, 0 FROM ot.agents a
     WHERE a.org_id = org AND a.parent_id IS NOT DISTINCT FROM superior
    UNION ALL
    SELECT a.id, a.kind, d.depth + 1 FROM ot.agents a JOIN down d ON a.parent_id = d.id
     WHERE a.org_id = org AND d.kind = 'project' AND d.depth < 1024)
  SELECT id FROM down WHERE kind = 'agent'
$$;
