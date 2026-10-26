-- A broadcast is a fresh decision, never an old target-specific Allow.
UPDATE ot.custom_apps SET permissions=permissions-'events.fire',permission_rev=permission_rev+1
 WHERE permissions ? 'events.fire';
CREATE TABLE ot.app_event_fires (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 uid text NOT NULL UNIQUE,
 org_id bigint NOT NULL,
 app_id text NOT NULL,
 panel_id text NOT NULL,
 name text NOT NULL,
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=131072),
 producer jsonb NOT NULL,
 at timestamptz NOT NULL DEFAULT now(),
 done boolean NOT NULL DEFAULT false,
 FOREIGN KEY(org_id,app_id) REFERENCES ot.custom_apps(org_id,id) ON DELETE CASCADE,
 FOREIGN KEY(org_id,panel_id) REFERENCES ot.custom_panels(org_id,id) ON DELETE CASCADE
);
CREATE INDEX app_event_pending ON ot.app_event_fires(org_id,app_id,id) WHERE NOT done;
-- Snapshot IDs are deliberately retained if a watchdog is removed. Missing,
-- paused, retired or revoked recipients are skipped by the delivery transaction.
CREATE TABLE ot.app_event_recipients (
 fire_id bigint NOT NULL REFERENCES ot.app_event_fires(id) ON DELETE CASCADE,
 dog_id bigint NOT NULL,
 delivery jsonb,
 actions_claimed boolean NOT NULL DEFAULT false,
 done boolean NOT NULL DEFAULT false,
 PRIMARY KEY(fire_id,dog_id)
);
CREATE INDEX app_event_recipient_pending ON ot.app_event_recipients(fire_id,dog_id) WHERE NOT done;
CREATE INDEX app_listener_source ON ot.watchdogs(org_id,target,id) WHERE kind='app_listener' AND state IN ('armed','paused');
