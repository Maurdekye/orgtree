-- Project nodes (docs/rust-engine/PROJECT-NODES.md; user 2026-10-16): a
-- tree node that stands for a project and is not an agent. It shares the
-- agents table so the tree, names, moves and credits treat it like any node;
-- it runs no turns, holds no seat and passes its parent's scope through.
ALTER TABLE ot.agents ADD COLUMN kind text NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'project'));
CREATE INDEX agents_projects ON ot.agents (org_id, id) WHERE kind = 'project' AND state = 'live';

-- The nearest AGENT above a node: whom it reports to. A project is
-- transparent for reporting, so an agent under a project reports to the
-- agent above the project (NULL: nobody, a top-level agent).
CREATE FUNCTION ot.superior_of(node bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up(id, parent_id, kind, depth) AS (
    SELECT a.id, a.parent_id, a.kind, 0 FROM ot.agents a WHERE a.id = node
    UNION ALL
    SELECT p.id, p.parent_id, p.kind, up.depth + 1 FROM ot.agents p JOIN up ON p.id = up.parent_id
     WHERE up.depth < 1024)
  SELECT id FROM up WHERE depth > 0 AND kind = 'agent' ORDER BY depth LIMIT 1
$$;

-- The fair project mail queue: a project's armed watchers, found by the
-- project's id (rename-proof; the target text is the name, for display).
CREATE INDEX watchdogs_fair_queue ON ot.watchdogs (((memo->>'target_id')::bigint)) WHERE kind = 'fair_queue' AND state = 'armed';

-- A document presented under a project records the agent that presented it.
ALTER TABLE ot.documents ADD COLUMN presented_by text;
