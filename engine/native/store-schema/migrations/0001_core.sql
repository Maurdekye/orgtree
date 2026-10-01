-- P03 WS2 base schema, part 1: identity, authority anchors, receipts,
-- runtime in-flight rows and restriction consumers.
--
-- Conventions (engine/native/store/CONTRACT-M1.md §2):
--   * immutable ids are uuid; every org-scoped table has org_id first in its
--     primary key and every org-scoped foreign key includes org_id;
--   * every textual identity key is COLLATE "C" (byte-exact, r7 §3.2);
--   * credits are bigint hundredths;
--   * constraint names are API: the executor's retry allowlist names them;
--   * narrow version rows (r7 C3) never carry busy/status/heartbeat fields.

-- One row. Written by the WS1 custodian at init and on restore (a restore
-- writes a NEW incarnation, v6 §Receipt retention).
CREATE TABLE store_incarnation (
    singleton    boolean     NOT NULL DEFAULT true,
    database_id  uuid        NOT NULL,
    incarnation  uuid        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT store_incarnation_pk PRIMARY KEY (singleton),
    CONSTRAINT store_incarnation_singleton CHECK (singleton)
);

CREATE TABLE organizations (
    org_id      uuid        NOT NULL,
    slug        text        COLLATE "C" NOT NULL,
    created_at  timestamptz NOT NULL,
    kiosk       boolean     NOT NULL DEFAULT false,
    CONSTRAINT organizations_pk PRIMARY KEY (org_id),
    CONSTRAINT organizations_slug UNIQUE (slug),
    CONSTRAINT organizations_slug_len CHECK (octet_length(slug) BETWEEN 1 AND 200)
);

-- One row per control FAMILY (v6 SCHEMA-CATALOG:9 "distinct control families
-- rather than one hot all-settings row"). Island writers FOR SHARE the rows
-- they read (r7 C2a P6); writers update `version`.
CREATE TABLE org_controls (
    org_id   uuid   NOT NULL,
    family   text   COLLATE "C" NOT NULL,
    version  bigint NOT NULL DEFAULT 1,
    value    jsonb  NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT org_controls_pk PRIMARY KEY (org_id, family),
    CONSTRAINT org_controls_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id),
    CONSTRAINT org_controls_family CHECK (family IN (
        'caps', 'killswitch', 'kiosk', 'cascade', 'defaults',
        'directories', 'extern_holders', 'restriction_epoch')),
    CONSTRAINT org_controls_version CHECK (version > 0),
    CONSTRAINT org_controls_value_object CHECK (jsonb_typeof(value) = 'object'),
    CONSTRAINT org_controls_value_bounded CHECK (octet_length(value::text) <= 65536)
);

-- Immutable principal. The current name lives here for display and in
-- agent_names for uniqueness. Lifecycle, generation and halt live in the
-- narrow authority_epoch row, never here.
CREATE TABLE agents (
    org_id        uuid        NOT NULL,
    principal_id  uuid        NOT NULL,
    name          text        COLLATE "C" NOT NULL,
    seat_id       uuid        NOT NULL,
    tier          text        COLLATE "C" NOT NULL,
    created_at    timestamptz NOT NULL,
    CONSTRAINT agents_pk PRIMARY KEY (org_id, principal_id),
    CONSTRAINT agents_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id),
    CONSTRAINT agents_seat UNIQUE (org_id, seat_id),
    CONSTRAINT agents_name_len CHECK (octet_length(name) BETWEEN 1 AND 200)
);

-- Active names AND name reservations share one unique namespace (S3 §8:
-- "a name reservation must live in the same unique namespace as the active
-- names, so that the unique index, not a separate check, keeps a reserved
-- name from being taken"). Archived agents keep their name (legacy suffix
-- rule); deleting an agent frees it.
CREATE TABLE agent_names (
    org_id        uuid NOT NULL,
    name          text COLLATE "C" NOT NULL,
    principal_id  uuid NOT NULL,
    kind          text COLLATE "C" NOT NULL,
    intent_id     uuid NULL,
    CONSTRAINT agent_names_active PRIMARY KEY (org_id, name),
    CONSTRAINT agent_names_agent_fk FOREIGN KEY (org_id, principal_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT agent_names_kind CHECK (kind IN ('active', 'reserved')),
    CONSTRAINT agent_names_reservation_intent CHECK ((kind = 'reserved') = (intent_id IS NOT NULL))
);
CREATE INDEX agent_names_by_principal ON agent_names (org_id, principal_id);

-- r7 C3: the caller anchor. Narrow: lifecycle, generation, halt and the C2a
-- versions (P1 audiences, P7 requests). Anchored FOR SHARE; its writers
-- (retire, archive, rehire, halt, generation change, grant insert/delete,
-- request filing) update it, FOR NO KEY UPDATE (S3 §8 M1).
CREATE TABLE authority_epoch (
    org_id            uuid    NOT NULL,
    principal_id      uuid    NOT NULL,
    lifecycle         text    COLLATE "C" NOT NULL,
    generation        bigint  NOT NULL,
    halted            boolean NOT NULL DEFAULT false,
    audience_version  bigint  NOT NULL DEFAULT 0,
    requests_version  bigint  NOT NULL DEFAULT 0,
    version           bigint  NOT NULL DEFAULT 0,
    CONSTRAINT authority_epoch_pk PRIMARY KEY (org_id, principal_id),
    CONSTRAINT authority_epoch_agent_fk FOREIGN KEY (org_id, principal_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT authority_epoch_lifecycle CHECK (lifecycle IN ('live', 'archived', 'unrecoverable')),
    CONSTRAINT authority_epoch_generation CHECK (generation >= 0)
);

-- One edge row per node: a re-parent updates the moved node's own row (C3).
-- parent_id NULL = top level.
CREATE TABLE topology_edges (
    org_id        uuid   NOT NULL,
    principal_id  uuid   NOT NULL,
    parent_id     uuid   NULL,
    ord           integer NOT NULL DEFAULT 0,
    version       bigint NOT NULL DEFAULT 0,
    CONSTRAINT topology_edges_pk PRIMARY KEY (org_id, principal_id),
    CONSTRAINT topology_edges_agent_fk FOREIGN KEY (org_id, principal_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT topology_edges_parent_fk FOREIGN KEY (org_id, parent_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT topology_edges_not_self CHECK (parent_id IS NULL OR parent_id <> principal_id)
);
CREATE INDEX topology_edges_children ON topology_edges (org_id, parent_id, ord);

-- r7 C2a P3: each node's capability scope, its own version row. Locked
-- top-down by (depth, principal_id) (C4 step 4).
CREATE TABLE scope_rows (
    org_id           uuid    NOT NULL,
    principal_id     uuid    NOT NULL,
    depth            integer NOT NULL,
    tools            jsonb   NOT NULL DEFAULT '{}'::jsonb,
    folders          jsonb   NOT NULL DEFAULT '[]'::jsonb,
    visibility       text    COLLATE "C" NOT NULL,
    permission_mode  text    COLLATE "C" NOT NULL,
    version          bigint  NOT NULL DEFAULT 0,
    CONSTRAINT scope_rows_pk PRIMARY KEY (org_id, principal_id),
    CONSTRAINT scope_rows_agent_fk FOREIGN KEY (org_id, principal_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT scope_rows_depth CHECK (depth >= 0),
    CONSTRAINT scope_rows_tools_object CHECK (jsonb_typeof(tools) = 'object'),
    CONSTRAINT scope_rows_folders_array CHECK (jsonb_typeof(folders) = 'array')
);
CREATE INDEX scope_rows_top_down ON scope_rows (org_id, depth, principal_id);

-- Minimal runtime state (E-D13, r7 C2a P4). Frequently written: never an
-- anchor for authority. The agent's reported STATUS is not here: S3 §4.1
-- keeps it in its own narrow per-seat row, added by WS4 in 0200 (lead
-- request 2026-09-25), so status lives in exactly one place.
CREATE TABLE runtime_state (
    org_id        uuid        NOT NULL,
    principal_id  uuid        NOT NULL,
    busy          boolean     NOT NULL DEFAULT false,
    bg_open       integer     NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL,
    version       bigint      NOT NULL DEFAULT 0,
    CONSTRAINT runtime_state_pk PRIMARY KEY (org_id, principal_id),
    CONSTRAINT runtime_state_agent_fk FOREIGN KEY (org_id, principal_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT runtime_state_bg_open CHECK (bg_open >= 0)
);

-- Audience grants. Every insert or delete bumps the grantee's
-- authority_epoch.audience_version in the same transaction (r7 C2a P1).
-- target_id is the nil uuid for the USER and EXTERN targets.
CREATE TABLE audience_grants (
    org_id       uuid        NOT NULL,
    grantee_id   uuid        NOT NULL,
    target_kind  text        COLLATE "C" NOT NULL,
    target_id    uuid        NOT NULL,
    anchor_id    uuid        NULL,
    created_at   timestamptz NOT NULL,
    CONSTRAINT audience_grants_key PRIMARY KEY (org_id, grantee_id, target_kind, target_id),
    CONSTRAINT audience_grants_grantee_fk FOREIGN KEY (org_id, grantee_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT audience_grants_target_kind CHECK (target_kind IN ('agent', 'user', 'extern'))
);
CREATE INDEX audience_grants_by_target ON audience_grants (org_id, target_kind, target_id);

-- Operation receipts (v6 SCHEMA-CATALOG:22, S3 E7). The claim is the first
-- write after admission; a committed row is never 'claimed' (enforced by the
-- deferred trigger below). Keys live under the IMMUTABLE principal (E7).
-- Every committed executor transaction writes exactly one row: its GROUP
-- IDENTITY for the feed (CONTRACT-M1 §3.7). Published with safe identifier
-- columns only, never `result` or `fingerprint`.
--   ns_kind  ns_id
--   agent        caller principal
--   quick_staff  item
--   operator     operator principal
--   minted       nil uuid (door without a caller key, E4)
CREATE TABLE operation_receipts (
    org_id             uuid        NOT NULL,
    ns_kind            text        COLLATE "C" NOT NULL,
    ns_id              uuid        NOT NULL,
    op_key             text        COLLATE "C" NOT NULL,
    receipt_id         uuid        NOT NULL,
    state              text        COLLATE "C" NOT NULL,
    family             text        COLLATE "C" NOT NULL,
    verb               text        COLLATE "C" NULL,
    fingerprint        text        COLLATE "C" NULL,
    fingerprint_codec  text        COLLATE "C" NULL,
    principal_kind     text        COLLATE "C" NOT NULL,
    principal_id       uuid        NULL,
    generation         bigint      NULL,
    acting_id          uuid        NULL,
    db_incarnation     uuid        NOT NULL,
    result             jsonb       NULL,
    created_at         timestamptz NOT NULL,
    decided_at         timestamptz NULL,
    CONSTRAINT operation_receipts_original_key PRIMARY KEY (org_id, ns_kind, ns_id, op_key),
    CONSTRAINT operation_receipts_id UNIQUE (receipt_id),
    -- NO foreign key to organizations: every committed transaction inserts
    -- here, and an FK would take FOR KEY SHARE on the one org row each time
    -- (MultiXact fan-in on an org-wide row; lead ruling F2 on CONTRACT-M1 r2).
    CONSTRAINT operation_receipts_ns_kind CHECK (ns_kind IN ('agent', 'quick_staff', 'operator', 'minted')),
    CONSTRAINT operation_receipts_state CHECK (state IN ('claimed', 'applied', 'fenced', 'compensated')),
    CONSTRAINT operation_receipts_key_len CHECK (octet_length(op_key) BETWEEN 1 AND 200),
    -- a fence carries no call identity; every other state does
    CONSTRAINT operation_receipts_fence_shape CHECK (
        (state = 'fenced') = (fingerprint IS NULL AND verb IS NULL)),
    CONSTRAINT operation_receipts_result_bounded CHECK (result IS NULL OR octet_length(result::text) <= 262144)
);

CREATE FUNCTION operation_receipts_refuse_claimed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM operation_receipts r
        WHERE r.org_id = NEW.org_id AND r.ns_kind = NEW.ns_kind
          AND r.ns_id = NEW.ns_id AND r.op_key = NEW.op_key
          AND r.state = 'claimed'
    ) THEN
        RAISE EXCEPTION 'operation receipt % is still claimed at commit', NEW.op_key
            USING ERRCODE = 'OT001';
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER operation_receipts_claimed_at_commit
    AFTER INSERT OR UPDATE ON operation_receipts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION operation_receipts_refuse_claimed();

-- Store-service processes. A process is live iff (liveness_pid,
-- liveness_backend_start) of the connection it holds open for its lifetime
-- is in pg_stat_activity (CONTRACT-M1 §4). The sweep of dead rows is P08's.
CREATE TABLE service_incarnations (
    incarnation_id          uuid        NOT NULL,
    kind                    text        COLLATE "C" NOT NULL,
    db_incarnation          uuid        NOT NULL,
    liveness_pid            integer     NOT NULL,
    liveness_backend_start  timestamptz NOT NULL,
    started_at              timestamptz NOT NULL,
    stopped_at              timestamptz NULL,
    CONSTRAINT service_incarnations_pk PRIMARY KEY (incarnation_id),
    CONSTRAINT service_incarnations_kind CHECK (kind IN ('store-service', 'read-service', 'test-harness'))
);

-- E-D13: an admitted keyed call, inserted in its own short transaction
-- before the command transaction and deleted when the call ends. ONE ROW PER
-- CALL (call_id): a concurrent same-key duplicate is admitted too, then waits
-- on the original's claim and replays (E7), as legacy's in-flight set lets
-- both proceed (review finding 2).
CREATE TABLE runtime_inflight (
    org_id               uuid        NOT NULL,
    ns_kind              text        COLLATE "C" NOT NULL,
    ns_id                uuid        NOT NULL,
    op_key               text        COLLATE "C" NOT NULL,
    service_incarnation  uuid        NOT NULL,
    call_id              uuid        NOT NULL,
    admitted_at          timestamptz NOT NULL,
    CONSTRAINT runtime_inflight_pk PRIMARY KEY (org_id, ns_kind, ns_id, op_key, service_incarnation, call_id),
    -- no FK to organizations: high-rate table (F2)
    CONSTRAINT runtime_inflight_service_fk FOREIGN KEY (service_incarnation)
        REFERENCES service_incarnations (incarnation_id)
);
CREATE INDEX runtime_inflight_by_service ON runtime_inflight (service_incarnation);

-- r7 C5 restriction consumers. One registration row per read-service
-- incarnation per org; a narrowing transaction inserts one obligation per
-- registered service in the SAME transaction; Effective = all acknowledged.
--
-- Ordering registration against capture (CONTRACT-M1 §6, lead ruling F1):
-- the org's org_controls row family='restriction_epoch' is taken FOR SHARE
-- by every narrowing writer BEFORE it reads read_service_registrations, and
-- FOR NO KEY UPDATE (with a version bump) by a registration, which is rare.
-- Narrowing writers therefore never block each other.
CREATE TABLE read_service_registrations (
    org_id               uuid        NOT NULL,
    service_incarnation  uuid        NOT NULL,
    installed_epoch      bigint      NOT NULL,
    registered_at        timestamptz NOT NULL,
    CONSTRAINT read_service_registrations_pk PRIMARY KEY (org_id, service_incarnation),
    CONSTRAINT read_service_registrations_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id),
    CONSTRAINT read_service_registrations_service_fk FOREIGN KEY (service_incarnation)
        REFERENCES service_incarnations (incarnation_id)
);

CREATE TABLE restrictions (
    org_id          uuid        NOT NULL,
    restriction_id  uuid        NOT NULL,
    epoch           bigint      NOT NULL,
    reason          text        COLLATE "C" NOT NULL,
    principals      uuid[]      NULL,   -- NULL = every claim in the org (coarse fallback)
    committed_at    timestamptz NOT NULL,
    effective_at    timestamptz NULL,
    CONSTRAINT restrictions_pk PRIMARY KEY (org_id, restriction_id),
    CONSTRAINT restrictions_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id)
);
-- `epoch` is the restriction_epoch version the narrowing writer observed,
-- not a counter: several restrictions may share one.

CREATE TABLE restriction_obligations (
    org_id               uuid        NOT NULL,
    restriction_id       uuid        NOT NULL,
    service_incarnation  uuid        NOT NULL,
    acked_at             timestamptz NULL,
    CONSTRAINT restriction_obligations_pk PRIMARY KEY (org_id, restriction_id, service_incarnation),
    CONSTRAINT restriction_obligations_restriction_fk FOREIGN KEY (org_id, restriction_id)
        REFERENCES restrictions (org_id, restriction_id),
    CONSTRAINT restriction_obligations_service_fk FOREIGN KEY (service_incarnation)
        REFERENCES service_incarnations (incarnation_id)
);
CREATE INDEX restriction_obligations_pending ON restriction_obligations (service_incarnation)
    WHERE acked_at IS NULL;
