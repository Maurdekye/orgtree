"""Real docket-save/agent-transaction lock interactions on disposable PostgreSQL.

The barriers only choose an interleaving; every write and row lock is the
production implementation. Run through the repository verification runner
under the heavy P03 lock, with an owned disposable cluster.
"""

import import_provenance  # noqa: F401  asserts this checkout before engine imports

import threading
import time
import unittest
from unittest.mock import patch

import test_orgdb_schema_rename_pg as f
from orgtree import orgtx, store
from orgtree.orgdb import registry
from orgtree.orgdb.compat import rows as R


def setUpModule():
    f.setUpModule()


def tearDownModule():
    f.tearDownModule()


def errors(error):
    result = []
    while error is not None:
        result.append((type(error).__name__, getattr(error, 'sqlstate', None), str(error)))
        error = error.__cause__
    return result


@f.f.needs_pg
class DocketAgentLocks(unittest.TestCase):
    def overlap(self, *, changed_roles=False):
        twins = f.f.Twins('docket-agent-' + self._testMethodName, before=f.prepare_legacy)
        ready, release = threading.Event(), threading.Event()
        outcomes, pids, blocked_queries = {}, {}, []
        real_write, real_checkout = R._docket_write, registry.checkout
        agent = 'owner' if changed_roles else 'worker'

        def checkout(*args, **kwargs):
            raw = real_checkout(*args, **kwargs)
            name = threading.current_thread().name
            if name in ('agent-writer', 'docket-writer'):
                pids[name] = raw.info.backend_pid
            return raw

        def docket_write(c, record, keys, previous):
            if threading.current_thread().name == 'docket-writer' and record.get('title') == 'B title':
                ready.set()
                if not release.wait(12):
                    raise RuntimeError('docket scheduling barrier expired')
            return real_write(c, record, keys, previous)

        def observe(name, fn):
            try:
                fn()
                outcomes[name] = ('committed', [])
            except BaseException as error:
                outcomes[name] = ('raised', errors(error))

        with f.f.storage(True):
            original = store.load_org(twins.copy)
            record = f.item(original, 'owned-item')
            record['title'] = 'B title'
            if changed_roles:
                # Reach every immediate current-role FK, with newly authored
                # identities rather than only the unchanged holder rewrite.
                holder = original._work_holder(agent)
                record['owner'] = holder.copy()
                record['reviewer'] = holder.copy()
                record['holders'][0].update(holder)
                seat = record['review_seats'][0]
                seat.update(reviewer=agent, holder=holder.copy(), recheck_owner=holder.copy())
                record['artifacts'][0]['grants'][0]['to'] = agent

            def agent_save():
                with orgtx.org_tx(twins.copy, nodes=[agent], sections=['work_items'],
                                  lock_timeout=10, retries=0) as tx:
                    tx.d['nodes'][agent]['title'] = 'A agent'
                    next(row for row in tx.d['work_items']
                         if row['slug'] == 'owned-item')['title'] = 'A title'

            with patch.object(R, '_docket_write', docket_write), patch.object(registry, 'checkout', checkout):
                docket = threading.Thread(name='docket-writer', target=observe,
                                          args=('docket', lambda: store.save_org(original)))
                agent_thread = threading.Thread(name='agent-writer', target=observe,
                                                args=('agent', agent_save))
                try:
                    docket.start()
                    self.assertTrue(ready.wait(10), outcomes)
                    agent_thread.start()
                    deadline = time.monotonic() + 7
                    with registry.connection(twins.copy) as monitor:
                        while time.monotonic() < deadline:
                            if 'agent-writer' in pids and 'docket-writer' in pids:
                                row = monitor.execute(
                                    'SELECT pg_blocking_pids(pid),query FROM pg_stat_activity WHERE pid=%s',
                                    (pids['agent-writer'],)).fetchone()
                                if row is not None and pids['docket-writer'] in row[0]:
                                    blocked_queries.append(row[1])
                                    break
                            time.sleep(.01)
                        else:
                            self.fail('agent writer never waited on docket writer: ' + repr((pids, outcomes)))
                finally:
                    release.set()
                    if agent_thread.ident:
                        agent_thread.join(25)
                    docket.join(25)
                self.assertFalse(agent_thread.is_alive() or docket.is_alive(), outcomes)
                self.assertTrue(blocked_queries, outcomes)
                sqlstates = [e[1] for _, caught in outcomes.values() for e in caught]
                self.assertNotIn('40P01', sqlstates, outcomes)
                self.assertEqual(outcomes, {'docket': ('committed', []), 'agent': ('committed', [])})
            reloaded = store.load_org(twins.copy)
            self.assertEqual(f.item(reloaded, 'owned-item')['title'], 'A title')
            self.assertEqual(reloaded.nodes[agent]['title'], 'A agent')
            if changed_roles:
                saved = f.item(reloaded, 'owned-item')
                for role in ('owner', 'reviewer'):
                    self.assertEqual(saved[role]['node'], agent)
                self.assertEqual(saved['holders'][0]['node'], agent)
                self.assertEqual(saved['review_seats'][0]['recheck_owner']['node'], agent)
                self.assertEqual(saved['artifacts'][0]['grants'][0]['to'], agent)

    def test_title_only_ordinary_save_and_native_agent_docket_transaction_do_not_deadlock(self):
        self.overlap()

    def test_changed_seven_current_roles_and_native_agent_docket_transaction_do_not_deadlock(self):
        self.overlap(changed_roles=True)
