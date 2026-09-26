"""The per-turn ORG STATE chart: byte-identical text, O(N) build, one render per turn.

Every agent turn renders an ORG STATE block (supervisor._org_state_parts). Its
chart was O(N^2): each rendered row called `Org.children`, which scans the whole
node table. The turn also rendered the parts twice (`org_state_chart` for the
D-223 change check, then `org_state_block`), both inside DOC_LOCK.

What this proves, on a disposable data root:
  * GOLDEN: the roster, chart and tail spans are byte-identical to the text the base
    commit rendered (tests/fixtures/org_state_chart_golden.json, generated at
    the base by `python tests/test_org_state_chart_scale.py --regenerate`) for
    three org shapes, every visibility, with and without archived agents, with
    a fixed clock and a fixed set of busy agents;
  * the turn block is the public `org_state_block` text (header aside);
  * the turn renders from an org no other lock holder can be mutating (review
    f1: never the store resident), shown by a real concurrent unsaved write;
  * one render builds ONE children index and never scans the node table per
    row; the turn path renders the parts ONCE.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import random
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "org_state_chart_golden.json"

_temp = tempfile.TemporaryDirectory(prefix="v3-chart-scale-", ignore_cleanup_errors=True)
(Path(_temp.name) / "data").mkdir()
(Path(_temp.name) / "home").mkdir()
for _k in [k for k in os.environ if k.startswith("ORGTREE_")]:
    os.environ.pop(_k)
os.environ.update(ORGTREE_DATA=str(Path(_temp.name) / "data"), HOME=str(Path(_temp.name) / "home"),
                  USERPROFILE=str(Path(_temp.name) / "home"), ORGTREE_STORE="sqlite",
                  ORGTREE_WARM="0")

sys.path.insert(0, str(ROOT / "engine" / "backend"))
sys.path.insert(0, str(ROOT))                # the `engine` package, for --regenerate runs
sys.path.insert(0, str(ROOT / "tests"))      # the runtime's ._pth omits the script dir
import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout
from orgtree import ledger, store  # noqa: E402
from orgtree import supervisor as sup  # noqa: E402

#: the fixed clock every render sees (2026-09-26T12:00:00Z)
NOW = 1790424000.0
TOOLS = {"bash": False, "edit": False, "web": False, "subagents": False, "mcp": []}


def _iso(seconds_ago: float) -> str:
    import datetime as _dt
    t = _dt.datetime.fromtimestamp(NOW - seconds_ago, _dt.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _hire(org, parent, name, vis="team"):
    org.hire(ledger.USER, parent, "opus", 0, name, add_dirs=[], tools=TOOLS,
             org_visibility=vis, charter="golden chart fixture agent")
    n = org.nodes[name]
    n["scope"]["org_visibility"] = vis
    return n


_built = [0]


def _new_org(slug):
    # a fresh slug per build (the slug never appears in the rendered spans)
    _built[0] += 1
    org = store.create_org(f"{slug}-{_built[0]}")
    org.d["max_top_grant"] = 0
    return org


def _stamp_created(org):
    # deterministic ordering keys: `created` is the tie-break after ui_order;
    # and the hire preset's status is stamped with the WALL clock, so pin it
    # to the fixed one or every age in the chart drifts between runs
    for i, k in enumerate(org.nodes):
        n = org.nodes[k]
        n["created"] = _iso(10_000_000 - i * 60)
        if isinstance(n.get("last_status"), dict):
            n["last_status"]["at"] = _iso(3000)


def build_mixed():
    """Hand-built: every branch the renderer and _status_note take."""
    org = _new_org("golden-mixed")
    _hire(org, None, "root", "full")
    _hire(org, None, "root2", "team")                      # a second top level
    _hire(org, "root", "mgr", "subtree")
    _hire(org, "root", "peer", "team")
    _hire(org, "root", "solo", "self")
    for k in ("w1", "w2", "w3", "w4"):
        _hire(org, "mgr", k, "team")
    _hire(org, "w1", "w1a", "team")
    _hire(org, "w1", "w1b", "team")
    # a subtree dead throughout (hidden when archived are excluded), with a bearer
    _hire(org, "mgr", "gone", "team")
    _hire(org, "gone", "gone-kid", "team")
    _hire(org, "gone", "gone-kid2", "team")
    # an archived manager with a LIVE child: rendered on the doubt
    _hire(org, "peer", "zombie", "team")
    _hire(org, "zombie", "zombie-live", "team")
    # bearers of every kind, a halt, and a second-level peer set
    _hire(org, "root2", "bearer-live", "team")
    _hire(org, "root2", "bearer-cons", "team")
    _hire(org, "root2", "preserver", "team")
    _hire(org, "root2", "lost", "team")
    _hire(org, "root2", "halted", "team")
    _stamp_created(org)
    nodes = org.nodes
    for k in ("gone", "gone-kid", "gone-kid2", "zombie", "bearer-cons", "preserver", "lost"):
        nodes[k]["state"] = "archived"
    nodes["gone-kid"]["bearer_state"] = "knowledge"
    nodes["bearer-cons"]["bearer_state"] = "knowledge"
    nodes["bearer-live"]["bearer_state"] = "knowledge"
    nodes["preserver"]["bearer_state"] = "preserving"
    nodes["lost"]["bearer_state"] = "lost"
    nodes["halted"]["halt"] = {"phase": "halted", "at": _iso(600)}
    # ui_order beats created
    nodes["w4"]["ui_order"] = -1
    nodes["w2"]["ui_order"] = 5
    # every _status_note branch
    nodes["w1"]["inflight"] = {"at": _iso(90), "text": "x"}          # busy (see BUSY)
    nodes["w2"]["inflight"] = {"at": _iso(7200), "text": "x"}        # died mid-turn
    nodes["w3"]["last_status"] = {"status": "working", "summary": "a  long\nsummary " * 20,
                                  "at": _iso(4 * 3600)}              # stale working
    nodes["w4"]["last_status"] = {"status": "working", "summary": "fresh", "at": _iso(30)}
    nodes["w1a"]["last_status"] = {"status": "idle", "at": _iso(86400 * 3)}
    nodes["w1b"].pop("last_status", None)
    nodes["w1b"]["prev_status"] = {"status": "done", "summary": "shipped", "at": _iso(5000)}
    nodes["peer"].pop("last_status", None)
    nodes["peer"].pop("prev_status", None)                           # no status at all
    nodes["mgr"]["last_status"] = {"status": "blocked", "summary": "waiting", "at": "not-a-date"}
    return org


def build_wide(n=300, seed=7):
    """A fan-out-8 tree with archived leaves and whole archived branches."""
    rnd = random.Random(seed)
    org = _new_org("golden-wide")
    names = []
    for i in range(n):
        parent = None if i == 0 else names[(i - 1) // 8]
        vis = ("full", "subtree", "team", "self")[i % 4] if i else "full"
        _hire(org, parent, f"n{i:03d}", vis)
        names.append(f"n{i:03d}")
    _stamp_created(org)
    for i, k in enumerate(names):
        node = org.nodes[k]
        if i and i % 7 == 0:
            node["state"] = "archived"
            if i % 14 == 0:
                node["bearer_state"] = "knowledge"
        r = rnd.random()
        if r < 0.2:
            node["last_status"] = {"status": rnd.choice(["working", "idle", "done", "blocked"]),
                                   "summary": f"task {i}", "at": _iso(rnd.randint(0, 20000))}
        elif r < 0.3:
            node["inflight"] = {"at": _iso(rnd.randint(0, 5000)), "text": "x"}
        if rnd.random() < 0.1:
            node["ui_order"] = rnd.randint(-3, 3)
    return org, names


def build_deep(n=60):
    org = _new_org("golden-deep")
    prev = None
    for i in range(n):
        _hire(org, prev, f"d{i:02d}", ("full", "subtree", "team", "self")[i % 4])
        prev = f"d{i:02d}"
    _stamp_created(org)
    org.nodes["d30"]["state"] = "archived"                # an archived node in a live chain
    return org


#: agents whose in-memory `busy` flag is set during every render
BUSY = {"w1", "n009", "n018", "d05"}


def _fake_state(slug, rid):
    return {"busy": rid in BUSY}


def render_parts(org, viewers):
    """{f'{viewer}|{archived}': {'roster', 'chart', 'tail'}} at the fixed clock."""
    out = {}
    with mock.patch("time.time", return_value=NOW), \
            mock.patch.object(sup, "state", _fake_state):
        for v in viewers:
            for arch in (False, True):
                roster, chart, tail = sup._org_state_parts(org, v, arch)
                out[f"{v}|{int(arch)}"] = {"roster": roster, "chart": chart, "tail": tail}
    return out


def _cases():
    mixed = build_mixed()
    wide, names = build_wide()
    deep = build_deep()
    return {
        "mixed": (mixed, sorted(k for k, n in mixed.nodes.items() if n["state"] == "live")),
        "wide": (wide, names[:40] + names[-10:]),
        "deep": (deep, [f"d{i:02d}" for i in range(0, 60, 3)]),
    }


def render_all():
    return {name: render_parts(org, viewers) for name, (org, viewers) in _cases().items()}


def setUpModule():
    store.claim_data_root()


class Golden(unittest.TestCase):
    def test_chart_and_roster_are_byte_identical_to_the_base_render(self):
        want = json.loads(FIXTURE.read_text(encoding="utf-8"))
        got = render_all()
        self.assertEqual(sorted(got), sorted(want["cases"]))
        compared = 0
        for case, rows in want["cases"].items():
            self.assertEqual(sorted(got[case]), sorted(rows), case)
            for key, spans in rows.items():
                with self.subTest(case=case, key=key):
                    self.assertEqual(got[case][key], spans)
                    compared += 1
        # the fixture is not vacuous: every visibility, archived hidden and shown
        self.assertGreaterEqual(compared, 160)
        charts = [s["chart"] for rows in want["cases"].values() for s in rows.values()]
        self.assertTrue(any("archived here" in c for c in charts))
        self.assertTrue(any("▶ mid-turn" in c for c in charts))
        self.assertTrue(any("never finished" in c for c in charts))
        self.assertTrue(any("knowledge bearer" in c for c in charts))
        self.assertTrue(any(c == "" for c in charts))                # self/team: no chart


class OneRenderPerTurn(unittest.TestCase):
    def setUp(self):
        self.org = build_mixed()

    def test_one_index_and_no_unindexed_scan_per_render(self):
        built = []
        scans = []
        real_index = ledger.Org.children_index
        real_children = ledger.Org.children

        def index(org_self):
            built.append(1)
            return real_index(org_self)

        def children(org_self, nid, live_only=True, index=None):
            if index is None:
                scans.append(nid)
            return real_children(org_self, nid, live_only, index)
        with mock.patch.object(ledger.Org, "children_index", index), \
                mock.patch.object(ledger.Org, "children", children), \
                mock.patch("time.time", return_value=NOW), \
                mock.patch.object(sup, "state", _fake_state):
            sup._org_state_parts(self.org, "root", False)
        self.assertEqual((len(built), scans), (1, []))

    def test_the_turn_block_renders_the_parts_once_and_matches_the_public_block(self):
        calls = []
        real = sup._org_state_parts

        def parts(*a, **k):
            calls.append(a[1])
            return real(*a, **k)
        pending: dict = {}
        with mock.patch.object(sup, "_org_state_parts", parts), \
                mock.patch("time.time", return_value=NOW), \
                mock.patch.object(sup, "state", _fake_state):
            block = sup._envelope_state_block(self.org, "root", NOW, pending)
            self.assertEqual(calls, ["root"])
            public = sup.org_state_block(self.org, "root")
        # header (timestamp and snapshot number) aside, the turn sent the full public block
        self.assertEqual(block.split("\n", 1)[1], public.split("\n", 1)[1])


class _Reached(RuntimeError):
    """Raised just past the turn's ORG STATE build."""


class TurnRendersFromADetachedOrg(unittest.TestCase):
    """review-astra f1 (2026-09-26): the turn must not render from the store's
    RESIDENT org. Under DOC_LOCK the row store hands every lock holder that same
    object, so a render that is not itself protected can publish another
    cycle's half-applied, never-saved state. This runs the real
    `_run_one_turn_recorded` up to the build and, at that instant, has a second
    thread take DOC_LOCK, write an unsaved grant into the resident and hold it
    while the block renders; the writer then abandons its change."""

    SAVED_GRANT, UNSAVED_GRANT = 56, 12345

    def setUp(self):
        self.slug = "chart-race"
        org = store.create_org(self.slug)
        org.d["max_top_grant"] = 0
        _hire(org, None, "worker", "full")
        org.nodes["worker"]["grant"] = self.SAVED_GRANT
        store.save_org(org)
        # a clean write cycle leaves a resident behind, as production does
        with store.DOC_LOCK:
            store.save_org(store.load_org(self.slug))

    def _race_then_build(self, real):
        import threading
        seen = {}

        def build(org, nid, *a, **k):
            holding, release = threading.Event(), threading.Event()

            def writer():
                if not store.DOC_LOCK.acquire(timeout=2):
                    seen["writer_blocked"] = True   # the build holds the lock: no race possible
                    return
                try:
                    w = store.load_org(self.slug)
                    seen["writer_is_render_input"] = w is org
                    w.nodes[nid]["grant"] = self.UNSAVED_GRANT
                    seen["writer_held"] = True
                    holding.set()
                    release.wait(10)
                    w.nodes[nid]["grant"] = self.SAVED_GRANT   # abandon, as the probe's writer did
                finally:
                    store.DOC_LOCK.release()
            t = threading.Thread(target=writer, daemon=True)
            t.start()
            holding.wait(3)
            try:
                seen["block"] = real(org, nid, *a, **k)
            finally:
                release.set()
                t.join(10)
            raise _Reached("past the ORG STATE build")
        return build, seen

    def test_the_turn_block_shows_the_saved_state_not_a_concurrent_unsaved_write(self):
        build, seen = self._race_then_build(sup._envelope_state_block)
        with mock.patch.object(sup, "spawn_env", return_value={}), \
                mock.patch.object(sup, "_deployment_org_gate"), \
                mock.patch.object(sup, "_envelope_state_block", side_effect=build):
            try:
                sup._run_one_turn_recorded(self.slug, "worker", "go")
            except Exception:                                  # noqa: BLE001
                pass
        self.assertIn("block", seen, "the turn never reached the ORG STATE build")
        # the race really ran (a lock holder had an unsaved write in place during
        # the render), or the render itself held DOC_LOCK so none could
        self.assertTrue(seen.get("writer_held") or seen.get("writer_blocked"),
                        "the concurrent writer neither ran nor was blocked: control is vacuous")
        self.assertFalse(seen.get("writer_is_render_input", False),
                         "the turn rendered from the resident org another lock holder mutates")
        self.assertIn(f"grant {self.SAVED_GRANT:g},", seen["block"])
        self.assertNotIn(f"grant {self.UNSAVED_GRANT:g}", seen["block"])


if __name__ == "__main__":
    if "--regenerate" in sys.argv:
        store.claim_data_root()
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        doc = {"schema": "orgtree.org-state-chart-golden/v1", "now": NOW, "busy": sorted(BUSY),
               "cases": render_all()}
        FIXTURE.write_text(json.dumps(doc, indent=1, ensure_ascii=False, sort_keys=True) + "\n",
                           encoding="utf-8", newline="\n")
        print("wrote", FIXTURE, sum(len(v) for v in doc["cases"].values()), "renders")
    else:
        unittest.main()
