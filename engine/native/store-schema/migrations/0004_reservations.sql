-- P03 WS2 base schema, part 4: shared-resource reservations (r7 §3.2).
-- K1 and K2 are the conflict detectors that replace DOC_LOCK; both are on the
-- executor's 23505 retry allowlist. K3/K4 are value rules.

CREATE TABLE resource_reservations (
    org_id              uuid             NOT NULL,
    reservation_id      uuid             NOT NULL,
    owner_id            uuid             NOT NULL,
    item_id             uuid             NULL,
    resource            text             COLLATE "C" NOT NULL,
    candidate           text             COLLATE "C" NULL,
    base                text             COLLATE "C" NULL,
    paths               text[]           NOT NULL DEFAULT '{}',
    state               text             COLLATE "C" NOT NULL,
    created_at          timestamptz      NOT NULL,
    updated_at          timestamptz      NOT NULL,
    expires_at          timestamptz      NOT NULL,
    heartbeat_at        timestamptz      NOT NULL,
    lease_s             double precision NOT NULL,
    stale_s             double precision NOT NULL,
    integration_key     text             COLLATE "C" NULL,
    release_receipt     jsonb            NULL,
    integration_receipt jsonb            NULL,
    successor_id        uuid             NULL,
    recovery_reason     text             NULL,
    stale_reason        text             NULL,
    CONSTRAINT resource_reservations_pk PRIMARY KEY (org_id, reservation_id),
    CONSTRAINT resource_reservations_owner_fk FOREIGN KEY (org_id, owner_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT resource_reservations_successor_fk FOREIGN KEY (org_id, successor_id) REFERENCES agents (org_id, principal_id),
    CONSTRAINT resource_reservations_item_fk FOREIGN KEY (org_id, item_id) REFERENCES work_items (org_id, item_id),
    -- K3
    CONSTRAINT resource_reservations_state CHECK (state IN ('held', 'released', 'recovered', 'stale', 'landed')),
    -- K4 (D12: finite)
    CONSTRAINT resource_reservations_lease CHECK (lease_s > 0 AND lease_s <= 86400),
    CONSTRAINT resource_reservations_stale CHECK (stale_s > 0 AND stale_s <= 86400),
    CONSTRAINT resource_reservations_paths CHECK (cardinality(paths) <= 128),
    CONSTRAINT resource_reservations_resource_len CHECK (char_length(resource) BETWEEN 1 AND 200),
    CONSTRAINT resource_reservations_key_len CHECK (integration_key IS NULL OR char_length(integration_key) BETWEEN 1 AND 200)
);

-- K1: at most one active holder per resource.
CREATE UNIQUE INDEX resource_reservations_held_resource
    ON resource_reservations (org_id, resource) WHERE state = 'held';
-- K2: one reservation per integration key.
CREATE UNIQUE INDEX resource_reservations_integration_key
    ON resource_reservations (org_id, integration_key) WHERE integration_key IS NOT NULL;

CREATE INDEX resource_reservations_by_owner ON resource_reservations (org_id, owner_id, state);
CREATE INDEX resource_reservations_by_item ON resource_reservations (org_id, item_id, state);
-- D1 cap: active claims only.
CREATE INDEX resource_reservations_held ON resource_reservations (org_id) WHERE state = 'held';

-- K4's path element bound (<= 512 characters each) needs a function: a CHECK
-- cannot contain a subquery.
CREATE FUNCTION resource_reservations_paths_ok(p text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(bool_and(char_length(x) <= 512), true) FROM unnest(p) AS x
$$;
ALTER TABLE resource_reservations
    ADD CONSTRAINT resource_reservations_path_len CHECK (resource_reservations_paths_ok(paths));
