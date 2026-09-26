"""S3 (fence-off): model switches on the row-transaction door —
`orgtree_switch_model` (agent) and the `switch_model` op — on
`supervisor.switch_rows` (lifecycle_door.switch_body).

Through the real `api.agent_call` / `api.org_op` (throwaway SQLite root,
PG-0's SeamBackend org_tx, ORGTREE_PGDOOR=1):

  · both are declared and routed, and on the door neither enters the
    DOC_LOCK cycle (`store.write_org` / `_org_op_locked` explode);
  · a same-provider switch and a provider CROSSING give the same result and
    the same tree as the cycle on a twin org;
  · each commits on its FIRST transaction (lead decision 40);
  · a crossing's transcript copy runs once, AFTER the commit;
  · a busy seat queues the switch (D-234) and copies nothing;
  · a refused switch commits and copies nothing.

Run:  python tools/run-python-verification.py tests/test_s3_switch_model.py
"""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix="s3-switch-", ignore_cleanup_errors=True)
os.environ["ORGTREE_DATA"] = _root.name
os.environ["ORGTREE_STORE"] = "sqlite"
os.environ["ORGTREE_PGDOOR"] = "1"
os.environ.pop("ORGTREE_DESKTOP_MANAGED", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))
import import_provenance  # noqa: F401,E402
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, orgtx, pgdoor, store, supervisor  # noqa: E402

REQUEST = SimpleNamespace(state=SimpleNamespace())
U = ledger.USER
_N = [0]
SAME = "terra"        # luna -> terra: same provider, no session boundary
CROSS = "haiku"       # luna -> haiku: a provider crossing (new bearer)


class SwitchDoor(unittest.TestCase):
    def build(self, slug):
        org = store.create_org(slug)
        org.hire(U, None, "luna", 20, "boss")
        org.hire(U, "boss", "luna", 6, "a")
        org.hire(U, "boss", "luna", 4, "b")
        org.hire(U, "a", "luna", 2, "x")
        org.hire(U, "x", "luna", 0, "x1")
        store.save_org(org)

    def setUp(self):
        _N[0] += 1
        self.slug, self.twin = f"s3sw{_N[0]}", f"s3swtwin{_N[0]}"
        self.build(self.slug)
        self.build(self.twin)
        self.seen = []
        slug = self.slug

        def export(org, nid, old_sid=None, reason=None, **_):
            self.seen.append((reason, nid, pgdoor.current(slug) is not None))
            return None, None
        self.p = [patch.object(supervisor, "send_message", lambda *a, **k: {}),
                  patch.object(supervisor, "remote_reap", lambda *a, **k: None),
                  patch.object(supervisor, "export_predecessor_transcript_deferred",
                               export),
                  patch.object(api, "hub_changed", lambda *a, **k: None),
                  patch.object(api, "provider_hire_gate", lambda *a, **k: None)]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()
        store._POOL.close_all(self.slug)
        store._POOL.close_all(self.twin)

    # ---------------------------------------------------------------- paths
    def tool(self, slug, node, args):
        return api.agent_call(api.AgentCall(org=slug, node=node,
                                            tool="orgtree_switch_model",
                                            args=args), REQUEST)

    def op(self, slug, **kw):
        return api.org_op(slug, api.Op(op="switch_model", **kw), REQUEST)

    def door(self, kind, node_or_actor, **kw):
        def boom(*a, **k):
            raise AssertionError("a door call entered the DOC_LOCK cycle")
        with patch.object(store, "write_org", boom), \
                patch.object(api, "_org_op_locked", boom):
            if kind == "tool":
                return self.tool(self.slug, node_or_actor, kw)
            return self.op(self.slug, actor=node_or_actor, **kw)

    def cycle(self, kind, node_or_actor, **kw):
        with patch.object(pgdoor, "enabled", lambda: False):
            if kind == "tool":
                return self.tool(self.twin, node_or_actor, kw)
            return self.op(self.twin, actor=node_or_actor, **kw)

    def attempts(self, kind, node_or_actor, **kw):
        real, opened = pgdoor._org_tx, []

        def counting():
            tx = real()

            def opener(*a, **k):
                opened.append(sorted(map(str, k.get("sections") or ())))
                return tx(*a, **k)
            return opener
        with patch.object(pgdoor, "_org_tx", counting):
            r = self.door(kind, node_or_actor, **kw)
        return r, opened

    def view(self, slug, sid=None):
        o = store.load_org(slug)
        v = repr(sorted((k, n.get("parent"), n.get("grant"), n.get("state"),
                         n.get("model"), n.get("generation", 0),
                         bool(n.get("pending_switch")))
                        for k, n in o.nodes.items()))
        v = v.replace(slug, "<slug>")
        return v.replace(sid, "<sid>") if sid else v

    @staticmethod
    def strip(r, slug):
        r = dict(r)
        for k in ("ref", "reference", "warnings", "old_session"):
            r.pop(k, None)
        return repr(r).replace(slug, "<slug>")

    # ---------------------------------------------------------------- cases
    KINDS = (("tool", "a"), ("op", U))

    def test_switch_model_is_declared_and_routed(self):
        for name in ("orgtree_switch_model", "switch_model"):
            self.assertTrue(pgdoor.declared(name), name)
            self.assertTrue(pgdoor.routed(name, {}), name)

    def test_a_same_provider_switch_matches_the_cycle(self):
        for kind, who in self.KINDS:
            with self.subTest(kind):
                self.tearDown()
                self.setUp()
                mine = self.door(kind, who, node="x", tier=SAME)
                legacy = self.cycle(kind, who, node="x", tier=SAME)
                self.assertEqual(self.strip(mine, self.slug),
                                 self.strip(legacy, self.twin))
                self.assertEqual(self.view(self.slug), self.view(self.twin))
                self.assertEqual(store.load_org(self.slug).nodes["x"]["model"],
                                 SAME)
                self.assertEqual(self.seen, [])

    def test_a_crossing_matches_the_cycle_and_copies_after_the_commit(self):
        for kind, who in self.KINDS:
            with self.subTest(kind):
                self.tearDown()
                self.setUp()
                mine = self.door(kind, who, node="x", tier=CROSS)
                self.assertTrue(mine.get("old_session"), mine)
                # the door's copy: ONCE, for x, with no transaction open
                self.assertEqual(self.seen, [("switch_model", "x", False)])
                legacy = self.cycle(kind, who, node="x", tier=CROSS)
                self.assertEqual(self.strip(mine, self.slug),
                                 self.strip(legacy, self.twin))
                self.assertEqual(self.view(self.slug, mine["old_session"]),
                                 self.view(self.twin, legacy["old_session"]))
                o = store.load_org(self.slug)
                self.assertEqual(o.nodes["x"]["model"], CROSS)
                self.assertEqual(o.nodes["x"]["generation"], 1)
                self.assertIn("x@0", o.nodes)

    def test_each_switch_commits_in_one_attempt(self):
        # an open ask of x (a crossing moots it: `asks` written) and the
        # parent's notice: a spec missing either would force a re-run
        for kind, who in self.KINDS:
            for tier in (SAME, CROSS):
                with self.subTest(kind=kind, tier=tier):
                    self.tearDown()
                    self.setUp()
                    org = store.load_org(self.slug)
                    org.d.setdefault("asks", []).append(
                        {"id": "q1", "node": "x", "status": "open",
                         "questions": []})
                    store.save_org(org)
                    _, opened = self.attempts(kind, who, node="x", tier=tier)
                    self.assertEqual(len(opened), 1, opened)
                    self.assertEqual(
                        store.load_org(self.slug).nodes["x"]["model"], tier)

    def test_a_busy_seat_queues_the_switch_and_copies_nothing(self):
        real = supervisor.state

        def busy(slug, nid):
            st = dict(real(slug, nid))
            if nid == "x":
                st["busy"] = True
            return st
        for kind, who in self.KINDS:
            with self.subTest(kind):
                self.tearDown()
                self.setUp()
                with patch.object(supervisor, "state", busy):
                    r = self.door(kind, who, node="x", tier=CROSS)
                self.assertTrue(r.get("queued"), r)
                o = store.load_org(self.slug)
                self.assertEqual(o.nodes["x"]["model"], "luna")
                self.assertEqual(o.nodes["x"]["pending_switch"]["tier"], CROSS)
                self.assertEqual(self.seen, [])

    def test_a_refused_switch_commits_and_copies_nothing(self):
        # b is not x's superior
        before = (self.view(self.slug), orgtx.backend().revision(self.slug))
        with self.assertRaises(HTTPException) as e:
            self.door("tool", "b", node="x", tier=CROSS)
        self.assertEqual(e.exception.status_code, 422)
        self.assertEqual((self.view(self.slug),
                          orgtx.backend().revision(self.slug)), before)
        self.assertEqual(self.seen, [])

    def test_a_failed_copy_is_a_warning_not_a_refusal(self):
        def fail(*a, **k):
            raise OSError("disk full")
        with patch.object(supervisor, "export_after_commit", fail):
            out = self.door("tool", "a", node="x", tier=CROSS)
        self.assertEqual(store.load_org(self.slug).nodes["x"]["model"], CROSS)
        self.assertIn("then:export",
                      [w.get("step") for w in out.get("warnings") or []
                       if isinstance(w, dict)], out)

    def test_a_stale_freeze_cleared_by_a_crossing_is_woken_after_the_commit(self):
        woke = []
        slug = self.slug
        with patch.object(supervisor, "drive_unfrozen_by_switch",
                          lambda s, nids: woke.append(
                              (list(nids), pgdoor.current(slug) is not None))):
            org = store.load_org(self.slug)
            with patch.object(type(org), "switch_model", autospec=True,
                              side_effect=_with_stale(type(org).switch_model)):
                out = self.door("tool", "a", node="x", tier=SAME)
        self.assertNotIn("resume_stale_freeze", out)
        self.assertIn((["x"], False), woke)


    # ------------------------------------------------ review f1 / f2 (S3)
    def test_the_provider_gate_runs_once_outside_the_transaction(self):
        # f1: provider_hire_gate may make HTTP requests (OpenRouter's key
        # check), so it runs before the row locks, once per call — not
        # again when the door widens and re-runs
        real_rows = supervisor.switch_rows
        for kind, who in self.KINDS:
            with self.subTest(kind):
                self.tearDown()
                self.setUp()
                gated, calls = [], [0]

                def narrow_first(org, actor, nid, *, rebind):
                    # the snapshot's plan misses the ancestors: one widen
                    calls[0] += 1
                    spec = real_rows(org, actor, nid, rebind=rebind)
                    if calls[0] == 1:
                        return pgdoor.TxSpec(
                            nodes=tuple(n for n in spec.nodes if n != "boss"),
                            sections=spec.sections,
                            share_nodes=tuple(n for n in spec.share_nodes
                                              if n != "boss"),
                            share_sections=spec.share_sections,
                            logs=spec.logs)
                    return spec
                with patch.object(api, "provider_hire_gate",
                                  lambda org, tier, **k: gated.append(
                                      (tier, pgdoor.current(self.slug)
                                       is not None))), \
                        patch.object(supervisor, "switch_rows", narrow_first):
                    _, opened = self.attempts(kind, who, node="x", tier=SAME)
                self.assertEqual(len(opened), 2, "the stale plan did not widen")
                self.assertEqual(gated, [(SAME, False)])
                self.assertEqual(store.load_org(self.slug).nodes["x"]["model"],
                                 SAME)

    def test_a_kiosk_flag_that_moved_after_the_gate_refuses(self):
        # the gate read the snapshot's kiosk flag; the body holds `kiosk`
        # and refuses when it no longer matches (the gate is not re-run)
        slug = self.slug

        def flip(org, tier, **k):
            o = store.load_org(slug)
            o.d["kiosk"] = {"credits": 0}
            store.save_org(o)
        with patch.object(api, "provider_hire_gate", flip):
            with self.assertRaises(HTTPException) as e:
                self.door("tool", "a", node="x", tier=SAME)
        self.assertEqual(e.exception.status_code, 422)
        self.assertIn("kiosk setting changed", str(e.exception.detail))
        self.assertEqual(store.load_org(self.slug).nodes["x"]["model"], "luna")

    def test_an_account_rebind_exports_before_the_unpark_wake(self):
        # f2 (review-astra's probe): a used, account-parked seat rebound
        # with the switch; the successor is woken only after its
        # predecessor's transcript and handoff are published
        from orgtree import registry
        for kind, who in self.KINDS:
            with self.subTest(kind):
                self.tearDown()
                self.setUp()
                org = store.load_org(self.slug)
                org.nodes["x"]["session_unrun"] = False
                org.nodes["x"]["frozen"] = {"cause": "account"}
                store.save_org(org)
                events = []
                sel = {"id": "review-openai", "provider": "openai",
                       "name": "review"}
                with patch.object(registry, "validate_selection",
                                  return_value=sel), \
                        patch.object(supervisor, "export_after_commit",
                                     lambda *a, **k: events.append("export")), \
                        patch.object(supervisor, "drive_account_unpark",
                                     lambda *a, **k: events.append("wake")):
                    self.door(kind, who, node="x", tier=SAME,
                              account="review-openai")
                final = store.load_org(self.slug).nodes["x"]
                self.assertEqual(final["account"], "review-openai")
                self.assertNotIn("frozen", final)
                self.assertEqual(final["generation"], 1)
                self.assertEqual(events, ["export", "wake"])

def _with_stale(real):
    def run(self, *a, **k):
        r = real(self, *a, **k)
        r["resume_stale_freeze"] = ["x"]
        return r
    return run


if __name__ == "__main__":
    unittest.main()
