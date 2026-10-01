-- P03 WS2 base schema, part 7: the versioned native publication catalog
-- (v6 SCHEMA-CATALOG:23, PROJECTION-RECOVERY:19). WS6 fills the rows and
-- creates the PostgreSQL publication in its own migration range; this table
-- is excluded from that publication.

CREATE TABLE publication_catalog (
    catalog_version   integer NOT NULL,
    relation          text    COLLATE "C" NOT NULL,
    key_columns       text[]  NOT NULL,
    columns           text[]  NOT NULL,
    replica_identity  text    COLLATE "C" NOT NULL,
    delete_rendering  text    COLLATE "C" NOT NULL,
    decoder_version   integer NOT NULL,
    CONSTRAINT publication_catalog_pk PRIMARY KEY (catalog_version, relation),
    CONSTRAINT publication_catalog_replica CHECK (replica_identity IN ('default', 'full', 'index')),
    CONSTRAINT publication_catalog_keys CHECK (cardinality(key_columns) >= 1)
);
