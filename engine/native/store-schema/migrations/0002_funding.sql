-- P03 WS2 base schema, part 2: funding (r7 C2a P2, S3 E8, v6 SCHEMA-CATALOG:12).
-- Credits are bigint hundredths (backend-codec Credits). The USER root is an
-- explicit unlimited mode, not a balance row (v6 SCHEMA-CATALOG:29).

-- The catalog's current-version row: share-locked by every funding writer,
-- updated only by a catalog price change (r7 RN4).
CREATE TABLE catalog_current (
    org_id           uuid   NOT NULL,
    catalog_version  bigint NOT NULL,
    CONSTRAINT catalog_current_pk PRIMARY KEY (org_id),
    CONSTRAINT catalog_current_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id),
    CONSTRAINT catalog_current_version CHECK (catalog_version > 0)
);

-- Immutable price rows per catalog version.
CREATE TABLE price_catalog (
    org_id           uuid   NOT NULL,
    catalog_version  bigint NOT NULL,
    tier             text   COLLATE "C" NOT NULL,
    seat_centi       bigint NOT NULL,
    CONSTRAINT price_catalog_pk PRIMARY KEY (org_id, catalog_version, tier),
    CONSTRAINT price_catalog_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id),
    CONSTRAINT price_catalog_seat CHECK (seat_centi >= 0)
);

-- The payer's capacity row: aggregate of committed child obligations in
-- UNPRICED terms (sum of child grants, count of child seats per tier), priced
-- at read under catalog_current (r7 C2a P2, RN4). Every obligation writer,
-- in or out of the island, UPDATES this row; island writers take it
-- FOR NO KEY UPDATE before computing `free`.
CREATE TABLE issuer_capacity (
    org_id             uuid   NOT NULL,
    principal_id       uuid   NOT NULL,
    child_grants_centi bigint NOT NULL DEFAULT 0,
    child_seats        jsonb  NOT NULL DEFAULT '{}'::jsonb,
    version            bigint NOT NULL DEFAULT 0,
    CONSTRAINT issuer_capacity_pk PRIMARY KEY (org_id, principal_id),
    CONSTRAINT issuer_capacity_agent_fk FOREIGN KEY (org_id, principal_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT issuer_capacity_grants CHECK (child_grants_centi >= 0),
    CONSTRAINT issuer_capacity_seats_object CHECK (jsonb_typeof(child_seats) = 'object')
);

-- One authoritative funding edge per child. issuer_id NULL = the user root.
CREATE TABLE funding_edges (
    org_id       uuid   NOT NULL,
    child_id     uuid   NOT NULL,
    issuer_id    uuid   NULL,
    tier         text   COLLATE "C" NOT NULL,
    grant_centi  bigint NOT NULL DEFAULT 0,
    version      bigint NOT NULL DEFAULT 0,
    CONSTRAINT funding_edges_pk PRIMARY KEY (org_id, child_id),
    CONSTRAINT funding_edges_child_fk FOREIGN KEY (org_id, child_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT funding_edges_issuer_fk FOREIGN KEY (org_id, issuer_id)
        REFERENCES agents (org_id, principal_id),
    CONSTRAINT funding_edges_grant CHECK (grant_centi >= 0)
);
CREATE INDEX funding_edges_by_issuer ON funding_edges (org_id, issuer_id, tier);

-- S3 E8: only in an org with a kiosk credits pool. Top-level holdings in
-- unpriced terms; every writer of a top-level holding takes it
-- FOR NO KEY UPDATE LAST in its lock order and updates it.
CREATE TABLE kiosk_pool (
    org_id            uuid   NOT NULL,
    pool_centi        bigint NOT NULL,
    top_grants_centi  bigint NOT NULL DEFAULT 0,
    top_seats         jsonb  NOT NULL DEFAULT '{}'::jsonb,
    version           bigint NOT NULL DEFAULT 0,
    CONSTRAINT kiosk_pool_pk PRIMARY KEY (org_id),
    CONSTRAINT kiosk_pool_org_fk FOREIGN KEY (org_id) REFERENCES organizations (org_id),
    CONSTRAINT kiosk_pool_pool CHECK (pool_centi >= 0),
    CONSTRAINT kiosk_pool_grants CHECK (top_grants_centi >= 0),
    CONSTRAINT kiosk_pool_seats_object CHECK (jsonb_typeof(top_seats) = 'object')
);
