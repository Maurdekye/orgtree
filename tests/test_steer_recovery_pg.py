"""Steer recovery on disposable per-org PostgreSQL, with real lock contention."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import unittest
from unittest.mock import patch
import test_orgdb_compat_pg as f
from orgtree import mailruntime, orgtx, supervisor as sup

setUpModule = f.setUpModule
tearDownModule = f.tearDownModule


@f.needs_pg
class SteerRecovery(unittest.TestCase):
    def setUp(self):
        def seed(slug):
            org = f.store.load_org(slug)
            for name, node in org.nodes.items():
                node['session_id'] = 'test-session-' + name
                org.mailbox_identity(name)
            org.d['steer_attempts'] = {}
            org.d['mail'] = {}
            org.d['delivering'] = {}
            org.d['asks'] = []
            mail = [dict(id='first', body='first message', at=f.AT, **{'from': 'boss'}),
                    dict(id='second', body='second message', at=f.AT, **{'from': 'boss'})]
            sup._journal_drain(org, 'dev', mail, [], via='steer')
            f.store.save_org(org)
        twin = f.Twins('steer recovery ' + self._testMethodName, seed)
        self.slug = twin.copy
        self.enterContext(f.storage(True))
        self.st = sup.state(self.slug, 'dev')
        self.addCleanup(sup._state.pop, (self.slug, 'dev'), None)
        self.tok = f.store.load_org(self.slug).d['delivering']['dev'][0]['tok']
        self.carrier = {'text': 'first message\nsecond message', 'toks': [self.tok], 'view': ''}
        self.st.update(busy=True, responding=True, steer=[self.carrier])

    def restart(self):
        sup._state.pop((self.slug, 'dev'))
        self.st = sup.state(self.slug, 'dev')
        with orgtx.org_tx(self.slug, whole=True) as tx:
            return sup._reconcile_mail_journal(tx.org, owners_gone=lambda row: True)

    def test_unrecorded_hook_claim_restarts_in_order_without_grace_delay(self):
        did, texts = sup.claim_steer(self.slug, 'dev', 'tool-before-restart')
        self.assertTrue(did)
        self.assertEqual(len(texts), 1)
        sup.ack_steer(self.slug, 'dev', did, 'tool-before-restart')
        self.assertEqual(self.restart(), {self.tok})
        org = f.store.load_org(self.slug)
        self.assertEqual([m['id'] for m in org.d['mail']['dev']], ['first', 'second'])
        self.assertEqual([m['redelivered'] for m in org.d['mail']['dev']], [1, 1])
        self.assertFalse(self.restart())

    def test_confirmed_hook_claim_is_not_replayed(self):
        did, _ = sup.claim_steer(self.slug, 'dev', 'recorded-tool')
        self.assertTrue(did)
        self.assertIsNotNone(sup._scan_steer_commit(self.slug, 'dev', {did: 'recorded-tool'}))
        self.assertFalse(self.restart())
        org = f.store.load_org(self.slug)
        self.assertFalse((org.d.get('delivering') or {}).get('dev'))
        self.assertFalse((org.d.get('mail') or {}).get('dev'))

    def test_restart_before_any_injection_recovers_immediately(self):
        self.assertEqual(self.restart(), {self.tok})
        org = f.store.load_org(self.slug)
        self.assertEqual([m['id'] for m in org.d['mail']['dev']], ['first', 'second'])

    def test_real_pg_lock_timeout_keeps_carrier_for_next_poll_and_turn(self):
        database = f.registry.lookup(self.slug)[1]
        with f.dbconn.connect(f.ADMIN, database) as blocker:
            blocker.execute('BEGIN')
            blocker.execute("SELECT id FROM orgtree.agents WHERE name='dev' FOR UPDATE")
            with patch.object(orgtx, 'DEFAULT_LOCK_TIMEOUT_S', 0.1), patch('builtins.print') as log:
                self.assertEqual(sup._pump_steer(self.slug, 'dev'), [])
                self.assertTrue(any('LockTimeout' in str(c) for c in log.call_args_list),
                                str(log.call_args_list))
            self.assertEqual(self.st['steer'], [self.carrier])
            blocker.execute('ROLLBACK')
        self.assertEqual(sup._pump_steer(self.slug, 'dev'), [self.carrier])
        # Provider rejects because its turn has ended: the same journal goes
        # through ordinary next-turn delivery and positive confirmation once.
        self.st['queue'].append(self.carrier)
        self.st['responding'] = False
        sup._fold_steer(self.st)
        self.assertEqual(self.st['queue'], [self.carrier])
        sup._confirm_delivered(self.slug, 'dev', [self.tok])
        self.assertFalse(self.restart())

    def test_inflight_fetch_and_chunk_keep_pg_delivery_journal_intact(self):
        org = f.store.load_org(self.slug)
        self.st['lifecycle_operation_id'] = 'running-attempt'
        mailruntime.register(self.st, org, 'dev', attempt='running-attempt', toks=[])
        result = sup.manual_fetch(self.slug, 'dev', 0, ['second', 'first'])
        self.assertTrue(result['ok'], result)
        self.assertEqual([item['content'] for item in result['fetched']],
                         ['second message', 'first message'])
        self.assertTrue(all(item['inflight_read'] for item in result['fetched']))
        self.assertEqual(f.store.load_org(self.slug).d['delivering']['dev'],
                         org.d['delivering']['dev'])
        for item in result['fetched']:
            chunk = sup.manual_fetch_chunk(self.slug, 'dev', 0,
                item['delivery_id'], item['message_id'], 0)
            self.assertEqual(chunk['content'], item['content'])


if __name__ == '__main__':
    unittest.main()
