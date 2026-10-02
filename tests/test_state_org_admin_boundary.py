"""P01 F7 legacy boundary contracts for the org administration routes (org-admin.*).

Disposable SQLite only; the app's lifecycle is not started. Every case builds a fresh org under this test's temporary
data root. Hub and net calls are spies. The routes, the ledger, the store's create and delete, the defaults file and
the workspace files are real. Each case's observation is normalized (one NORM block) and compared with
docs/state-system/org-admin-boundary.json, and each test pins a fact stated in
docs/state-system/operation-contracts.json (org-admin.*).

This module launches no process. An audit hook installed before anything else is imported refuses and records any
process launch for the whole run (imports, the app's construction, every case), and the module fails at teardown if
one was recorded.
"""
from __future__ import annotations

import sys

# ---- the no-process guard, first: any process launch is refused (before the child exists) and recorded.
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

import copy  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
from pathlib import Path  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402
from unittest.mock import AsyncMock, patch  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import state_operation_contracts as contracts  # noqa: E402
import inventory_scan_cache  # noqa: E402,F401 -- one shared source scan per suite run

# left for the OS to reclaim: hires create agent scratch folders under the data root
_temp = tempfile.mkdtemp(prefix='p01-org-admin-boundary-')
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
from orgtree import agentauth, api, ledger, net, store, supervisor  # noqa: E402

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), 'this process would have written to the live root'
assert os.environ.get('ORGTREE_DESKTOP_MANAGED') == '1', 'the desktop-managed profile is the app under test'
assert LAUNCHES == [], LAUNCHES      # nothing above (the imports, the app's construction) tried to launch a process

OP = {'X-Orgtree-Desktop-Token': 'operator'}
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
SCOPE = {'add_dirs': [], 'tools': NO_TOOLS, 'org_visibility': 'team', 'charter': 'fixture'}
FIELDS = {'schema', 'source_contract_sha256', 'qualification', 'contracts', 'cases', 'legacy_defects', 'scope'}
SEQ = [0]
CUR: dict = {}
EXTRA = Path(_temp) / 'extra-dir'
EXTRA.mkdir()


def boundary(document=None):
    """Refuse an incomplete or stale fixture before any case runs."""
    d = document if document is not None else contracts.load(ROOT / 'docs/state-system/org-admin-boundary.json')
    registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
    if set(d) != FIELDS:
        raise ValueError('boundary fields')
    if d['schema'] != 'orgtree.org-admin-boundary/v1':
        raise ValueError('boundary schema')
    if d['source_contract_sha256'] != contracts.digest(registry):
        raise ValueError('stale boundary binding')
    if set(d['qualification']) != set(contracts.GATES) or any(v is not False for v in d['qualification'].values()):
        raise ValueError('boundary cannot qualify conversion')
    if set(d['contracts']) != {k for k in registry['contracts'] if k.startswith('org-admin.')}:
        raise ValueError('every org-admin contract is required')
    return d


# ---- NORM (verbatim from the P01 F7 probe's f7/norm.py) ------------------------------------------------------------
def norm(c, cur):
    slugs = sorted({cur["slug"], *cur.get("created", [])}, key=len, reverse=True)

    def text(v):
        if isinstance(v, str):
            for s in slugs:
                v = v.replace(s, "{slug}")
        return v
    born = list(c["born"].values())
    return {
        "status": c["status"],
        "ctype": c["ctype"],
        "keys": c["keys"],
        "detail": text(c["detail"]),
        "sections": c["changed"],
        "orgs": [c["orgs_created"], c["orgs_removed"]],
        "born": born[0] if len(born) == 1 else None,
        "files": {"added": c["files_added"], "removed": c["files_removed"], "changed": c["files_changed"]},
        "spies": dict(sorted((c.get("spies") or {}).items())),
    }


# ---- harness (verbatim from the P01 F7 probe) ------------------------------------------------------------
def fresh():
    SEQ[0] += 1
    org = store.create_org(f"p01-f7-{SEQ[0]}")
    slug = str(org.d["slug"])
    org.hire(ledger.USER, None, "haiku", 20, "top", add_dirs=[], tools={}, charter="fixture")
    org.hire("top", "top", "haiku", 6, "mid", **SCOPE)
    org.d["mail"] = {}
    store.save_org(org)
    CUR["slug"] = slug
    CUR["tokens"] = {n: agentauth.child_env(slug, n)["ORGTREE_AGENT_TOKEN"] for n in ("top", "mid")}


def durable(slug):
    store._invalidate_snapshot(slug)
    store._POOL.close_all(slug)
    try:
        return json.loads(json.dumps(store.load_org(slug).d))
    except ledger.LedgerError:
        return None


def changed(b, a):
    if b is None or a is None:
        return None if b is a else ("<removed>" if a is None else "<created>")
    return sorted(k for k in set(b) | set(a) if b.get(k) != a.get(k))


def slugs():
    return sorted(o["slug"] for o in store.list_orgs())


def files():
    """Data-root files outside the org stores. diagnostics/ is excluded: the slow-request trace
    (diagnostics/slow-requests.jsonl) is written by any request that crosses a latency threshold, i.e. by load."""
    out = {}
    for p in _data.rglob("*"):
        if p.is_file() and p.relative_to(_data).parts[0] not in ("orgs", "diagnostics"):
            rel = p.relative_to(_data).as_posix()
            try:
                out[rel] = p.stat().st_size, p.stat().st_mtime_ns
            except OSError:
                pass
    return out


def norm_path(rel):
    import re
    for s in sorted(set(slugs() + [CUR.get("slug", "")]), key=len, reverse=True):
        if s:
            rel = rel.replace(s, "{slug}")
    return re.sub(r"\d{8}T\d{6}", "{ts}", rel)


class Spies:
    def __enter__(self):
        self.ps, self.s = [], {}

        def add(target, name, **kw):
            p = patch.object(target, name, **kw)
            self.s[name] = p.start()
            self.ps.append(p)
        add(supervisor, "send_message", return_value={"delivered": True})
        add(supervisor, "notify")
        add(supervisor, "forget_state")
        add(supervisor, "remote_reap")
        add(api, "hub_changed")
        add(api, "mail_notify")
        add(api.hub, "changed", new_callable=AsyncMock)
        add(net, "kick")
        add(net, "unregister_org", return_value={"unregistered": []})
        return self

    def calls(self):
        return {k: len(m.call_args_list) for k, m in self.s.items() if m.call_count}

    def __exit__(self, *e):
        for p in reversed(self.ps):
            p.stop()


# ---- helpers -----------------------------------------------------------------------------------------------------
def op(method, path, **kw):
    def go(c):
        return c.request(method, path.format(slug=CUR["slug"]), headers=OP, **kw)
    return go


def then(*steps):
    def go(c):
        for step in steps:
            step(c)
    return go


def defaults(d):
    def go(c):
        (_data / "defaults.json").write_text(json.dumps(d), encoding="utf-8")
    return go


def no_defaults(c):
    try:
        (_data / "defaults.json").unlink()
    except FileNotFoundError:
        pass


def no_workspace(c):
    org = store.load_org(CUR["slug"])
    org.d["workspace"] = None
    store.save_org(org)


def add_extra_dir(c):
    org = store.load_org(CUR["slug"])
    org.d["dirs"] = list(org.d["dirs"]) + [{"path": str(EXTRA), "mode": "rw"}]
    org.nodes["mid"]["scope"]["add_dirs"] = [{"path": str(EXTRA), "mode": "rw"}]
    store.save_org(org)


def fable_lock(c):
    import time
    org = store.load_org(CUR["slug"])
    org.d["fable_lock"] = {"at": "2026-09-25T00:00:00Z", "reason": "fixture", "until_ts": time.time() + 3600}
    org.nodes["mid"]["limit_locked"] = True
    store.save_org(org)


def lenient_policies(c):
    org = store.load_org(CUR["slug"])
    org.d["fable_limit_policy"] = "opus"
    org.d["fable_filter_policy"] = "opus"
    store.save_org(org)


def spool(c):
    org = store.load_org(CUR["slug"])
    org.d["net_hubs"] = [{"id": "old1", "address": "http://10.0.0.1:7370", "enabled": True}]
    org.d["net_spool"] = {"old1": [{"id": "m1"}]}
    store.save_org(org)


def env(**kw):
    return kw


S = "/api/orgs/{slug}/settings"
CASES = [
    # create
    ("create", op("POST", "/api/orgs", json={"name": "p01-f7-born"}), no_defaults,
     env(born_watch=("net_autoconnect", "net_hubs", "default_top_grant"))),
    ("create_defaults", op("POST", "/api/orgs", json={"name": "p01-f7-born-d"}),
     defaults({"compact_at": 0.7, "net_hub_address": "http://10.9.9.9:7370", "prefer_reserve": False}),
     env(born_watch=("compact_at", "net_hub_address", "prefer_reserve", "net_hubs"))),
    ("create_no_autoconnect", op("POST", "/api/orgs", json={"name": "p01-f7-born-n", "net_autoconnect": False,
                                                            "net_hubs": ["10.1.1.1"]}), no_defaults,
     env(born_watch=("net_autoconnect", "net_hubs"))),
    ("create_duplicate", op("POST", "/api/orgs", json={"name": "p01-f7-dup"}),
     then(no_defaults, op("POST", "/api/orgs", json={"name": "p01-f7-dup"})), None),
    ("create_bad_name", op("POST", "/api/orgs", json={"name": ""}), no_defaults, None),
    # delete
    ("delete", op("DELETE", "/api/orgs/{slug}"), None, None),
    ("delete_missing", op("DELETE", "/api/orgs/nope-org"), None, None),
    ("delete_twice", op("DELETE", "/api/orgs/{slug}"), op("DELETE", "/api/orgs/{slug}"), None),
    # settings
    ("settings_caps", op("POST", S, json={"max_top_grant": 10, "default_top_grant": 3, "compact_at": 99}), None,
     env(watch=("max_top_grant", "default_top_grant", "compact_at"))),
    ("settings_refused_after_edits", op("POST", S, json={"max_top_grant": 10, "compact_at": 60,
                                                        "fable_filter_model": "fable"}), None,
     env(watch=("max_top_grant", "compact_at"))),
    ("settings_unknown_model", op("POST", S, json={"fable_filter_model": "no-such-tier"}), None, None),
    ("settings_org_dirs_remove", op("POST", S, json={"org_dirs": []}), add_extra_dir, env(watch=("dirs",))),
    ("settings_org_dirs_bad", op("POST", S, json={"org_dirs": [None]}), None, None),
    ("settings_refused_after_revoke", op("POST", S, json={"org_dirs": [], "fable_filter_model": "fable"}),
     add_extra_dir, env(watch=("dirs",))),
    ("settings_clear_fable_lock", op("POST", S, json={"clear_fable_lock": True}), fable_lock,
     env(watch=("fable_lock",))),
    ("settings_refused_after_lock_clear", op("POST", S, json={"clear_fable_lock": True,
                                                             "fable_filter_model": "fable"}), fable_lock,
     env(watch=("fable_lock",))),
    ("settings_headless_lenient", op("POST", S, json={"headless": True}), lenient_policies,
     env(watch=("headless", "auto_resume"))),
    ("settings_hire_defaults", op("POST", S, json={"default_visibility": "subtree", "default_effort": "low"}), None,
     env(watch=("default_visibility", "default_effort"))),
    ("settings_headless", op("POST", S, json={"headless": True}), None,
     env(watch=("headless", "auto_resume"))),
    ("settings_net_hubs", op("POST", S, json={"net_hubs": [{"address": "10.2.2.2"}]}), spool,
     env(watch=("net_hubs", "net_spool", "net_autoconnect"))),
    ("settings_net_hubs_bad", op("POST", S, json={"net_hubs": ["nope"]}), None, None),
    ("settings_empty", op("POST", S, json={}), None, None),
    ("settings_no_org", op("POST", "/api/orgs/nope-org/settings", json={}), None, None),
    # hire defaults
    ("defaults", op("POST", "/api/orgs/{slug}/defaults", json={"default_visibility": "subtree"}), None, None),
    ("defaults_bad", op("POST", "/api/orgs/{slug}/defaults", json={"default_visibility": "bogus"}), None,
     None),
    ("defaults_no_org", op("POST", "/api/orgs/nope-org/defaults", json={}), None, None),
    # org.md
    ("orgmd_put", op("PUT", "/api/orgs/{slug}/orgmd", json={"content": "# charter"}), None, None),
    ("orgmd_put_unicode", op("PUT", "/api/orgs/{slug}/orgmd", json={"content": "é" * 10}), None, None),
    ("orgmd_put_long", op("PUT", "/api/orgs/{slug}/orgmd", json={"content": "x" * 70000}), None, None),
    ("orgmd_put_no_workspace", op("PUT", "/api/orgs/{slug}/orgmd", json={"content": "x"}), no_workspace,
     None),
    ("orgmd_put_no_org", op("PUT", "/api/orgs/nope-org/orgmd", json={"content": "x"}), None, None),
    # the gate
    ("agent_token", lambda c: c.post(f"/api/orgs/{CUR['slug']}/settings", json={},
                                     headers={"X-Orgtree-Agent-Token": CUR["tokens"]["mid"]}), None, None),
]


CASES = {n: (r, p, e) for n, r, p, e in CASES}


def observe(name):
    """Run one fixtured case on a fresh org and return its normalized observation, the body and the case record."""
    request, pre, e = CASES[name]
    fresh()
    CUR.update(e or {})
    client = TestClient(app, raise_server_exceptions=False)
    try:
        with Spies() as sp:
            if pre:
                pre(client)
                for m in sp.s.values():
                    m.reset_mock()
            b, bs, bf = durable(CUR['slug']), slugs(), files()
            r = request(client)
            a, as_, af = durable(CUR['slug']), slugs(), files()
            ctype = r.headers.get('content-type', '')
            body = r.json() if 'json' in ctype else None
            created = sorted(set(as_) - set(bs))
            raw = {'status': r.status_code, 'ctype': ctype.split(';')[0],
                   'keys': sorted(body) if isinstance(body, dict) else ('list' if isinstance(body, list) else None),
                   'detail': body.get('detail') if isinstance(body, dict) else None,
                   'changed': changed(b, a),
                   'orgs_created': len(created), 'orgs_removed': len(set(bs) - set(as_)),
                   'born': {s: sorted((durable(s) or {}).keys()) for s in created},
                   'files_added': sorted(norm_path(p) for p in set(af) - set(bf)),
                   'files_removed': sorted(norm_path(p) for p in set(bf) - set(af)),
                   'files_changed': sorted(norm_path(p) for p in set(af) & set(bf) if af[p] != bf[p]),
                   'spies': sp.calls()}
            cur = {'slug': CUR['slug'], 'created': created,
                   'doc_after': {k: a.get(k) for k in CUR.get('watch', ())} if a else None,
                   'born_doc': {k: (durable(created[0]) or {}).get(k) for k in CUR.get('born_watch', ())}
                   if len(created) == 1 else None,
                   'extra': CUR['extra_fn']() if CUR.get('extra_fn') else None}
            return norm(raw, cur), body, cur
    finally:
        for k in ('watch', 'born_watch', 'extra_fn'):
            CUR.pop(k, None)


class BoundaryBinding(unittest.TestCase):
    def test_current_binding(self):
        spec = boundary()
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        result = contracts.validate(registry, contracts.inventory.scan(ROOT), ROOT)
        self.assertTrue(result['valid'], result['errors'])
        self.assertEqual(len(spec['contracts']), 5)
        self.assertEqual(set(spec['cases']), set(CASES))
        for d in contracts.DIMENSIONS:
            self.assertEqual(registry['facets']['org-admin.' + d]['status'],
                             'unresolved' if d in ('conflicts', 'wire', 'instrumentation') else 'specified', d)
        modes = {k: c['domain_mode'] for k, c in registry['contracts'].items() if k.startswith('org-admin.')}
        self.assertEqual({k for k, m in modes.items() if m != 'write'}, set())

    def test_stale_incomplete_or_elevated_fixture_refuses(self):
        for edit in [lambda d: d['contracts'].pop('org-admin.settings'), lambda d: d.update(covered=True),
                     lambda d: d['qualification'].update(runtime_census=True),
                     lambda d: d.update(source_contract_sha256='0' * 64)]:
            with self.subTest(edit=edit):
                d = copy.deepcopy(boundary())
                edit(d)
                with self.assertRaises(ValueError):
                    boundary(d)

    def test_every_entry_selects_exactly_its_contract_and_is_mapped(self):
        registry = contracts.load(ROOT / 'docs/state-system/operation-contracts.json')
        entries = {r['id']: r for r in registry['entries']}
        bound = {}
        for name, c in registry['contracts'].items():
            if name.startswith('org-admin.'):
                for e in c['entry_ids']:
                    bound.setdefault(e, []).append(name)
                    self.assertEqual(contracts.select(registry, e, {}), [name], name)
        self.assertEqual(len(bound), 5)
        for e, names in bound.items():
            self.assertEqual((entries[e]['disposition'], entries[e]['contracts']), ('mapped', names))


class OrgAdminBoundary(unittest.TestCase):
    def setUp(self):
        self.spec = boundary()

    def check(self, *names):
        out = {}
        for name in names:
            with self.subTest(case=name):
                seen, body, cur = observe(name)
                self.assertEqual(seen, self.spec['cases'][name], name)
                out[name] = (seen, body, cur)
        return out

    def test_create_and_the_org_it_is_born_as(self):
        got = self.check('create', 'create_defaults', 'create_no_autoconnect', 'create_duplicate', 'create_bad_name')
        born = got['create'][2]['born_doc']
        # a throwaway data root never points a new org at the operator's real hub
        self.assertEqual((born['net_autoconnect'], born['net_hubs'], born['default_top_grant']),
                         (True, [{'id': 'local', 'address': net.UNROUTABLE_HUB_ADDRESS, 'enabled': True}], 50))
        # the global defaults are written into the org, except the two that are not org settings
        d = got['create_defaults'][2]['born_doc']
        self.assertEqual((d['compact_at'], d['net_hub_address'], d['prefer_reserve'], d['net_hubs'][0]['address']),
                         (0.7, None, None, 'http://10.9.9.9:7370'))
        n = got['create_no_autoconnect'][2]['born_doc']
        self.assertEqual((n['net_autoconnect'], [h['address'] for h in n['net_hubs']]), (False, ['10.1.1.1']))

    def test_delete_renames_the_store_away_and_tears_down_its_runtime(self):
        got = self.check('delete', 'delete_missing', 'delete_twice')
        self.assertEqual(got['delete'][0]['files']['added'], ['deleted/{slug}-{ts}.db'])
        self.assertEqual(got['delete'][1], {'ok': True, 'net': {'unregistered': []}})

    def test_settings_write_what_they_name_and_a_refusal_writes_nothing(self):
        got = self.check('settings_caps', 'settings_refused_after_edits', 'settings_unknown_model',
                         'settings_org_dirs_remove', 'settings_org_dirs_bad', 'settings_refused_after_revoke',
                         'settings_clear_fable_lock', 'settings_refused_after_lock_clear', 'settings_headless_lenient',
                         'settings_hire_defaults', 'settings_headless', 'settings_net_hubs',
                         'settings_net_hubs_bad', 'settings_empty', 'settings_no_org')
        self.assertEqual(got['settings_caps'][2]['doc_after'],
                         {'max_top_grant': 10, 'default_top_grant': 3, 'compact_at': 0.95})   # 99 clamps to 95
        # applied to the cached document, then refused: the lock release discards all of it
        refused = got['settings_refused_after_edits'][2]['doc_after']
        self.assertNotEqual((refused['max_top_grant'], refused['compact_at']), (10, 0.6))
        self.assertIn(str(EXTRA), [x['path'] for x in got['settings_refused_after_revoke'][2]['doc_after']['dirs']])
        self.assertIsNotNone(got['settings_refused_after_lock_clear'][2]['doc_after']['fable_lock'])
        self.assertNotIn(str(EXTRA), [x['path'] for x in got['settings_org_dirs_remove'][2]['doc_after']['dirs']])
        self.assertIsNone(got['settings_clear_fable_lock'][2]['doc_after']['fable_lock'])
        self.assertEqual(got['settings_headless_lenient'][2]['doc_after'], {'headless': True, 'auto_resume': True})
        hubs = got['settings_net_hubs'][2]['doc_after']
        self.assertEqual((hubs['net_autoconnect'], hubs['net_spool']), (False, {hubs['net_hubs'][0]['id']: [{'id': 'm1'}]}))

    def test_hire_defaults_and_the_orgmd_write(self):
        got = self.check('defaults', 'defaults_bad', 'defaults_no_org', 'orgmd_put', 'orgmd_put_unicode',
                         'orgmd_put_long', 'orgmd_put_no_workspace', 'orgmd_put_no_org')
        self.assertEqual(Path(got['orgmd_put'][1]['path']).read_text(encoding='utf-8'), '# charter')
        # recorded legacy defect: `bytes` is the character count
        u = got['orgmd_put_unicode'][1]
        self.assertEqual((u['bytes'], u['chars'], len(('é' * 10).encode('utf-8'))), (10, 10, 20))
        long_ = got['orgmd_put_long'][1]
        self.assertEqual((long_['chars'], long_['prompt_truncated'], len(long_['warnings'])), (70000, True, 1))

    def test_an_agent_credential_is_refused(self):
        self.check('agent_token')


class NoProcess(unittest.TestCase):
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


def tearDownModule():
    # a launch the product caught and swallowed fails no case; it still fails the module. The hook cannot be
    # removed, so it is switched off here: a single-process discover run's later modules do not inherit it.
    try:
        assert LAUNCHES == [], LAUNCHES
    finally:
        GUARD['on'] = False


if __name__ == '__main__':
    unittest.main()
