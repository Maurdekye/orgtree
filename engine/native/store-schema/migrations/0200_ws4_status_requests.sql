-- P03 WS4, part 1: the status row and credit-request identities.
-- WS4 range 0200-0299 (CONTRACT-M1 §7). Adds tables, columns and
-- constraints only; renames nothing a consumer relies on.
--
-- Growth classes (v6 SCHEMA-CATALOG "Growth and query contracts"):
--   status_rows    current entity-bound: one row per seat, updated in place,
--                  dies with its agent.

-- S3 §4.1: a status report updates the caller's STATUS ROW, a narrow per-seat
-- row that is NOT the authority-epoch row (r7 C3, N12) and not the runtime
-- row the runtime owner writes (busy, background work): reports never wait
-- on turn admission and nothing anchors this row. It holds exactly legacy's
-- node fields `last_status {status, summary, at}` and `working_activity_at`.
-- The status value is not validated and the summary is not capped (legacy;
-- the wire owner decides those, `status.wire`), so neither is constrained
-- beyond the row bound.
CREATE TABLE status_rows (
    org_id              uuid        NOT NULL,
    principal_id        uuid        NOT NULL,
    last_status         jsonb       NULL,
    working_activity_at timestamptz NULL,
    version             bigint      NOT NULL DEFAULT 0,
    CONSTRAINT status_rows_pk PRIMARY KEY (org_id, principal_id),
    CONSTRAINT status_rows_agent_fk FOREIGN KEY (org_id, principal_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT status_rows_last_status_object CHECK (last_status IS NULL OR jsonb_typeof(last_status) = 'object'),
    CONSTRAINT status_rows_bounded CHECK (last_status IS NULL OR octet_length(last_status::text) <= 1048576)
);

-- S3 §4.13: credit-request ids keep their legacy `cr<n>` form, minted from the
-- organization's request count, with a unique id as the conflict detector
-- (two concurrent new requests by different agents can mint the same id; one
-- collides and retries with the next number; the index is on WS4's 23505
-- allowlist). NULL for asks and scope requests, which WS4 does not mint here.
ALTER TABLE request_batches ADD COLUMN legacy_id text COLLATE "C" NULL;
ALTER TABLE request_batches ADD CONSTRAINT request_batches_legacy_id_len
    CHECK (legacy_id IS NULL OR octet_length(legacy_id) BETWEEN 1 AND 64);
CREATE UNIQUE INDEX request_batches_legacy_id ON request_batches (org_id, legacy_id)
    WHERE legacy_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON status_rows TO orgtree_runtime;
GRANT SELECT ON status_rows TO orgtree_repl;
