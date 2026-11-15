-- An org database's core (design §3.0, §3.2–3.8 "Additions"): who this
-- database is, its revision counter, the topology lock, sections outside the
-- engine's key registry, and the record of how it was converted. The domain
-- tables follow in their own files.
--
-- No table in an org database carries org_id: the database is the org.

-- one row, checked against the registry on every pool open (§3.0).
-- incarnation is minted when the database is created, and again whenever
-- another database replaces it (restore, import), so no client cursor from
-- another copy is ever accepted (§2.5, §2.13). Written by the lifecycle module
-- only; the runtime role may read it.
CREATE TABLE orgtree.org_identity (
  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  org_uuid     uuid NOT NULL,
  slug         text NOT NULL CHECK (slug <> ''),
  incarnation  uuid NOT NULL
);

-- the org's revision, bumped by every committed change (§2.5)
CREATE TABLE orgtree.org_revision (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  rev        bigint NOT NULL DEFAULT 0 CHECK (rev >= 0)
);
INSERT INTO orgtree.org_revision DEFAULT VALUES;

-- the one-row topology lock (rev 5, f1; §2.2): every tree reshape locks it
CREATE TABLE orgtree.org_topology (
  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  row_version  bigint NOT NULL DEFAULT 0
);
INSERT INTO orgtree.org_topology DEFAULT VALUES;

-- a top-level section outside the engine's key registry, kept exactly
-- (rev 4, §5.2): a hand-edited defaults.json key or a v1 import's key
CREATE TABLE orgtree.org_extra (
  key  text PRIMARY KEY,
  val  json NOT NULL
);

-- how this database was converted (§5.2 step 5), one row per attempt that
-- published it, with per-kind counts and checksums on both sides
CREATE TABLE orgtree.conversion_runs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  build             text NOT NULL,
  legacy_database   text,
  legacy_org_id     bigint,
  legacy_level      text,
  legacy_file       text,
  report_path       text
);

CREATE TABLE orgtree.conversion_run_kinds (
  run_id         bigint NOT NULL REFERENCES orgtree.conversion_runs(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  source_count   bigint NOT NULL,
  dest_count     bigint NOT NULL,
  source_sha256  text NOT NULL,
  dest_sha256    text NOT NULL,
  PRIMARY KEY (run_id, kind)
);
