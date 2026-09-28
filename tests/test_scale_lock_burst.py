"""The lock-wait probe (tools/scale/lock_waits.py, lock_burst.py, baseline --lock-burst).

n1000-burst-27-of-messages-fail-with-locktimeout: the recorder must name the
lock a transaction waits on, attribute it to the registered holder, and the
summary must count episodes and failures exactly. Pure parts only; the live
probe runs in a p03 slot.
"""
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/scale"))
import lock_burst
import lock_waits


def signed(name):
    """A stand-in for PG's signed int4 hashtext: some names hash negative."""
    return {"section:mail_transitions": -731012790, "section:audiences": 123456,
            "node:coord-0": -5, "org:*": 7}.get(name, 99)


def wait(pid, lock, waited, at, blockers):
    return dict(at=at, pid=pid, waited_s=waited, lock=lock, mode="ExclusiveLock",
                waiter_site=["pgdoor.py:470:_run"], waiter_plan=[], blockers=blockers)


def holder(site, age):
    return dict(pid=9, site=site, plan=[], registered_s=age, xact_s=age, state="active", query="")


class DecodeKey(unittest.TestCase):
    def test_negative_hashes_match_the_unsigned_objid(self):
        cache = {}
        objid = -731012790 & 0xFFFFFFFF
        self.assertEqual(lock_waits.decode_key(objid, ["section:audiences", "section:mail_transitions"],
                                               cache, signed), "section:mail_transitions")
        self.assertEqual(lock_waits.decode_key(123456, ["section:audiences"], cache, signed),
                         "section:audiences")

    def test_an_unknown_key_is_none_and_hashes_are_cached(self):
        calls = []
        def counting(name):
            calls.append(name)
            return signed(name)
        cache = {}
        self.assertIsNone(lock_waits.decode_key(424242, ["org:*", "node:coord-0"], cache, counting))
        lock_waits.decode_key(424242, ["org:*", "node:coord-0"], cache, counting)
        self.assertEqual(calls, ["org:*", "node:coord-0"])


class Register(unittest.TestCase):
    def test_every_lock_block_registers_its_plan_by_backend_pid(self):
        import contextlib
        import threading

        class Backend:
            @contextlib.contextmanager
            def transaction_many(self, txs, lock_timeout):
                yield

        built = []
        fake_orgtx = SimpleNamespace(_ORG_KEY="*", PgBackend=Backend,
                                     _lock_block=lambda raw, org_id, entries: built.append(entries) or "DO $x$$x$")
        fake_pg = SimpleNamespace(connect=lambda: (_ for _ in ()).throw(RuntimeError("no PG here")))
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            stop = lock_waits.install(fake_orgtx, fake_pg, Path(tmp) / "waits.jsonl")
            try:
                raw = SimpleNamespace(info=SimpleNamespace(backend_pid=4242))
                sql = fake_orgtx._lock_block(raw, 1, [("section", "audiences", True),
                                                      ("node", "coord-0", False)])
                with Backend().transaction_many([], 1):
                    pass
            finally:
                stop.set()
                for t in threading.enumerate():
                    if t.name in ("scale-lock-waits", "scale-tx-profile"):
                        t.join(5)
            self.assertTrue((Path(tmp) / "tx-profile.json").exists(), "the holder profile is written on stop")
        self.assertEqual(sql, "DO $x$$x$", "the real block is still built and returned")
        self.assertEqual(len(built), 1)
        entry = lock_waits._registry[4242]
        self.assertEqual(entry["plan"], ["X section:audiences", "S node:coord-0"])
        self.assertEqual(entry["names"], ["org:*", "section:audiences", "node:coord-0"])


class LockLines(unittest.TestCase):
    def test_multi_line_lock_calls_are_matched_by_their_start_line(self):
        import contextlib

        class Backend:
            @contextlib.contextmanager
            def transaction_many(self, txs, lock_timeout, raw=None):
                raw.execute("SELECT pg_advisory_xact_lock(%s, hashtext(%s))", (1, "org:*"))
                ids = [r for r in raw.execute(
                    "SELECT id FROM nodes ORDER BY id FOR UPDATE").fetchall()]
                raw.execute(block)                            # noqa: F821
                raw.execute("SELECT 1")
                yield ids

        import inspect
        fn = Backend.transaction_many.__wrapped__
        src, first = inspect.getsourcelines(fn)
        start = {first + i for i, line in enumerate(src)
                 if "raw.execute(" in line and "SELECT 1" not in line and "fetchall()]" not in line}
        got = lock_waits._lock_statement_lines(SimpleNamespace(), Backend.transaction_many)
        self.assertEqual(got, start)


class Summarize(unittest.TestCase):
    def test_samples_of_one_wait_are_one_episode_with_its_longest_wait(self):
        waits = [wait(1, "section:audiences", .1, 100.1, [holder(["a.py:1:x"], 1.0)]),
                 wait(1, "section:audiences", .3, 100.3, [holder(["a.py:1:x"], 1.2)]),
                 wait(2, "section:notices", .5, 100.5, [holder(["b.py:2:y"], 2.0)]),
                 {"at": 101, "sampler_error": "boom"}]
        sends = [dict(status=200, seconds=.5, error=None), dict(status=500, seconds=10.1, error="55P03"),
                 dict(status=200, seconds=1.5, error=None)]
        counts = [dict(lock_timeout_55P03=0), dict(lock_timeout_55P03=1)]
        s = lock_burst.summarize(waits, counts, sends)
        self.assertEqual(s["wait_episodes"], 2)
        self.assertEqual(s["by_lock"]["section:audiences"]["n"], 1)
        self.assertEqual(s["by_lock"]["section:audiences"]["max"], .3)
        self.assertEqual(s["by_blocker_site_xact_age_s"]["a.py:1:x"]["max"], 1.2)
        self.assertEqual((s["sends"], s["failed"], s["lock_timeouts_55P03"]), (3, 1, 1))
        self.assertEqual(s["statuses"], {200: 2, 500: 1})
        self.assertEqual(s["send_s"]["max"], 10.1)

    def test_a_blocker_outside_org_tx_is_named_so(self):
        s = lock_burst.summarize([wait(3, "section:x", .2, 5.2, [holder(None, .4)])], [], [])
        self.assertIn("(not org_tx)", s["by_blocker_site_xact_age_s"])


class Admission(unittest.TestCase):
    def test_lock_burst_is_a_small_no_go_run(self):
        import baseline
        args = SimpleNamespace(small_control=False, preflight_only=False, lock_burst=100, go_file=None)
        config = baseline.require_go(args, "0" * 40)
        self.assertEqual(config["lock_burst"], 100)
        self.assertTrue(config["preflight_only"], "no seeded N1000 run follows the probe")


if __name__ == "__main__":
    unittest.main()
