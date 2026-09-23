"""The bundled-hub adapter (engine/mailhub_runtime.py), end to end.

The adapter is the thin layer the mail-hub ticket allows Orgtree to keep:
settings storage, desktop-engine lifecycle, and migration of the superseded
V2 hub's data into the pinned orgtree-mailhub product. This suite drives the
REAL thing — the lifecycle checks spawn the actual child process (the same
`python -m mailhub.serve` the Docker image runs) on a loopback test port.

    §1  hosting-config validation
    §2  desktop-hub.json migration — clean mapping, refused mappings, notes
    §3  V2 store migration — counts, meta record, skips, idempotence,
        read-only source
    §4  lifecycle — start/healthz/status/stop, orphan pid handling
    §5  configure — apply-with-restart, rollback on a bad patch

    python tests/test_mailhub_runtime.py [-v]
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import traceback
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.normpath(os.path.join(_HERE, ".."))
sys.path.insert(0, _ROOT)                      # engine.* from THIS worktree

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.mailhub_runtime import (                             # noqa: E402
    MailhubRuntime, validate_config, _config_from_v2)

TEST_PORT = 7397                               # loopback only, test-local

PASS = 0
FAIL: list[tuple[str, str]] = []


def check(label, fn) -> None:
    global PASS
    try:
        fn()
    except Exception:                                            # noqa: BLE001
        FAIL.append((label, traceback.format_exc()))
        print(f"  FAIL     {label}")
        return
    PASS += 1
    print(f"  ok {PASS:3d}  {label}")


def fresh_root() -> str:
    return tempfile.mkdtemp(prefix="orgtree-mailhub-rt-")


def refuses(fn) -> bool:
    try:
        fn()
    except ValueError:
        return True
    return False


# ═════════════════════════════════════════════════════════ §1 validation
def sec_validation() -> None:
    print("§1  hosting-config validation")

    def _defaults():
        c = validate_config({})
        assert c["port"] == 7370 and c["bind"] == "127.0.0.1"
        assert c["retention_days"] is None      # integrated default: forever
        assert c["org_retention_days"] == 45
        assert c["public_listener"] is False
    check("defaults: port 7370, loopback, keep-forever retention", _defaults)

    def _refusals():
        assert refuses(lambda: validate_config({"port": 0}))
        assert refuses(lambda: validate_config({"port": "7370"}))
        assert refuses(lambda: validate_config({"bind": "192.168.1.5"}))
        assert refuses(lambda: validate_config({"retention_days": 0}))
        assert refuses(lambda: validate_config({"retention_days": "30"}))
        assert refuses(lambda: validate_config({"name": "two\nlines"}))
        assert refuses(lambda: validate_config({"public_listener": "yes"}))
        assert refuses(lambda: validate_config([]))
    check("refusals: bad port/bind/retention/name/flag shapes", _refusals)


# ══════════════════════════════════════════════ §2 desktop-hub.json mapping
def sec_config_migration() -> None:
    print("\n§2  desktop-hub.json migration")

    def _live_shape_maps_cleanly():
        c = _config_from_v2({"version": 1, "enabled": True,
                             "bind_host": "127.0.0.1", "port": 7370,
                             "advertise_host": "127.0.0.1"})
        assert c["port"] == 7370 and c["bind"] == "127.0.0.1"
        assert c["retention_days"] is None
        assert c["migrated"]["from"] == "desktop-hub.json"
        assert c["migrated"]["notes"] == []
    check("the live machine's shape maps cleanly with no notes",
          _live_shape_maps_cleanly)

    def _tls_public_is_refused_to_loopback():
        c = _config_from_v2({"version": 1, "enabled": True,
                             "bind_host": "0.0.0.0", "port": 7370,
                             "advertise_host": "hub.example",
                             "tls_certfile": "C:/x.pem",
                             "tls_keyfile": "C:/y.pem"})
        assert c["bind"] == "127.0.0.1", (
            "a TLS-hosted public bind was carried into a hub that does not "
            "terminate TLS — that silently downgrades the user's transport")
        assert any("TLS" in n for n in c["migrated"]["notes"])
        assert any("advertise" in n.lower() or "advertised" in n.lower()
                   for n in c["migrated"]["notes"])
    check("public-with-TLS is NOT carried over (reset to loopback, told)",
          _tls_public_is_refused_to_loopback)

    def _plain_public_carries():
        c = _config_from_v2({"version": 1, "enabled": True,
                             "bind_host": "0.0.0.0", "port": 7370,
                             "advertise_host": "127.0.0.1"})
        assert c["bind"] == "0.0.0.0"
        assert any("carried over" in n for n in c["migrated"]["notes"])
    check("plain public bind carries over, with the operator-page warning",
          _plain_public_carries)

    def _dynamic_port_gets_the_standard():
        c = _config_from_v2({"version": 1, "enabled": False,
                             "bind_host": "127.0.0.1", "port": 0,
                             "advertise_host": "127.0.0.1"})
        assert c["port"] == 7370
        assert any("port" in n for n in c["migrated"]["notes"])
    check("a dynamic/invalid port maps to the standard 7370, noted",
          _dynamic_port_gets_the_standard)

    def _legacy_file_is_never_touched():
        root = fresh_root()
        legacy = os.path.join(root, "desktop-hub.json")
        payload = ('{"version": 1, "enabled": true, "bind_host": '
                   '"127.0.0.1", "port": 7370, "advertise_host": '
                   '"127.0.0.1"}')
        with open(legacy, "w", encoding="utf-8") as f:
            f.write(payload)
        rt = MailhubRuntime(root)
        assert open(legacy, encoding="utf-8").read() == payload
        assert rt.config["migrated"]["from"] == "desktop-hub.json"
        assert os.path.exists(os.path.join(root, "mailhub-hosting.json"))
        # a second construction reads the NEW file, not the legacy again
        rt2 = MailhubRuntime(root)
        assert rt2.config == rt.config
        shutil.rmtree(root, ignore_errors=True)
    check("the legacy file is read once, never modified, and the mapped "
          "config persists", _legacy_file_is_never_touched)


# ═══════════════════════════════════════════════════ §3 V2 store migration
_V2_SCHEMA = """
CREATE TABLE IF NOT EXISTS orgs (
  slug TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, org_name TEXT NOT NULL,
  username TEXT NOT NULL, blurb TEXT NOT NULL, registered_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL,
  body TEXT NOT NULL, kind TEXT, thread_id TEXT, sent_at TEXT,
  received_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
  fetched_at TEXT, delivered_at TEXT, read_at TEXT,
  receipts_pushed INTEGER NOT NULL DEFAULT 1, attachments TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, owner_slug TEXT NOT NULL, name TEXT NOT NULL,
  bytes INTEGER NOT NULL, created_at TEXT NOT NULL, message_id TEXT
);
"""


def plant_v2_store(root: str) -> None:
    hub = os.path.join(root, "hub")
    os.makedirs(os.path.join(hub, "blobs"), exist_ok=True)
    con = sqlite3.connect(os.path.join(hub, "hub.sqlite3"))
    con.executescript(_V2_SCHEMA)
    con.execute("INSERT INTO orgs VALUES ('a.u.aaaaaa','','A','u','',"
                "'2026-09-01T00:00:00Z','2026-09-10T00:00:00Z')")
    con.execute("INSERT INTO orgs VALUES ('b.u.bbbbbb','','B','u','',"
                "'2026-09-01T00:00:00Z','2026-09-10T00:00:00Z')")
    con.execute("INSERT INTO orgs VALUES ('c.u.cccccc','"
                + "f" * 64 + "','C','u','','2026-09-01T00:00:00Z',"
                "'2026-09-10T00:00:00Z')")
    con.execute("INSERT INTO messages VALUES ('m1','a.u.aaaaaa','b.u.bbbbbb'"
                ",'queued mail',NULL,NULL,'2026-09-10T00:00:00Z',"
                "'2026-09-10T00:00:01Z','queued',NULL,NULL,NULL,1,"
                "'[{\"id\":\"aa11\",\"name\":\"f.txt\",\"bytes\":5}]')")
    con.execute("INSERT INTO messages VALUES ('m2','b.u.bbbbbb','a.u.aaaaaa'"
                ",'old fetched mail',NULL,NULL,'2026-06-01T00:00:00Z',"
                "'2026-06-01T00:00:01Z','fetched','2026-06-01T00:01:00Z',"
                "'2026-06-01T00:02:00Z','2026-06-01T00:03:00Z',1,'[]')")
    con.execute("INSERT INTO attachments VALUES ('aa11','a.u.aaaaaa',"
                "'f.txt',5,'2026-09-10T00:00:00Z','m1')")
    con.commit()
    con.close()
    with open(os.path.join(hub, "blobs", "aa11"), "wb") as f:
        f.write(b"hello")


def sec_store_migration() -> None:
    print("\n§3  V2 store migration")

    def _migrates_whole():
        root = fresh_root()
        plant_v2_store(root)
        src_db = os.path.join(root, "hub", "hub.sqlite3")
        before = open(src_db, "rb").read()
        rt = MailhubRuntime(root)
        rt._migrate_store()
        dst = sqlite3.connect(os.path.join(root, "mailhub", "hub.sqlite3"))
        dst.row_factory = sqlite3.Row
        msgs = {r["id"]: dict(r) for r in
                dst.execute("SELECT * FROM messages").fetchall()}
        assert set(msgs) == {"m1", "m2"}
        assert msgs["m2"]["state"] == "fetched"          # delivery state
        assert msgs["m2"]["read_at"] == "2026-06-01T00:03:00Z"
        assert msgs["m1"]["received_at"] == "2026-09-10T00:00:01Z"
        atts = dst.execute("SELECT * FROM attachments").fetchall()
        assert len(atts) == 1 and atts[0]["id"] == "aa11"
        orgs = {r["slug"]: r["fingerprint"] for r in
                dst.execute("SELECT slug, fingerprint FROM orgs").fetchall()}
        assert orgs == {"c.u.cccccc": "f" * 64}, (
            "fingerprint-less V2 roster rows must be SKIPPED (unclaimable "
            "under owned-address auth), fingerprinted rows kept: %r" % orgs)
        meta = json.loads(dst.execute(
            "SELECT v FROM meta WHERE k='migrated_from_v2'").fetchone()[0])
        assert meta["messages"] == 2 and meta["attachments"] == 1
        assert set(meta["orgs_skipped"]) == {"a.u.aaaaaa", "b.u.bbbbbb"}
        dst.close()
        blob = os.path.join(root, "mailhub", "blobs", "aa11")
        assert open(blob, "rb").read() == b"hello"
        report = json.loads(open(os.path.join(
            root, "mailhub", "migration-report.json"),
            encoding="utf-8").read())
        assert report["messages"] == 2
        assert open(src_db, "rb").read() == before, "THE SOURCE WAS TOUCHED"
        shutil.rmtree(root, ignore_errors=True)
    check("messages, states, timestamps, attachments and blobs migrate "
          "whole; fingerprint-less roster rows are skipped and recorded; "
          "the source store is untouched", _migrates_whole)

    def _idempotent():
        root = fresh_root()
        plant_v2_store(root)
        rt = MailhubRuntime(root)
        rt._migrate_store()
        rt._migrate_store()                       # marker short-circuits
        dst = sqlite3.connect(os.path.join(root, "mailhub", "hub.sqlite3"))
        assert dst.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2
        dst.close()
        shutil.rmtree(root, ignore_errors=True)
    check("a second run is a no-op (durable meta marker)", _idempotent)

    def _no_source_no_op():
        root = fresh_root()
        rt = MailhubRuntime(root)
        rt._migrate_store()
        assert not os.path.exists(os.path.join(root, "mailhub",
                                               "hub.sqlite3"))
        shutil.rmtree(root, ignore_errors=True)
    check("no V2 store → nothing invented", _no_source_no_op)


# ═══════════════════════════════════════════════════════════ §4 lifecycle
def sec_lifecycle() -> None:
    print("\n§4  lifecycle — the real child process")

    def _start_serve_stop():
        root = fresh_root()
        rt = MailhubRuntime(root)
        rt.configure_quiet = True
        rt.config["port"] = TEST_PORT
        rt.config["name"] = "adapter-test-hub"
        try:
            st = rt.start()
            assert not st.get("error"), st
            assert st["status"]["running"] and st["status"]["healthy"], st
            assert st["status"]["address"] == f"http://127.0.0.1:{TEST_PORT}"
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{TEST_PORT}/healthz",
                    timeout=5) as r:
                h = json.loads(r.read().decode())
            assert h["name"] == "adapter-test-hub", h
            assert h["retention_days"] == 36500, (
                "keep-forever must reach the child as HUB_RETENTION_DAYS: "
                f"{h}")
            assert os.environ.get("ORGTREE_LOCAL_HUB_ADDRESS") \
                == f"http://127.0.0.1:{TEST_PORT}"
        finally:
            rt.stop()
        # stopped = port free again
        try:
            urllib.request.urlopen(
                f"http://127.0.0.1:{TEST_PORT}/healthz", timeout=2)
            raise AssertionError("the hub still answers after stop()")
        except (OSError, urllib.error.URLError):
            pass
        shutil.rmtree(root, ignore_errors=True)
    check("start → real /healthz with the configured name and keep-forever "
          "retention → stop frees the port", _start_serve_stop)

    def _stale_pid_is_harmless():
        root = fresh_root()
        rt = MailhubRuntime(root)
        rt.config["port"] = TEST_PORT
        os.makedirs(rt.data_dir, exist_ok=True)
        with open(os.path.join(rt.data_dir, "hub.pid"), "w",
                  encoding="utf-8") as f:
            f.write("999999")                    # long dead
        try:
            st = rt.start()
            assert not st.get("error"), st
            assert st["status"]["healthy"]
        finally:
            rt.stop()
        shutil.rmtree(root, ignore_errors=True)
    check("a stale orphan pid file does not block a start",
          _stale_pid_is_harmless)


# ═══════════════════════════════════════════════════════════ §5 configure
def sec_configure() -> None:
    print("\n§5  configure — restart and rollback")

    def _apply_restarts_with_new_name():
        root = fresh_root()
        rt = MailhubRuntime(root)
        rt.config["port"] = TEST_PORT
        try:
            rt.start()
            out = rt.configure({"name": "renamed-hub"})
            assert out["status"]["healthy"], out
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{TEST_PORT}/healthz",
                    timeout=5) as r:
                assert json.loads(r.read().decode())["name"] == "renamed-hub"
            saved = json.loads(open(rt.path, encoding="utf-8").read())
            assert saved["name"] == "renamed-hub"
        finally:
            rt.stop()
        shutil.rmtree(root, ignore_errors=True)
    check("a config change restarts the hub and persists",
          _apply_restarts_with_new_name)

    def _bad_patch_rolls_back():
        root = fresh_root()
        rt = MailhubRuntime(root)
        rt.config["port"] = TEST_PORT
        try:
            rt.start()
            try:
                rt.configure({"port": -1})
                raise AssertionError("an invalid port was accepted")
            except ValueError:
                pass
            st = rt.status()
            assert st["port"] == TEST_PORT and st["status"]["healthy"], (
                "the previous configuration did not survive a refused patch:"
                f" {st}")
        finally:
            rt.stop()
        shutil.rmtree(root, ignore_errors=True)
    check("an invalid patch is refused and the running hub is untouched",
          _bad_patch_rolls_back)


print("the bundled-hub adapter — engine/mailhub_runtime.py")
sec_validation()
sec_config_migration()
sec_store_migration()
sec_lifecycle()
sec_configure()

print()
if FAIL:
    for label, tb in FAIL:
        print(f"\n✗ {label}\n{tb}")
    print(f"mailhub-runtime: {PASS} passed · {len(FAIL)} FAILED")
    sys.exit(1)
print(f"mailhub-runtime: all {PASS} checks passed")
