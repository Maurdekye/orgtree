"""PG-4 RT9 on a REAL PostgreSQL: a missed NOTIFY is detected and the screen refetches.

Needs a DISPOSABLE PostgreSQL (never a live one), exactly like test_pgstore:
  ORGTREE_TEST_PG_ADMIN_URL  a superuser URL; this module creates and drops its
                             own database `orgtree_pg4_t<pid>`
  ORGTREE_TEST_PYDEPS        (optional) a folder holding psycopg
Without the URL every test SKIPS, and a skip is not a pass.

What it proves (each arm counts that its forcing really happened):
  * a commit through the seam reaches the feed as a NOTIFY, not a gap;
  * RT9: the listener's backend is TERMINATED (the kill is counted and the new
    session has a different pid), two commits land while it is down, and NO
    notification for them ever reaches the feed (the notification counter does
    not move for them); the reconnect catch-up finds revision n+2 as a GAP;
  * the engine side of RT9: a commit made by ANOTHER session (not this
    process's store) while the listener was down makes the shared snapshot
    (store.cached_org) serve the new value and schedules the `changed`
    broadcast; the tree payload carries org_rev;
  * negative control: the same run with the catch-up/poll reads disabled leaves
    the snapshot STALE and broadcasts nothing, so the pass above is the
    catch-up's doing.
Run:  python tools/run-python-verification.py tests/test_pgfeed_live.py
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import urlsplit, urlunsplit

ADMIN = os.environ.get("ORGTREE_TEST_PG_ADMIN_URL", "").strip()
DEPS = os.environ.get("ORGTREE_TEST_PYDEPS", "").strip()
if DEPS:
    sys.path.insert(0, DEPS)

_temp = tempfile.TemporaryDirectory(prefix="v3-pgfeed-", ignore_cleanup_errors=True)
data = Path(_temp.name) / "data"
data.mkdir()
home = Path(_temp.name) / "home"
home.mkdir()
DBNAME = f"orgtree_pg4_t{os.getpid()}"


def _with_db(url: str, db: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, "/" + db, p.query, p.fragment))


if ADMIN:
    import psycopg
    with psycopg.connect(ADMIN, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {DBNAME}")
        c.execute(f"CREATE DATABASE {DBNAME}")
    os.environ["ORGTREE_PG_URL"] = _with_db(ADMIN, DBNAME)
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_STORE="postgres")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine" / "backend"))
import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout
from orgtree import pgfeed, pgstore, store  # noqa: E402


def setUpModule() -> None:
    if ADMIN:
        with pgstore.connect() as c:
            pgstore.migrate(c)
        store.claim_data_root()


def tearDownModule() -> None:
    if ADMIN:
        import psycopg
        with psycopg.connect(ADMIN, autocommit=True) as c:
            c.execute(f"DROP DATABASE IF EXISTS {DBNAME} WITH (FORCE)")


def _wait(cond, timeout: float = 10.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.02)
    return bool(cond())


def _fresh_org(name: str) -> str:
    org = store.create_org(name)
    slug = org.d["slug"]
    org.d["nodes"]["a"] = {"id": "a", "name": "a", "parent": None, "children": []}
    store.save_org(org)
    return slug


def _rev(slug: str) -> int:
    with pgstore.connect() as c:
        return int(c.execute("SELECT revision FROM public.orgs WHERE slug=%s",
                             (slug,)).fetchone()[0])


def _foreign_rename(slug: str, name: str) -> int:
    """A commit NOT made by this process's store: another session edits node
    'a', bumps the revision and NOTIFYs, as another engine process would."""
    with pgstore.connect() as c:
        with c.transaction():
            org_id = int(c.execute("SELECT org_id FROM public.orgs WHERE slug=%s",
                                   (slug,)).fetchone()[0])
            val = c.execute(f"SELECT val FROM org_{org_id}.nodes WHERE id='a'").fetchone()[0]
            node = json.loads(val)
            node["name"] = name
            c.execute(f"UPDATE org_{org_id}.nodes SET val=%s WHERE id='a'",
                      (json.dumps(node, ensure_ascii=False, separators=(",", ":")),))
            rev = int(c.execute("UPDATE public.orgs SET revision = revision + 1 "
                                "WHERE org_id=%s RETURNING revision", (org_id,)).fetchone()[0])
            c.execute("SELECT pg_notify('org_rev', %s)", (f"{slug}:{rev}",))
    return rev


class _Rig:
    """A RevisionFeed over real psycopg sessions, recording every session it
    opened so the test can terminate the listener and count the kill."""

    def __init__(self, on_change, *, catch_up: bool, poll_s: float) -> None:
        self.sessions: list = []
        #: cleared = a reconnect waits here: the listener stays DOWN until the
        #: test has made its commits (without this the 50 ms retry can be back
        #: LISTENing before they land, and their NOTIFYs are simply delivered)
        self.up = threading.Event()
        self.up.set()

        def connect():
            self.up.wait(30)
            s = pgfeed.psycopg_conn(os.environ["ORGTREE_PG_URL"])
            self.sessions.append(s)
            return s
        self.feed = pgfeed.RevisionFeed(connect, on_change, poll_s=poll_s, retry_s=0.05)
        self.feed.catch_up_enabled = catch_up

    def pid(self) -> int:
        return int(self.sessions[-1].c.info.backend_pid)

    def kill_listener(self) -> int:
        pid = self.pid()
        import psycopg
        with psycopg.connect(ADMIN, autocommit=True) as c:
            ok = c.execute("SELECT pg_terminate_backend(%s)", (pid,)).fetchone()[0]
        assert ok is True, f"pg_terminate_backend({pid}) did not terminate"
        return pid


@unittest.skipUnless(ADMIN, "ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN")
class Rt9Live(unittest.TestCase):
    def rig(self, on_change, *, catch_up: bool = True, poll_s: float = 60.0) -> _Rig:
        r = _Rig(on_change, catch_up=catch_up, poll_s=poll_s)
        r.feed.start()
        self.addCleanup(r.feed.stop)
        self.assertTrue(_wait(lambda: r.feed.stats.catchups >= 1), "the listener never connected")
        return r

    def test_a_seam_commit_arrives_as_a_notification(self) -> None:
        slug = _fresh_org("rt9-notify")
        calls: list = []
        r = self.rig(lambda s, v, g: calls.append((s, v, g)))
        before = _rev(slug)
        org = store.load_org(slug)
        org.d["nodes"]["a"]["name"] = "A1"
        store.save_org(org)
        self.assertTrue(_wait(lambda: (slug, before + 1, False) in calls), calls)
        self.assertGreaterEqual(r.feed.stats.notifications, 1)

    def _missed_while_down(self, slug: str, r: _Rig, calls: list) -> tuple[int, int]:
        n = _rev(slug)
        self.assertTrue(_wait(lambda: r.feed.last_seen(slug) == n or not r.feed.catch_up_enabled))
        notes_before = r.feed.stats.notifications
        sessions_before = len(r.sessions)
        r.up.clear()                              # hold the reconnect ...
        killed = r.kill_listener()
        self.assertTrue(_wait(lambda: r.feed.stats.reconnects >= 1), "the kill was not seen")
        # two commits by another session while this listener's session is gone
        _foreign_rename(slug, "down-1")
        last = _foreign_rename(slug, "down-2")
        self.assertEqual(last, n + 2)
        self.assertEqual(len(r.sessions), sessions_before, "a session opened while held")
        r.up.set()                                # ... and only now let it back
        self.assertTrue(_wait(lambda: len(r.sessions) >= 2 and r.feed.stats.catchups >= 2),
                        "the listener never reconnected")
        self.assertNotEqual(r.pid(), killed, "the reconnect reused the killed backend")
        time.sleep(0.5)
        # the NOTIFYs for n+1 and n+2 were really missed: nothing arrived for them
        self.assertEqual(r.feed.stats.notifications, notes_before)
        return n, last

    def test_rt9_a_notify_missed_while_the_listener_was_down_is_a_gap(self) -> None:
        slug = _fresh_org("rt9-gap")
        calls: list = []
        r = self.rig(lambda s, v, g: calls.append((s, v, g)))
        n, last = self._missed_while_down(slug, r, calls)
        self.assertTrue(_wait(lambda: (slug, last, True) in calls), calls)
        self.assertEqual(r.feed.last_seen(slug), n + 2)
        self.assertEqual(r.feed.stats.polls, 0, "the poll, not the catch-up, found it")

    def test_rt9_engine_the_snapshot_refreshes_and_the_screen_is_told(self) -> None:
        slug = _fresh_org("rt9-engine")
        self.assertEqual(store.cached_org(slug).d["nodes"]["a"]["name"], "a")
        told: list = []
        r = self.rig(pgfeed.engine_callback(store.external_change, told.append))
        seq0 = store.org_seq(slug)
        self._missed_while_down(slug, r, told)
        self.assertTrue(_wait(lambda: told.count(slug) >= 1), "no 'changed' broadcast")
        self.assertGreater(store.org_seq(slug), seq0)
        self.assertEqual(store.cached_org(slug).d["nodes"]["a"]["name"], "down-2")
        self.assertEqual(pgfeed.known_revision(r.feed, slug), _rev(slug))

    def test_rt9_control_without_catch_up_the_snapshot_stays_stale(self) -> None:
        slug = _fresh_org("rt9-control")
        self.assertEqual(store.cached_org(slug).d["nodes"]["a"]["name"], "a")
        told: list = []
        r = self.rig(pgfeed.engine_callback(store.external_change, told.append),
                     catch_up=False)
        seq0 = store.org_seq(slug)
        _n, last = self._missed_while_down(slug, r, told)
        time.sleep(0.5)
        # the control did its work (killed, reconnected, two commits landed) and
        # nothing noticed: this is the stale screen RT9 exists to prevent
        self.assertGreaterEqual(r.feed.stats.reconnects, 1)
        self.assertEqual(_rev(slug), last)
        self.assertIsNone(r.feed.last_seen(slug))
        self.assertEqual(told, [])
        self.assertEqual(store.org_seq(slug), seq0)
        self.assertEqual(store.cached_org(slug).d["nodes"]["a"]["name"], "a")

    def test_a_suppressed_notify_on_a_live_session_is_found_by_the_poll(self) -> None:
        slug = _fresh_org("rt9-poll")
        calls: list = []
        r = self.rig(lambda s, v, g: calls.append((s, v, g)), poll_s=0.3)
        self.assertTrue(_wait(lambda: r.feed.last_seen(slug) == _rev(slug)))
        with pgstore.connect() as c:        # a revision bump whose NOTIFY never fires
            rev = int(c.execute("UPDATE public.orgs SET revision = revision + 1 "
                                "WHERE slug=%s RETURNING revision", (slug,)).fetchone()[0])
        self.assertTrue(_wait(lambda: (slug, rev, True) in calls), calls)
        self.assertGreaterEqual(r.feed.stats.polls, 1)
        self.assertEqual(r.feed.stats.reconnects, 0)


if __name__ == "__main__":
    unittest.main()
