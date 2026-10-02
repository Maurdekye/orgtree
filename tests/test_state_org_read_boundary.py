"""P01 F6 legacy boundary contracts for the org and agent reads (org-read.*).

Disposable SQLite only; the app's lifecycle is not started. Every case builds a fresh org under this test's temporary
data root. A node's transcript is a fixture file (supervisor.transcript_path_for_node and transcript_path point at
it); drives, notices and broadcasts are spies; the routes, the ledger, the chat projection and its sidecars, the
scratch folders and the history and event readers are real. Each case's observation is normalized (one NORM block)
and compared with docs/state-system/org-read-boundary.json, and each test pins a fact stated in
docs/state-system/operation-contracts.json (org-read.*).

This module launches no process. An audit hook installed before anything else is imported refuses and records any
process launch for the whole run (imports, the app's construction, every case).
"""
from __future__ import annotations

import sys

# ---- the no-process guard, first: any process launch is refused (before the child exists) and recorded
# _winapi.CreateProcess is the Windows launch that bypasses subprocess.Popen (multiprocessing's spawn uses it)
LAUNCH_EVENTS = ('subprocess.Popen', '_winapi.CreateProcess', 'os.system', 'os.posix_spawn', 'os.spawn',
                 'os.startfile', 'os.exec')
GUARD = {'on': True}
LAUNCHES: list = []


def _no_process(event, args):
    if GUARD['on'] and event in LAUNCH_EVENTS:
        LAUNCHES.append((event, repr(args)[:200]))
        raise RuntimeError('real process launch refused by the boundary test guard: ' + event)


sys.addaudithook(_no_process)

import base64  # noqa: E402
import copy  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
from pathlib import Path  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402
from unittest.mock import patch  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import state_operation_contracts as contracts
import inventory_scan_cache  # noqa: E402,F401 -- one shared source scan per suite run

# left for the OS to reclaim: hires create agent scratch folders under the data root
_temp = tempfile.mkdtemp(prefix='p01-org-read-boundary-')
_data = Path(_temp) / 'data'
_home = Path(_temp) / 'home'
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE_BACKEND='sqlite')
for _key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, ledger, store, supervisor  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'
assert LAUNCHES == [], LAUNCHES      # nothing above (the imports, the app's construction) tried to launch a process
OP ={'X-Orgtree-Desktop-Token': 'operator'}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SCOPE = {'add_dirs': [], 'tools': NO_TOOLS, 'org_visibility': 'team', 'charter': 'fixture'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'cases', 'legacy_defects', 'scope'}
SEQ = [0]
CUR: dict = {}
TRANSCRIPTS = Path(_temp) / 'transcripts'
TRANSCRIPTS.mkdir()
PNG = base64.b64encode(b'\x89PNG fixture bytes').decode()


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/org-read-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.org-read-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != {k for k in registry['contracts'] if k.startswith('org-read.')}:
        raise ValueError('every org-read contract is required')
    return d


# ---- NORM (verbatim from the P01 F6 probe's f6/norm.py) ----------------------------------------------------------
def norm(c, cur):
    def text(v):
        return v.replace(cur["slug"], "{slug}") if isinstance(v, str) else v
    return {
        "status": c["status"],
        "ctype": c["ctype"],
        "keys": c["keys"],
        "detail": text(c["detail"]),
        "sections": c["changed"],
        "spies": dict(sorted((c.get("spies") or {}).items())),
    }


# ---- harness (verbatim from the P01 F6 probe) --------------------------------------------------------------------
def fresh():
    SEQ[0] += 1
    org = store.create_org(f"p01-f6-{SEQ[0]}")
    slug = str(org.d["slug"])
    org.hire(ledger.USER, None, "haiku", 20, "top", add_dirs=[], tools={}, charter="fixture")
    org.hire("top", "top", "haiku", 6, "mid", **SCOPE)
    org.hire("top", "mid", "haiku", 2, "leaf", **SCOPE)
    org.d["mail"] = {}
    store.save_org(org)
    CUR["slug"] = slug
    CUR["tokens"] = {n: agentauth.child_env(slug, n)["ORGTREE_AGENT_TOKEN"] for n in ("top", "mid", "leaf")}
    CUR["transcript"] = TRANSCRIPTS / f"{slug}.jsonl"


def durable(slug):
    store._invalidate_snapshot(slug)
    store._POOL.close_all(slug)
    return json.loads(json.dumps(store.load_org(slug).d))


def changed(b, a):
    return sorted(k for k in set(b) | set(a) if b.get(k) != a.get(k))


def sidecars():
    return sorted(p.name for p in _data.iterdir() if p.is_file() and p.suffix in (".sqlite3", ".db"))


def sidecar_sizes():
    return {p.name: p.stat().st_size for p in _data.iterdir() if p.is_file() and p.suffix in (".sqlite3", ".db")}


class Spies:
    def __enter__(self):
        self.ps, self.s = [], {}

        def add(target, name, **kw):
            p = patch.object(target, name, **kw)
            self.s[name] = p.start()
            self.ps.append(p)
        add(supervisor, "send_message", return_value={"delivered": True})
        add(supervisor, "delivery_note", return_value="fixture carrier")
        add(supervisor, "notify")
        add(api, "hub_changed")
        add(api, "mail_notify")
        # the transcript of a node is the fixture file, whatever the session
        add(supervisor, "transcript_path_for_node", side_effect=lambda *a, **k: str(CUR["transcript"]))
        add(supervisor, "transcript_path", side_effect=lambda *a, **k: str(CUR["transcript"])
            if CUR["transcript"].exists() else None)
        return self

    def calls(self):
        return {k: len(m.call_args_list) for k, m in self.s.items()
                if m.call_count and k not in ("delivery_note", "transcript_path_for_node", "transcript_path")}

    def __exit__(self, *e):
        for p in reversed(self.ps):
            p.stop()


# ---- helpers -----------------------------------------------------------------------------------------------------
def op(method, path, **kw):
    def go(c):
        return c.request(method, path.format(slug=CUR["slug"]), headers=OP, **kw)
    return go


def transcript(image=True):
    def go(c):
        org = store.load_org(CUR["slug"])
        org.node("mid")["session_id"] = "11111111-2222-3333-4444-555555555555"
        store.save_org(org)
        rows = [{"type": "user", "uuid": "u-1", "timestamp": "2026-09-10T12:00:00Z",
                 "message": {"role": "user", "content": "hello"}},
                {"type": "assistant", "uuid": "a-1", "timestamp": "2026-09-10T12:00:01Z",
                 "message": {"id": "m-1", "role": "assistant",
                             "content": [{"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {}}]}},
                {"type": "user", "uuid": "u-2", "timestamp": "2026-09-10T12:00:02Z",
                 "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1",
                                                          "content": ([{"type": "image", "source": {
                                                              "type": "base64", "media_type": "image/png",
                                                              "data": PNG}}] if image else "text only")}]}},
                {"type": "assistant", "uuid": "a-2", "timestamp": "2026-09-10T12:00:03Z",
                 "message": {"id": "m-2", "role": "assistant", "content": "done"}}]
        CUR["transcript"].write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return go


def scratch(c):
    p = Path(supervisor.scratch_dir(CUR["slug"], "mid"))
    (p / "sub").mkdir(parents=True, exist_ok=True)
    (p / "notes.txt").write_text("notes", encoding="utf-8")
    (p / "sub" / "deep.txt").write_text("deep", encoding="utf-8")


def workspace(size=10):
    def go(c):
        ws = Path(_temp) / f"ws-{CUR['slug']}"
        ws.mkdir(exist_ok=True)
        (ws / "CLAUDE.md").write_text("x" * size, encoding="utf-8")
        org = store.load_org(CUR["slug"])
        org.d["workspace"] = str(ws)
        store.save_org(org)
    return go


def then(*steps):
    """Setup steps run in order before the observed call."""
    def go(c):
        for step in steps:
            step(c)
    return go


def twice(req):
    def go(c):
        req(c)
        return req(c)
    return go


CASES = [
    # chat
    ("chat_no_transcript", op("GET", "/api/orgs/{slug}/nodes/mid/chat"), None),
    ("chat_cold", op("GET", "/api/orgs/{slug}/nodes/mid/chat"), transcript()),
    ("chat_warm", op("GET", "/api/orgs/{slug}/nodes/mid/chat"),
     then(transcript(), op("GET", "/api/orgs/{slug}/nodes/mid/chat"))),
    ("chat_bad_cursor", op("GET", "/api/orgs/{slug}/nodes/mid/chat", params={"before": "garbage"}), transcript()),
    ("chat_ghost", op("GET", "/api/orgs/{slug}/nodes/ghost/chat"), None),
    # files
    ("file", op("GET", "/api/orgs/{slug}/nodes/mid/file", params={"path": "notes.txt"}), scratch),
    ("file_missing", op("GET", "/api/orgs/{slug}/nodes/mid/file", params={"path": "nope.txt"}), scratch),
    ("file_escape", op("GET", "/api/orgs/{slug}/nodes/mid/file", params={"path": "../../x"}), scratch),
    ("file_ghost", op("GET", "/api/orgs/{slug}/nodes/ghost/file", params={"path": "x"}), None),
    ("scratch_dir", op("GET", "/api/orgs/{slug}/nodes/mid/scratch"), scratch),
    ("scratch_file", op("GET", "/api/orgs/{slug}/nodes/mid/scratch", params={"path": "sub/deep.txt"}), scratch),
    ("scratch_missing", op("GET", "/api/orgs/{slug}/nodes/mid/scratch", params={"path": "nope"}), scratch),
    ("scratch_escape", op("GET", "/api/orgs/{slug}/nodes/mid/scratch", params={"path": "../.."}), scratch),
    ("scratch_ghost", op("GET", "/api/orgs/{slug}/nodes/ghost/scratch"), None),
    ("toolimg", op("GET", "/api/orgs/{slug}/nodes/mid/toolimg/toolu_1"), transcript()),
    ("toolimg_no_image", op("GET", "/api/orgs/{slug}/nodes/mid/toolimg/toolu_1"), transcript(image=False)),
    ("toolimg_no_transcript", op("GET", "/api/orgs/{slug}/nodes/mid/toolimg/toolu_1"), None),
    ("toolimg_ghost", op("GET", "/api/orgs/{slug}/nodes/ghost/toolimg/toolu_1"), None),
    # history and events
    ("node_history", op("GET", "/api/orgs/{slug}/nodes/mid/history"), None),
    ("node_history_ghost", op("GET", "/api/orgs/{slug}/nodes/ghost/history"), None),
    ("node_history_no_org", op("GET", "/api/orgs/nope-org/nodes/mid/history"), None),
    ("history_sources", op("GET", "/api/orgs/{slug}/history"), None),
    ("history_sources_no_org", op("GET", "/api/orgs/nope-org/history"), None),
    ("history_events", op("GET", "/api/orgs/{slug}/history/events"), None),
    ("history_chat", op("GET", "/api/orgs/{slug}/history/chat", params={"node": "mid"}), transcript()),
    ("history_chat_warm", op("GET", "/api/orgs/{slug}/history/chat", params={"node": "mid"}),
     then(transcript(), op("GET", "/api/orgs/{slug}/history/chat", params={"node": "mid"}))),
    ("history_node_missing", op("GET", "/api/orgs/{slug}/history/node-mail"), None),
    ("history_unknown", op("GET", "/api/orgs/{slug}/history/bogus"), None),
    ("history_bad_cursor", op("GET", "/api/orgs/{slug}/history/events", params={"cursor": "garbage"}), None),
    ("events", op("GET", "/api/orgs/{slug}/events"), None),
    ("events_last", op("GET", "/api/orgs/{slug}/events", params={"last": 2}), None),
    ("events_no_org", op("GET", "/api/orgs/nope-org/events"), None),
    # org reads
    ("orgmd_none", op("GET", "/api/orgs/{slug}/orgmd"), None),
    ("orgmd", op("GET", "/api/orgs/{slug}/orgmd"), workspace()),
    ("orgmd_long", op("GET", "/api/orgs/{slug}/orgmd"), workspace(70000)),
    ("orgmd_no_org", op("GET", "/api/orgs/nope-org/orgmd"), None),
    ("net_first", op("GET", "/api/orgs/{slug}/net"), None),
    ("net_second", op("GET", "/api/orgs/{slug}/net"), op("GET", "/api/orgs/{slug}/net")),
    ("net_no_org", op("GET", "/api/orgs/nope-org/net"), None),
    ("aggregates", op("GET", "/api/orgs/{slug}/diagnostics/aggregates"), None),
    ("aggregates_one", op("GET", "/api/orgs/{slug}/diagnostics/aggregates", params={"collections": "events"}),
     None),
    ("aggregates_bad", op("GET", "/api/orgs/{slug}/diagnostics/aggregates", params={"collections": "bogus"}),
     None),
    ("aggregates_no_org", op("GET", "/api/orgs/nope-org/diagnostics/aggregates"), None),
    # the gate
    ("agent_token", lambda c: c.get(f"/api/orgs/{CUR['slug']}/events",
                                    headers={"X-Orgtree-Agent-Token": CUR["tokens"]["mid"]}), None),
]



def observe(name):
    """Run one fixtured case on a fresh org and return its normalized observation."""
    request, pre = CASES[name]
    fresh()
    client = TestClient(app, raise_server_exceptions=False)
    with Spies() as sp:
        if pre:
            pre(client)
            for m in sp.s.values():
                m.reset_mock()
        b = durable(CUR['slug'])
        r = request(client)
        a = durable(CUR['slug'])
        ctype = r.headers.get('content-type', '')
        body = r.json() if 'json' in ctype else None
        raw = {'status': r.status_code, 'ctype': ctype.split(';')[0],
               'keys': sorted(body) if isinstance(body, dict) else ('list' if isinstance(body, list) else None),
               'detail': body.get('detail') if isinstance(body, dict) else None,
               'changed': changed(b, a), 'spies': sp.calls()}
        return norm(raw, CUR), (body if body is not None else r.content), (b, a), dict(CUR)


CASES = {n: (r, p) for n, r, p in CASES}


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        spec = boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(len(spec['contracts']), 11)
        self.assertEqual(set(spec['cases']), set(CASES))
        for d in contracts.DIMENSIONS:
            self.assertEqual(registry['facets']['org-read.' + d]['status'],
                             'unresolved' if d in ('conflicts', 'wire', 'instrumentation') else 'specified', d)

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('org-read.chat'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_every_entry_selects_exactly_its_contract_and_the_rows_are_mapped(self):
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        source = contracts.inventory.scan(ROOT)
        entries = {r['id']: r for r in registry['entries']}
        bound = {}
        for name, c in registry['contracts'].items():
            if name.startswith('org-read.'):
                for e in c['entry_ids']:
                    bound.setdefault(e, []).append(name)
                    self.assertEqual(contracts.select(registry, e, {}), [name], name)
        self.assertEqual(len(bound), 11)
        for e, names in bound.items():
            self.assertEqual((entries[e]['disposition'], entries[e]['contracts']), ('mapped', names))
        # the transcript card-rendering branches every reader of which is now contracted (rule 1)
        dispatch = {r['id']: r for r in registry['dispatch']}
        mapped = {tuple(s['values']): dispatch[contracts.witness_id('dispatch', s)]['contracts']
                  for s in source['dispatch_selectors'] if s['source']['symbol'] == '_read_chat_source'
                  and 'P01 F6' in dispatch[contracts.witness_id('dispatch', s)]['reason']}
        self.assertEqual(mapped, {('orgtree_present',): ['asks.present'], ('orgtree_send_file',): ['exchange.send-file']})


class OrgReadBoundary(unittest.TestCase):
    def setUp(self):
        self.spec = boundary()

    def check(self, *names):
        out = {}
        for name in names:
            with self.subTest(case=name):
                seen, body, docs, cur = observe(name)
                self.assertEqual(seen, self.spec['cases'][name], name)
                out[name] = (seen, body, docs, cur)
        return out

    def test_chat_reads_mint_on_the_first_read_only(self):
        got = self.check('chat_no_transcript', 'chat_cold', 'chat_warm', 'chat_bad_cursor', 'chat_ghost')
        # the first read of a node mints its reply and transcript-record incarnations; a warm read writes nothing
        self.assertEqual(got['chat_cold'][0]['sections'], ['nodes', 'reply_incarnation'])
        self.assertEqual(got['chat_warm'][0]['sections'], [])
        for sidecar in ('chat-window-index.sqlite3', 'reply-events.sqlite3', 'transcript-records.sqlite3'):
            self.assertTrue((Path(store.DATA_ROOT) / sidecar).exists(), sidecar)
        # recorded legacy defect (docket org-reads-that-write-chat-gets-mint-on-first-rea): the mint runs before the cursor check,
        # so a read refused 422 still writes
        self.assertEqual((got['chat_bad_cursor'][0]['status'], got['chat_bad_cursor'][0]['sections']),
                         (422, ['nodes', 'reply_incarnation']))

    def test_node_files_and_tool_images(self):
        got = self.check('file', 'file_missing', 'file_escape', 'file_ghost', 'scratch_dir', 'scratch_file',
                         'scratch_missing', 'scratch_escape', 'scratch_ghost', 'toolimg', 'toolimg_no_image',
                         'toolimg_no_transcript', 'toolimg_ghost')
        self.assertEqual(got['toolimg'][1], b'\x89PNG fixture bytes')
        self.assertEqual(got['file'][1], b'notes')
        self.assertEqual(sorted(e['name'] for e in got['scratch_dir'][1]['entries']), ['notes.txt', 'sub'])

    def test_history_and_events(self):
        got = self.check('node_history', 'node_history_ghost', 'node_history_no_org', 'history_sources',
                         'history_sources_no_org', 'history_events', 'history_chat', 'history_chat_warm',
                         'history_node_missing', 'history_unknown', 'history_bad_cursor', 'events', 'events_last',
                         'events_no_org')
        self.assertEqual(len(got['events_last'][1]['events']), 2)
        self.assertEqual(got['events_last'][1]['offset'], got['events_last'][1]['total'] - 2)

    def test_org_reads_and_the_network_identity_backfill(self):
        got = self.check('orgmd_none', 'orgmd', 'orgmd_long', 'orgmd_no_org', 'net_first', 'net_second',
                         'net_no_org', 'aggregates', 'aggregates_one', 'aggregates_bad', 'aggregates_no_org')
        self.assertEqual((got['orgmd_long'][1]['read_truncated'], got['orgmd_long'][1]['chars'],
                          len(got['orgmd_long'][1]['content'])), (True, 70000, 60000))
        self.assertEqual((got['orgmd_none'][1]['content'], got['orgmd_none'][1]['chars']), ('', 0))   # no CLAUDE.md yet
        # a GET that writes: the first reveal backfills the identity and hub list, later ones write nothing
        self.assertEqual(got['net_first'][0]['sections'], ['net_autoconnect', 'net_hubs', 'net_identity'])
        self.assertEqual(got['net_second'][0]['sections'], [])

    def test_the_guard_refuses_a_real_launch_before_it_happens(self):
        before = len(LAUNCHES)
        self.assertTrue(GUARD['on'])         # on for the whole module, never switched off
        with self.assertRaises(RuntimeError):
            subprocess.run([sys.executable, '-c', 'raise SystemExit(7)'], capture_output=True)
        self.assertEqual([e for e, _ in LAUNCHES[before:]], ['subprocess.Popen'])
        del LAUNCHES[before:]

    @unittest.skipUnless(os.name == 'nt', 'the Windows launch path')
    def test_the_guard_refuses_a_multiprocessing_spawn_child(self):
        import multiprocessing
        before = len(LAUNCHES)
        with self.assertRaises(RuntimeError):
            multiprocessing.get_context('spawn').Process(target=os.getpid).start()
        self.assertEqual([e for e, _ in LAUNCHES[before:]], ['_winapi.CreateProcess'])
        del LAUNCHES[before:]

    def test_an_agent_credential_is_refused(self):
        self.check('agent_token')


def tearDownModule():
    # a launch the product caught and swallowed fails no case; it still fails the module. The hook cannot be
    # removed, so it is switched off here: a single-process discover run's later modules do not inherit it.
    try:
        assert LAUNCHES == [], LAUNCHES
    finally:
        GUARD['on'] = False


if __name__ == '__main__':
    unittest.main()
