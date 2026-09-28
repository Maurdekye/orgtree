"""`Org.work_identity_state` judges the ARCHIVE from the PostgreSQL docket index.

Every `orgtree_work` call checks docket identity first, and that check used to
walk the whole work archive (~109 MB per call at N1000). The index holds the
three facts it needs per item. These tests hold the new answer to the old one:

  * side by side on real PostgreSQL rows, for every case PG can store
    (clean; an archived item with an old `id`, and with `"id": null`; an active
    item with an old `id`), the index path and the row walk agree, and the
    index path never loads the archive section;
  * for the cases PG refuses to commit (duplicate and empty names), the same
    loop is fed the same facts both ways, with no database;
  * real `orgtree_work` calls through `api.agent_call` (create, update,
    evidence, get, list) never load the archive section.

Run:  python tools/run-python-verification.py tests/test_pg_work_identity_index.py
"""
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ['ORGTREE_PGDOOR'] = '1'
import test_pgstore as f  # noqa: E402  (sets the PG store environment)
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import api, ledger, pgstore, store, supervisor  # noqa: E402

U = ledger.USER
REQUEST = SimpleNamespace(state=SimpleNamespace())
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
ARCHIVE = 'work_items_archive'


def tearDownModule():
    f.tearDownModule()


class _Refused(AssertionError):
    pass


#: every attempted archive load, even one a caller catches and reports
ATTEMPTS = []


def _refuse_archive():
    original = store._load_section

    def load(slug, sect, snap_logs):
        if sect == ARCHIVE:
            ATTEMPTS.append(slug)
            raise _Refused('the work archive was loaded')
        return original(slug, sect, snap_logs)
    return patch.object(store, '_load_section', load)


def _spy_index():
    """Record what `archive_identity` answered (None = fell back)."""
    seen = []
    original = store.LazyDoc.archive_identity

    def spy(self):
        result = original(self)
        seen.append(result)
        return result
    return seen, patch.object(store.LazyDoc, 'archive_identity', spy)


class _Doc(dict):
    """A plain document that answers `archive_identity` from given facts."""
    def __init__(self, d, facts):
        super().__init__(d)
        self.facts = facts

    def archive_identity(self):
        return self.facts


def _old_state(items):
    """The pre-change loop, verbatim, over whole items."""
    names = set()
    for it in items:
        if 'id' in it:
            return 'legacy'
        name = str(it.get('slug') or '')
        if not name:
            return 'legacy'
        if name in names:
            return 'legacy'
        names.add(name)
    return 'slug'


class SameFactsNoDatabase(unittest.TestCase):
    """Cases PostgreSQL will not commit (UNIQUE slug, non-empty slug), so the
    index can never report them; the loop must still answer them the same."""

    CASES = {
        'clean': ([{'slug': 'a'}], [{'slug': 'b'}]),
        'dup archive/archive': ([{'slug': 'a'}], [{'slug': 'b'}, {'slug': 'b'}]),
        'dup active/archive': ([{'slug': 'a'}], [{'slug': 'a'}]),
        'dup active/active': ([{'slug': 'a'}, {'slug': 'a'}], []),
        'empty archived name': ([{'slug': 'a'}], [{'slug': ''}]),
        'missing archived name': ([{'slug': 'a'}], [{'title': 'x'}]),
        'archived old id': ([{'slug': 'a'}], [{'slug': 'b', 'id': 'w1234abcd'}]),
        'archived null id': ([{'slug': 'a'}], [{'slug': 'b', 'id': None}]),
        'active old id': ([{'slug': 'a', 'id': 'w1234abcd'}], [{'slug': 'b'}]),
        'no items': ([], []),
        'numeric name': ([{'slug': 7}], [{'slug': '7'}]),
    }

    def org(self, active, facts):
        org = ledger.Org.__new__(ledger.Org)
        org.d = _Doc({'work_items': active, ARCHIVE: None}, facts)
        return org

    def test_index_facts_give_the_row_walk_answer(self):
        for name, (active, archived) in self.CASES.items():
            with self.subTest(name):
                expected = _old_state(active + archived)
                facts = [(str(it.get('slug') or ''), 'id' in it) for it in archived]
                with patch.object(ledger.Org, '_work_archive',
                                  side_effect=AssertionError('archive walked')):
                    self.assertEqual(self.org(active, facts).work_identity_state(), expected)
                fallback = self.org(active, None)
                fallback.d[ARCHIVE] = archived
                self.assertEqual(fallback.work_identity_state(), expected)

    def test_names_in_use_and_backfill_match_the_row_walk(self):
        # An archived item's name must stay taken either way, and a nameless
        # ACTIVE item must be minted the same name either way.
        active = [{'slug': 'a'}, {'title': 'Old ticket'}, {'title': 'Old ticket'}]
        archived = [{'slug': 'old-ticket'}, {'slug': 'b'}]
        deleted = ['old-ticket-2']

        def make(indexed):
            act = [dict(it) for it in active]
            org = self.org(act, [(it['slug'], False) for it in archived] if indexed else None)
            org.d['work_deleted_names'] = deleted
            if not indexed:
                org.d[ARCHIVE] = [dict(it) for it in archived]
            return org
        new, old = make(True), make(False)
        with patch.object(ledger.Org, '_work_archive',
                          side_effect=AssertionError('archive walked')):
            self.assertEqual(new._work_names_in_use(), {'a', 'old-ticket', 'b', 'old-ticket-2'})
            minted = new._work_backfill_slugs()
        self.assertEqual(old._work_names_in_use(), new._work_names_in_use() - set(minted))
        self.assertEqual(minted, old._work_backfill_slugs())
        self.assertEqual(minted, ['old-ticket-3', 'old-ticket-4'])
        self.assertEqual([it['slug'] for it in new.d['work_items']],
                         [it['slug'] for it in old.d['work_items']])

    def test_backfill_reads_nothing_when_every_item_is_named(self):
        org = self.org([{'slug': 'a'}], [('b', False)])
        with patch.object(ledger.Org, '_work_names_in_use',
                          side_effect=AssertionError('names built')):
            self.assertEqual(org._work_backfill_slugs(), [])


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class OnPostgres(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        ATTEMPTS.clear()
        org = store.create_org('wid-' + self._testMethodName)
        self.slug = org.d['slug']
        org.hire(U, None, 'luna', 20, 'boss')
        for n in range(3):
            org.work_create('boss', f'Live item {n}', objective='Problem. Solution.')
        template = dict(org.d['work_items'][0])
        org.d[ARCHIVE] = [dict(template, slug=f'old-{n}', title=f'Old {n}', status='done',
                               evidence=[{'note': 'x' * 2000}]) for n in range(6)]
        store.save_org(org)
        self.c = pgstore.connect()
        self.oid = self.c.execute('SELECT org_id FROM public.orgs WHERE slug=%s',
                                  (self.slug,)).fetchone()[0]
        self.s = f'org_{self.oid}'

    def tearDown(self):
        self.c.close()

    def set_archived(self, slug, key, value):
        self.c.execute(f"UPDATE {self.s}.log_l SET val=jsonb_set(val::jsonb,%s,%s::jsonb)::text "
                       f"WHERE sect='{ARCHIVE}' AND val::jsonb->>'slug'=%s",
                       ('{' + key + '}', json.dumps(value), slug))

    def set_active(self, slug, key, value):
        self.c.execute(f"UPDATE {self.s}.doc SET val=jsonb_set(val::jsonb,%s,%s::jsonb)::text "
                       f"WHERE key=%s", ('{' + key + '}', json.dumps(value),
                                         'work_items\x1f' + slug))

    def both(self):
        """(index answer, row-walk answer, what the index said)."""
        seen, spy = _spy_index()
        with spy, _refuse_archive():
            new = store.load_org(self.slug).work_identity_state()
        whole = store.load_org(self.slug)
        rows = list(whole.d[ARCHIVE])      # resident: the row walk
        self.assertTrue(rows)
        old = whole.work_identity_state()
        return new, old, seen

    def test_same_decision_as_the_row_walk(self):
        live = store.load_org(self.slug).d['work_items'][0]['slug']
        cases = [
            ('clean', lambda: None, 'slug'),
            ('archived old id', lambda: self.set_archived('old-2', 'id', 'w1234abcd'), 'legacy'),
            ('archived null id', lambda: self.set_archived('old-3', 'id', None), 'legacy'),
            ('active old id', lambda: self.set_active(live, 'id', 'w8765dcba'), 'legacy'),
        ]
        for name, mutate, expected in cases:
            with self.subTest(name):
                mutate()
                new, old, seen = self.both()
                self.assertEqual(old, expected, 'bad test: the row walk disagrees')
                self.assertEqual(new, old)
                self.assertTrue(seen and seen[-1] is not None, 'index path not taken')
                self.assertEqual(len(seen[-1]), 6)

    def test_resident_or_edited_archive_answers_from_memory(self):
        org = store.load_org(self.slug)
        org.d[ARCHIVE][0]['id'] = 'w1234abcd'      # edited in memory, not saved
        self.assertIsNone(org.d.archive_identity())
        self.assertEqual(org.work_identity_state(), 'legacy')

    def test_buffered_archive_row_forces_the_row_walk(self):
        # review-astra f1: the sweep moves an item with store.log_append, which
        # buffers it without loading the section. Until the save the index does
        # not have that row and the active list no longer does, so answering
        # from the index would drop its name and let create mint it again.
        org = store.load_org(self.slug)
        moved = org.d['work_items'].pop(0)
        store.log_append(org.d, ARCHIVE, moved)
        self.assertIsNone(org.d.archive_identity(), 'a buffered archive row must force the row walk')
        self.assertIn(moved['slug'], org._work_names_in_use())
        self.assertEqual(org.work_identity_state(), 'slug')

    def test_archive_blob_or_bad_index_falls_back(self):
        org = store.load_org(self.slug)
        self.assertIsNotNone(org.d.archive_identity())
        self.c.execute(f'UPDATE {self.s}.work_index_state SET valid=false')
        self.assertIsNone(store.load_org(self.slug).d.archive_identity())
        self.c.execute(f'UPDATE {self.s}.work_index_state SET valid=true')
        self.c.execute(f"UPDATE {self.s}.work_index SET summary=summary-'_query' "
                       f"WHERE location='archive' AND slug='old-1'")
        self.assertIsNone(store.load_org(self.slug).d.archive_identity())

    def agent(self, **args):
        return api.agent_call(api.AgentCall(org=self.slug, node='boss', tool='orgtree_work',
                                            args=args), REQUEST)

    def test_tool_paths_never_load_the_archive(self):
        seen, spy = _spy_index()
        with (spy, _refuse_archive(),
              patch.object(supervisor, 'send_message', lambda *a, **k: {}),
              patch.object(api, 'mail_notify', lambda *a, **k: None),
              patch.object(api, 'hub_changed', lambda *a, **k: None)):
            made = self.agent(action='create', title='Fresh item',
                              objective='Problem first. Then the solution.')
            wid = made.get('created') or made.get('slug')
            self.assertTrue(wid, made)
            results = [
                self.agent(action='update', slug=wid, done_so_far=['one'], working_on_next=[]),
                self.agent(action='evidence', slug=wid, kind='note', ref='r', note='n'),
                self.agent(action='get', slug=wid),
                self.agent(action='list')]
        self.assertEqual(ATTEMPTS, [], 'an orgtree_work call loaded the work archive')
        for r in results:
            self.assertIsInstance(r, dict)
            self.assertNotIn('error', r)
        self.assertEqual(results[2]['item']['done_so_far'], ['one'])
        self.assertTrue(seen, 'identity check never consulted the index')
        self.assertTrue(all(r is not None for r in seen), seen)


if __name__ == '__main__':
    unittest.main()
