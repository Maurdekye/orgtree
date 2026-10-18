-- Expand each explicit grant once at each project endpoint. Read only base
-- grants: inherited access never relays through nested projects or grants.
-- NOT MATERIALIZED lets each caller's org/name predicates reach the base
-- indexes rather than materializing active audiences from every organization.
CREATE OR REPLACE VIEW ot.effective_audiences AS
WITH holders AS NOT MATERIALIZED (
    SELECT au.id, au.org_id, au.grantee, au.grantor, au.granted_at, au.reason,
           au.revoked_at, au.paused, NULL::text AS source_project
      FROM ot.audiences au
     WHERE au.revoked_at IS NULL AND NOT au.paused
    UNION ALL
    SELECT au.id, au.org_id, member.name AS grantee, au.grantor, au.granted_at, au.reason,
           au.revoked_at, au.paused, project.name AS source_project
      FROM ot.audiences au
      JOIN ot.agents project ON project.org_id = au.org_id AND project.name = au.grantee
                             AND project.kind = 'project' AND project.state = 'live'
      JOIN ot.agents member ON member.org_id = project.org_id AND member.parent_id = project.id
                            AND member.state = 'live'
     WHERE au.revoked_at IS NULL AND NOT au.paused AND au.grantor <> '@extern'
)
SELECT id, org_id, grantee, grantor, granted_at, reason, revoked_at, paused, source_project
  FROM holders
UNION ALL
SELECT held.id, held.org_id, held.grantee, recipient.name AS grantor, held.granted_at, held.reason,
       held.revoked_at, held.paused, coalesce(held.source_project, project.name) AS source_project
  FROM holders held
  JOIN ot.agents project ON project.org_id = held.org_id AND project.name = held.grantor
                         AND project.kind = 'project' AND project.state = 'live'
  JOIN ot.agents recipient ON recipient.org_id = project.org_id AND recipient.parent_id = project.id
                           AND recipient.kind = 'agent' AND recipient.state = 'live';
