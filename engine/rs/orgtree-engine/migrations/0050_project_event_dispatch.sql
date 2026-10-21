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
