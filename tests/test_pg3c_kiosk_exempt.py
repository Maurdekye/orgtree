"""PG-3c: the kiosk credit cap is skipped for tools that cannot move a pool
(lead decision 18.8's condition: prove a non-funding tool cannot push a pool
over its cap).

`Org.audit()["top_level_holds"]` sums seat_cost(model) + grant over the live
top-level nodes, so it can change only through a node's parent / state /
model / grant, a new node, or the `tiers` prices. For every tool in
rcdoor.KIOSK_EXEMPT this test calls the REAL agent door on a kiosk org that
is ALREADY over its cap (an operator lowered the cap), and asserts:

  * the call succeeds (the exemption is in force — before it, every tool
    in such an org was refused);
  * top_level_holds is unchanged, and so is every node's parent, state,
    model and grant, the node set, and `tiers` — the facts the cap reads;
  * the call really wrote something durable (a pass is not an empty call).

CONTROL: a funding tool (orgtree_reallocate) on the same org is still
refused by the cap, so the check has not been switched off wholesale.

Run:  python tools/run-python-verification.py tests/test_pg3c_kiosk_exempt.py
"""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

root = tempfile.TemporaryDirectory(prefix='v3-pg3c-kiosk-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE='sqlite')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()
from fastapi.testclient import TestClient  # noqa: E402
from orgtree import agentauth, api, ledger, rcdoor, store  # noqa: E402

SHA_C, SHA_B = 'c' * 40, 'd' * 40
CALLS = {
    'orgtree_status': ('mid', {'status': 'done', 'summary': 'finished'}),
    'orgtree_reservation': ('mid', {'action': 'acquire', 'resource': 'landing:main',
                                    'candidate': SHA_C, 'base': SHA_B}),
    'orgtree_resource_reservation': ('kid', {'action': 'acquire', 'resource': 'other',
                                             'candidate': SHA_C, 'base': SHA_B}),
    # a file dog on a path inside the owner's own scratch (contained)
    'orgtree_watchdog': ('mid', {'action': 'create', 'name': 'w', 'kind': 'file',
                                 'target': 'watch.txt', 'pattern': 'DONE'}),
    'orgtree_request_credits': ('top', {'new_limit': 40, 'reason': 'more work'}),
}


def tearDownModule() -> None:
    root.cleanup()


class KioskExempt(unittest.TestCase):
    seq = 0

    def setUp(self) -> None:
        type(self).seq += 1
        org = store.create_org(f'pg3ckiosk{self.seq}')
        self.slug = str(org.d['slug'])
        org.hire(ledger.USER, None, 'haiku', 20, 'top')
        org.hire(ledger.USER, 'top', 'haiku', 6, 'mid')
        org.hire(ledger.USER, 'mid', 'haiku', 2, 'kid')
        holds = org.audit()['top_level_holds']
        # an operator LOWERED the cap below what the org already holds
        org.d['kiosk'] = {'credits': max(1, int(holds) - 5)}
        self.assertGreater(holds, org.d['kiosk']['credits'], 'fixture: the org must be over its cap')
        store.save_org(org)
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN']
                       for n in ('top', 'mid', 'kid')}
        self.client = TestClient(app, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.enterContext(patch.object(api.supervisor, 'send_message', return_value={'delivered': True}))
        self.enterContext(patch.object(api, 'mail_notify'))
        self.enterContext(patch.object(api, 'hub_changed'))

    def durable(self) -> dict:
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        return json.loads(json.dumps(store.load_org(self.slug).d))

    def facts(self, d: dict) -> dict:
        """Everything the cap can read."""
        return {'nodes': {k: {f: v.get(f) for f in rcdoor.HOLDS_FIELDS}
                          for k, v in d['nodes'].items()},
                'tiers': d.get('tiers')}

    def call(self, tool: str, actor: str, args: dict):
        return self.client.post('/api/agent', json=dict(org=self.slug, node=actor, tool=tool, args=args),
                                headers={'X-Orgtree-Agent-Token': self.tokens[actor]})

    def test_every_exempt_tool_leaves_the_cap_inputs_untouched(self) -> None:
        self.assertEqual(set(CALLS), set(rcdoor.KIOSK_EXEMPT), 'every exempt tool needs a proof call')
        # the list the door AND the cycle read is pgdoor's; rcdoor declares
        # into it — they must be the same set, or the proof covers the wrong one
        from orgtree import pgdoor
        self.assertEqual({t for t in pgdoor.KIOSK_EXEMPT if t in rcdoor.TOOLS},
                         set(rcdoor.KIOSK_EXEMPT))
        for tool, (actor, args) in CALLS.items():
            with self.subTest(tool=tool):
                before = self.durable()
                holds = store.load_org(self.slug).audit()['top_level_holds']
                r = self.call(tool, actor, args)
                self.assertEqual(r.status_code, 200, r.text)
                after = self.durable()
                self.assertEqual(self.facts(before), self.facts(after))
                self.assertEqual(store.load_org(self.slug).audit()['top_level_holds'], holds)
                self.assertNotEqual(before, after, f'{tool} wrote nothing: not a proof')

    def test_control_a_funding_tool_is_still_capped(self) -> None:
        r = self.call('orgtree_reallocate', 'top', {'node': 'mid', 'delta': 1})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn('kiosk credit cap', r.json()['detail'])


if __name__ == '__main__':
    unittest.main()
