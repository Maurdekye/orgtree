"""ORGTREE_LAZY_ROWS: node rows and split-section owner rows load when touched.

Actual PostgreSQL (disposable, via test_pgstore); the switch is patched ON
here (it is ON by default; ORGTREE_LAZY_ROWS=0 turns it off). What these prove:
  * a whole load for a stale heal epoch heals and stamps; after that loads
    read no node or owner row until one is touched;
  * DATA LOSS: rows never decoded are byte-identical after saves around
    them; a decoded row's edit, replacement and deletion all reach storage;
    a walk after a delete does not resurrect the row; a section replaced
    wholesale is refused, not silently half-saved;
  * the per-row heals equal the whole-load heals on legacy shapes;
  * an undeclared lazily fetched row is still refused (UnlockedWrite);
  * walks count a fallback and call the harness hook; declared nodes are
    fetched in ONE statement.

Run:  python tools/run-python-verification.py tests/test_pg_lazy_rows.py
"""
import contextlib
import copy
import json
import unittest
import uuid
from unittest.mock import patch

import test_pgstore as f
from orgtree import ledger, orgtx, pgstore, store


def tearDownModule():
    f.tearDownModule()


def node(nid, **extra):
    return {'id': nid, 'name': nid, 'parent': None, 'children': [], 'payload': {'v': 1}, **extra}


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class LazyRows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        flags = patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True)
        flags.start()
        self.addCleanup(flags.stop)
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        org = store.create_org('lazy-' + uuid.uuid4().hex[:10])
        self.slug = org.d['slug']
        for i in range(30):
            org.d['nodes'][f'n{i}'] = node(f'n{i}')
        org.d['mail'] = {f'n{i}': [{'id': f'm{i}', 'body': f'hello {i}'}] for i in range(10)}
        org.d['notices'] = {f'n{i}': [{'id': f'x{i}', 'body': 'note'}] for i in range(10)}
        store.save_org(org)
        with pgstore.connect() as raw:
            self.oid = raw.execute('SELECT org_id FROM public.orgs WHERE slug=%s',
                                   (self.slug,)).fetchone()[0]

    # -- helpers ----------------------------------------------------------
    @contextlib.contextmanager
    def raw(self):
        with pgstore.connect() as raw:
            raw.execute('BEGIN')
            raw.execute(f'SET LOCAL search_path TO org_{self.oid},public')
            try:
                yield raw
            except BaseException:
                raw.execute('ROLLBACK')
                raise
            else:
                raw.execute('COMMIT')

    def rows(self):
        with self.raw() as raw:
            nodes = dict(raw.execute('SELECT id, val FROM nodes').fetchall())
            doc = dict(raw.execute('SELECT key, val FROM doc').fetchall())
        return nodes, doc

    def epoch(self):
        with self.raw() as raw:
            row = raw.execute("SELECT val FROM meta WHERE key='heal_epoch'").fetchone()
        return row[0] if row else None

    def stamp(self):
        """One org_tx: the whole load heals (committing its own heal save)
        and stamps the epoch."""
        with orgtx.org_tx(self.slug, nodes=['n0']):
            pass
        self.assertEqual(self.epoch(), store.heal_epoch())

    def stats(self):
        return dict(store.LAZY_ROWS_STATS)

    def delta(self, before):
        return {k: store.LAZY_ROWS_STATS.get(k, 0) - before.get(k, 0)
                for k in store.LAZY_ROWS_STATS}

    # -- epoch ------------------------------------------------------------
    def test_stale_epoch_loads_whole_heals_and_stamps_then_loads_lazily(self):
        self.assertIsNone(self.epoch())
        before = self.stats()
        self.stamp()
        self.assertGreaterEqual(self.delta(before)['epoch_fallbacks'], 1)
        # the heal the whole load found (these rows had no scope) was committed
        nodes, _ = self.rows()
        self.assertIn('scope', json.loads(nodes['n17']))
        before = self.stats()
        with orgtx.org_tx(self.slug, nodes=['n1']) as tx:
            nm = dict.get(tx.org.d, 'nodes')
            self.assertIsInstance(nm, store.LazyNodesMap)
            self.assertEqual(sorted(dict.keys(nm)), ['n1'], 'only the declared row is decoded')
            self.assertIsInstance(dict.get(tx.org.d, 'mail'), store.LazySplitSection)
            self.assertEqual(dict.__len__(dict.get(tx.org.d, 'mail')), 0)
        d = self.delta(before)
        self.assertEqual(d['loads'], 1)
        self.assertEqual(d['fallbacks'], 0)

    def test_a_legacy_row_is_healed_by_the_whole_load_even_when_untouched(self):
        with self.raw() as raw:
            raw.execute('UPDATE nodes SET val=%s WHERE id=%s',
                        (json.dumps(node('n20', purpose='legacy role')), 'n20'))
        self.stamp()                      # touches n0 only
        nodes, _ = self.rows()
        healed = json.loads(nodes['n20'])
        self.assertEqual(healed.get('charter'), 'legacy role')
        self.assertNotIn('purpose', healed)

    # -- data loss --------------------------------------------------------
    def test_rows_never_decoded_stay_byte_identical_around_saves(self):
        self.stamp()
        nodes0, doc0 = self.rows()
        with orgtx.org_tx(self.slug, nodes=['n0'], sections=[('mail', 'n0')]) as tx:
            tx.org.node('n0')['payload']['v'] = 2
            tx.org.d['mail']['n0'].append({'id': 'm0b', 'body': 'again'})
        view = store.load_runtime_org(self.slug)
        self.assertEqual(view.nodes['n5']['payload'], {'v': 1})
        nodes1, doc1 = self.rows()
        self.assertEqual(json.loads(nodes1['n0'])['payload'], {'v': 2})
        self.assertEqual(len(json.loads(doc1['mail\x1fn0'])), 2)
        changed_nodes = {k for k in nodes0 if nodes0[k] != nodes1.get(k)}
        changed_doc = {k for k in set(doc0) | set(doc1) if doc0.get(k) != doc1.get(k)}
        self.assertEqual(changed_nodes, {'n0'})
        self.assertEqual({k for k in changed_doc if '\x1f' in k}, {'mail\x1fn0'})
        self.assertEqual(set(nodes0), set(nodes1))

    def test_replacing_an_undecoded_node_updates_its_row(self):
        self.stamp()
        with orgtx.org_tx(self.slug, nodes=orgtx.ALL) as tx:   # ALL: no prefetch
            nm = dict.get(tx.org.d, 'nodes')
            self.assertFalse(dict.__contains__(nm, 'n3'), 'n3 must start undecoded')
            nm['n3'] = node('n3', payload={'v': 'replaced'})
        nodes, _ = self.rows()
        self.assertEqual(json.loads(nodes['n3'])['payload'], {'v': 'replaced'})
        self.assertEqual(len(nodes), 30)

    def test_deleting_an_undecoded_node_deletes_its_row(self):
        self.stamp()
        with orgtx.org_tx(self.slug, nodes=orgtx.ALL) as tx:
            nm = dict.get(tx.org.d, 'nodes')
            self.assertFalse(dict.__contains__(nm, 'n4'), 'n4 must start undecoded')
            del nm['n4']
        nodes, _ = self.rows()
        self.assertNotIn('n4', nodes)
        self.assertEqual(len(nodes), 29)

    def test_a_walk_after_a_delete_does_not_resurrect_the_row(self):
        self.stamp()
        with orgtx.org_tx(self.slug, nodes=orgtx.ALL) as tx:
            tx.org.d['nodes'].pop('n6')
            self.assertNotIn('n6', list(tx.org.d['nodes']))
        nodes, _ = self.rows()
        self.assertNotIn('n6', nodes)

    def test_owner_rows_delete_and_replace(self):
        self.stamp()
        _, doc0 = self.rows()
        with orgtx.org_tx(self.slug, sections=[('mail', 'n1'), ('mail', 'n2')]) as tx:
            mail = dict.get(tx.org.d, 'mail')
            del tx.org.d['mail']['n1']
            tx.org.d['mail']['n2'] = [{'id': 'new', 'body': 'replaced'}]
            self.assertIsInstance(mail, store.LazySplitSection)
        _, doc1 = self.rows()
        self.assertNotIn('mail\x1fn1', doc1)
        self.assertEqual(json.loads(doc1['mail\x1fn2']), [{'id': 'new', 'body': 'replaced'}])
        for i in range(3, 10):
            self.assertEqual(doc1[f'mail\x1fn{i}'], doc0[f'mail\x1fn{i}'])

    def test_a_section_replaced_wholesale_is_refused_and_nothing_lands(self):
        self.stamp()
        _, doc0 = self.rows()
        with self.assertRaisesRegex(ledger.LedgerError, 'replaced or removed wholesale'):
            with orgtx.org_tx(self.slug, sections=['mail']) as tx:
                tx.org.d['mail'] = {'n0': []}
        _, doc1 = self.rows()
        self.assertEqual(doc0, doc1)

    def test_an_undeclared_lazily_fetched_node_write_is_refused(self):
        self.stamp()
        nodes0, _ = self.rows()
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug, nodes=['n0']) as tx:
                tx.org.node('n7')['payload']['v'] = 'sneaky'
        nodes1, _ = self.rows()
        self.assertEqual(nodes0, nodes1)

    def test_a_runtime_view_reads_a_row_changed_after_its_load_and_counts_it(self):
        # decision A (2026-09-28): fresher, never an error, always counted
        self.stamp()
        seen = []
        view = store.load_runtime_org(self.slug)
        with orgtx.org_tx(self.slug, nodes=['n5'], sections=[('mail', 'n5')]) as tx:
            tx.org.node('n5')['payload']['v'] = 'later'
            tx.org.d['mail']['n5'].append({'id': 'late', 'body': 'after the load'})
        before = self.stats()
        with patch.object(store, 'LAZY_ROWS_HOOK', lambda kind, why: seen.append(kind)):
            self.assertEqual(view.nodes['n5']['payload'], {'v': 'later'})
            self.assertEqual([m['id'] for m in view.d['mail']['n5']], ['m5', 'late'])
            self.assertEqual(view.nodes['n6']['payload'], {'v': 1})       # unchanged
            self.assertEqual(view.d['mail']['n6'], [{'id': 'm6', 'body': 'hello 6'}])
        self.assertEqual(self.delta(before)['post_load_changes'], 2)
        self.assertEqual(seen, ['post_load_change', 'post_load_change'])

    def test_rows_read_inside_org_tx_are_never_counted_as_post_load(self):
        # a real post-load change: committed from ANOTHER connection after
        # the org_tx loaded and before the tx touches the row
        self.stamp()
        before = self.stats()
        with orgtx.org_tx(self.slug, nodes=['n0']) as tx:
            with self.raw() as raw:
                raw.execute('UPDATE nodes SET val=%s WHERE id=%s',
                            (store._dumps(dict(json.loads(self.rows()[0]['n11']),   # the store's encoding
                                               payload={'v': 'elsewhere'})), 'n11'))
            self.assertEqual(tx.org.nodes.get('n11')['payload'], {'v': 'elsewhere'})
        self.assertEqual(self.delta(before)['post_load_changes'], 0)

    # -- the mail drain path (pg-supervisor-a review, 2026-09-28) ----------
    def test_take_mail_of_an_undecoded_box_drains_it_and_deletes_the_row(self):
        self.stamp()
        with orgtx.org_tx(self.slug, nodes=['n3'], sections=[('mail', 'n3')]) as tx:
            self.assertFalse(dict.__contains__(dict.get(tx.org.d, 'mail'), 'n3'))
            got = tx.org.take_mail('n3')
            self.assertEqual(got, [{'id': 'm3', 'body': 'hello 3'}])
        _, doc = self.rows()
        self.assertNotIn('mail\x1fn3', doc)
        self.assertIn('mail\x1fn4', doc)

    def test_a_partial_drain_readded_box_survives_a_walk_and_is_stored(self):
        # supervisor._take_delivery_mail: take the box, put a remainder back
        self.stamp()
        rest = [{'id': 'rest', 'body': 'kept for later'}]
        with orgtx.org_tx(self.slug, nodes=['n4'], sections=[('mail', 'n4')]) as tx:
            self.assertEqual(len(tx.org.take_mail('n4')), 1)
            tx.org.d.setdefault('mail', {})['n4'] = rest
            # bookkeeping: a present owner is never also recorded as deleted
            self.assertNotIn('n4', dict.get(tx.org.d, 'mail')._deleted)
            self.assertIn('n4', list(tx.org.d['mail']))          # a walk
            self.assertEqual(len(tx.org.d['mail']), 10)
        _, doc = self.rows()
        self.assertEqual(json.loads(doc['mail\x1fn4']), rest)

    def test_a_drained_box_is_not_resurrected_by_a_walk(self):
        self.stamp()
        with orgtx.org_tx(self.slug, nodes=['n5'], sections=[('mail', 'n5')]) as tx:
            tx.org.take_mail('n5')
            self.assertNotIn('n5', list(tx.org.d['mail']))
        _, doc = self.rows()
        self.assertNotIn('mail\x1fn5', doc)
        self.assertEqual(sum(1 for k in doc if k.startswith('mail\x1f')), 9)

    def test_membership_and_get_use_the_real_operators_on_undecoded_nodes(self):
        self.stamp()
        view = store.load_runtime_org(self.slug)
        nm = dict.get(view.d, 'nodes')
        self.assertFalse(dict.__contains__(nm, 'n9'))
        self.assertTrue('n9' in view.nodes)
        self.assertFalse('nope' in view.nodes)
        self.assertEqual(view.nodes.get('n12')['payload'], {'v': 1})
        self.assertIsNone(view.nodes.get('nope'))
        box = view.d.get('mail') or {}
        self.assertTrue('n2' in box)
        self.assertEqual(box.get('n2'), [{'id': 'm2', 'body': 'hello 2'}])

    def test_a_node_deleted_then_readded_survives_a_walk(self):
        self.stamp()
        with orgtx.org_tx(self.slug, nodes=orgtx.ALL) as tx:
            nm = tx.org.d['nodes']
            del nm['n10']
            nm['n10'] = node('n10', payload={'v': 'again'})
            self.assertNotIn('n10', dict.get(tx.org.d, 'nodes')._deleted)
            self.assertIn('n10', list(nm))
        nodes, _ = self.rows()
        self.assertEqual(json.loads(nodes['n10'])['payload'], {'v': 'again'})
        self.assertEqual(len(nodes), 30)

    def test_a_section_saved_as_a_blob_deletes_every_owner_row(self):
        # a non-list box turns the section into one blob row: every stored
        # owner row must go, including the ones never decoded (encoding the
        # non-empty section calls items(), which decodes every owner before
        # the save diffs its baselines)
        self.stamp()
        with orgtx.org_tx(self.slug, sections=['mail']) as tx:
            tx.org.d['mail']['n1'] = 'not a list'
        _, doc = self.rows()
        self.assertEqual([k for k in doc if k.startswith('mail\x1f')], [])
        blob = json.loads(doc['mail'])
        self.assertEqual(blob['n1'], 'not a list')
        self.assertEqual(blob['n7'], [{'id': 'm7', 'body': 'hello 7'}])
        self.assertEqual(len(blob), 10)

    # -- serializers never emit an undecoded container as empty -------------
    def test_every_document_serializer_sees_undecoded_rows(self):
        import pickle
        from orgtree import statepreview
        self.stamp()
        whole = store.load_org(self.slug)
        want_mail = {k: list(v) for k, v in whole.d['mail'].items()}
        want_notices = {k: list(v) for k, v in whole.d['notices'].items()}
        want_nodes = sorted(whole.nodes)

        def check(doc, how):
            self.assertEqual(doc['mail'], want_mail, how)
            self.assertEqual(doc['notices'], want_notices, how)
            self.assertEqual(sorted(doc['nodes']), want_nodes, how)

        def fresh():
            view = store.load_runtime_org(self.slug)
            for k in ('nodes', 'mail', 'notices'):
                self.assertEqual(dict.__len__(dict.get(view.d, k)), 0, 'must start undecoded')
            return view
        check(json.loads(json.dumps(fresh().d)), 'json.dumps (C encoder)')
        check(json.loads(json.dumps(fresh().d, indent=2)), 'json.dumps indent (Python encoder)')
        check(json.loads(orgtx._json_image(fresh())), 'orgtx._json_image')
        check(statepreview.isolated(fresh()).d, 'statepreview.isolated')
        check_json = json.loads(json.dumps(store.eager_sections(fresh().d)))
        self.assertEqual(check_json['mail'], want_mail, 'eager_sections json')
        eager = pickle.loads(pickle.dumps(store.eager_sections(fresh().d)))   # quickstaff
        self.assertEqual(eager['mail'], want_mail)
        self.assertEqual(sorted(eager['nodes']), want_nodes)
        with orgtx.org_tx(self.slug, nodes=['n0']) as tx:
            check(json.loads(json.dumps(tx.org.d)), 'json.dumps inside org_tx')
            copy_org = ledger.Org(json.loads(json.dumps(tx.org.d)))   # switch_model's dry run
            check(copy_org.d, 'switch_model dry-run copy')

    def test_no_engine_code_serializes_a_lazy_container_on_its_own(self):
        # the C json encoder writes "{}" for a container with nothing decoded:
        # only whole-document dumps are safe (LazyDoc.materialize_all)
        import pathlib
        import re
        root = pathlib.Path(store.__file__).parent
        # an org document is reached as `<x>.d` (or `.nodes`); other dicts
        # that happen to have a 'nodes' key (foreground caches) are not lazy
        bad = re.compile(r'(json\.dumps|_dumps|dict)\(\s*[\w.]*'
                         r'(\.nodes\s*\)|\.d\[\s*["\'](nodes|mail|delivering|notices)["\']\s*\]\s*\)'
                         r'|\.d\.get\(\s*["\'](nodes|mail|delivering|notices)["\']\s*\)\s*\))')
        hits = []
        for p in sorted(root.glob('*.py')):
            for i, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1):
                if bad.search(line):
                    hits.append(f'{p.name}:{i}: {line.strip()}')
        self.assertEqual(hits, [], 'a lazy container dumped on its own')

    # -- walks, prefetch, copies -------------------------------------------
    def test_a_walk_counts_a_fallback_calls_the_hook_and_equals_the_whole_load(self):
        self.stamp()
        seen = []
        with patch.object(store, 'LAZY_ROWS_HOOK', lambda kind, why: seen.append(kind)):
            before = self.stats()
            view = store.load_runtime_org(self.slug)
            lazy_nodes = {k: dict(v) for k, v in view.nodes.items()}
            lazy_mail = {k: list(v) for k, v in view.d['mail'].items()}
            self.assertEqual(self.delta(before)['fallbacks'], 2)
        self.assertEqual(seen, ['fallback', 'fallback'])
        whole = store.load_org(self.slug)
        self.assertEqual(lazy_nodes, {k: dict(v) for k, v in whole.nodes.items()})
        self.assertEqual(lazy_mail, {k: list(v) for k, v in whole.d['mail'].items()})
        self.assertEqual(list(lazy_nodes), list(whole.nodes))

    def test_declared_nodes_are_fetched_in_one_statement(self):
        self.stamp()
        before = self.stats()
        with orgtx.org_tx(self.slug, nodes=['n1', 'n2', 'n3']) as tx:
            self.assertEqual(sorted(dict.keys(dict.get(tx.org.d, 'nodes'))), ['n1', 'n2', 'n3'])
        d = self.delta(before)
        self.assertEqual((d['fetches'], d['rows']), (1, 3))

    def test_a_deep_copy_stays_lazy_and_reads_the_same_rows(self):
        self.stamp()
        view = store.load_runtime_org(self.slug)
        dup = copy.deepcopy(view.d)
        nm = dict.get(dup, 'nodes')
        self.assertIsInstance(nm, store.LazyNodesMap)
        self.assertEqual(nm['n9']['payload'], {'v': 1})
        self.assertEqual(dup['mail']['n9'], [{'id': 'm9', 'body': 'hello 9'}])


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ChatRuntimeView(unittest.TestCase):
    """The desk chat read (api.node_chat) on a runtime view: the same payload
    as the whole load, reading only the rows it touches."""
    setUpClass = LazyRows.setUpClass
    setUp, raw, rows, epoch = LazyRows.setUp, LazyRows.raw, LazyRows.rows, LazyRows.epoch
    stamp, stats, delta = LazyRows.stamp, LazyRows.stats, LazyRows.delta

    def test_node_chat_on_a_runtime_view_matches_the_whole_load(self):
        from orgtree import api
        with self.raw() as raw:           # a realistic pending mail entry
            raw.execute('UPDATE doc SET val=%s WHERE key=%s', (store._dumps([
                {'id': 'm1', 'from': 'n0', 'kind': 'message', 'at': '2026-09-28T00:00:00Z',
                 'body': 'hello 1'}]), 'mail\x1fn1'))
        self.stamp()
        with patch.object(api, '_CHAT_RUNTIME_VIEW', False):
            whole = api.node_chat(self.slug, 'n1', last=8)
        seen = []
        real = store.load_runtime_org
        before = self.stats()
        with patch.object(api, '_CHAT_RUNTIME_VIEW', True), \
                patch.object(store, 'load_runtime_org',
                             lambda slug, *a, **k: seen.append(slug) or real(slug, *a, **k)):
            view = api.node_chat(self.slug, 'n1', last=8)
        d = self.delta(before)
        self.assertEqual(seen, [self.slug], 'the chat read must take the runtime view')
        self.assertEqual(view, whole)
        self.assertEqual(d['fallbacks'], 0)
        self.assertLessEqual(d['rows'], 4, 'only the node and its own boxes are read')
        self.assertIn('"m1"', json.dumps(view), 'the mailbox row reached the payload')


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class NoticesRuntimeView(unittest.TestCase):
    """Desktop notifications (every 5 s): runtime views + one frozen-agent
    query, the same notices as the whole loads."""
    setUpClass = LazyRows.setUpClass
    setUp, raw, rows, epoch = LazyRows.setUp, LazyRows.raw, LazyRows.rows, LazyRows.epoch
    stamp, stats, delta = LazyRows.stamp, LazyRows.stats, LazyRows.delta

    def seed(self):
        frozen = {'at': '2026-09-28T00:00:00Z', 'error': 'usage limit', 'until_ts': 9e9}
        shapes = {'n2': node('n2', state='live', frozen=frozen, generation=3),
                  'n3': node('n3', state='archived', frozen=frozen),       # not live
                  'n4': node('n4', state='live', frozen=None),             # not frozen
                  'n5': node('n5', state='live', frozen={})}               # falsy freeze
        with self.raw() as raw:
            for nid, val in shapes.items():
                raw.execute('UPDATE nodes SET val=%s WHERE id=%s', (store._dumps(val), nid))
        self.stamp()

    def test_frozen_live_nodes_reads_only_the_frozen_agents(self):
        self.seed()
        view = store.load_runtime_org(self.slug)
        before = self.stats()
        got = [(nid, n['generation']) for nid, n in store.frozen_live_nodes(view)]
        d = self.delta(before)
        self.assertEqual(got, [('n2', 3)])
        # candidates: n2, plus n5 whose freeze is an empty object (falsy, so
        # filtered in Python); n3 (archived) and n4 (null) never leave PG
        self.assertEqual((d['fetches'], d['rows'], d['fallbacks']), (1, 2, 0))
        whole = store.load_org(self.slug)
        self.assertEqual([nid for nid, _ in store.frozen_live_nodes(whole)], ['n2'])

    def test_notices_on_runtime_views_equal_the_whole_loads(self):
        from orgtree import desktop_notifications as dn
        self.seed()
        with orgtx.org_tx(self.slug, sections=['user_inbox', 'asks']) as tx:
            tx.org.d.setdefault('user_inbox', []).append(
                {'id': 'u1', 'from': 'n1', 'kind': 'message', 'urgent': True,
                 'urgent_reason': 'look', 'body': 'b', 'at': '2026-09-28T00:00:00Z'})
            tx.org.d.setdefault('asks', []).append(
                {'id': 'a1', 'node': 'n2', 'status': 'open', 'question': 'q?'})
        with patch.object(dn, '_RUNTIME_VIEWS', False):
            whole = dn.notices(limit=10_000)
        before = self.stats()
        with patch.object(dn, '_RUNTIME_VIEWS', True):
            view = dn.notices(limit=10_000)
        self.assertEqual(view, whole)
        self.assertEqual(self.delta(before)['fallbacks'], 0)
        mine = [r for r in view['notices'] if r['org'] == self.slug]
        self.assertEqual(sorted(r['kind'] for r in mine), ['agent-frozen', 'question', 'urgent-mail'])

    def test_notices_use_runtime_views(self):
        from orgtree import desktop_notifications as dn
        self.seed()
        seen = []
        real = store.load_runtime_org
        with patch.object(dn, '_RUNTIME_VIEWS', True), \
                patch.object(store, 'load_runtime_org',
                             lambda slug, *a, **k: seen.append(slug) or real(slug, *a, **k)), \
                patch.object(store, 'list_orgs_with_docs',
                             lambda *a, **k: self.fail('whole loads of every org')):
            dn.notices()
        self.assertIn(self.slug, seen)


class SwitchDefault(unittest.TestCase):
    def test_lazy_rows_is_on_unless_explicitly_false(self):
        for v in (None, '', '1', 'true', 'on', 'yes', 'anything'):
            self.assertTrue(store._switch_on(v), repr(v))
        for v in ('0', 'false', 'FALSE', 'off', 'no', ' No '):
            self.assertFalse(store._switch_on(v), repr(v))

    def test_the_process_default_is_on(self):
        import os
        if 'ORGTREE_LAZY_ROWS' in os.environ:
            self.skipTest('ORGTREE_LAZY_ROWS set in this environment: default NOT tested')
        self.assertTrue(store.LAZY_ROWS)

    def test_the_chat_view_default_is_on(self):
        import os
        from orgtree import api
        if 'ORGTREE_CHAT_RUNTIME_VIEW' in os.environ:
            self.skipTest('ORGTREE_CHAT_RUNTIME_VIEW set in this environment: default NOT tested')
        self.assertTrue(api._CHAT_RUNTIME_VIEW)


class PostLoad(unittest.TestCase):
    def test_modular_visibility_against_a_load_snapshot(self):
        snap = '100:105:101,103'
        self.assertFalse(store._after_load(snap, '99'))    # before the snapshot
        self.assertFalse(store._after_load(snap, '102'))   # committed, not running
        self.assertTrue(store._after_load(snap, '101'))    # running at the load
        self.assertTrue(store._after_load(snap, '105'))    # at/after xmax
        self.assertFalse(store._after_load(snap, '2'))     # frozen
        self.assertFalse(store._after_load(None, '105'))   # inside org_tx: never
        wrap = f'{2**32 + 10}:{2**32 + 20}:'                # 64-bit ids past a wrap
        self.assertTrue(store._after_load(wrap, '25'))
        self.assertFalse(store._after_load(wrap, '5'))
        self.assertFalse(store._after_load(wrap, str(2**32 - 5)))


class HealEquivalence(unittest.TestCase):
    """The per-row heal equals the whole-load heal, on legacy shapes."""

    LEGACY = {
        'bare': {'id': 'bare', 'parent': None},
        'bash': {'id': 'bash', 'scope': {'bash': False, 'add_dirs': ['C:/x']}},
        'acc': {'id': 'acc', 'scope': {'tools': {}, 'auto_cheap_compact': {'idle_s': 5}}},
        'purpose': {'id': 'purpose', 'purpose': 'old role', 'queued_msgs': ['x']},
        'six': {'id': 'six', 'model': 'gpt-6-sol'},
        'gem': {'id': 'gem', 'gemini_session': 'abc'},
        'spend': {'id': 'spend', 'frozen': {'error': 'spend limit'}},
        'locked': {'id': 'locked', 'limit_locked': True},
    }

    def doc(self):
        nodes = {k: dict(copy.deepcopy(v), seat_id=f'seat-{k}') for k, v in self.LEGACY.items()}
        return {'slug': 'heal', 'nodes': nodes, 'permission_mode': 'plan',
                'tiers': dict(ledger.TIERS), 'models': dict(ledger.MODELS)}

    def test_every_per_row_heal_matches_the_whole_load(self):
        whole = ledger.Org(self.doc()).nodes
        doc = self.doc()
        for i, (nid, raw) in enumerate(list(doc['nodes'].items())):
            n = copy.deepcopy(raw)
            self.assertTrue(ledger.heal_decoded_node(doc, nid, n, i))
            self.assertEqual(n, dict(whole[nid]), nid)

    def test_a_point_fetch_without_ui_order_or_seat_asks_for_the_whole_table(self):
        n = {'id': 'x', 'seat_id': 's'}
        self.assertFalse(ledger.heal_decoded_node({}, 'x', dict(n), None))
        self.assertFalse(ledger.heal_decoded_node({}, 'x', {'id': 'x', 'ui_order': 1.0}, None))
        self.assertTrue(ledger.heal_decoded_node({}, 'x', dict(n, ui_order=1.0), None))

    def test_mail_box_heal_adds_ids_only_where_missing(self):
        box = [{'id': 'keep'}, {'body': 'no id'}]
        self.assertTrue(ledger.heal_decoded_box('mail', box))
        self.assertEqual(box[0]['id'], 'keep')
        self.assertTrue(box[1].get('id'))
        self.assertFalse(ledger.heal_decoded_box('mail', box))
        self.assertFalse(ledger.heal_decoded_box('notices', [{'body': 'x'}]))


if __name__ == '__main__':
    unittest.main()
