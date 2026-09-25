"""P01 F4 legacy boundary contracts for mail, inbox, files and external chat (exchange.*).

Disposable SQLite only; the app's lifecycle is not started. Every case builds a fresh pair of orgs (main and other,
the other optionally a kiosk) under this test's temporary data root. The drives (supervisor.send_message), the
sparks, notices, broadcasts and the mail-hub kick are spies; the routes, the ledger, the org inbox, the machine-wide
extern-peers.json sighting file, the file-deliveries sidecar, the compose stage and the agents' scratch folders are
real. Each case's observation is normalized (one NORM block) and compared with
docs/state-system/exchange-boundary.json, and each test pins a fact stated in
docs/state-system/operation-contracts.json (exchange.*).
"""
from __future__ import annotations

import copy
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import state_operation_contracts as contracts

# left for the OS to reclaim: hires create agent scratch folders under the data root
_temp = tempfile.mkdtemp(prefix='p01-exchange-boundary-')
_data = Path(_temp) / 'data'
_home = Path(_temp) / 'home'
_data.mkdir()
_home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home), USERPROFILE=str(_home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE_BACKEND='sqlite', ORGTREE_EXTERN_ID='probe.peer')
for _key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_key, None)

import import_provenance  # noqa: E402,F401
from engine.launch import load_app  # noqa: E402
app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, externtool, ledger, opreceipts, store, supervisor  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'

OP = {'X-Orgtree-Desktop-Token': 'operator'}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SCOPE = {'add_dirs': [], 'tools': NO_TOOLS, 'org_visibility': 'team', 'charter': 'fixture'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'cases', 'externtool', 'legacy_defects',
          'scope'}
SEQ = [0]
CUR: dict = {}
BIG = Path(_temp) / 'big.bin'
SMALL = Path(_temp) / 'note.txt'
SMALL.write_text('fixture attachment', encoding='utf-8')


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/exchange-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.exchange-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != {k for k in registry['contracts'] if k.startswith('exchange.')}:
        raise ValueError('every exchange contract is required')
    return d


# ---- NORM (verbatim from the P01 F4 probe's f4/norm.py) ----------------------------------------------------------
def norm(c, cur):
    def text(v):
        if not isinstance(v, str):
            return v
        v = re.sub(r"[A-Za-z]:[\\/][^'\"]*", "<path>", v)
        return v.replace(cur["other"], "{other}").replace(cur["slug"], "{slug}")
    files = {n: sorted(re.sub(r"delivery-[0-9a-f]{64}", "delivery-*", f) for f in fs)
             for n, fs in (c.get("files_new") or {}).items()}
    mb, ma = c["machine_before"], c["machine_after"]
    return {
        "status": c["status"],
        "keys": c["keys"],
        "detail": text(c["detail"]),
        "sections": c["changed"],
        "sections_other": c["changed_other"],
        "files": files,
        "peer_seen": ma["peers"].get("@mcp:" + cur["peer"]) != mb["peers"].get("@mcp:" + cur["peer"]),
        "deliveries_added": len(set(ma["deliveries"]) - set(mb["deliveries"])),
        "stage_added": len(set(ma["stage"]) - set(mb["stage"])),
        "spies": {k: len(v) for k, v in sorted((c.get("spies") or {}).items())},
    }


# ---- harness (verbatim from the P01 F4 probe) --------------------------------------------------------------------
def fresh(kiosk_other=False):
    SEQ[0] += 1
    orgs = {}
    for role in ("main", "other"):
        org = store.create_org(f"p01-f4-{role}-{SEQ[0]}")
        slug = str(org.d["slug"])
        org.hire(ledger.USER, None, "haiku", 20, "top", add_dirs=[], tools={}, charter="fixture")
        org.hire("top", "top", "haiku", 6, "mid", **SCOPE)
        org.hire("top", "mid", "haiku", 2, "leaf", **SCOPE)
        org.hire(ledger.USER, None, "haiku", 5, "top2", add_dirs=[], tools={}, charter="fixture")
        org.d["mail"] = {}
        if role == "other" and kiosk_other:
            org.d["kiosk"] = {"enabled": True, "credits": 0, "spend_limit": 0.0, "storage_limit_mb": 0,
                              "token": "kiosk-token-fixture", "auto_raise": False,
                              # a ceiling already set: without one every cold load mints a new ceiling notice
                              # (docket a-kiosk-config-without-a-ceiling-mints-a-new-per), noise here
                              "max_scope": {"tools": NO_TOOLS, "add_dirs": [], "org_visibility": "team",
                                            "permission_mode": "acceptEdits"}}
        store.save_org(org)
        orgs[role] = slug
    CUR["slug"], CUR["other"] = orgs["main"], orgs["other"]
    CUR["peer"] = f"probe.p{SEQ[0]}"     # one peer per case: the extern scans read EVERY org on the machine
    CUR["tokens"] = {n: agentauth.child_env(orgs["main"], n)["ORGTREE_AGENT_TOKEN"] for n in ("top", "mid", "leaf")}


def durable(slug):
    store._invalidate_snapshot(slug)
    store._POOL.close_all(slug)
    return json.loads(json.dumps(store.load_org(slug).d))


def changed(b, a):
    return sorted(k for k in set(b) | set(a) if b.get(k) != a.get(k))


def files_under(root):
    out = []
    if root.exists():
        for p in sorted(root.rglob("*")):
            if p.is_file():
                out.append(str(p.relative_to(root)).replace("\\", "/"))
    return out


def machine():
    peers = _data / "extern-peers.json"
    deliveries = []
    db = _data / "file-deliveries.db"
    if db.exists():
        c = sqlite3.connect(db)
        try:
            deliveries = [r[0][:12] for r in c.execute("SELECT id FROM deliveries")]
        finally:
            c.close()
    return {"peers": json.loads(peers.read_text(encoding="utf-8")) if peers.exists() else {},
            "deliveries": deliveries, "stage": files_under(_data / "net_stage")}


def scratch_files(slug):
    return {n: files_under(Path(supervisor.scratch_dir(slug, n))) for n in ("top", "mid", "leaf", "top2")}


class Spies:
    def __enter__(self):
        self.ps, self.s = [], {}

        def add(target, name, **kw):
            p = patch.object(target, name, **kw)
            self.s[name] = p.start()
            self.ps.append(p)
        add(supervisor, "send_message", return_value={"delivered": True})
        add(supervisor, "delivery_note", return_value="fixture carrier")
        add(supervisor, "mail_spark")
        add(supervisor, "notify")
        add(supervisor, "maybe_storage_check")
        add(supervisor, "workspace_usage_cached", return_value=None)
        add(api, "hub_changed")
        add(api, "mail_notify")
        add(api.net, "kick")
        return self

    def calls(self):
        return {k: [[repr(x)[:50] for x in c.args[:3]] for c in m.call_args_list]
                for k, m in self.s.items() if m.call_count and k not in ("delivery_note", "maybe_storage_check",
                                                                         "workspace_usage_cached")}

    def __exit__(self, *e):
        for p in reversed(self.ps):
            p.stop()


# ---- request helpers ----------------------------------------------------------------------------------------------
def fill(v):
    if isinstance(v, str):
        return v.format(slug=CUR["slug"], other=CUR["other"], peer=CUR["peer"])
    if isinstance(v, dict):
        return {k: fill(x) for k, x in v.items()}
    if isinstance(v, list):
        return [fill(x) for x in v]
    return v


def op(method, path, **kw):
    def go(c):
        extra = {k: (fill(v) if k in ("json", "params") else v) for k, v in kw.items()}
        return c.request(method, fill(path), headers=OP, **extra)
    return go


def conflict(c):
    agent("orgtree_send_file", {"path": "report.txt", "delivery_id": DID})(c)
    return agent("orgtree_send_file", {"path": "other.txt", "delivery_id": DID})(c)


def agent(tool, args, actor="mid"):
    def go(c):
        return c.post("/api/agent", json=dict(org=CUR["slug"], node=actor, tool=tool, args=args),
                      headers={"X-Orgtree-Agent-Token": CUR["tokens"][actor]})
    return go


def keyed(tool, args, actor="mid"):
    def go(c):
        k = opreceipts.mint_key()
        h = {"X-Orgtree-Agent-Token": CUR["tokens"][actor]}
        ep = c.post("/api/agent", json=dict(org=CUR["slug"], node=actor, tool=opreceipts.OP_EPOCH, args={}),
                    headers=h).json()["epoch"]
        return c.post("/api/agent", json=dict(org=CUR["slug"], node=actor, tool=opreceipts.OP_CALL,
                                              args=dict(tool=tool, args=args, op_key=k, op_epoch=ep)), headers=h)
    return go


def twice(req):
    def go(c):
        req(c)
        return req(c)
    return go


# ---- fixture states -----------------------------------------------------------------------------------------------
def org_reply(c):
    """The org answers the peer: an 'out' entry to @mcp:<peer>, after the peer's own inbound."""
    op("POST", "/api/extern/{peer}/send", json={"org": CUR["slug"], "body": "question one"})(c)
    org = store.load_org(CUR["slug"])
    org._org_inbox_log("out", f"@mcp:{CUR['peer']}", "answer one", by="top")
    store.save_org(org)


def user_mail(c):
    org = store.load_org(CUR["slug"])
    org.post_mail("top", ledger.USER, "hello user")
    store.save_org(org)


def pending_mail(c):
    org = store.load_org(CUR["slug"])
    org.post_mail("top", "mid", "pending for mid")
    store.save_org(org)
    CUR["mid_mail"] = [m["id"] for m in store.load_org(CUR["slug"]).d["mail"]["mid"]][-1]


def staged(c):
    r = c.post(f"/api/orgs/{CUR['slug']}/org_inbox/upload?name=note.txt", content=b"staged bytes", headers=OP)
    CUR["stage"] = r.json()["id"]


def scratch_file(c):
    p = Path(supervisor.scratch_dir(CUR["slug"], "mid"))
    p.mkdir(parents=True, exist_ok=True)
    (p / "report.txt").write_text("report", encoding="utf-8")
    (p / "other.txt").write_text("other", encoding="utf-8")


def storage_blocked(c):
    org = store.load_org(CUR["slug"])
    org.d["storage_blocked"] = True
    store.save_org(org)


def dyn(fn):
    return lambda c: fn()(c)


def big_file():
    if not BIG.exists():
        with open(BIG, "wb") as f:
            f.truncate(25 * 1048576 + 1)
    return BIG


DID = "f4-delivery-0001"
CASES = [
    # GET /api/orgs (moved into F4) and the external-chat routes
    ("orgs_list", op("GET", "/api/orgs"), None, True),
    ("extern_send", op("POST", "/api/extern/{peer}/send", json={"org": "{slug}", "body": "hi"}), None, False),
    ("extern_send_empty", op("POST", "/api/extern/{peer}/send", json={"org": "{slug}", "body": "  "}), None, False),
    ("extern_send_bad_peer", op("POST", "/api/extern/bad!peer/send", json={"org": "{slug}", "body": "hi"}), None, False),
    ("extern_send_no_org", op("POST", "/api/extern/{peer}/send", json={"org": "nope-org", "body": "hi"}), None, False),
    ("extern_send_kiosk", op("POST", "/api/extern/{peer}/send", json={"org": "{other}", "body": "hi"}), None, True),
    ("extern_send_att", dyn(lambda: op("POST", "/api/extern/{peer}/send",
                                       json={"org": CUR["slug"], "body": "file", "attachments": [str(SMALL)]})),
     None, False),
    ("extern_send_att_missing", op("POST", "/api/extern/{peer}/send",
                                   json={"org": "{slug}", "body": "x", "attachments": ["C:/nope/missing.txt"]}),
     None, False),
    ("extern_send_att_big", dyn(lambda: op("POST", "/api/extern/{peer}/send",
                                           json={"org": CUR["slug"], "body": "x", "attachments": [str(big_file())]})),
     None, False),
    ("extern_messages", op("GET", "/api/extern/{peer}/messages"), org_reply, False),
    ("extern_messages_org", dyn(lambda: op("GET", "/api/extern/{peer}/messages", params={"org": CUR["other"]})),
     org_reply, False),
    ("extern_messages_none", op("GET", "/api/extern/{peer}/messages"), None, False),
    ("extern_wait_ready", op("GET", "/api/extern/{peer}/wait", params={"timeout": 1}), org_reply, False),
    ("extern_wait_timeout", op("GET", "/api/extern/{peer}/wait", params={"timeout": 1}), None, False),
    # the org inbox, mail items and the user's inbox
    ("org_inbox", op("GET", "/api/orgs/{slug}/org_inbox"), org_reply, False),
    ("org_inbox_no_org", op("GET", "/api/orgs/nope-org/org_inbox"), None, False),
    ("mail_user_found", dyn(lambda: op("GET", f"/api/orgs/{CUR['slug']}/mail/user/"
                                       + store.load_org(CUR["slug"]).d["user_inbox"][-1]["id"])), user_mail, False),
    ("mail_user_missing", op("GET", "/api/orgs/{slug}/mail/user/nope"), user_mail, False),
    ("mail_node_found", dyn(lambda: op("GET", f"/api/orgs/{CUR['slug']}/mail/node/{CUR['mid_mail']}",
                                       params={"node": "mid"})), pending_mail, False),
    ("mail_node_unknown", op("GET", "/api/orgs/{slug}/mail/node/x", params={"node": "ghost"}), None, False),
    ("mail_bad_box", op("GET", "/api/orgs/{slug}/mail/bogus/x"), None, False),
    ("mail_org_found", dyn(lambda: op("GET", f"/api/orgs/{CUR['slug']}/mail/org/"
                                      + store.load_org(CUR["slug"]).d["org_inbox"][-1]["id"])), org_reply, False),
    ("org_inbox_read", op("POST", "/api/orgs/{slug}/org_inbox/read"), org_reply, False),
    ("org_inbox_read_no_org", op("POST", "/api/orgs/nope-org/org_inbox/read"), None, False),
    ("org_inbox_upload", op("POST", "/api/orgs/{slug}/org_inbox/upload", params={"name": "a b?.txt"},
                            content=b"bytes"), None, False),
    ("org_inbox_upload_big", dyn(lambda: op("POST", f"/api/orgs/{CUR['slug']}/org_inbox/upload",
                                            content=big_file().read_bytes())), None, False),
    ("org_send_mcp", op("POST", "/api/orgs/{slug}/org_inbox/send", json={"to": "@mcp:someone", "body": "hi"}),
     None, False),
    ("org_send_org", op("POST", "/api/orgs/{slug}/org_inbox/send", json={"to": "@org:{other}", "body": "hi"}),
     None, False),
    ("org_send_org_kiosk", dyn(lambda: op("POST", f"/api/orgs/{CUR['slug']}/org_inbox/send",
                                          json={"to": f"@org:{CUR['other']}", "body": "hi"})), None, True),
    ("org_send_org_missing", op("POST", "/api/orgs/{slug}/org_inbox/send", json={"to": "@org:nope-org", "body": "x"}),
     None, False),
    ("org_send_org_att", dyn(lambda: op("POST", f"/api/orgs/{CUR['slug']}/org_inbox/send",
                                        json={"to": f"@org:{CUR['other']}", "body": "f",
                                              "attachments": [CUR["stage"]]})), staged, False),
    ("org_send_ext", op("POST", "/api/orgs/{slug}/org_inbox/send", json={"to": "@ext:x", "body": "x"}), None, False),
    ("org_send_bad_to", op("POST", "/api/orgs/{slug}/org_inbox/send", json={"to": "bob", "body": "x"}), None, False),
    ("org_send_bad_stage", op("POST", "/api/orgs/{slug}/org_inbox/send",
                              json={"to": "@org:{other}", "body": "x", "attachments": ["nope"]}), None, False),
    ("org_send_mcp_att", dyn(lambda: op("POST", f"/api/orgs/{CUR['slug']}/org_inbox/send",
                                        json={"to": "@mcp:x", "body": "x", "attachments": [CUR["stage"]]})),
     staged, False),
    ("org_send_net_nohub", op("POST", "/api/orgs/{slug}/org_inbox/send", json={"to": "@net:elsewhere", "body": "x"}),
     None, False),
    ("inbox_clear", op("POST", "/api/orgs/{slug}/inbox/clear"), user_mail, False),
    ("inbox_clear_no_org", op("POST", "/api/orgs/nope-org/inbox/clear"), None, False),
    # node files, reply events and retraction
    ("node_upload", op("POST", "/api/orgs/{slug}/nodes/mid/upload", params={"name": "a.txt"}, content=b"one"),
     None, False),
    ("node_upload_dup", twice(op("POST", "/api/orgs/{slug}/nodes/mid/upload", params={"name": "a.txt"},
                                 content=b"one")), None, False),
    ("node_upload_empty", op("POST", "/api/orgs/{slug}/nodes/mid/upload", params={"name": "a.txt"}, content=b""),
     None, False),
    ("node_upload_ghost", op("POST", "/api/orgs/{slug}/nodes/ghost/upload", content=b"x"), None, False),
    ("node_upload_blocked", op("POST", "/api/orgs/{slug}/nodes/mid/upload", content=b"x"), storage_blocked, False),
    ("reply_events", op("GET", "/api/orgs/{slug}/nodes/mid/reply-events"), None, False),
    ("reply_events_ghost_node", op("GET", "/api/orgs/{slug}/nodes/ghost/reply-events"), None, False),
    ("reply_events_no_org", op("GET", "/api/orgs/nope-org/nodes/mid/reply-events"), None, False),
    ("reply_events_clear", op("DELETE", "/api/orgs/{slug}/nodes/mid/reply-events"), None, False),
    ("reply_events_clear_ghost", op("DELETE", "/api/orgs/{slug}/nodes/ghost/reply-events"), None, False),
    ("retract", dyn(lambda: op("DELETE", f"/api/orgs/{CUR['slug']}/nodes/mid/mail/{CUR['mid_mail']}")),
     pending_mail, False),
    ("retract_gone", op("DELETE", "/api/orgs/{slug}/nodes/mid/mail/nope"), None, False),
    # the gate: a route with no credential, and with an agent credential
    ("route_no_token", lambda c: c.get("/api/orgs"), None, False),
    ("route_agent_token", lambda c: c.get(f"/api/orgs/{CUR['slug']}/org_inbox",
                                          headers={"X-Orgtree-Agent-Token": CUR["tokens"]["mid"]}), None, False),
    ("extern_no_token", lambda c: c.get(f"/api/extern/{CUR['peer']}/messages"), None, False),
    # agent tools
    ("send_file", agent("orgtree_send_file", {"path": "report.txt", "note": "the report"}), scratch_file, False),
    ("send_file_missing", agent("orgtree_send_file", {"path": "nope.txt"}), scratch_file, False),
    ("send_file_no_path", agent("orgtree_send_file", {}), scratch_file, False),
    ("send_file_escape", agent("orgtree_send_file", {"path": "../../x.txt"}), scratch_file, False),
    ("send_file_delivery", agent("orgtree_send_file", {"path": "report.txt", "delivery_id": DID}), scratch_file, False),
    ("send_file_delivery_replay", twice(agent("orgtree_send_file", {"path": "report.txt", "delivery_id": DID})),
     scratch_file, False),
    ("send_file_delivery_conflict", conflict, scratch_file, False),
    ("send_file_bad_id", agent("orgtree_send_file", {"path": "report.txt", "delivery_id": "short"}), scratch_file,
     False),
    ("send_file_once", agent("orgtree_send_file_once", {"path": "report.txt", "delivery_id": DID}), scratch_file,
     False),
    ("send_file_once_no_id", agent("orgtree_send_file_once", {"path": "report.txt"}), scratch_file, False),
    ("send_file_keyed", keyed("orgtree_send_file", {"path": "report.txt"}), scratch_file, False),
    ("send_file_blocked", agent("orgtree_send_file", {"path": "report.txt", "delivery_id": DID}),
     lambda c: (scratch_file(c), storage_blocked(c)), False),
]



def observe(name):
    """Run one fixtured case on a fresh org pair and return its normalized observation."""
    request, pre, kiosk_other = CASES[name]
    fresh(kiosk_other)
    client = TestClient(app, raise_server_exceptions=False)
    with Spies() as sp:
        if pre:
            pre(client)
            for m in sp.s.values():
                m.reset_mock()
        b_main, b_other, b_m, b_f = durable(CUR['slug']), durable(CUR['other']), machine(), scratch_files(CUR['slug'])
        r = request(client)
        a_main, a_other, a_m, a_f = durable(CUR['slug']), durable(CUR['other']), machine(), scratch_files(CUR['slug'])
        try:
            body = r.json()
        except Exception:  # noqa: BLE001
            body = None
        raw = {'status': r.status_code,
               'keys': sorted(body) if isinstance(body, dict) else ('list' if isinstance(body, list) else None),
               'detail': body.get('detail') if isinstance(body, dict) else None,
               'changed': changed(b_main, a_main), 'changed_other': changed(b_other, a_other),
               'machine_before': b_m, 'machine_after': a_m,
               'files_new': {n: sorted(set(a_f[n]) - set(b_f[n])) for n in a_f if set(a_f[n]) - set(b_f[n])},
               'spies': sp.calls()}
        return norm(raw, CUR), body, (b_main, a_main, b_other, a_other), dict(CUR)


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
            self.assertEqual(registry['facets']['exchange.' + d]['status'],
                             'unresolved' if d in ('conflicts', 'wire', 'instrumentation') else 'specified', d)

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('exchange.send-file'), lambda d: d.update(covered=True),
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
            if name.startswith('exchange.'):
                for e in c['entry_ids']:
                    bound.setdefault(e, []).append(name)
                    self.assertEqual(contracts.select(registry, e, {}), [name], name)
        self.assertEqual(len(bound), 20)
        for e, names in bound.items():
            self.assertEqual((entries[e]['disposition'], entries[e]['contracts']), ('mapped', names))
        # the four agent-door branches and the two sidecar sites that only F4's operations reach
        dispatch = {r['id']: r for r in registry['dispatch']}
        storage = {r['id']: r for r in registry['storage']}
        mapped = [dispatch[contracts.witness_id('dispatch', s)] for s in source['dispatch_selectors']
                  if 'P01 F4' in dispatch[contracts.witness_id('dispatch', s)]['reason']]
        self.assertEqual(len(mapped), 4)
        self.assertTrue(all(r['disposition'] == 'mapped' for r in mapped))
        sites = {s['source']['path'].rsplit('/', 1)[-1] + ':' + s['source']['symbol']:
                 storage[contracts.witness_id('storage', s)] for s in source['connection_sites']}
        self.assertEqual(sites['filedelivery.py:snapshot']['contracts'], ['exchange.send-file'])
        self.assertEqual(sites['reply_events.py:count']['contracts'], ['exchange.reply-events-count'])
        self.assertEqual(sites['reply_events.py:_connect']['disposition'], 'pending')


class ExchangeBoundary(unittest.TestCase):
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

    # -- the org list and the external-chat routes ----------------------------------------------------------------
    def test_orgs_list_reads_every_org_and_carries_the_kiosk_flags(self):
        [(seen, body, _, cur)] = self.check('orgs_list').values()
        rows = {r['slug']: r for r in body}
        self.assertEqual((rows[cur['slug']]['kiosk'], rows[cur['other']]['kiosk']), (False, True))
        self.assertIn('token', rows[cur['other']]['kiosk_cfg'])       # the admin view carries the share token
        self.assertNotIn('kiosk_cfg', rows[cur['slug']])

    def test_extern_send_records_the_sighting_first_then_delivers_to_the_org_inbox(self):
        got = self.check('extern_send', 'extern_send_empty', 'extern_send_bad_peer', 'extern_send_no_org',
                         'extern_send_kiosk', 'extern_send_att', 'extern_send_att_missing', 'extern_send_att_big')
        # the sighting is written before the empty-body, unknown-org, kiosk and attachment refusals, not before a
        # bad peer id (docket external-chat-messages-and-wait-read-every-org-u, the extern-peers point)
        self.assertEqual({n for n, (s, _, _, _) in got.items() if s['peer_seen']},
                         set(got) - {'extern_send_bad_peer'})
        # a sealed kiosk answers exactly like a missing org
        self.assertEqual(got['extern_send_kiosk'][0]['detail'].replace('{other}', 'X'),
                         got['extern_send_no_org'][0]['detail'].replace('nope-org', 'X'))

    def test_extern_read_and_wait_scan_every_org(self):
        self.check('extern_messages', 'extern_messages_org', 'extern_messages_none', 'extern_wait_ready',
                   'extern_wait_timeout')
        # recorded legacy defect (docket external-chat-messages-and-wait-read-every-org-u): the scan reads every org
        # on the machine; a peer's replies from TWO orgs come back from one call, and a wait returns at once when
        # any org holds a fresh reply
        fresh()
        client = TestClient(app, raise_server_exceptions=False)
        peer = CUR['peer']
        with Spies():
            for slug in (CUR['slug'], CUR['other']):
                client.post(f'/api/extern/{peer}/send', json={'org': slug, 'body': 'q'}, headers=OP)
                org = store.load_org(slug)
                org._org_inbox_log('out', f'@mcp:{peer}', 'a from ' + slug, by='top')
                store.save_org(org)
            got = client.get(f'/api/extern/{peer}/messages', headers=OP).json()['messages']
            self.assertEqual(sorted(m['org'] for m in got), sorted([CUR['slug'], CUR['other']]))
            t0 = time.monotonic()
            waited = client.get(f'/api/extern/{peer}/wait', params={'timeout': 5}, headers=OP).json()['messages']
            self.assertEqual((len(waited), time.monotonic() - t0 < 2), (2, True))
            scanned = []
            real = store.load_org
            with patch.object(store, 'load_org', lambda slug: scanned.append(slug) or real(slug)):
                client.get(f'/api/extern/{peer}/messages', params={'org': CUR['slug']}, headers=OP)
                filtered = list(scanned)
                client.get(f'/api/extern/{peer}/messages', headers=OP)
            # an org filter skips the other docs' loads; without it every org on the machine is loaded
            self.assertEqual(set(filtered), {CUR['slug']})
            self.assertGreaterEqual(len(set(scanned)) - len(set(filtered)), 2)

    def test_the_gate_and_the_external_chat_client(self):
        self.check('route_no_token', 'route_agent_token', 'extern_no_token')
        # the external-chat MCP server sends no credential: every one of its verbs is refused by the gate both
        # current launch paths install; with the desktop token its client logic works
        for token, want in ((False, self.spec['externtool']['bare']), (True, self.spec['externtool']['token'])):
            with self.subTest(token=token):
                self.assertEqual(run_externtool(token), want)

    # -- the org inbox, mail items and the user's inbox ---------------------------------------------------------
    def test_org_inbox_mail_items_and_the_user_inbox(self):
        got = self.check('org_inbox', 'org_inbox_no_org', 'mail_user_found', 'mail_user_missing', 'mail_node_found',
                         'mail_node_unknown', 'mail_bad_box', 'mail_org_found', 'org_inbox_read',
                         'org_inbox_read_no_org', 'inbox_clear', 'inbox_clear_no_org')
        self.assertEqual((got['mail_user_found'][1]['found'], got['mail_user_missing'][1]),
                         (True, {'found': False, 'mail': None}))
        b, a, _, _ = got['inbox_clear'][2]
        self.assertEqual((a['user_inbox'], len(a['user_mail_log']) - len(b.get('user_mail_log') or [])),
                         ([], len(b['user_inbox'])))

    def test_org_inbox_upload_and_send(self):
        got = self.check('org_inbox_upload', 'org_inbox_upload_big', 'org_send_mcp', 'org_send_org',
                         'org_send_org_kiosk', 'org_send_org_missing', 'org_send_org_att', 'org_send_ext',
                         'org_send_bad_to', 'org_send_bad_stage', 'org_send_mcp_att', 'org_send_net_nohub')
        # an @org: send writes the OTHER org's documents and drives its holders; a sealed or missing one only warns
        self.assertEqual(got['org_send_org_kiosk'][1]['warnings'],
                         [f"not delivered: no organization named {got['org_send_org_kiosk'][3]['other']!r} is reachable"])
        self.assertEqual(got['org_send_org'][1]['warnings'], [])

    # -- node files, reply events and retraction ----------------------------------------------------------------
    def test_node_upload_reply_events_and_retraction(self):
        self.check('node_upload', 'node_upload_dup', 'node_upload_empty', 'node_upload_ghost', 'node_upload_blocked',
                   'reply_events', 'reply_events_clear', 'retract', 'retract_gone')

    def test_reply_events_answer_500_for_an_unknown_org_or_node(self):
        # recorded legacy defect (docket reply-events-get-and-delete-answer-a-raw-500-for)
        got = self.check('reply_events_ghost_node', 'reply_events_no_org', 'reply_events_clear_ghost')
        self.assertEqual({s['status'] for s, _, _, _ in got.values()}, {500})

    # -- the agent tools ----------------------------------------------------------------------------------------
    def test_send_file_and_the_retryable_delivery(self):
        got = self.check('send_file', 'send_file_missing', 'send_file_no_path', 'send_file_escape',
                         'send_file_delivery', 'send_file_delivery_replay', 'send_file_delivery_conflict',
                         'send_file_bad_id', 'send_file_once', 'send_file_once_no_id', 'send_file_keyed',
                         'send_file_blocked')
        # filesystem only: no call writes the org document, and a keyed call files no receipt (class NONE)
        for name, (seen, _, _, _) in got.items():
            self.assertEqual((seen['sections'], seen['sections_other']), ([], []), name)
        self.assertEqual(got['send_file_delivery'][1]['sent']['path'].split('/')[0], 'outbox')
        # why a keyed call files no receipt: the tool returns from the agent door's read-only block before the
        # dispatch transaction, and its coverage class is NONE, which a receipt lookup of its key reports
        fresh()
        client = TestClient(app, raise_server_exceptions=False)
        with Spies():
            scratch_file(client)
            head = {'X-Orgtree-Agent-Token': CUR['tokens']['mid']}
            key = opreceipts.mint_key()
            epoch = client.post('/api/agent', json=dict(org=CUR['slug'], node='mid', tool=opreceipts.OP_EPOCH,
                                                        args={}), headers=head).json()['epoch']
            args = {'path': 'report.txt'}
            sent = client.post('/api/agent', json=dict(org=CUR['slug'], node='mid', tool=opreceipts.OP_CALL, args=dict(
                tool='orgtree_send_file', args=args, op_key=key, op_epoch=epoch)), headers=head)
            self.assertEqual(sent.status_code, 200, sent.text)
            answer = client.post('/api/agent', json=dict(org=CUR['slug'], node='mid', tool=opreceipts.OP_LOOKUP, args={
                'op_key': key, 'op_epoch': epoch, 'for_tool': 'orgtree_send_file', 'for_args': args}), headers=head).json()
        self.assertEqual((answer['state'], answer['reason'], answer['coverage']), ('unknown', 'unsupported_operation', 'none'))


def run_externtool(token):
    """externtool.run_tool for its four verbs, its http() served by this app with EXACTLY the headers it sends
    (Content-Type only), or with the desktop token added."""
    fresh(kiosk_other=True)
    client = TestClient(app, raise_server_exceptions=False)

    def http(method, path, body=None, timeout=30.0):
        r = client.request(method, path, json=body, headers=OP if token else {'Content-Type': 'application/json'})
        if r.status_code >= 400:
            raise urllib.error.HTTPError(path, r.status_code, 'error', {}, io.BytesIO(r.content))
        return r.json()

    out = {}
    with Spies(), patch.object(externtool, 'http', http):
        for tool, args in (('orgtree_list_orgs', {}), ('orgtree_send', {'org': CUR['slug'], 'body': 'hello'}),
                           ('orgtree_read', {'org': CUR['slug']}), ('orgtree_wait', {'org': CUR['slug'], 'timeout_s': 5})):
            if tool == 'orgtree_read':
                org = store.load_org(CUR['slug'])
                org._org_inbox_log('out', f'@mcp:{externtool.PEER}', 'reply', by='top')
                store.save_org(org)
            text, err = externtool.run_tool(tool, args)
            if err:
                out[tool] = {'error': True, 'text': text[:200]}
                continue
            data = json.loads(text)
            if tool == 'orgtree_list_orgs':
                out[tool] = {'error': False, 'kiosk_hidden': all(o['slug'] != CUR['other'] for o in data['orgs']),
                             'main_listed': any(o['slug'] == CUR['slug'] for o in data['orgs']),
                             'peer': data['your_peer_id']}
            elif tool == 'orgtree_send':
                out[tool] = {'error': False, 'keys': sorted(data)}
            else:
                out[tool] = {'error': False, 'messages': len(data['messages'])}
    return out


if __name__ == '__main__':
    unittest.main()
