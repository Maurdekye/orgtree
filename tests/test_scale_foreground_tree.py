"""The scale harness's copy of App's selected-tree read (ui_hooks.ForegroundTree)."""
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/scale"))
import ui_hooks
from ui_hooks import ForegroundTree, WindowDriver, visible_parents

BASE = "/api/orgs/test/foreground-tree"


def node(nid, state="live", children=(), hidden=0, parent=None):
    return dict(id=nid, state=state, children=list(children), hidden_retired_children=hidden,
                parent=parent, axis="org", lineage_loaded=False)


def snapshot(revision="r1", catalog="c1", nodes=None, roots=("lead",), hidden_roots=0):
    nodes = nodes or {"lead": node("lead", children=["gone"]), "gone": node("gone", "archived", parent="lead")}
    return dict(format=ui_hooks.FOREGROUND_FORMAT, kind="snapshot", revision=revision, catalog_revision=catalog,
                org_rev=1, sync_rev=1, roots=list(roots), nodes=nodes,
                header=dict(hidden_retired_roots=hidden_roots), missing_requested=[])


def page(matches, catalog="c1"):
    return dict(format=ui_hooks.FOREGROUND_FORMAT, kind="page", revision="p", catalog_revision=catalog,
                org_rev=1, sync_rev=1, nodes={m: node(m, "archived") for m in matches},
                matches=list(matches), next_cursor=None)


def reply(status, body=None, etag=None, headers=None):
    text = json.dumps(body) if body is not None else "<html>"
    return SimpleNamespace(status_code=status, is_success=200 <= status < 300, text=text,
                           content=text.encode(), num_bytes_downloaded=len(text),
                           headers={**({"etag": etag} if etag else {}), **(headers or {})},
                           json=lambda: json.loads(text), raise_for_status=lambda: None)


class Server:
    """Answers by URL prefix; records every request exactly as sent."""
    def __init__(self, answers):
        self.answers, self.sent = answers, []

    def __call__(self, route, url, etag):
        self.sent.append((route, url, etag))
        for prefix, queue in self.answers.items():
            if url.startswith(prefix):
                return queue.pop(0)
        raise AssertionError("unexpected request " + url)


class ForegroundTreeControls(unittest.TestCase):
    def test_plan_reads_both_pile_edges_then_one_conditional_read(self):
        server = Server({BASE + "/children": [reply(200, page(["g1"])), reply(200, page(["gone"]))],
                         BASE: [reply(200, snapshot(), "e1"), reply(200, snapshot("r2"), "e2"),
                                reply(304, headers={"x-orgtree-catalog-rev": "c1"})]})
        tree = ForegroundTree("test")
        legacy = lambda: self.fail("no legacy read expected")
        tree.read(server, legacy)
        self.assertEqual([(r, u) for r, u, _ in server.sent], [
            ("org_tree", BASE), ("org_tree_page", BASE + "/children?parent=lead&limit=1"),
            ("org_tree_page", BASE + "/children?parent=lead&limit=1&edge=last"),
            ("org_tree", BASE + "?include=g1&include=gone")])
        self.assertEqual(tree.plan, (["g1", "gone"], "c1"))
        server.sent.clear()
        tree.read(server, legacy)
        self.assertEqual(server.sent, [("org_tree", BASE + "?include=g1&include=gone", "e2")])

    def test_compatibility_uses_legacy_and_holds_it_for_the_inferred_window(self):
        server = Server({BASE: [reply(404, {"detail": "no route"})]})
        tree, calls = ForegroundTree("test"), []
        tree.read(server, lambda: calls.append("legacy"))
        tree.read(server, lambda: calls.append("legacy"))
        self.assertEqual(calls, ["legacy", "legacy"])
        self.assertEqual(len(server.sent), 1, "the inferred compatibility answer is remembered")
        self.assertAlmostEqual(tree.unavailable_until - ui_hooks.time.time(), 30, delta=2)

    def test_delta_applies_only_to_its_exact_base_and_changed_catalog_replans(self):
        flat = {"lead": node("lead")}
        delta = dict(snapshot("r2", nodes={}), kind="delta", base="r1", removed=[],
                     nodes={"lead": {"set": {"state": "live"}, "unset": []},
                            "new": {"set": node("new", parent="lead"), "unset": []}},
                     header={"set": {}, "unset": []})
        server = Server({BASE: [reply(200, snapshot(nodes=flat), "e1"), reply(200, delta, "e2"),
                                reply(200, snapshot("r3", "c2", nodes=flat), "e3"), reply(304), reply(304)]})
        tree = ForegroundTree("test")
        # A first plan always re-reads (App does too); here that re-read is the delta.
        tree.read(server, lambda: self.fail("legacy"))
        self.assertEqual(sorted(tree.snapshot["nodes"]), ["lead", "new"])
        self.assertEqual([e for _, _, e in server.sent], [None, "e1"])
        tree.read(server, lambda: self.fail("legacy"))
        self.assertEqual(tree.plan, ([], "c2"), "a changed catalog re-plans from explicit targets")
        self.assertEqual(len(server.sent), 5)

    def test_visible_parents_follow_only_the_front_of_each_pile(self):
        nodes = {"lead": node("lead", children=["a", "b"]), "a": node("a", "archived", ["x"]),
                 "b": node("b", "archived", ["y"]), "x": node("x"), "y": node("y", hidden=2)}
        self.assertEqual(visible_parents(snapshot(nodes=nodes)), ["lead", "y"], "b holds no pile; y has two hidden retirees")

    def test_driver_records_every_request_and_fails_closed_on_a_bad_answer(self):
        rows = []
        recorder = SimpleNamespace(write=lambda name, row: rows.append((name, row)))
        client = SimpleNamespace(get=lambda url, headers: reply(200, {"format": "wrong"}), close=lambda: None)
        with patch("httpx.Client", return_value=client):
            driver = WindowDriver("test", "worker", 1, "http://localhost", {}, recorder, threading.Event())
        driver.started = 1
        driver.clock.active["org_tree"] = 1
        try:
            driver.fetch(driver.clock.specs["org_tree"], 1)
        finally:
            driver.pool.shutdown()
        self.assertEqual([r["url"] for _, r in rows], [BASE, "<tree read>"])
        self.assertIn("boundary", rows[-1][1]["err"])
        self.assertEqual(driver.clock.active["org_tree"], 0)


if __name__ == "__main__":
    unittest.main()
