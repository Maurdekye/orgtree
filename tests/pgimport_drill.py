"""PYPG PG-1 + PG-2 drills, end to end, with the REAL pg-custodian, a real
PostgreSQL and PG-0's real migrations and store, on disposable roots under
%TEMP%. They need all three branches (an integration checkout).

Not a ``test_*`` module on purpose: it starts real PostgreSQL clusters, so it
runs only explicitly, under the P03 run lock (a HEAVY run), via the safe runner:

    set ORGTREE_PG_CUSTODIAN=<abs path to pg-custodian.exe with bind-product>
    set ORGTREE_P03_PG_BIN=<...>\\artifacts\\p03-postgresql\\18.6-4\\bin
    set ORGTREE_TEST_PYDEPS=<a folder holding psycopg 3>
    python tools/run-python-verification.py tests/pgimport_drill.py

Without those variables it FAILS (never skips). Each drill prints one
``PYPG-PG12-DRILL {json}`` line.

1. PROTOTYPE ROOT: an org in ``.db`` and one in ``.json`` -> ``pgimport import
   --cutover`` (the database comes up through the custodian, PG-0's migrations
   0001/0002 are applied as the admin role, the rows are COPYed, read back byte
   for byte, the markers written, ``store-backend.json`` written, the old files
   moved to ``pre-postgres/orgs`` unchanged). Then the ENGINE BRACKET with
   ``ORGTREE_STORE`` UNSET chooses postgres from the record, starts the
   database and hands over the runtime role; the real store, as
   ``orgtree_runtime``, loads the orgs and they equal what the SQLite store
   loaded from the same files before the import. A new log row gets the next
   ``seq`` (the identity was moved past the imported rows).
2. PRODUCT ROOT: the same, but the root is the engine's own ``ORGTREE_DATA``
   with no prototype marker: ``pgimport prepare`` binds it (and refuses when
   an agent variable names it), the import and the bracket run the custodian
   with ``--product``, and ``destroy`` refuses on it.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

DEPS = os.environ.get("ORGTREE_TEST_PYDEPS", "").strip()
if DEPS:
    sys.path.insert(0, DEPS)

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from engine import pg_process as bracket  # noqa: E402
import test_pgimport as fixtures  # noqa: E402  (sample_doc, write_db, and loads pgimport)

pgimport = fixtures.pgimport

# The store as the ENGINE sees it, in a fresh process: prints every org's
# fully materialised document as canonical JSON.
READER = textwrap.dedent('''
    import json, os, sys
    sys.path[:0] = [sys.argv[1], os.path.join(sys.argv[2], "engine", "backend"), sys.argv[2]]
    from orgtree import store
    if os.environ.get("ORGTREE_STORE") == "postgres":
        store.claim_data_root()
    out = {"backend": store.STORE_BACKEND, "store_file": store.__file__, "orgs": {}}
    for slug in json.loads(sys.argv[3]):
        org = store.load_org(slug)
        d = org.d
        if hasattr(d, "materialize_all"):
            d.materialize_all()
        out["orgs"][slug] = store.canon(dict(d))
    print(json.dumps(out))
''')


def report(drill: str, outcome: str, detail: dict) -> None:
    print("PYPG-PG12-DRILL " + json.dumps({"drill": drill, "outcome": outcome, "detail": detail}, default=str), flush=True)


def custodian_json(*args: str, env: dict | None = None) -> dict:
    out = subprocess.run([os.environ[bracket.CUSTODIAN_ENV], *args], capture_output=True, text=True,
                         stdin=subprocess.DEVNULL, timeout=900, env=env)
    return json.loads(out.stdout)


def digest_tree(folder: Path) -> dict[str, str]:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.iterdir()) if p.is_file()}


def read_store(root: Path, slugs: list[str], env: dict) -> dict:
    tmp = Path(tempfile.mkdtemp(prefix="orgtree-pg12-reader-"))
    try:
        script = tmp / "reader.py"
        script.write_text(READER, encoding="utf-8")
        run_env = {**env, "ORGTREE_DATA": str(root)}
        out = subprocess.run([sys.executable, str(script), DEPS, str(REPO), json.dumps(slugs)],
                             capture_output=True, text=True, env=run_env, timeout=300)
        if out.returncode != 0:
            raise AssertionError(f"store reader failed ({run_env.get('ORGTREE_STORE')}): {out.stderr[-3000:]}")
        return json.loads(out.stdout.strip().splitlines()[-1])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def runtime_sql(conninfo: str, sql: str) -> str:
    psql = Path(os.environ["ORGTREE_P03_PG_BIN"]) / "psql.exe"
    out = subprocess.run([str(psql), conninfo, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
                         capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60,
                         env={k: v for k, v in os.environ.items() if not k.startswith("PG")})
    if out.returncode != 0:
        raise AssertionError(f"runtime connection failed: {out.stderr.strip()}")
    return out.stdout.strip()


def populate(root: Path) -> None:
    (root / "orgs").mkdir(parents=True, exist_ok=True)
    doc = fixtures.sample_doc("Acme")
    doc["events"] += [{"at": f"2026-09-25T11:00:{i:02d}Z", "kind": "tick", "i": i} for i in range(40)]
    fixtures.write_db(root / "orgs" / "acme.db", doc)
    (root / "orgs" / "beta.json").write_text(json.dumps(fixtures.sample_doc("Beta")), encoding="utf-8")


class Drills(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        for name in (bracket.CUSTODIAN_ENV, "ORGTREE_P03_PG_BIN", "ORGTREE_TEST_PYDEPS"):
            if not os.environ.get(name):
                raise AssertionError(f"{name} must be set: this drill never skips silently")
        import psycopg  # noqa: F401  proves the dependency is really there
        cls.cleanup: list[tuple[Path, bool, dict]] = []

    @classmethod
    def tearDownClass(cls) -> None:
        for root, product, env in cls.cleanup:
            flag = ["--product"] if product else []
            try:
                custodian_json("stop", "--root", str(root), "--immediate", *flag, env=env)
                if not product:
                    custodian_json("destroy", "--root", str(root), env=env)
            except Exception:  # noqa: BLE001  best-effort cleanup of a disposable root
                pass
            shutil.rmtree(root.parent if product else root, ignore_errors=True)

    def import_cli(self, root: Path, env: dict, *extra: str) -> tuple[int, dict]:
        """pgimport's own main(), in this process (psycopg comes from
        ORGTREE_TEST_PYDEPS), with ``env`` as the process environment."""
        out = Path(tempfile.mkdtemp(prefix="orgtree-pg12-out-")) / "report.json"
        saved = dict(os.environ)
        os.environ.clear()
        os.environ.update(env)
        try:
            code = pgimport.main(["import", "--root", str(root), "--custodian", env[bracket.CUSTODIAN_ENV],
                                  "--out", str(out), *extra])
        finally:
            os.environ.clear()
            os.environ.update(saved)
        rep = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
        shutil.rmtree(out.parent, ignore_errors=True)
        return code, rep

    def end_to_end(self, root: Path, env: dict, product: bool) -> dict:
        populate(root)
        sources = digest_tree(root / "orgs")
        # the reference: what the SQLite store loads from a copy of the same files
        ref_root = Path(tempfile.mkdtemp(prefix="orgtree-pg12-ref-"))
        try:
            shutil.copytree(root / "orgs", ref_root / "orgs")
            (ref_root / "orgs" / "beta.json").unlink()  # JSON conversion is an operator step on SQLite
            reference = read_store(ref_root, ["acme"], {**env, "ORGTREE_STORE": "sqlite"})
        finally:
            shutil.rmtree(ref_root, ignore_errors=True)
        self.assertEqual(reference["backend"], "sqlite")

        code, rep = self.import_cli(root, env, "--cutover")
        self.assertEqual(code, 0, rep)
        self.assertEqual({s: v["action"] for s, v in rep["orgs"].items()}, {"acme": "imported", "beta": "imported"})
        self.assertEqual(sorted(rep["migrations"]["current"]), ["0001_base.sql", "0002_runtime_grants.sql"])
        record = json.loads((root / "store-backend.json").read_text(encoding="utf-8"))
        self.assertEqual(record["backend"], "postgres")
        self.assertEqual(sorted(p.name for p in (root / "orgs").iterdir()), ["acme.pg", "beta.pg"])
        self.assertEqual(digest_tree(root / "pre-postgres" / "orgs"), sources, "the old files moved unchanged")
        again_code, again = self.import_cli(root, env)
        self.assertEqual((again_code, again.get("kind"), again.get("moved")), (0, "cutover_completed", []))

        # The ENGINE: ORGTREE_STORE unset, so the record decides.
        engine_env = {k: v for k, v in env.items() if k != bracket.STORE_ENV}
        engine_env["ORGTREE_DATA"] = str(root)
        owned = bracket.start_for_engine(root, engine_env)
        try:
            self.assertEqual(owned.product, product)
            self.assertEqual(engine_env[bracket.STORE_ENV], "postgres")
            self.assertEqual(owned.migration["applied"], [], "the import already migrated; the engine only checks")
            loaded = read_store(root, ["acme", "beta"], engine_env)
            self.assertEqual(loaded["backend"], "postgres")
            self.assertTrue(Path(loaded["store_file"]).resolve().is_relative_to(REPO), loaded["store_file"])
            self.assertEqual(loaded["orgs"]["acme"], reference["orgs"]["acme"],
                             "the engine on PostgreSQL loads exactly what SQLite loaded")
            self.assertEqual(json.loads(loaded["orgs"]["beta"])["name"], "Beta")
            conn = engine_env[bracket.CONNINFO_ENV]
            org_id = json.loads((root / "orgs" / "acme.pg").read_text(encoding="utf-8"))["org_id"]
            top = int(runtime_sql(conn, f"SELECT max(seq) FROM org_{org_id}.log_l"))
            new = int(runtime_sql(conn, f"INSERT INTO org_{org_id}.log_l(sect, at, val) VALUES ('events', NULL, '{{}}') RETURNING seq"))
            who = runtime_sql(conn, "SELECT current_user")
        finally:
            stopped = owned.stop()
        self.assertEqual(new, top + 1, "the log identity continues after the imported rows")
        self.assertEqual(who, "orgtree_runtime")
        self.assertTrue(stopped["database_stop"]["ok"], stopped)
        return {"orgs": rep["orgs"], "migrations": rep["migrations"], "moved": sorted(record_moved(root)),
                "engine": {"action": owned.database is None and "stopped", "mode": "product" if product else "prototype",
                           "migration_applied": owned.migration["applied"], "runtime_role": who,
                           "next_seq": new, "imported_max_seq": top},
                "acme_equal_to_sqlite": True, "stop": stopped}

    def test_prototype_root_import_cutover_and_engine_start(self) -> None:
        root = Path(tempfile.gettempdir()) / f"orgtree-p03-pg12-proto-{os.getpid()}-{time.monotonic_ns() % 100000}"
        env = dict(os.environ)
        r = custodian_json("init-root", "--root", str(root), env=env)
        self.assertTrue(r["ok"], r)
        self.cleanup.append((root, False, env))
        detail = self.end_to_end(root, env, product=False)
        report("prototype root: import, cutover, engine on postgres", "passed", detail)

    def test_product_root_bind_import_cutover_and_engine_start(self) -> None:
        parent = Path(tempfile.mkdtemp(prefix="orgtree-p03-pg12-product-"))
        root = parent / "data"
        root.mkdir()
        env = {**os.environ, "ORGTREE_DATA": str(root)}
        self.cleanup.append((root, True, env))
        tool = REPO / "tools" / "pypg" / "pgimport.py"
        prep = [sys.executable, str(tool), "prepare", "--root", str(root), "--custodian", env[bracket.CUSTODIAN_ENV]]
        # an agent session naming this root refuses, and binds nothing: the
        # custodian itself (pgimport would not even load the store there —
        # devguard refuses an agent's inherited data root first)
        refused = custodian_json("bind-product", "--root", str(root), env={**env, "ORGTREE_AGENT_PARENT_DATA": str(root)})
        self.assertEqual((refused["ok"], refused.get("code")), (False, "root.protected"), refused)
        guarded = subprocess.run(prep, capture_output=True, text=True, timeout=120,
                                 env={**env, "ORGTREE_AGENT_PARENT_DATA": str(root)})
        self.assertNotEqual(guarded.returncode, 0, guarded.stderr)
        self.assertIn("devguard", guarded.stderr)
        self.assertFalse((root / "orgtree-product-root.json").exists())
        # a root that is not ORGTREE_DATA refuses too
        other = subprocess.run(prep, capture_output=True, text=True, timeout=120, env={**env, "ORGTREE_DATA": str(parent)})
        self.assertEqual(other.returncode, 3, other.stderr)
        self.assertIn("product.not_engine_root", other.stderr)
        ok = subprocess.run(prep, capture_output=True, text=True, timeout=120, env=env)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertTrue((root / "orgtree-product-root.json").exists())
        detail = self.end_to_end(root, env, product=True)
        destroy = custodian_json("destroy", "--root", str(root), "--product", env=env)
        destroy_plain = custodian_json("destroy", "--root", str(root), env=env)
        self.assertFalse(destroy["ok"], destroy)
        self.assertFalse(destroy_plain["ok"], destroy_plain)
        self.assertTrue((root / "pg").is_dir(), "the product cluster must survive both destroy attempts")
        detail["destroy_refused"] = {"with_product": destroy.get("code"), "without": destroy_plain.get("code")}
        detail["prepare_refusals"] = {"custodian_agent_variable": "root.protected", "pgimport_agent_variable": "devguard",
                                      "not_orgtree_data": "product.not_engine_root"}
        report("product root: bind, import, cutover, engine on postgres", "passed", detail)


def record_moved(root: Path) -> list[str]:
    return [p.name for p in (root / "pre-postgres" / "orgs").iterdir()]


if __name__ == "__main__":
    unittest.main()
