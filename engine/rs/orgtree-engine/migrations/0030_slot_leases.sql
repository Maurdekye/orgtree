-- Project slots (docket project-slots-first-come-permits-claimed-through;
-- user 2026-10-18 08:37Z-08:42Z): a project with a slot count gives out that
-- many permits, first come first served. A lease is one held permit; an
-- ended lease is the history (how each hold ended). The LINE is not stored
-- here: it is the project's armed `slot` watchdogs, ordered by
-- memo.queued_at, so it survives restarts like every dog.
CREATE TABLE ot.slot_leases (
  id               bigserial PRIMARY KEY,
  uid              text NOT NULL UNIQUE,
  org_id           bigint NOT NULL REFERENCES ot.orgs(id),
  project_id       bigint NOT NULL REFERENCES ot.agents(id),
  holder_agent_id  bigint NOT NULL REFERENCES ot.agents(id),
  slot_no          int NOT NULL,
  reason           text,
  dog_id           bigint,
  granted_at       timestamptz NOT NULL DEFAULT now(),
  -- checkup wakes this hold has had (the idle reclaim, as ack mode's)
  wakes            int NOT NULL DEFAULT 0,
  ended_at         timestamptz,
  end_reason       text,
  ended_by         text
);
CREATE INDEX slot_leases_active ON ot.slot_leases (project_id, slot_no) WHERE ended_at IS NULL;
CREATE INDEX slot_leases_holder ON ot.slot_leases (holder_agent_id) WHERE ended_at IS NULL;
CREATE INDEX slot_leases_history ON ot.slot_leases (project_id, id DESC);
CREATE INDEX watchdogs_slot ON ot.watchdogs (((memo->>'target_id')::bigint)) WHERE kind = 'slot' AND state = 'armed';
