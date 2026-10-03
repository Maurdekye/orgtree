"""The org lifecycle: the ONLY holder of the admin connection (design §2.11, Q10).

Every operation follows the rules of design §2.13:

1. One operation at a time per org, claimed in the registry by compare-and-set
   (``op_kind``, ``op_epoch``, ``op_owner``). A second request is ``Busy``.
2. Each step is recorded in ``op_step`` and is idempotent, so the next host
   resumes a crashed one's claim (``take_over``).
3. Work is built in a staging database named by the claim
   (``<p>stage_<n>_<epoch>``). Cleanup drops only the staging database its own
   claim recorded, and never the database the row names as current.
4. A row becomes ``active`` last, after the database exists under its final
   name with its identity and grants.
5. The runtime fence: ``REVOKE CONNECT`` from the runtime role, then terminate
   its backends. Every org database is created with ``REVOKE ALL ... FROM
   PUBLIC``, so the runtime reaches one only through an explicit grant.

What is here (landing step 1):

  bootstrap()        create the app database if missing, migrate it, grant the
                     runtime role, register this engine instance, and drop
                     staging databases no claim names any more
  create_org()       a new, empty org: provisioning -> active
  register_org(), open_build(), publish(), abandon()
                     the staging protocol of the converter, a retry and the
                     first-launch import. The caller fills the staging database
                     as the runtime role, which this module lets into exactly
                     that database until it is published. The admin connection
                     never leaves this module.
  take_over()        claims a crashed host left behind (one host at a time: the
                     data-root owner lock); a create resumes here, builds go
                     back to their owner
  migrate_orgs()     every active org to the current level; a failing or newer
                     org becomes unavailable while the others start (§2.12)
  check_identity()   org_identity against the registry (step 'identity')
  retry_in_place()   Retry for the steps 'migration' and 'identity'
  fence_runtime() / unfence_runtime()

Trash, restore, purge, export and import land with design §6.3 step 3.
"""

from __future__ import annotations

import os
import socket
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from . import conn as _conn
from . import migrate as _migrate
from . import names

ADMIN_ENV = "ORGTREE_PG_ADMIN_CONNINFO"
RUNTIME_ROLE = "orgtree_runtime"
MAINTENANCE_DB = "postgres"

# the runtime role reads these and never writes them; every other table of
# schema orgtree gets SELECT, INSERT, UPDATE, DELETE
_READ_ONLY = {"app": ("orgs", "schema_migrations"),
              "org": ("org_identity", "schema_migrations")}

# registry columns a step may set besides op_step (an allowlist: the names
# are interpolated into SQL)
_STEP_COLUMNS = frozenset({"op_target_db"})
_RELEASE_COLUMNS = frozenset({"unavailable_step", "state_reason", "report_path", "attempted_build",
                              "trashed_at", "database", "legacy_database", "legacy_org_id",
                              "legacy_file"})


class LifecycleError(RuntimeError):
    """A lifecycle operation cannot proceed."""


class Busy(LifecycleError):
    """Another lifecycle operation holds this org's claim."""


class LostClaim(LifecycleError):
    """The claim moved on under this operation (taken over or released)."""


@dataclass(frozen=True)
class Claim:
    org_id: int
    kind: str
    epoch: int


@dataclass(frozen=True)
class Build:
    """A staging database being filled under a claim. ``ready`` means an
    earlier attempt already filled and renamed it: only publish() remains."""
    claim: Claim
    database: str          # the staging database
    final: str             # the name it is published under (the row's database)
    slug: str
    org_uuid: str
    ready: bool = False


def admin_base() -> str:
    value = os.environ.get(ADMIN_ENV, "").strip()
    if not value:
        raise LifecycleError(f"{ADMIN_ENV} is not set: the org lifecycle needs the admin connection")
    return value


def _sql() -> Any:
    from psycopg import sql   # noqa: PLC0415
    return sql


class Lifecycle:
    def __init__(self, admin: str | None = None, *, runtime_role: str = RUNTIME_ROLE,
                 prefix: str | None = None, build: str = "") -> None:
        self._admin_base = admin or admin_base()
        self.runtime_role = runtime_role
        self.prefix = prefix or names.prefix()
        self.build = build
        self.instance_id: int | None = None

    # ------------------------------------------------------------ connections

    def _admin(self, dbname: str) -> Any:
        return _conn.connect(self._admin_base, dbname, application_name="orgtree-lifecycle")

    def _app(self) -> Any:
        return self._admin(names.app(self.prefix))

    def _me(self) -> int:
        if self.instance_id is None:
            raise LifecycleError("bootstrap() first: this engine instance is not registered")
        return self.instance_id

    @staticmethod
    def _exists(c: Any, dbname: str) -> bool:
        return c.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,)).fetchone() is not None

    def _role_exists(self, c: Any) -> bool:
        return c.execute("SELECT 1 FROM pg_roles WHERE rolname = %s",
                         (self.runtime_role,)).fetchone() is not None

    # ------------------------------------------------------------ databases

    def _create_db(self, dbname: str) -> None:
        sql = _sql()
        with self._admin(MAINTENANCE_DB) as c:
            if not self._exists(c, dbname):
                c.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))
            c.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(dbname)))

    def _drop_db(self, dbname: str) -> None:
        sql = _sql()
        with self._admin(MAINTENANCE_DB) as c:
            c.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(dbname)))

    def _terminate(self, c: Any, dbname: str, *, role: str | None = None) -> None:
        if role is None:
            c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                      "WHERE datname = %s AND pid <> pg_backend_pid()", (dbname,))
        else:
            c.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                      "WHERE datname = %s AND usename = %s AND pid <> pg_backend_pid()",
                      (dbname, role))

    def _rename_db(self, old: str, new: str) -> None:
        sql = _sql()
        with self._admin(MAINTENANCE_DB) as c:
            self._terminate(c, old)
            c.execute(sql.SQL("ALTER DATABASE {} RENAME TO {}").format(
                sql.Identifier(old), sql.Identifier(new)))

    def _grant_runtime(self, c: Any, dbname: str, kind: str) -> None:
        """The runtime role's rights inside one database (re-applied after every
        migration run, so new tables are covered). Never CONNECT: that is
        granted only when a database is opened to the runtime."""
        sql = _sql()
        c.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        if not self._role_exists(c):
            return
        role = sql.Identifier(self.runtime_role)
        c.execute(sql.SQL("GRANT USAGE ON SCHEMA orgtree TO {}").format(role))
        c.execute(sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA orgtree TO {}")
                  .format(role))
        c.execute(sql.SQL("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA orgtree TO {}").format(role))
        for table in _READ_ONLY[kind]:
            c.execute(sql.SQL("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON {} FROM {}").format(
                sql.Identifier("orgtree", table), role))
        c.execute(sql.SQL("ALTER ROLE {} IN DATABASE {} SET search_path = orgtree").format(
            role, sql.Identifier(dbname)))

    def fence_runtime(self, dbname: str) -> None:
        """Rule 5's runtime fence: no engine process can keep or open a
        connection to ``dbname`` any more. The admin still can."""
        sql = _sql()
        with self._admin(MAINTENANCE_DB) as c:
            if not self._role_exists(c):
                return
            c.execute(sql.SQL("REVOKE CONNECT ON DATABASE {} FROM {}").format(
                sql.Identifier(dbname), sql.Identifier(self.runtime_role)))
            self._terminate(c, dbname, role=self.runtime_role)

    def unfence_runtime(self, dbname: str) -> None:
        sql = _sql()
        with self._admin(MAINTENANCE_DB) as c:
            if not self._role_exists(c):
                return
            c.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                sql.Identifier(dbname), sql.Identifier(self.runtime_role)))

    def _migrate_org_db(self, dbname: str) -> dict[str, Any]:
        with self._admin(dbname) as c:
            report = _migrate.migrate(c, _migrate.ORG_DIR, _migrate.ORG_LOCK)
            self._grant_runtime(c, dbname, "org")
        return report

    def _write_identity(self, dbname: str, org_uuid: str, slug: str) -> str:
        incarnation = str(uuid.uuid4())
        with self._admin(dbname) as c:
            c.execute("INSERT INTO orgtree.org_identity (singleton, org_uuid, slug, incarnation) "
                      "VALUES (true, %s, %s, %s) ON CONFLICT (singleton) DO UPDATE SET "
                      "org_uuid = EXCLUDED.org_uuid, slug = EXCLUDED.slug, "
                      "incarnation = EXCLUDED.incarnation", (org_uuid, slug, incarnation))
        return incarnation

    def read_identity(self, dbname: str) -> dict[str, str] | None:
        with self._admin(dbname) as c:
            row = c.execute("SELECT org_uuid::text, slug, incarnation::text "
                            "FROM orgtree.org_identity").fetchone()
        return None if row is None else {"org_uuid": row[0], "slug": row[1], "incarnation": row[2]}

    # ------------------------------------------------------------ app database

    def bootstrap(self) -> dict[str, Any]:
        """Create the app database if missing, migrate it, grant the runtime
        role, register this engine instance, and drop staging databases that
        no claim names. A failure here refuses the start (§2.12)."""
        app = names.app(self.prefix)
        self._create_db(app)
        sql = _sql()
        with self._app() as c:
            report = _migrate.migrate(c, _migrate.APP_DIR, _migrate.APP_LOCK)
            self._grant_runtime(c, app, "app")
            if self._role_exists(c):
                c.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                    sql.Identifier(app), sql.Identifier(self.runtime_role)))
            self.instance_id = int(c.execute(
                "INSERT INTO orgtree.engine_instances (host, pid) VALUES (%s, %s) RETURNING id",
                (socket.gethostname(), os.getpid())).fetchone()[0])
        report["swept"] = self.sweep_stages()
        return report

    def sweep_stages(self) -> list[str]:
        """Drop staging databases of this prefix that no claim names: leftovers
        of an attempt whose claim already moved on. Never an org's current
        database (stage names are never current)."""
        with self._app() as c:
            named = {str(r[0]) for r in c.execute(
                "SELECT op_target_db FROM orgtree.orgs WHERE op_target_db IS NOT NULL").fetchall()}
        with self._admin(MAINTENANCE_DB) as c:
            present = [str(r[0]) for r in c.execute(
                "SELECT datname FROM pg_database WHERE datname LIKE %s", (self.prefix + "stage%",)).fetchall()]
        dropped = []
        for db in present:
            if names.kind(db, self.prefix) == "stage" and db not in named:
                self._drop_db(db)
                dropped.append(db)
        return dropped

    def rows(self) -> list[dict[str, Any]]:
        with self._app() as c:
            cur = c.execute("SELECT * FROM orgtree.orgs ORDER BY org_id")
            cols = [d.name for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    def row(self, org_id: int) -> dict[str, Any]:
        with self._app() as c:
            return self._row(c, org_id)

    @staticmethod
    def _row(c: Any, org_id: int) -> dict[str, Any]:
        cur = c.execute("SELECT * FROM orgtree.orgs WHERE org_id = %s", (org_id,))
        row = cur.fetchone()
        if row is None:
            raise LifecycleError(f"no org {org_id} in the registry")
        return dict(zip([d.name for d in cur.description], row))

    # ------------------------------------------------------------ claims

    def _claim_in(self, c: Any, org_id: int, kind: str, *, expect_state: str | None = None,
                  expect_steps: tuple[str, ...] | None = None) -> Claim:
        steps = list(expect_steps) if expect_steps else None
        row = c.execute(
            "UPDATE orgtree.orgs SET op_kind = %s, op_epoch = op_epoch + 1, op_owner = %s, "
            "op_step = 'claimed', op_target_db = NULL, op_started_at = now(), "
            "row_version = row_version + 1 "
            "WHERE org_id = %s AND op_kind IS NULL AND (%s::text IS NULL OR state = %s) "
            "AND (%s::text[] IS NULL OR unavailable_step = ANY(%s::text[])) RETURNING op_epoch",
            (kind, self._me(), org_id, expect_state, expect_state, steps, steps)).fetchone()
        if row is None:
            now = self._row(c, org_id)
            fits = ((expect_state is None or now["state"] == expect_state)
                    and (steps is None or now["unavailable_step"] in steps))
            if now["op_kind"] is not None or fits:     # held, or held until a moment ago
                raise Busy(f"org {org_id} is busy with another operation")
            at = f" at {now['unavailable_step']}" if now["unavailable_step"] else ""
            raise LifecycleError(f"org {org_id} is {now['state']}{at}, not "
                                 f"{expect_state or now['state']}"
                                 + (f" at {' or '.join(steps)}" if steps else ""))
        return Claim(org_id, kind, int(row[0]))

    def claim(self, org_id: int, kind: str, *, expect_state: str | None = None,
              expect_steps: tuple[str, ...] | None = None) -> Claim:
        """Claim ``org_id`` for one operation (§2.13 rule 1); Busy when another holds it.
        With ``expect_state`` (and ``expect_steps``, the unavailable steps allowed) the claim
        is taken only while the org is in that state, in the same statement: a Retry can never
        claim an org that another Retry has just made active."""
        with self._app() as c:
            return self._claim_in(c, org_id, kind, expect_state=expect_state,
                                  expect_steps=expect_steps)

    def _step(self, claim: Claim, step: str, **cols: Any) -> None:
        bad = set(cols) - _STEP_COLUMNS
        if bad:
            raise LifecycleError(f"not a step column: {sorted(bad)}")
        sets = "".join(f", {k} = %s" for k in cols)
        with self._app() as c:
            n = c.execute(
                f"UPDATE orgtree.orgs SET op_step = %s{sets}, row_version = row_version + 1 "
                "WHERE org_id = %s AND op_kind = %s AND op_epoch = %s AND op_owner = %s",
                (step, *cols.values(), claim.org_id, claim.kind, claim.epoch, self._me())).rowcount
        if n != 1:
            raise LostClaim(f"org {claim.org_id}: claim {claim.kind}#{claim.epoch} moved on")

    def _release(self, c: Any, claim: Claim, state: str, *, attempts_up: bool = False,
                 **cols: Any) -> None:
        bad = set(cols) - _RELEASE_COLUMNS
        if bad:
            raise LifecycleError(f"not a release column: {sorted(bad)}")
        if state != "unavailable":
            cols.setdefault("unavailable_step", None)
        sets = "".join(f", {k} = %s" for k in cols)
        n = c.execute(
            f"UPDATE orgtree.orgs SET state = %s, state_at = now(){sets}, "
            f"attempts = attempts + {1 if attempts_up else 0}, "
            "op_kind = NULL, op_step = NULL, op_owner = NULL, op_target_db = NULL, "
            "op_started_at = NULL, row_version = row_version + 1 "
            "WHERE org_id = %s AND op_kind = %s AND op_epoch = %s AND op_owner = %s",
            (state, *cols.values(), claim.org_id, claim.kind, claim.epoch, self._me())).rowcount
        if n != 1:
            raise LostClaim(f"org {claim.org_id}: claim {claim.kind}#{claim.epoch} moved on")

    def take_over(self) -> list[Claim]:
        """Every claim another (crashed) engine instance left behind becomes
        this instance's, with a new epoch. Only one engine host runs at a time
        (the data-root owner lock), so the previous owner is gone."""
        out = []
        with self._app() as c:
            for org_id, kind, epoch in c.execute(
                    "SELECT org_id, op_kind, op_epoch FROM orgtree.orgs WHERE op_kind IS NOT NULL "
                    "AND op_owner IS DISTINCT FROM %s ORDER BY org_id", (self._me(),)).fetchall():
                row = c.execute(
                    "UPDATE orgtree.orgs SET op_epoch = op_epoch + 1, op_owner = %s, "
                    "row_version = row_version + 1 WHERE org_id = %s AND op_epoch = %s "
                    "RETURNING op_epoch", (self._me(), org_id, epoch)).fetchone()
                if row is not None:
                    out.append(Claim(int(org_id), str(kind), int(row[0])))
        return out

    # ------------------------------------------------------------ registry rows

    def register_org(self, slug: str, *, state: str, org_uuid: str | None = None,
                     unavailable_step: str | None = None, state_reason: str | None = None,
                     report_path: str | None = None, legacy_database: str | None = None,
                     legacy_org_id: int | None = None, legacy_file: str | None = None,
                     trashed_at: Any = None) -> int:
        """Insert a registry row. Its database name is final from the start:
        ``<p>org_<n>``, or for a legacy trashed org (``trashed_at`` given) the
        trash name it will be published under (§5.2). Fixing the name here
        means a crash right after the rename is recognised on resume."""
        with self._app() as c:
            with c.transaction():
                return self._insert_row(
                    c, slug, state=state, org_uuid=org_uuid, unavailable_step=unavailable_step,
                    state_reason=state_reason, report_path=report_path,
                    legacy_database=legacy_database, legacy_org_id=legacy_org_id,
                    legacy_file=legacy_file, trashed_at=trashed_at)

    def _register_claimed(self, slug: str, kind: str, *, org_uuid: str | None = None) -> Claim:
        """A new 'provisioning' row born claimed for ``kind``, in ONE transaction: no moment
        exists in which the row is registered but unclaimed, which nothing would ever finish
        or remove (review f23)."""
        with self._app() as c:
            with c.transaction():
                org_id = self._insert_row(c, slug, state="provisioning", org_uuid=org_uuid)
                return self._claim_in(c, org_id, kind)

    def _insert_row(self, c: Any, slug: str, *, state: str, org_uuid: str | None = None,
                    unavailable_step: str | None = None, state_reason: str | None = None,
                    report_path: str | None = None, legacy_database: str | None = None,
                    legacy_org_id: int | None = None, legacy_file: str | None = None,
                    trashed_at: Any = None) -> int:
        if state not in ("provisioning", "converting", "unavailable"):
            raise LifecycleError(f"a new registry row cannot start as {state!r}")
        import psycopg   # noqa: PLC0415
        org_id = int(c.execute(
            "SELECT nextval(pg_get_serial_sequence('orgtree.orgs', 'org_id'))").fetchone()[0])
        database = (names.org(org_id, self.prefix) if trashed_at is None else
                    names.trash(org_id, trashed_at.strftime("%Y%m%dt%H%M%S"), self.prefix))
        try:
            with c.transaction():
                c.execute(
                    "INSERT INTO orgtree.orgs (org_id, slug, org_uuid, database, state, "
                    "unavailable_step, state_reason, report_path, attempted_build, "
                    "legacy_database, legacy_org_id, legacy_file) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (org_id, slug, org_uuid or str(uuid.uuid4()), database,
                     state, unavailable_step, state_reason, report_path,
                     self.build if state == "unavailable" else None,
                     legacy_database, legacy_org_id, legacy_file))
        except psycopg.errors.UniqueViolation as e:
            raise LifecycleError(f"an org named {slug!r} (or with that uuid) exists") from e
        return org_id

    def set_legacy_source(self, org_id: int, *, legacy_database: str, legacy_org_id: int) -> None:
        """Record where an org's legacy data now is (a held-back org imported by Retry)."""
        with self._app() as c:
            c.execute("UPDATE orgtree.orgs SET legacy_database = %s, legacy_org_id = %s, "
                      "row_version = row_version + 1 WHERE org_id = %s",
                      (legacy_database, legacy_org_id, org_id))

    def _mark_unavailable(self, org_id: int, step: str, reason: str) -> bool:
        """An unclaimed active org becomes unavailable (migration, identity)."""
        with self._app() as c:
            n = c.execute(
                "UPDATE orgtree.orgs SET state = 'unavailable', unavailable_step = %s, "
                "state_reason = %s, attempted_build = %s, state_at = now(), "
                "row_version = row_version + 1 "
                "WHERE org_id = %s AND state = 'active' AND op_kind IS NULL",
                (step, reason[:500], self.build, org_id)).rowcount
        return n == 1

    # ------------------------------------------------------------ create

    def create_org(self, slug: str, *, org_uuid: str | None = None,
                   prepare_folder: Callable[[str], None] | None = None) -> int:
        """A new, empty org, published active (§2.13 Create)."""
        claim = self._register_claimed(slug, "create", org_uuid=org_uuid)
        self.resume_create(claim, prepare_folder=prepare_folder)
        return claim.org_id

    def resume_create(self, claim: Claim, *,
                      prepare_folder: Callable[[str], None] | None = None) -> None:
        """Run (or finish) a create claim from its recorded step."""
        row = self.row(claim.org_id)
        final = str(row["database"])
        if row["op_step"] != "renamed":
            if self._renamed_already(row):
                self._step(claim, "renamed")
            else:
                stage = self._prepare(claim, row, writer=False)
                if prepare_folder is not None:
                    prepare_folder(str(row["slug"]))
                self._step(claim, "folder")
                self._rename_db(stage, final)
                self._step(claim, "renamed")
        self.unfence_runtime(final)
        with self._app() as c:
            self._release(c, claim, "active")

    def begin_create(self, slug: str, *, org_uuid: str | None = None) -> Build:
        """A new org that its first save fills: the engine's create_org with the storage
        switch on (the compatibility view, design §6.2 item 3). The org is registered
        'provisioning' and claimed, and gets a migrated staging database the runtime may fill;
        mark_filled() then publish() make it active, and cancel_create() removes every trace,
        as a failed create_org leaves nothing today. A crash in between leaves a 'create'
        claim, which take_over() returns and resume_create() finishes as an empty org.

        The row is registered already claimed (one transaction). An ordinary error before the
        Build is returned (building and migrating the staging database) is a failed create too:
        this attempt's staging database and row are removed here, fenced by its claim, so the
        name can be created again at once (review f23). Busy and LostClaim mean the org is no
        longer this attempt's to clean up."""
        claim = self._register_claimed(slug, "create", org_uuid=org_uuid)
        try:
            row = self.row(claim.org_id)
            stage = self._prepare(claim, row, writer=True)
        except (Busy, LostClaim):
            raise
        except Exception:
            try:
                self._cancel_create(claim)
            except Exception:                                   # noqa: BLE001
                pass      # the claim stays: take_over() and resume_create() finish it later
            raise
        return Build(claim, stage, str(row["database"]), slug, str(row["org_uuid"]))

    def cancel_create(self, build: Build) -> None:
        """begin_create()'s first save failed: drop its staging database and its row."""
        self._cancel_create(build.claim)

    def _cancel_create(self, claim: Claim) -> None:
        row = self.row(claim.org_id)
        self._check_current(row, claim)
        stage = row["op_target_db"]
        if stage and stage != row["database"] and names.kind(stage, self.prefix) == "stage":
            self._drop_db(stage)
        with self._app() as c:
            n = c.execute("DELETE FROM orgtree.orgs WHERE org_id = %s AND op_kind = 'create' "
                          "AND op_epoch = %s AND op_owner = %s AND state = 'provisioning'",
                          (claim.org_id, claim.epoch, self._me())).rowcount
        if n != 1:
            raise LostClaim(f"org {claim.org_id}: claim create#{claim.epoch} moved on")

    def _renamed_already(self, row: dict[str, Any]) -> bool:
        """A crash between the rename and its record leaves the final database
        present, the recorded staging one gone, and the step not 'renamed'."""
        stage = row["op_target_db"]
        final = str(row["database"])
        if not stage or row["op_step"] not in ("folder", "filled"):
            return False
        with self._admin(MAINTENANCE_DB) as c:
            if self._exists(c, stage) or not self._exists(c, final):
                return False
        ident = self.read_identity(final)
        return bool(ident) and ident["org_uuid"] == str(row["org_uuid"])

    def _drop_unpublished(self, row: dict[str, Any]) -> None:
        """An org that is not active can still have a database under its final name: a build
        renamed there whose publication failed, when a crash interrupted the cleanup (review
        f18). It holds only that unpublished build, so a new build replaces it. A database of
        that name that is not this org's is refused, never dropped."""
        final = str(row["database"])
        with self._admin(MAINTENANCE_DB) as c:
            if not self._exists(c, final):
                return
        ident = self.read_identity(final)
        if not ident or ident["org_uuid"] != str(row["org_uuid"]):
            raise LifecycleError(f"{final} exists and is not org {row['org_id']}'s unpublished "
                                 "build: refusing to replace it")
        self._drop_db(final)

    def _prepare(self, claim: Claim, row: dict[str, Any], *, writer: bool) -> str:
        """A fresh staging database for this claim: any earlier attempt's is
        dropped first (only the one its claim recorded, never the current
        database). The intent is recorded before the database exists, so a
        crash can never leave an unnamed staging database behind."""
        old = row["op_target_db"]
        final = str(row["database"])
        stage = names.stage(claim.org_id, claim.epoch, self.prefix)
        # recording the intent also proves the claim is still ours, BEFORE
        # anything is dropped; a crash right after it leaves `old` unnamed,
        # and sweep_stages() drops it at the next start
        self._step(claim, "claimed", op_target_db=stage)
        if old and old != final and names.kind(old, self.prefix) == "stage" and old != stage:
            self._drop_db(old)
        if writer and row["state"] != "active":
            self._drop_unpublished(row)
        self._drop_db(stage)            # an earlier try of this very epoch
        self._create_db(stage)
        self._step(claim, "database")
        self._migrate_org_db(stage)
        self._step(claim, "migrated")
        self._write_identity(stage, str(row["org_uuid"]), str(row["slug"]))
        if writer:
            self.unfence_runtime(stage)
        self._step(claim, "identity")
        return stage

    # ------------------------------------------------------------ builds

    def open_build(self, org_id: int, kind: str) -> Build:
        """Claim ``org_id`` for a conversion, retry or import and give the
        caller a migrated staging database with its identity, which the
        runtime role may connect to and fill."""
        if kind not in ("convert", "retry", "import"):
            raise LifecycleError(f"not a build kind: {kind!r}")
        return self.resume_build(self.claim(org_id, kind))

    def resume_build(self, claim: Claim) -> Build:
        """A fresh staging database for a build claim (a resumed build is
        redone from scratch, design §5.2 rule 5)."""
        row = self.row(claim.org_id)
        args = (str(row["database"]), str(row["slug"]), str(row["org_uuid"]))
        if row["op_step"] != "renamed" and self._renamed_already(row):
            self._step(claim, "renamed")
            row = self.row(claim.org_id)
        if row["op_step"] == "renamed":
            return Build(claim, str(row["op_target_db"]), *args, ready=True)
        stage = self._prepare(claim, row, writer=True)
        return Build(claim, stage, *args)

    def mark_filled(self, build: Build) -> None:
        """The caller has filled and verified the staging database. Every identity
        sequence moves past the ids the caller assigned (only the admin may set them), so
        inserts after publishing never collide."""
        with self._admin(build.database) as c:
            for table, col in c.execute(
                    "SELECT table_name, column_name FROM information_schema.columns "
                    "WHERE table_schema = 'orgtree' AND is_identity = 'YES'").fetchall():
                c.execute(f"SELECT setval(pg_get_serial_sequence('orgtree.{table}', '{col}'), "
                          f"coalesce((SELECT max({col}) FROM orgtree.{table}), 0) + 1, false)")
        self._step(build.claim, "filled")

    def publish(self, build: Build, *, state: str = "active", trashed_at: Any = None) -> str:
        """Rename the filled staging database to the row's database name and
        publish the row. ``state='trashed'`` publishes a legacy trashed org,
        registered with its trash name (register_org(trashed_at=...)): its
        database stays fenced (§5.2)."""
        row = self.row(build.claim.org_id)
        self._check_current(row, build.claim)
        final = str(row["database"])
        if state == "trashed":
            if trashed_at is None or names.kind(final, self.prefix) != "trash":
                raise LifecycleError("a trashed org is registered with its trash name and time")
        elif state != "active" or names.kind(final, self.prefix) != "org":
            raise LifecycleError(f"cannot publish {final} as {state!r}")
        if row["op_step"] != "renamed":
            if row["op_step"] != "filled":
                raise LifecycleError(f"org {build.claim.org_id}: build not marked filled")
            self.fence_runtime(build.database)
            self._rename_db(build.database, final)
            self._step(build.claim, "renamed")
        if state == "active":
            self.unfence_runtime(final)
        cols: dict[str, Any] = {"state_reason": None, "report_path": None}
        if state == "trashed":
            cols["trashed_at"] = trashed_at
        with self._app() as c:
            self._release(c, build.claim, state, **cols)
        return final

    def abandon(self, claim: Claim, *, step: str, reason: str,
                report_path: str | None = None) -> None:
        """The build failed: drop its staging database (only the one its claim
        recorded) and leave the org unavailable with the reason (Q12)."""
        row = self.row(claim.org_id)
        self._check_current(row, claim)
        stage = row["op_target_db"]
        if stage and stage != row["database"] and names.kind(stage, self.prefix) == "stage":
            self._drop_db(stage)
        if (claim.kind in ("convert", "retry", "import") and row["op_step"] == "renamed"
                and row["state"] != "active"):
            # renamed to the final name but never published: that database holds only this
            # failed build, and a Retry starts from scratch (review f18)
            self._drop_db(str(row["database"]))
        with self._app() as c:
            self._release(c, claim, "unavailable", attempts_up=True, unavailable_step=step,
                          state_reason=reason[:500], report_path=report_path,
                          attempted_build=self.build)

    def _check_current(self, row: dict[str, Any], claim: Claim) -> None:
        """Refuse before touching anything when ``claim`` is no longer the
        org's current claim, so a stale cleanup never drops a newer attempt's
        database (§2.13 rule 3)."""
        if (row["op_kind"], row["op_epoch"], row["op_owner"]) != (claim.kind, claim.epoch, self._me()):
            raise LostClaim(f"org {claim.org_id}: claim {claim.kind}#{claim.epoch} moved on")

    # ------------------------------------------------------------ start-up checks

    def migrate_orgs(self) -> dict[str, Any]:
        """Bring every active, unclaimed org to the current level, one at a
        time. A failing or newer org becomes unavailable and is fenced; the
        others go on (§2.12)."""
        out: dict[str, Any] = {"migrated": {}, "unavailable": {}}
        for row in self.rows():
            if row["state"] != "active" or row["op_kind"] is not None:
                continue
            db = str(row["database"])
            try:
                report = self._migrate_org_db(db)
            except _migrate.NewerDatabase as e:
                reason = f"written by a newer Orgtree: {e}"
            except Exception as e:   # noqa: BLE001  one org's failure is that org's
                reason = f"migration failed: {type(e).__name__}: {e}"
            else:
                out["migrated"][row["org_id"]] = report["applied"]
                continue
            if self._mark_unavailable(int(row["org_id"]), "migration", reason):
                self.fence_runtime(db)
                out["unavailable"][row["org_id"]] = reason
        return out

    def check_identity(self, org_id: int) -> bool:
        """org_identity against the registry; a mismatch makes the org
        unavailable (step 'identity') and fences it."""
        row = self.row(org_id)
        db = str(row["database"])
        try:
            ident = self.read_identity(db)
        except Exception as e:   # noqa: BLE001
            ident, why = None, f"{type(e).__name__}: {e}"
        else:
            why = "no org_identity row"
        if ident is not None:
            if ident["org_uuid"] == str(row["org_uuid"]) and ident["slug"] == row["slug"]:
                return True
            why = (f"org_identity says {ident['slug']} {ident['org_uuid']}, "
                   f"the registry {row['slug']} {row['org_uuid']}")
        if row["state"] == "active" and self._mark_unavailable(org_id, "identity", why):
            self.fence_runtime(db)
        return False

    def import_held_back(self, slug: str, path: str, *, legacy_database: str,
                         orgs_dir: str) -> dict[str, Any]:
        """Retry of step 'import' (design §5.1, §2.13): the 2.1.14 first-launch import held
        ``slug`` back. Check its file again with THIS build's importer (the reason a new
        build retries once by itself); when it passes, import that one org into the legacy
        database and write its marker in ``orgs_dir``. Nothing already in the legacy
        database changes. Here because the importer connects as the admin role (Q10); it
        runs in a child process because it sets the store to SQLite for itself, which must
        not leak into this process (pg_process._run_importer's rule).
        Returns {"imported": bool, "reason": str}."""
        import subprocess       # noqa: PLC0415
        import sys              # noqa: PLC0415
        from pathlib import Path   # noqa: PLC0415
        tool = Path(__file__).resolve().parents[4] / "tools" / "pypg" / "pgimport.py"
        if not tool.is_file():
            return {"imported": False, "reason": f"the bundled importer is missing ({tool})"}
        env = {k: v for k, v in os.environ.items()
               if k not in (ADMIN_ENV, "ORGTREE_STORE", "ORGTREE_PG_CONNINFO", "ORGTREE_STORAGE")}
        env["ORGTREE_PGIMPORT_CONNINFO"] = _conn.with_db(self._admin_base, legacy_database)
        env["ORGTREE_DATA"] = str(Path(orgs_dir).parent)
        r = subprocess.run([sys.executable, str(tool), "import-held", "--file", str(path),
                            "--slug", slug, "--orgs-dir", str(orgs_dir)],
                           env=env, cwd=str(tool.parent), capture_output=True, text=True,
                           timeout=3600, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if r.returncode == 0:
            return {"imported": True, "reason": ""}
        lines = [l for l in (r.stderr or "").splitlines() if l.strip()]
        reason = lines[-1] if lines else f"the importer exited {r.returncode}"
        return {"imported": False, "reason": reason.split("REFUSED: ", 1)[-1][:300]}

    def retry_in_place(self, org_id: int) -> bool:
        """Retry an org that is unavailable at step 'migration' or 'identity'
        (§2.13). The steps 'conversion' and 'import' are the converter's."""
        steps = ("migration", "identity")
        row = self.row(org_id)
        if row["state"] != "unavailable" or row["unavailable_step"] not in steps:
            raise LifecycleError(f"org {org_id} is not unavailable at migration or identity")
        claim = self.claim(org_id, "retry", expect_state="unavailable", expect_steps=steps)
        row = self.row(org_id)
        db = str(row["database"])
        try:
            self._migrate_org_db(db)
            ident = self.read_identity(db)
            if ident is None or ident["org_uuid"] != str(row["org_uuid"]) or ident["slug"] != row["slug"]:
                raise LifecycleError(f"org_identity does not match the registry: {ident}")
        except Exception as e:   # noqa: BLE001
            with self._app() as c:
                self._release(c, claim, "unavailable", attempts_up=True,
                              unavailable_step=row["unavailable_step"],
                              state_reason=f"{type(e).__name__}: {e}"[:500],
                              attempted_build=self.build)
            return False
        self.unfence_runtime(db)
        with self._app() as c:
            self._release(c, claim, "active", state_reason=None, attempted_build=self.build)
        return True

    # ------------------------------------------------------------ trash, restore, purge
    # (design §2.13, landing step 3.) Each is one claim whose steps are recorded in op_step
    # and repeatable, so a crash or a refused step (a folder held open) is finished by the
    # same operation asked again, or by the next start (take_over, then resume_lifecycle).
    # Folders: the caller names an org's folders as (label, path); the trash keeps them under
    # <trash_dir>/<slug>-<stamp>-<org_id>/<label>, the stamp being the trash database's.

    _TRASH_STEPS = ("claimed", "named", "closing", "fenced", "drained", "closed", "moved",
                    "renamed")
    _RESTORE_STEPS = ("claimed", "reserved", "renamed", "opened", "checked", "moved")
    _PURGE_STEPS = ("claimed", "dropped", "removed")

    def _own_claim(self, org_id: int, kind: str) -> Claim | None:
        """This instance's unfinished claim of ``kind`` on the org (an operation asked again
        after a refused step), else None."""
        row = self.row(org_id)
        if row["op_kind"] == kind and row["op_owner"] == self._me():
            return Claim(org_id, kind, int(row["op_epoch"]))
        return None

    def _set_state(self, claim: Claim, state: str) -> None:
        """A claimed org's state, the claim kept (closing: admission is closed)."""
        with self._app() as c:
            n = c.execute(
                "UPDATE orgtree.orgs SET state = %s, state_at = now(), row_version = row_version + 1 "
                "WHERE org_id = %s AND op_kind = %s AND op_epoch = %s AND op_owner = %s",
                (state, claim.org_id, claim.kind, claim.epoch, self._me())).rowcount
        if n != 1:
            raise LostClaim(f"org {claim.org_id}: claim {claim.kind}#{claim.epoch} moved on")

    def _allow_connections(self, dbname: str, allow: bool) -> None:
        """Rule 5's last fence (off) or its reopening (on). Off also ends every backend."""
        sql = _sql()
        with self._admin(MAINTENANCE_DB) as c:
            c.execute(sql.SQL("ALTER DATABASE {} ALLOW_CONNECTIONS {}").format(
                sql.Identifier(dbname), sql.SQL("true" if allow else "false")))
            if not allow:
                self._terminate(c, dbname)

    def _rename_once(self, old: str, new: str) -> None:
        """Rename, or recognise a rename an earlier attempt already made."""
        with self._admin(MAINTENANCE_DB) as c:
            have_old, have_new = self._exists(c, old), self._exists(c, new)
        if have_old and not have_new:
            self._rename_db(old, new)
        elif not have_new:
            raise LifecycleError(f"neither {old} nor {new} exists")
        elif have_old:
            raise LifecycleError(f"both {old} and {new} exist: refusing to choose")

    @staticmethod
    def _move_once(src: str, dst: str) -> None:
        """Move a folder (one rename on its volume), or recognise a move already made. A
        folder that never existed is nothing to move; a target that exists is never
        overwritten."""
        if os.path.exists(src):
            if os.path.exists(dst):
                raise LifecycleError(f"cannot move {src}: {dst} exists")
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.replace(src, dst)

    @staticmethod
    def trash_folder(trash_dir: str, slug: str, trash_db: str, org_id: int) -> str:
        """Where a trashed org's folders are kept: named by its slug, its trash database's
        stamp and its org_id (two orgs of one name trashed in the same second stay apart)."""
        return os.path.join(trash_dir, f"{slug}-{trash_db.rsplit('_', 1)[1]}-{int(org_id)}")

    def trash(self, org_id: int, *, folders: tuple[tuple[str, str], ...] = (),
              trash_dir: str | None = None, drain: Callable[[], None] | None = None) -> str:
        """Delete an active org to the trash (§2.13 Trash); returns its trash database's name.
        Admission closes, the runtime is fenced off, ``drain`` runs (it must not need the org's
        database), connections end, the folders move to the trash, the database is renamed,
        and the row is trashed, which frees the name. Busy while another operation holds the
        org; the same call again finishes this instance's own unfinished trash."""
        claim = self._own_claim(org_id, "trash") or self.claim(org_id, "trash",
                                                               expect_state="active")
        return self._resume_trash(claim, folders=folders, trash_dir=trash_dir, drain=drain)

    def _resume_trash(self, claim: Claim, *, folders: tuple[tuple[str, str], ...] = (),
                      trash_dir: str | None = None, drain: Callable[[], None] | None = None) -> str:
        import datetime as _dt   # noqa: PLC0415
        import time              # noqa: PLC0415
        row = self.row(claim.org_id)
        self._check_current(row, claim)
        steps = self._TRASH_STEPS
        step = str(row["op_step"])
        db = str(row["database"])

        def done(s: str) -> bool:
            return steps.index(step) >= steps.index(s)
        if not done("named"):
            target = names.trash(claim.org_id, time.strftime("%Y%m%dt%H%M%S", time.gmtime()),
                                 self.prefix)
            self._step(claim, "named", op_target_db=target)
            step = "named"
        else:
            target = str(row["op_target_db"])
        if not done("closing"):
            self._set_state(claim, "closing")
            self._step(claim, step := "closing")
        if not done("fenced"):
            self.fence_runtime(db)
            self._step(claim, step := "fenced")
        if not done("drained"):
            if drain is not None:
                drain()
            self._step(claim, step := "drained")
        if not done("closed"):
            self._allow_connections(db, False)
            self._step(claim, step := "closed")
        if not done("moved"):
            if folders:
                if trash_dir is None:
                    raise LifecycleError("folders to trash need a trash folder")
                keep = self.trash_folder(trash_dir, str(row["slug"]), target, claim.org_id)
                for label, path in folders:
                    self._move_once(path, os.path.join(keep, label))
            self._step(claim, step := "moved")
        if not done("renamed"):
            self._rename_once(db, target)
            self._step(claim, step := "renamed")
        stamp = target.rsplit("_", 1)[1]
        at = _dt.datetime.strptime(stamp, "%Y%m%dt%H%M%S").replace(tzinfo=_dt.timezone.utc)
        with self._app() as c:
            self._release(c, claim, "trashed", database=target, trashed_at=at)
        return target

    def restore(self, org_id: int, *, folders: tuple[tuple[str, str], ...] = (),
                trash_dir: str | None = None) -> str:
        """A trashed org back to active under its own name (§2.13 Restore); returns its
        database. Refused while another org has the name: an org records its folder paths
        (its workspace, its agents' folders) under its name, so it cannot move to another one.
        The identity is checked by the admin before the runtime can connect again; a mismatch
        leaves the org unavailable (step 'identity')."""
        claim = self._own_claim(org_id, "restore") or self.claim(org_id, "restore",
                                                                 expect_state="trashed")
        return self._resume_restore(claim, folders=folders, trash_dir=trash_dir)

    def _resume_restore(self, claim: Claim, *, folders: tuple[tuple[str, str], ...] = (),
                        trash_dir: str | None = None) -> str:
        import psycopg   # noqa: PLC0415
        row = self.row(claim.org_id)
        self._check_current(row, claim)
        steps = self._RESTORE_STEPS
        step = str(row["op_step"])
        trash_db = str(row["database"])
        final = names.org(claim.org_id, self.prefix)

        def done(s: str) -> bool:
            return steps.index(step) >= steps.index(s)
        if names.kind(trash_db, self.prefix) != "trash":
            raise LifecycleError(f"org {claim.org_id}'s database {trash_db} is not a trash name")
        if not done("reserved"):
            try:
                # closing counts for the name (UNIQUE (slug) WHERE state <> 'trashed'), so this
                # also reserves the name, or finds it taken
                self._set_state(claim, "closing")
            except psycopg.errors.UniqueViolation:
                with self._app() as c:
                    self._release(c, claim, "trashed", trashed_at=row["trashed_at"])
                raise LifecycleError(f"org {claim.org_id} cannot be restored: another org is "
                                     f"named {row['slug']!r} now") from None
            self._step(claim, step := "reserved")
        if not done("renamed"):
            self._rename_once(trash_db, final)
            self._step(claim, step := "renamed")
        if not done("opened"):
            self._allow_connections(final, True)
            self._step(claim, step := "opened")
        if not done("checked"):
            ident = self.read_identity(final)
            if (ident is None or ident["org_uuid"] != str(row["org_uuid"])
                    or ident["slug"] != row["slug"]):
                with self._app() as c:
                    self._release(c, claim, "unavailable", attempts_up=True,
                                  unavailable_step="identity", database=final,
                                  state_reason=f"restored, but org_identity is {ident}"[:500],
                                  attempted_build=self.build)
                return final
            self._step(claim, step := "checked")
        if not done("moved"):
            if folders:
                if trash_dir is None:
                    raise LifecycleError("folders to restore need the trash folder")
                keep = self.trash_folder(trash_dir, str(row["slug"]), trash_db, claim.org_id)
                for label, path in folders:
                    self._move_once(os.path.join(keep, label), path)
                if os.path.isdir(keep) and not os.listdir(keep):
                    os.rmdir(keep)
            self._step(claim, step := "moved")
        self.unfence_runtime(final)
        with self._app() as c:
            self._release(c, claim, "active", database=final, trashed_at=None)
        return final

    def purge(self, org_id: int, *, trash_dir: str | None = None) -> None:
        """Empty one org out of the trash (§2.13 Purge): its trash database dropped, its trash
        folder removed, its registry row deleted (its tickets cascade). Only a trashed org,
        and only a database with a trash name, is ever dropped here."""
        claim = self._own_claim(org_id, "purge") or self.claim(org_id, "purge",
                                                               expect_state="trashed")
        self._resume_purge(claim, trash_dir=trash_dir)

    def _resume_purge(self, claim: Claim, *, trash_dir: str | None = None) -> None:
        import shutil   # noqa: PLC0415
        row = self.row(claim.org_id)
        self._check_current(row, claim)
        steps = self._PURGE_STEPS
        step = str(row["op_step"])
        db = str(row["database"])

        def done(s: str) -> bool:
            return steps.index(step) >= steps.index(s)
        if names.kind(db, self.prefix) != "trash":
            with self._app() as c:
                self._release(c, claim, str(row["state"]), trashed_at=row["trashed_at"])
            raise LifecycleError(f"org {claim.org_id}: {db} is not a trash database, not dropped")
        if not done("dropped"):
            self._drop_db(db)
            self._step(claim, step := "dropped")
        if not done("removed"):
            if trash_dir is not None:
                keep = self.trash_folder(trash_dir, str(row["slug"]), db, claim.org_id)
                if os.path.isdir(keep):
                    shutil.rmtree(keep)
            self._step(claim, step := "removed")
        with self._app() as c:
            n = c.execute("DELETE FROM orgtree.orgs WHERE org_id = %s AND op_kind = %s "
                          "AND op_epoch = %s AND op_owner = %s",
                          (claim.org_id, claim.kind, claim.epoch, self._me())).rowcount
        if n != 1:
            raise LostClaim(f"org {claim.org_id}: claim {claim.kind}#{claim.epoch} moved on")

    def resume_lifecycle(self, claim: Claim, *, folders: tuple[tuple[str, str], ...] = (),
                         trash_dir: str | None = None) -> None:
        """Finish a trash, restore or purge claim taken over at start (no drain: the
        crashed host's providers are gone with it)."""
        if claim.kind == "trash":
            self._resume_trash(claim, folders=folders, trash_dir=trash_dir)
        elif claim.kind == "restore":
            self._resume_restore(claim, folders=folders, trash_dir=trash_dir)
        elif claim.kind == "purge":
            self._resume_purge(claim, trash_dir=trash_dir)
        else:
            raise LifecycleError(f"not a trash, restore or purge claim: {claim.kind}")
