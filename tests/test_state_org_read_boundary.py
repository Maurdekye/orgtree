"""P01 F6 legacy boundary contracts for the org and agent reads (org-read.*).

Disposable SQLite only; the app's lifecycle is not started. Every case builds a fresh org under this test's temporary
data root. A node's transcript is a fixture file (supervisor.transcript_path_for_node and transcript_path point at
it); drives, notices and broadcasts are spies; the routes, the ledger, the chat projection and its sidecars, the
scratch folders and the history and event readers are real. Each case's observation is normalized (one NORM block)
and compared with docs/state-system/org-read-boundary.json, and each test pins a fact stated in
docs/state-system/operation-contracts.json (org-read.*).
"""
from __future__ import annotations

import base64
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import state_operation_contracts as contracts

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

import import_provenance  # noqa: E402,F401
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, deployment, ledger, store, supervisor  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'

OP = {'X-Orgtree-Desktop-Token': 'operator'}
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
def fresh(kiosk=False):
    SEQ[0] += 1
    org = store.create_org(f"p01-f6-{SEQ[0]}")
    slug = str(org.d["slug"])
    org.hire(ledger.USER, None, "haiku", 20, "top", add_dirs=[], tools={}, charter="fixture")
    org.hire("top", "top", "haiku", 6, "mid", **SCOPE)
    org.hire("top", "mid", "haiku", 2, "leaf", **SCOPE)
    org.d["mail"] = {}
    if kiosk:
        org.d["kiosk"] = {"enabled": True, "credits": 0, "spend_limit": 0.0, "storage_limit_mb": 0,
                          "token": "kiosk-token-fixture", "auto_raise": False,
                          "max_scope": {"tools": NO_TOOLS, "add_dirs": [], "org_visibility": "team",
                                        "permission_mode": "acceptEdits"}}
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
        add(supervisor, "maybe_storage_check")
        add(api, "hub_changed")
        add(api, "mail_notify")
        # the transcript of a node is the fixture file, whatever the session
        add(supervisor, "transcript_path_for_node", side_effect=lambda *a, **k: str(CUR["transcript"]))
        add(supervisor, "transcript_path", side_effect=lambda *a, **k: str(CUR["transcript"])
            if CUR["transcript"].exists() else None)
        return self

    def calls(self):
        return {k: len(m.call_args_list) for k, m in self.s.items()
                if m.call_count and k not in ("delivery_note", "maybe_storage_check", "transcript_path_for_node",
                                              "transcript_path")}

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


def fake_disk(c):
    org = store.load_org(CUR["slug"])
    org.d["disk"] = {"size_mb": 1024}
    store.save_org(org)


def frozen(req):
    def go(c):
        with patch.object(api.deployment, "current_policy", return_value=deployment.FROZEN):
            loop = TestClient(app, raise_server_exceptions=False, client=("127.0.0.1", 50000))
            return req(loop)
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
    ("chat_no_transcript", op("GET", "/api/orgs/{slug}/nodes/mid/chat"), None, False),
    ("chat_cold", op("GET", "/api/orgs/{slug}/nodes/mid/chat"), transcript(), False),
    ("chat_warm", op("GET", "/api/orgs/{slug}/nodes/mid/chat"),
     then(transcript(), op("GET", "/api/orgs/{slug}/nodes/mid/chat")), False),
    ("chat_bad_cursor", op("GET", "/api/orgs/{slug}/nodes/mid/chat", params={"before": "garbage"}), transcript(), False),
    ("chat_ghost", op("GET", "/api/orgs/{slug}/nodes/ghost/chat"), None, False),
    # files
    ("file", op("GET", "/api/orgs/{slug}/nodes/mid/file", params={"path": "notes.txt"}), scratch, False),
    ("file_missing", op("GET", "/api/orgs/{slug}/nodes/mid/file", params={"path": "nope.txt"}), scratch, False),
    ("file_escape", op("GET", "/api/orgs/{slug}/nodes/mid/file", params={"path": "../../x"}), scratch, False),
    ("file_ghost", op("GET", "/api/orgs/{slug}/nodes/ghost/file", params={"path": "x"}), None, False),
    ("scratch_dir", op("GET", "/api/orgs/{slug}/nodes/mid/scratch"), scratch, False),
    ("scratch_file", op("GET", "/api/orgs/{slug}/nodes/mid/scratch", params={"path": "sub/deep.txt"}), scratch, False),
    ("scratch_missing", op("GET", "/api/orgs/{slug}/nodes/mid/scratch", params={"path": "nope"}), scratch, False),
    ("scratch_escape", op("GET", "/api/orgs/{slug}/nodes/mid/scratch", params={"path": "../.."}), scratch, False),
    ("scratch_ghost", op("GET", "/api/orgs/{slug}/nodes/ghost/scratch"), None, False),
    ("toolimg", op("GET", "/api/orgs/{slug}/nodes/mid/toolimg/toolu_1"), transcript(), False),
    ("toolimg_no_image", op("GET", "/api/orgs/{slug}/nodes/mid/toolimg/toolu_1"), transcript(image=False), False),
    ("toolimg_no_transcript", op("GET", "/api/orgs/{slug}/nodes/mid/toolimg/toolu_1"), None, False),
    ("toolimg_ghost", op("GET", "/api/orgs/{slug}/nodes/ghost/toolimg/toolu_1"), None, False),
    # history and events
    ("node_history", op("GET", "/api/orgs/{slug}/nodes/mid/history"), None, False),
    ("node_history_ghost", op("GET", "/api/orgs/{slug}/nodes/ghost/history"), None, False),
    ("node_history_no_org", op("GET", "/api/orgs/nope-org/nodes/mid/history"), None, False),
    ("history_sources", op("GET", "/api/orgs/{slug}/history"), None, False),
    ("history_sources_no_org", op("GET", "/api/orgs/nope-org/history"), None, False),
    ("history_events", op("GET", "/api/orgs/{slug}/history/events"), None, False),
    ("history_chat", op("GET", "/api/orgs/{slug}/history/chat", params={"node": "mid"}), transcript(), False),
    ("history_chat_warm", op("GET", "/api/orgs/{slug}/history/chat", params={"node": "mid"}),
     then(transcript(), op("GET", "/api/orgs/{slug}/history/chat", params={"node": "mid"})), False),
    ("history_node_missing", op("GET", "/api/orgs/{slug}/history/node-mail"), None, False),
    ("history_unknown", op("GET", "/api/orgs/{slug}/history/bogus"), None, False),
    ("history_bad_cursor", op("GET", "/api/orgs/{slug}/history/events", params={"cursor": "garbage"}), None, False),
    ("events", op("GET", "/api/orgs/{slug}/events"), None, False),
    ("events_last", op("GET", "/api/orgs/{slug}/events", params={"last": 2}), None, False),
    ("events_no_org", op("GET", "/api/orgs/nope-org/events"), None, False),
    # org reads
    ("orgmd_none", op("GET", "/api/orgs/{slug}/orgmd"), None, False),
    ("orgmd", op("GET", "/api/orgs/{slug}/orgmd"), workspace(), False),
    ("orgmd_long", op("GET", "/api/orgs/{slug}/orgmd"), workspace(70000), False),
    ("orgmd_no_org", op("GET", "/api/orgs/nope-org/orgmd"), None, False),
    ("net_first", op("GET", "/api/orgs/{slug}/net"), None, False),
    ("net_second", op("GET", "/api/orgs/{slug}/net"), op("GET", "/api/orgs/{slug}/net"), False),
    ("net_kiosk", op("GET", "/api/orgs/{slug}/net"), None, True),
    ("net_no_org", op("GET", "/api/orgs/nope-org/net"), None, False),
    ("bridge_standard", op("GET", "/api/orgs/{slug}/bridge-credential"), None, False),
    ("bridge_frozen", frozen(op("GET", "/api/orgs/{slug}/bridge-credential")), None, False),
    ("bridge_frozen_no_org", frozen(op("GET", "/api/orgs/nope-org/bridge-credential")), None, False),
    ("aggregates", op("GET", "/api/orgs/{slug}/diagnostics/aggregates"), None, False),
    ("aggregates_one", op("GET", "/api/orgs/{slug}/diagnostics/aggregates", params={"collections": "events"}),
     None, False),
    ("aggregates_bad", op("GET", "/api/orgs/{slug}/diagnostics/aggregates", params={"collections": "bogus"}),
     None, False),
    ("aggregates_no_org", op("GET", "/api/orgs/nope-org/diagnostics/aggregates"), None, False),
    # the org disk
    ("disk_none", op("GET", "/api/orgs/{slug}/disk"), None, False),
    ("disk_dir_none", op("GET", "/api/orgs/{slug}/disk/dir"), None, False),
    ("disk_file_none", op("GET", "/api/orgs/{slug}/disk/file", params={"path": "home/x"}), None, False),
    ("disk_fake", op("GET", "/api/orgs/{slug}/disk"), fake_disk, False),
    ("disk_dir_fake", op("GET", "/api/orgs/{slug}/disk/dir"), fake_disk, False),
    ("disk_dir_escape", op("GET", "/api/orgs/{slug}/disk/dir", params={"path": "../x"}), fake_disk, False),
    ("disk_file_escape", op("GET", "/api/orgs/{slug}/disk/file", params={"path": "../x"}), fake_disk, False),
    ("disk_file_missing", op("GET", "/api/orgs/{slug}/disk/file", params={"path": "home/none.txt"}), fake_disk, False),
    ("disk_no_org", op("GET", "/api/orgs/nope-org/disk"), None, False),
    # the gate
    ("agent_token", lambda c: c.get(f"/api/orgs/{CUR['slug']}/events",
                                    headers={"X-Orgtree-Agent-Token": CUR["tokens"]["mid"]}), None, False),
]



def observe(name):
    """Run one fixtured case on a fresh org and return its normalized observation."""
    request, pre, kiosk = CASES[name]
    fresh(kiosk)
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


CASES = {n: (r, p, k) for n, r, p, k in CASES}


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        spec = boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(len(spec['contracts']), 15)
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
        self.assertEqual(len(bound), 15)
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
        # recorded legacy defect: the mint runs before the cursor check, so a read refused 422 still writes
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
        got = self.check('orgmd_none', 'orgmd', 'orgmd_long', 'orgmd_no_org', 'net_first', 'net_second', 'net_kiosk',
                         'net_no_org', 'aggregates', 'aggregates_one', 'aggregates_bad', 'aggregates_no_org')
        self.assertEqual((got['orgmd_long'][1]['read_truncated'], got['orgmd_long'][1]['chars'],
                          len(got['orgmd_long'][1]['content'])), (True, 70000, 60000))
        self.assertEqual((got['orgmd_none'][1]['content'], got['orgmd_none'][1]['chars']), ('', 0))   # no CLAUDE.md yet
        # a GET that writes: the first reveal backfills the identity and hub list, later ones write nothing
        self.assertEqual(got['net_first'][0]['sections'], ['net_autoconnect', 'net_hubs', 'net_identity'])
        self.assertEqual(got['net_second'][0]['sections'], [])
        self.assertEqual(got['net_kiosk'][1], {'identity': None, 'hubs': [], 'autoconnect': False})

    def test_bridge_credential_per_deployment_profile_and_the_org_disk(self):
        self.check('bridge_standard', 'bridge_frozen', 'bridge_frozen_no_org', 'disk_none', 'disk_dir_none',
                   'disk_file_none', 'disk_fake', 'disk_dir_fake', 'disk_dir_escape', 'disk_file_escape',
                   'disk_file_missing', 'disk_no_org', 'agent_token')


if __name__ == '__main__':
    unittest.main()
