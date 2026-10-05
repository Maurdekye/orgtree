"""Native feed replacement and transport reads on disposable PostgreSQL."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest
import uuid

import test_orgdb_compat_pg as fixture
from orgtree import pgfeed
from orgtree.orgdb import record_reads as Q, record_transport as T
from orgtree.orgdb.record_registry import Entity, Registry, Selection

setUpModule = fixture.setUpModule
tearDownModule = fixture.tearDownModule


@fixture.needs_pg
class Transport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = fixture.Twins('record transport')
        cls.database = fixture.registry.lookup(cls.twin.copy)[1]

    def test_real_adapter_observes_replaced_identity_without_revision_or_later_write(self):
        with fixture.storage(True):
            session = pgfeed.orgdb_conn()
            self.addCleanup(session.close)
            calls = []
            feed = pgfeed.RevisionFeed(lambda:session,lambda *args:calls.append(args))
            feed._read_all(session,'catchup')
            old = session.identity(self.twin.copy)
            revision = feed.last_seen(self.twin.copy)
            with fixture.dbconn.connect(fixture.ADMIN,self.database) as raw:
                replacement = str(uuid.uuid4())
                raw.execute('UPDATE orgtree.org_identity SET incarnation=%s',(replacement,))
            calls.clear()
            feed._read_all(session,'poll')
            self.assertIn((self.twin.copy,revision,True),calls)
            self.assertEqual(session.identity(self.twin.copy),(old[0],replacement))
            self.assertEqual(feed.last_seen(self.twin.copy),revision)
            with Q.snapshot(self.twin.copy) as state:
                self.assertEqual(Q.cursor(state).incarnation,replacement)
                self.assertEqual(Q.cursor(state).rev,revision)

    def test_all_socket_answers_use_explicit_same_repeatable_read_connection(self):
        registry = Registry()
        seen = []
        def members(state,selection):
            seen.append(state.raw)
            return frozenset(row[0] for row in state.raw.execute(
                "SELECT id::text FROM orgtree.agents WHERE name='dev' AND NOT tombstone"))
        def bodies(state,ids):
            seen.append(state.raw)
            return {key:dict(title=title) for key,title in state.raw.execute(
                'SELECT id::text,title FROM orgtree.agents WHERE id=ANY(%s::bigint[])',(list(ids),))}
        registry.register(Entity('agent',members,bodies))
        requests = {'a':T.SocketRequest((Selection(),Selection('sub:1')),frozenset((1,))),
                    'b':T.SocketRequest((Selection(),Selection('sub:2')),frozenset((2,)))}
        with fixture.storage(True),Q.snapshot(self.twin.copy) as state:
            isolation = state.raw.execute('SHOW transaction_isolation').fetchone()[0]
            readonly = state.raw.execute('SHOW transaction_read_only').fetchone()[0]
            result = T.read_snapshot(registry,state,Q.cursor(state),requests)
            self.assertEqual((isolation,readonly),('repeatable read','on'))
            self.assertTrue(seen)
            self.assertTrue(all(raw is state.raw for raw in seen))
            self.assertEqual(result.answers['a'][0]['rev'],result.answers['b'][0]['rev'])
            self.assertEqual(result.answers['a'][0]['rev'],result.cursor.rev)
            self.assertEqual(result.answers['a'][0]['records'][0]['set'],'sub:1')
            self.assertEqual(result.answers['b'][0]['records'][0]['set'],'sub:2')


if __name__ == '__main__':
    unittest.main()
