-- Pending project fires survive restart; one stable history row per event.
CREATE TABLE ot.project_event_dispatch (
  fire_id bigint PRIMARY KEY REFERENCES ot.project_fires(id) ON DELETE CASCADE,
  org_id bigint NOT NULL REFERENCES ot.orgs(id),
  project_id bigint NOT NULL REFERENCES ot.agents(id),
  after_id bigint NOT NULL DEFAULT 0 CHECK(after_id>=0),
  high_water bigint NOT NULL CHECK(high_water>=0),
  done boolean NOT NULL DEFAULT false
);
CREATE INDEX project_event_dispatch_pending ON ot.project_event_dispatch(project_id,fire_id) WHERE NOT done;
CREATE INDEX project_event_dispatch_recovery ON ot.project_event_dispatch(fire_id) WHERE NOT done;

-- A crossed watch edge and its fire obligation commit together. Event-page
-- delivery effects use the same durable outbox after their mail is committed.
CREATE TABLE ot.listener_fire_outbox (
  id bigserial PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES ot.orgs(id),
  project_id bigint NOT NULL REFERENCES ot.agents(id),
  watchdog_id bigint NOT NULL REFERENCES ot.watchdogs(id) ON DELETE CASCADE,
  line text,
  delivery jsonb,
  actions_claimed boolean NOT NULL DEFAULT false,
  processing_boot text,
  done boolean NOT NULL DEFAULT false,
  CHECK(line IS NOT NULL OR delivery IS NOT NULL)
);
CREATE INDEX listener_fire_outbox_pending ON ot.listener_fire_outbox(project_id,id) WHERE NOT done;
CREATE INDEX listener_fire_outbox_recovery ON ot.listener_fire_outbox(id) WHERE NOT done;
