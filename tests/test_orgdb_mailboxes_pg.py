"""Native archive bounds: exact legacy ordinals, bounded sends and transactional writers.

Needs a disposable PostgreSQL via ORGTREE_TEST_PG_ADMIN_URL/RUNTIME_URL.
The shared compatibility fixture creates and removes only its own databases.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import contextlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as fixture
import racekit
from orgtree import ledger, mailtx, orgtx, pgstore, restart_wake, store
from orgtree.orgdb import conn as dbconn, registry

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


def seed(slug, values):
    org = store.load_org(slug)
    org.d['mail_log'] = {'dev': [dict(id=f'old-{i}', recv_seq=v, body='old',
                                    at=fixture.AT, **{'from': 'boss'})
                               for i, v in enumerate(values)]}
    org.d['mail'] = {'dev': []}
    org.d['nodes']['dev']['mail_seq'] = 0
    store.save_org(org)


@contextlib.contextmanager
def no_archive_load():
    original = store.SectionMap._load_owner

    def guarded(section, owner):
        if section._sect == 'mail_log':
            raise AssertionError('deposit loaded the retained archive')
        return original(section, owner)

    with patch.object(store.SectionMap, '_load_owner', guarded):
        yield


@fixture.needs_pg
class Mailboxes(unittest.TestCase):
    def twin(self, values=range(1, 10)):
        return fixture.Twins('mailboxes', before=lambda s: seed(s, values))

    def query(self, twin, sql, params=()):
        with dbconn.connect(fixture.ADMIN, registry.lookup(twin.copy)[1]) as c:
            return c.execute(sql, params).fetchall()

    def present(self, twin):
        self.assertEqual(self.query(twin, "SELECT to_regclass('orgtree.mailboxes') IS NOT NULL"),
                         [(True,)], 'the native mailbox row must exist')

    def bound(self, twin, owner='dev'):
        rows = self.query(twin, 'SELECT version,nrows,next_recv_seq-1 FROM orgtree.mailboxes m '
                          'JOIN orgtree.agents a ON a.id=m.agent_id WHERE a.name=%s', (owner,))
        return tuple(map(int, rows[0])) if rows else (0, 0, 0)

    def send(self, twin, mid='new', owner='dev', **kw):
        with orgtx.org_tx(twin.copy, **mailtx.send_rows(owner)) as tx:
            return dict(tx.org.deposit_mail(owner, dict(id=mid, body=mid, **{'from': 'boss'}), **kw))

    def test_conversion_preserves_unbounded_and_misfit_ordinals(self):
        values = [1, 17, True, False, 0, -1, 4.0, '88', None, 2**63, 10**100]
        t = self.twin(values)
        self.present(t)
        self.assertEqual(self.bound(t)[1:], (len(values), 10**100))
        with fixture.storage(False):
            with orgtx.org_tx(t.legacy, **mailtx.send_rows('dev')) as tx:
                want = dict(tx.org.deposit_mail('dev', {'id': 'new', 'body': 'new', 'from': 'boss'}))
        with fixture.storage(True), no_archive_load():
            got = self.send(t)
            self.assertEqual(got['recv_seq'], want['recv_seq'])
            self.assertEqual(got['recv_seq'], 10**100 + 1)
            self.assertEqual(self.send(t, 'again')['recv_seq'], 10**100 + 2)
        self.assertEqual(self.bound(t)[1:], (len(values)+2, 10**100+2))

    def test_send_and_restart_supersede_without_loading_or_trimming_archive(self):
        t = self.twin(range(1, 301))
        self.present(t)
        with fixture.storage(True), no_archive_load():
            self.assertEqual(self.send(t)['recv_seq'], 301)
            for n in range(2):
                with orgtx.org_tx(t.copy, **restart_wake._notice_rows(['dev'])) as tx:
                    row = tx.org.deposit_mail('dev', {'id': f'restart-{n}', 'kind': 'notice',
                                              'body': 'restart', 'from': 'orgtree'},
                                              supersede=lambda m: m.get('kind') == 'notice')
                    self.assertEqual(row['recv_seq'], 302+n)
        self.assertEqual(self.bound(t)[1:], (303, 303))
        with fixture.storage(True):
            doc = fixture.document(t.copy)
        self.assertEqual(len(doc['mail_log']['dev']), 303)
        self.assertEqual([r['id'] for r in doc['mail_log']['dev'][:300]],
                         [f'old-{i}' for i in range(300)])
        self.assertEqual([r['id'] for r in doc['mail']['dev']], ['new', 'restart-1'])

    def test_deposit_examined_rows_are_flat_at_ten_times_archive_history(self):
        measurements = []
        for scale in (1, 10):
            t = self.twin(range(1, 101*scale))
            self.present(t)
            with no_archive_load():
                seen = fixture.recorded_with_params(lambda: self.send(t))
            reads = [(q, p) for q, p in seen if q.lstrip().upper().startswith('SELECT')]
            self.assertTrue(any('FROM orgtree.mailboxes ' in q for q, _ in reads), reads)
            self.assertFalse(any('orgtree.mail_log' in q for q, _ in reads), reads)
            blocks = [q for q, _ in seen if q.startswith('DO $orgtx_')]
            self.assertEqual(len(blocks), 1)
            self.assertIn('orgtree.mailboxes', blocks[0])
            self.assertNotIn('orgtree.mail_log', blocks[0])
            scans = []
            with dbconn.connect(fixture.ADMIN, registry.lookup(t.copy)[1], autocommit=False) as c:
                c.execute('ANALYZE')
                for q, params in reads:
                    plan = c.execute('EXPLAIN (ANALYZE,FORMAT JSON) '+q, params).fetchone()[0][0]['Plan']
                    scans.append(fixture.plan_examined(plan))
                    self.assertEqual(fixture.plan_scans(plan, 'mail_log'), [], q)
                c.rollback()
            measurements.append(scans)
        self.assertTrue(measurements[0], 'no hot read was measured')
        self.assertEqual(measurements[1], measurements[0], 'mail history increased examined rows')

    def test_archive_edits_deletes_and_rewrites_keep_exact_bounds(self):
        t = self.twin()
        self.present(t)
        operations = [lambda d: d['mail_log']['dev'][0].__setitem__('recv_seq', 77),
                      lambda d: d['mail_log']['dev'].pop(0),
                      lambda d: d['mail_log'].__setitem__('dev', [{'id': 'rewrite', 'recv_seq': 40}]),
                      lambda d: d['mail_log']['dev'].clear(),
                      lambda d: d['mail_log'].pop('dev')]
        previous = self.bound(t)[0]
        for change in operations:
            t.edit(change)
            t.compare(self, 'archive edit/delete/rewrite')
            with fixture.storage(False):
                rows = fixture.document(t.legacy).get('mail_log', {}).get('dev', [])
            high = max([0]+[ledger.Org._recv_ordinal(r.get('recv_seq')) or 0 for r in rows])
            bound = self.bound(t)
            self.assertEqual(bound[1:], (len(rows), high))
            if rows or bound[1:] != (0, 0):
                self.assertGreater(bound[0], previous)
            previous = bound[0]

    def test_archive_body_edit_invalidates_buffer_even_with_same_count_and_maximum(self):
        t = self.twin()
        self.present(t)
        before = self.bound(t)
        with fixture.storage(True):
            with self.assertRaises(store.StaleWrite):
                with orgtx.org_tx(t.copy, **mailtx.send_rows('dev')) as tx:
                    tx.org.deposit_mail('dev', {'id': 'refused'})
                    c = store._orgtx_local.pinned[t.copy]
                    seq, raw = c.execute("SELECT seq, val FROM log_d WHERE sect=? AND owner=? ORDER BY seq",
                                         ('mail_log', 'dev')).fetchone()
                    altered = dict(json.loads(raw), body='same count and ordinal, changed body')
                    self.assertEqual(c.execute('UPDATE log_d SET at=?, val=? WHERE seq=? AND val=?',
                                               (altered.get('at'), json.dumps(altered), seq, raw)).rowcount, 1)
            self.assertEqual(self.bound(t), before)
            self.assertEqual(self.send(t)['recv_seq'], 10)

    def test_save_failure_rolls_back_archive_summary_and_node_sequence(self):
        t = self.twin()
        self.present(t)
        from orgtree.orgdb.compat import mailboxes
        original = mailboxes.advance

        def fail_after_advance(*args):
            original(*args)
            raise RuntimeError('after summary advance')

        before = self.bound(t)
        with fixture.storage(True):
            with patch.object(mailboxes, 'advance', fail_after_advance):
                with self.assertRaisesRegex(RuntimeError, 'after summary advance'):
                    self.send(t, 'refused')
            self.assertEqual(self.bound(t), before)
            self.assertEqual(store.load_org(t.copy).node('dev')['mail_seq'], 0)
            self.assertEqual(self.send(t)['recv_seq'], 10)

    def test_missing_empty_owner_and_migration_backfill_use_exact_legacy_domain(self):
        values = [2**63, 10**90, 4.0, True, '99', 0, -1, None]
        t = self.twin(values)
        self.present(t)
        # Migration of an already-populated development database must also work.
        migration = Path(__file__).resolve().parents[1] / 'engine/backend/orgtree/pg_migrations/org/0013_mailboxes.sql'
        with dbconn.connect(fixture.ADMIN, registry.lookup(t.copy)[1], autocommit=False) as c:
            c.execute('UPDATE orgtree.mail_log SET extra=%s::json WHERE public_id=%s',
                      (json.dumps({'recv_seq': 10**90, 'unrelated': 'nul\u0000text'}), 'old-1'))
            c.execute('DROP TABLE orgtree.mailboxes')
            c.execute(migration.read_text(encoding='utf-8'))
            c.commit()
        self.assertEqual(self.bound(t)[1:], (len(values), 10**90))
        self.assertEqual(self.bound(t, 'boss'), (0, 0, 0))
        with fixture.storage(True), no_archive_load():
            self.assertEqual(self.send(t, owner='boss')['recv_seq'], 1)
        self.assertEqual(self.bound(t, 'boss')[1:], (1, 1))

    def test_tombstone_rehire_and_org_trash_restore_preserve_archive_floor(self):
        t = self.twin()
        self.present(t)
        t.edit(lambda d: d['nodes'].pop('dev'))
        self.assertEqual(self.bound(t)[1:], (9, 9))
        t.edit(lambda d: d['nodes'].__setitem__('dev', fixture.node('dev', 'boss')))
        t.compare(self, 'tombstone then same-name node')
        before = self.bound(t)
        registry.close_idle()
        org_id = registry.lookup(t.copy)[0]
        fixture.LC[0].trash(org_id)
        fixture.LC[0].restore(org_id)
        self.assertEqual(self.bound(t), before)
        with fixture.storage(True), no_archive_load():
            self.assertEqual(self.send(t)['recv_seq'], 10)

    def test_concurrent_deposits_wait_and_assign_consecutive_ordinals(self):
        t = self.twin()
        self.present(t)
        # racekit's proof database is separate from the native target; both are private.
        proof = racekit.disposable_pg(fixture.ADMIN, 'mailbox_race')
        old_url = os.environ['ORGTREE_PG_URL']
        old_hooks = os.environ.get('ORGTREE_ORGTX_TEST_HOOKS')
        os.environ.update(ORGTREE_PG_URL=proof, ORGTREE_ORGTX_TEST_HOOKS='1')
        try:
            with fixture.storage(True), racekit.Race(pair='converted') as race:
                a = race.actor('A', self.send, t, 'sender-a')
                b = race.actor('B', self.send, t, 'sender-b')
                held = race.hold(a, 'after_lock')
                race.start(a)
                race.reached(held)
                race.start(b)
                race.blocked(b)
                race.release(held)
                race.join(a, b)
                self.assertEqual((a.result['recv_seq'], b.result['recv_seq']), (10, 11))
                race.expect_order('A.after_commit', 'B.after_lock')
            # A holds ONLY the mailbox row, so this proves B takes that row too.
            with fixture.storage(True), racekit.Race(pair='converted') as race:
                def hold_mailbox():
                    reg = registry.lookup(t.copy)
                    c = registry.checkout(t.copy, reg[1], reg[3])
                    try:
                        c.execute('BEGIN')
                        c.execute('SELECT 1 FROM orgtree.mailboxes m JOIN orgtree.agents a '
                                  "ON a.id=m.agent_id WHERE a.name='dev' FOR UPDATE OF m")
                        race.mark('mailbox-held')
                        race.mark('mailbox-releasing')
                        c.execute('COMMIT')
                    finally:
                        registry.release(c, reg[1])
                a = race.actor('A', hold_mailbox)
                b = race.actor('B', self.send, t, 'sender-c')
                held = race.hold(a, 'mailbox-held')
                race.start(a)
                race.reached(held)
                race.start(b)
                race.blocked(b)
                self.assertIn('postgres Lock/transactionid', race.blocked_on['B'])
                race.release(held)
                race.join(a, b)
                race.expect_order('A.mailbox-releasing', 'B.after_lock')
                self.assertEqual(b.result['recv_seq'], 12)
        finally:
            os.environ['ORGTREE_PG_URL'] = old_url
            if old_hooks is None:
                os.environ.pop('ORGTREE_ORGTX_TEST_HOOKS', None)
            else:
                os.environ['ORGTREE_ORGTX_TEST_HOOKS'] = old_hooks
            pgstore.close_idle()
            racekit.drop_disposable_pg(fixture.ADMIN, proof)


if __name__ == '__main__':
    unittest.main()
