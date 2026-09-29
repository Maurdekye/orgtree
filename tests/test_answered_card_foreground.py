"""The answered-card linger through the FOREGROUND context, which is what the
desk actually draws from (GET /foreground-tree -> foreground_view ->
ForegroundContext.tree_node -> Org.node_ask bound to the context).

Adopted from review-astra's probe of ed144be (item v3-an-old-answered-
question-card-reappears-in-th). That candidate read the archived predecessor
bearer, which the context neither exposes (AttributeError) nor holds (only the
selected live rows), so the fix now reads `session_began_at` off the live node.

  1. a recently answered card on a node never split renders through the
     context exactly as on the whole Org (no AttributeError);
  2. after a cheap compaction the context hides it as the whole Org does,
     although the archived bearer is not one of its rows.

Run:  python tools/run-python-verification.py tests/test_answered_card_foreground.py
"""
import copy
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix="orgtree-answered-card-fg-")
os.environ["ORGTREE_DATA"] = str(Path(_temp.name) / "data")
Path(os.environ["ORGTREE_DATA"]).mkdir()
os.environ["ORGTREE_V2_TOKEN"] = "answered-card-fg"

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout
from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import ledger                                           # noqa: E402
from orgtree.foreground_context import ForegroundContext             # noqa: E402


def tearDownModule() -> None:
    _temp.cleanup()


def at(seconds_ago):
    d = datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def context_for(org, include):
    """A ForegroundContext over the `include` rows only, built the way
    tests/test_foreground_context.py builds one."""
    org = ledger.Org(copy.deepcopy(org.d))
    graph = {'stamp': {'cost': str(sum(n.get('cost_usd', 0) for n in org.nodes.values())),
                       'cost_unknown': False},
             'rows': {nid: {'node': n, 'ordinal': i}
                      for i, (nid, n) in enumerate(org.nodes.items()) if nid in include}}
    funding = [dict(id=nid, **{k: n[k] for k in ('parent', 'state', 'model', 'grant')})
               for nid, n in org.nodes.items() if n['state'] != 'archived']
    settings = {k: copy.deepcopy(v) for k, v in org.d.items() if k not in ('nodes', 'events')}
    windows = {'asks': {s: copy.deepcopy(org.d.get(s, []))
                        for s in ('asks', 'credit_requests', 'scope_requests')},
               'documents': {}, 'document_counts': {}}
    return ForegroundContext(settings=settings, graph=graph, funding=funding, windows=windows,
                             inbox={'total': 0, 'unread': 0, 'entries': []},
                             work_counts={'active': 0, 'attention': 0, 'archived': 0,
                                          'backlogged': 0})


def answered_org():
    org = ledger.Org.create('answered card fg')
    org.hire(ledger.USER, None, 'haiku', 30, 'agent')
    org.ask_user('agent', 'Proceed?')
    a = org.d['asks'][-1]
    a['status'] = 'answered'
    a['resolved_at'] = at(120)
    return org


class ForegroundCard(unittest.TestCase):
    def setUp(self):
        boot = at(3600)                     # one long-lived process
        p = patch.object(ledger.Org, '_boot_at', staticmethod(lambda: boot))
        p.start()
        self.addCleanup(p.stop)

    def test_1_answered_card_renders_through_the_foreground_context(self):
        org = answered_org()
        self.assertIsNotNone(org.node_ask('agent'), 'fixture: whole Org shows the card')
        view = context_for(org, {'agent'})
        self.assertEqual(view.node_ask('agent'), org.node_ask('agent'))

    def test_2_after_cheap_compaction_foreground_matches_whole_org(self):
        org = answered_org()
        org.cheap_compact(ledger.USER, 'agent')
        self.assertTrue(org.nodes['agent'].get('session_began_at'),
                        'fixture: the compaction stamped the live node')
        org.nodes['agent']['session_began_at'] = at(60)
        self.assertIsNone(org.node_ask('agent'), 'fixture: whole Org hides it')
        view = context_for(org, {'agent'})  # the archived bearer is not a row
        self.assertIsNone(view.node_ask('agent'))


if __name__ == '__main__':
    unittest.main()
