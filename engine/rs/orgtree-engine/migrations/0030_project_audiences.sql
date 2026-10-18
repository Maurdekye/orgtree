-- Explicit grants stay in ot.audiences. One live project parent contributes
-- its OWN grants to each direct member. This view never reads itself, so an
-- inherited grant cannot relay through nested projects. Moves need no writes.
CREATE VIEW ot.effective_audiences AS
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
 WHERE au.revoked_at IS NULL AND NOT au.paused AND au.grantor <> '@extern';
