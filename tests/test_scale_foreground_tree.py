"""The scale harness's copy of App's selected-tree read (ui_hooks.ForegroundTree)."""
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/scale"))
import ui_hooks
from ui_hooks import ForegroundTree, WindowDriver

BASE = "/api/orgs/test/foreground-tree"
PILES = "piles=1&fronts=%7B%7D"


def node(nid, state="live", children=(), hidden=0, parent=None):
    return dict(id=nid, state=state, children=list(children), hidden_retired_children=hidden,
                parent=parent, axis="org", lineage_loaded=False)


def snapshot(revision="r1", catalog="c1", nodes=None, roots=("lead",), hidden_roots=0):
    nodes = nodes or {"lead": node("lead", children=["gone"]), "gone": node("gone", "archived", parent="lead")}
    return dict(format=ui_hooks.FOREGROUND_FORMAT, kind="snapshot", revision=revision, catalog_revision=catalog,
                org_rev=1, sync_rev=1, roots=list(roots), nodes=nodes,
                header=dict(hidden_retired_roots=hidden_roots), missing_requested=[])


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
    def test_one_piles_read_then_one_conditional_read_and_no_child_pages(self):
        server = Server({BASE: [reply(200, snapshot(), "e1"),
                                reply(304, headers={"x-orgtree-catalog-rev": "c1"})]})
        tree = ForegroundTree("test")
        legacy = lambda: self.fail("no legacy read expected")
        tree.read(server, legacy, legacy)
        self.assertEqual([(r, u) for r, u, _ in server.sent], [("org_tree", BASE + "?" + PILES)])
        self.assertEqual(tree.plan, ([], "c1"))
        server.sent.clear()
        tree.read(server, legacy, legacy)
        self.assertEqual(server.sent, [("org_tree", BASE + "?" + PILES, "e1")])

    def test_desk_includes_travel_with_the_piles_read(self):
        server = Server({BASE: [reply(200, snapshot(), "e1")]})
        ForegroundTree("test", ["b", "a"]).read(server, lambda: self.fail("full"), lambda: self.fail("held"))
        self.assertEqual(server.sent, [("org_tree", BASE + "?include=a&include=b&" + PILES, None)])

    def test_compatibility_uses_legacy_and_holds_it_for_the_inferred_window(self):
        server = Server({BASE: [reply(404, {"detail": "no route"})]})
        tree, calls = ForegroundTree("test"), []
        tree.read(server, lambda: calls.append("full"), lambda: calls.append("held"))
        tree.read(server, lambda: calls.append("full"), lambda: calls.append("held"))
        self.assertEqual(calls, ["full", "held"], "first fallback is the full read; held reads follow")
        self.assertEqual(len(server.sent), 1, "the inferred compatibility answer is remembered")
        self.assertAlmostEqual(tree.unavailable_until - ui_hooks.time.time(), 30, delta=2)

    def test_delta_applies_only_to_its_exact_base_and_changed_catalog_replans(self):
        flat = {"lead": node("lead")}
        delta = dict(snapshot("r2", nodes={}), kind="delta", base="r1", removed=[],
                     nodes={"lead": {"set": {"state": "live"}, "unset": []},
                            "new": {"set": node("new", parent="lead"), "unset": []}},
                     header={"set": {}, "unset": []})
        server = Server({BASE: [reply(200, snapshot(nodes=flat), "e1"), reply(200, delta, "e2"),
                                reply(200, snapshot("r3", "c2", nodes=flat), "e3")]})
        tree = ForegroundTree("test")
        tree.read(server, lambda: self.fail("full"), lambda: self.fail("held"))
        tree.read(server, lambda: self.fail("full"), lambda: self.fail("held"))
        self.assertEqual(sorted(tree.snapshot["nodes"]), ["lead", "new"])
        self.assertEqual([e for _, _, e in server.sent], [None, "e1"])
        tree.read(server, lambda: self.fail("full"), lambda: self.fail("held"))
        self.assertEqual(tree.plan, ([], "c2"), "a changed catalog re-plans from explicit targets")
        self.assertEqual(len(server.sent), 3, "the server re-resolved the piles: no second read")

    def driver_with(self, answer):
        """A real WindowDriver whose HTTP client answers by URL and records headers."""
        sent = []

        def get(url, headers):
            sent.append((url, headers.get("If-None-Match")))
            return answer(url)
        client = SimpleNamespace(get=get, close=lambda: None)
        with patch("httpx.Client", return_value=client):
            driver = WindowDriver("test", "worker", 0, "http://localhost", {},
                                  SimpleNamespace(write=lambda name, row: None), threading.Event())
        driver.started = 1
        self.addCleanup(driver.pool.shutdown)
        return driver, sent

    def read(self, driver, times):
        for _ in range(times):
            driver.clock.active["org_tree"] += 1
            driver.fetch(driver.clock.specs["org_tree"], 1)

    def test_over_128_requested_pays_the_full_uncached_history_every_read(self):
        # Review f3: getCompleteTree carries no usable cache between reads.
        legacy = "/api/orgs/test?view=delta"
        driver, sent = self.driver_with(lambda url: reply(200, {"roots": []}, "L1"))
        driver.tree_view = ForegroundTree("test", [f"id{i}" for i in range(129)])
        driver.cache["org_tree"].etag = "stale"            # even a warm legacy cache is dropped
        self.read(driver, 3)
        self.assertEqual(sent, [(legacy, "stale"), (legacy, None), (legacy, None)])
        self.assertIsNone(driver.tree_view.plan)

    def test_compatibility_first_read_is_full_then_held_reads_are_conditional(self):
        legacy = "/api/orgs/test?view=delta"
        driver, sent = self.driver_with(lambda url: reply(404, {"detail": "none"}) if "foreground" in url
                                        else reply(200, {"roots": []}, "L1"))
        self.read(driver, 3)
        self.assertEqual(sent, [(BASE + "?" + PILES, None), (legacy, None), (legacy, None), (legacy, "L1")])

    def test_two_resets_fall_back_after_exactly_two_foreground_reads(self):
        server = Server({BASE: [reply(409, {"kind": "reset"}), reply(409, {"kind": "reset"})]})
        tree, calls = ForegroundTree("test"), []
        tree.read(server, lambda: calls.append("full"), lambda: calls.append("held"))
        self.assertEqual(len(server.sent), 2)
        self.assertEqual(calls, ["full"])
        self.assertEqual(tree.unavailable_until, 0., "a reset is not a compatibility answer")

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
        self.assertEqual([r["url"] for _, r in rows], [BASE + "?" + PILES, "<tree read>"])
        self.assertIn("boundary", rows[-1][1]["err"])
        self.assertEqual(driver.clock.active["org_tree"], 0)

    def test_a_metadata_frame_keeps_the_selected_trees_etag(self):
        # App's patchedTreeCache fences only the full-tree cache. Dropping the
        # selected tree's ETag here made every read after a cache_forecast or
        # MCP frame an unconditional 6.9 MB snapshot at N1000 (attempt 9).
        driver, sent = self.driver_with(lambda url: reply(200, snapshot(), "e1") if not sent[:-1]
                                        else reply(304, headers={"x-orgtree-catalog-rev": "c1"}))
        self.read(driver, 1)
        for kind in ("cache_forecast", "mcp_tool_count", "mcp_readiness"):
            driver.event(dict(type="node_stream", node="worker", kind=kind))
        self.read(driver, 1)
        self.assertEqual([etag for _, etag in sent], [None, "e1"])


if __name__ == "__main__":
    unittest.main()
