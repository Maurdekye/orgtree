-- The project desk's history (docket
-- project-desk-mail-event-listeners-and-slots-tabs; user 2026-10-20
-- 06:22Z-06:42Z, design approved by the coordinator 06:36Z). Every read of
-- these is a 30-row page by key, so no read grows with history.

-- Each fired project event, and each listener watch reaching its count, with
-- who was listening then: the agent, its dog, when it began listening (its
-- arming or its previous event) and, for an event, the fire mail it got.
CREATE TABLE ot.project_fires (
  id          bigserial PRIMARY KEY,
  org_id      bigint NOT NULL REFERENCES ot.orgs (id),
  project_id  bigint NOT NULL REFERENCES ot.agents (id),
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind IN ('event', 'watch')),
  fired_by    text,
  message     text,
  -- a watch: {agent, dog, name, count, armed, since}
  watch       jsonb,
  -- [{agent, dog, name, once, since, mail}] in delivery (dog) order
  listeners   jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX project_fires_page ON ot.project_fires (project_id, id DESC);

-- Each handed project mail that ended: acked; failed (taken back from a
-- holder that stopped listening, was halted or retired, or did not ack in
-- time); taken back by the user; or sent to the dead letters. A row is
-- written in its ending's own transaction, so id order is ending order.
CREATE TABLE ot.project_mail_endings (
  id           bigserial PRIMARY KEY,
  org_id       bigint NOT NULL REFERENCES ot.orgs (id),
  project_id   bigint NOT NULL REFERENCES ot.agents (id),
  mail_uid     text NOT NULL,
  copy_uid     text,
  agent_id     bigint,
  agent_name   text NOT NULL,
  dog_uid      text,
  how          text NOT NULL CHECK (how IN ('acked', 'failed', 'taken_back', 'dead_letter')),
  why          text,
  attempt      integer,
  waited_from  timestamptz,
  held_at      timestamptz,
  ended_at     timestamptz NOT NULL DEFAULT now(),
  ack_uid      text
);
CREATE INDEX project_mail_endings_page ON ot.project_mail_endings (project_id, id DESC);

-- The mail queue's hand-outs, newest first (round-robin's Recently
-- Delivered): one copy per hand-out, in its listener's mailbox.
CREATE INDEX mail_project_copies ON ot.mail ((extra->'via_project'->>'id'), id DESC) WHERE extra ? 'via_project';
-- The jobs held right now (ack mode's Working): handed and not acked yet.
CREATE INDEX mail_project_held ON ot.mail (recipient_agent_id, id)
  WHERE state = 'read' AND extra->'claimed'->>'ack' = 'true' AND extra->'claimed'->>'acked_at' IS NULL;

-- The history that existed before this migration. The statements below the
-- marker are idempotent: tools/rig/proofs/project-history.mjs runs them again.
-- BACKFILL

-- A project shows its event Listeners tab once any listener has registered
-- on it: projects whose listener or watch came before this migration.
UPDATE ot.agents a SET extra = a.extra || jsonb_build_object('listeners_seen_at', w.first)
  FROM (SELECT memo->>'target_id' AS project, min(created_at) AS first FROM ot.watchdogs
         WHERE kind IN ('project_listener', 'listener_watch') AND memo ? 'target_id' GROUP BY 1) w
 WHERE a.kind = 'project' AND a.id::text = w.project AND NOT (a.extra ? 'listeners_seen_at');

-- Earlier fires, from the org event log: the firer, a 200-character message
-- and the names of the listeners reached (no dogs or listening times).
INSERT INTO ot.project_fires (org_id, project_id, at, kind, fired_by, message, listeners)
SELECT e.org_id, e.subject_agent_id, e.at, 'event', e.actor, e.detail->>'message',
       CASE WHEN jsonb_typeof(e.detail->'listeners') = 'array'
            THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('agent', x.l) ORDER BY x.n), '[]'::jsonb)
                    FROM jsonb_array_elements_text(e.detail->'listeners') WITH ORDINALITY AS x(l, n))
            ELSE '[]'::jsonb END
  FROM ot.events e JOIN ot.agents a ON a.id = e.subject_agent_id AND a.kind = 'project'
 WHERE e.op = 'project_event_fire'
   AND NOT EXISTS (SELECT 1 FROM ot.project_fires f
                    WHERE f.project_id = e.subject_agent_id AND f.kind = 'event' AND f.at = e.at)
 ORDER BY e.id;

-- Earlier endings, in ending order: the acks (each kept as a read record in
-- the project's mailbox), then every attempt a job's log shows ended without
-- one (its last, for a dead letter, as the dead letter).
INSERT INTO ot.project_mail_endings (org_id, project_id, mail_uid, copy_uid, agent_id, agent_name, dog_uid, how, why,
                                     attempt, held_at, ended_at, ack_uid)
SELECT s.org_id, s.project_id, s.mail_uid, s.copy_uid, s.agent_id, s.agent_name, s.dog_uid, s.how, s.why,
       s.attempt, s.held_at, s.ended_at, s.ack_uid
  FROM (
    SELECT k.org_id, k.recipient_agent_id AS project_id, j.uid AS mail_uid, j.extra->'claimed'->>'copy' AS copy_uid,
           k.sender_agent_id AS agent_id, k.sender AS agent_name, j.extra->'claimed'->>'dog' AS dog_uid,
           'acked' AS how, NULL::text AS why,
           CASE WHEN jsonb_typeof(j.extra->'attempts') = 'number' THEN (j.extra->>'attempts')::integer END AS attempt,
           CASE WHEN pg_input_is_valid(j.extra->'claimed'->>'at', 'timestamptz')
                THEN (j.extra->'claimed'->>'at')::timestamptz END AS held_at,
           k.created_at AS ended_at, k.uid AS ack_uid
      FROM ot.agents p
      JOIN ot.mail k ON k.recipient_agent_id = p.id AND k.extra ? 'ack_of'
      JOIN ot.mail j ON j.uid = k.extra->>'ack_of' AND j.recipient_agent_id = p.id
     WHERE p.kind = 'project'
    UNION ALL
    SELECT j.org_id, j.recipient_agent_id, j.uid, a.x->>'copy',
           CASE WHEN jsonb_typeof(a.x->'by_id') = 'number' THEN (a.x->>'by_id')::bigint END, coalesce(a.x->>'by', '?'), NULL,
           CASE WHEN j.extra ? 'dead_letter' AND a.n = jsonb_array_length(j.extra->'attempt_log') THEN 'dead_letter' ELSE 'failed' END,
           a.x->'ended'->>'why',
           CASE WHEN jsonb_typeof(a.x->'n') = 'number' THEN (a.x->>'n')::integer END,
           CASE WHEN pg_input_is_valid(a.x->>'at', 'timestamptz') THEN (a.x->>'at')::timestamptz END,
           CASE WHEN pg_input_is_valid(a.x->'ended'->>'at', 'timestamptz') THEN (a.x->'ended'->>'at')::timestamptz END,
           NULL
      FROM ot.agents p
      JOIN ot.mail j ON j.recipient_agent_id = p.id AND jsonb_typeof(j.extra->'attempt_log') = 'array'
      CROSS JOIN LATERAL jsonb_array_elements(j.extra->'attempt_log') WITH ORDINALITY AS a(x, n)
     WHERE p.kind = 'project' AND a.x->'ended'->>'how' IN ('released', 'timed_out')
  ) s
 WHERE s.ended_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ot.project_mail_endings e
                    WHERE e.project_id = s.project_id AND e.mail_uid = s.mail_uid AND e.ended_at = s.ended_at)
 ORDER BY s.ended_at, s.mail_uid;
