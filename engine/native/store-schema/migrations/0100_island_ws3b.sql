-- P03 WS3b (p03-ws3b-topology): the island's lineage stacks and the seat
-- configuration head (DDL-REVIEW "Gap for WS3: lineage stacks / bearers are
-- not modelled; WS3 adds them in its range").
--
-- Why each table exists (S3 §3.1, r7 C2a):
--   * lineage_bearers: a lineage split (cheap_compact, a cross-provider
--     switch_model, an account split, the compaction split, the CLI
--     compaction record, reseed) copies the live seat into a NEW archived
--     bearer node `nid@gen` whose parent is copied from the seat. The bearer
--     is a real node (agents, authority_epoch archived, topology_edges under
--     the seat's parent) so that a move re-parents the whole stack as one
--     unit (legacy `{nid, *lineage_stack(nid)}`). This row links it to its
--     seat. The move reads the stack by the (seat_id, generation) index and
--     the split inserts into that range, so SERIALIZABLE tracking pairs them
--     (Q-E2); `lost` is the one bearer state an island predicate reads
--     (rehire refuses a lost bearer; drop_phantom_generation requires one).
--   * seat_config: the seat's configuration head (model tier, account
--     binding). S3 §3.1: a splitting transition takes it FOR UPDATE because
--     retool's account branch and other switches write it. Narrow: no busy,
--     status or heartbeat field.
--
-- Neither table is high-rate (a split is a rare lifecycle event; a
-- configuration change is an operator/manager act), so both keep their
-- composite foreign keys to agents (lint R9 concerns organization-wide rows
-- only; neither references organizations).

CREATE TABLE lineage_bearers (
    org_id        uuid        NOT NULL,
    bearer_id     uuid        NOT NULL,
    seat_id       uuid        NOT NULL,
    generation    bigint      NOT NULL,
    bearer_state  text        COLLATE "C" NOT NULL,
    created_at    timestamptz NOT NULL,
    CONSTRAINT lineage_bearers_pk PRIMARY KEY (org_id, bearer_id),
    -- one bearer per generation of a seat: two splits of one seat that both
    -- mint generation g collide here (a conflict detector, C4).
    CONSTRAINT lineage_bearers_generation UNIQUE (org_id, seat_id, generation),
    CONSTRAINT lineage_bearers_bearer_fk FOREIGN KEY (org_id, bearer_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT lineage_bearers_seat_fk FOREIGN KEY (org_id, seat_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT lineage_bearers_not_self CHECK (bearer_id <> seat_id),
    CONSTRAINT lineage_bearers_generation_pos CHECK (generation >= 0),
    CONSTRAINT lineage_bearers_state CHECK (bearer_state IN ('knowledge', 'preserving', 'lost'))
);

CREATE TABLE seat_config (
    org_id            uuid    NOT NULL,
    principal_id      uuid    NOT NULL,
    tier              text    COLLATE "C" NOT NULL,
    effort            text    COLLATE "C" NULL,
    account_id        text    COLLATE "C" NULL,
    account_primary   boolean NOT NULL DEFAULT true,
    harness           text    COLLATE "C" NULL,
    prefer_reserve    boolean NOT NULL DEFAULT false,
    account_fallback  jsonb   NULL,
    pending           jsonb   NULL,
    version           bigint  NOT NULL DEFAULT 0,
    CONSTRAINT seat_config_pk PRIMARY KEY (org_id, principal_id),
    CONSTRAINT seat_config_agent_fk FOREIGN KEY (org_id, principal_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT seat_config_fallback_bounded CHECK (account_fallback IS NULL OR octet_length(account_fallback::text) <= 65536),
    CONSTRAINT seat_config_pending_object CHECK (pending IS NULL OR jsonb_typeof(pending) = 'object'),
    CONSTRAINT seat_config_pending_bounded CHECK (pending IS NULL OR octet_length(pending::text) <= 65536)
);

-- Roles (0008 pattern): the runtime role gets DML; the replication role reads
-- the published set.
GRANT SELECT, INSERT, UPDATE, DELETE ON lineage_bearers, seat_config TO orgtree_runtime;
GRANT SELECT ON lineage_bearers, seat_config TO orgtree_repl;
