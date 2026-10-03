"""Native docket saves never maintain the legacy work_read/list/index tables.

Uses test_orgdb_compat_pg's disposable cluster and release-equivalent storage
fixture. Run only through run-python-verification.py under the heavy P03 lock.
"""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import contextlib
import re
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as f
from orgtree import orgtx, store, workindex, worklistmeta, workread

setUpModule = f.setUpModule
tearDownModule = f.tearDownModule


@contextlib.contextmanager
def forbid_legacy_sql():
    """Observe real saves, including queries made outside the normal save hook."""
    import psycopg
    original = psycopg.Connection.execute
    seen = []

    def execute(raw, query, *args, **kwargs):
        text = str(query)
        # to_regclass hides a table name in its parameters; inspect those too.
        statement = text + repr(args)
        if re.search(r'\bwork_(?:read_|list_|index\b|index_)|\borg_\d+\.', statement):
            raise AssertionError('legacy docket SQL: ' + statement)
        seen.append(text)
        return original(raw, query, *args, **kwargs)

    with patch.object(psycopg.Connection, 'execute', execute):
        yield seen


@f.needs_pg
class Maintenance(unittest.TestCase):
    def test_every_maintenance_entry_point_is_a_noop(self):
        twin = f.Twins('maintenance entry points')
        org_id, database, _, _ = f.registry.lookup(twin.copy)
        with f.storage(True), f.dbconn.connect(f.RUNTIME, database) as raw:
            calls = [
                ('read refresh', lambda: workread.refresh(raw, org_id), False),
                ('read reconcile', lambda: workread.reconcile(raw, org_id), False),
                ('read bootstrap', lambda: workread.bootstrap(raw), None),
                ('read installed', lambda: workread._installed(raw, 'org_1'), False),
                ('list refresh', lambda: worklistmeta.refresh(raw, org_id), None),
                ('list known pending', lambda: worklistmeta.refresh(
                    raw, org_id, known_pending=True), None),
                ('list locked', lambda: worklistmeta.refresh(
                    raw, org_id, known_pending=True, locked=True), None),
                ('list reconcile', lambda: worklistmeta.reconcile(raw, org_id), False),
                ('list installed', lambda: worklistmeta.installed(raw, 'org_1'), False),
                ('list pending', lambda: worklistmeta.pending(raw, org_id), False),
                ('list ready', lambda: worklistmeta.ready(raw, org_id), False),
                ('index ready', lambda: workindex.ready(raw, org_id), False),
                ('index reconcile', lambda: workindex.reconcile(raw, org_id), False),
                ('counts fallback', lambda: workread.counts_raw(
                    raw, org_id, viewer='dev', now_ts=0), None),
            ]
            for name, call, expected in calls:
                with self.subTest(name), patch.object(raw, 'execute', side_effect=
                        AssertionError('maintenance issued SQL')) as execute:
                    self.assertIs(call(), expected)
                    execute.assert_not_called()

    def test_docket_create_edit_archive_delete_keeps_exact_view(self):
        twin = f.Twins('maintenance save')
        _, database, _, _ = f.registry.lookup(twin.copy)
        with f.storage(True), forbid_legacy_sql() as statements:
            org = store.load_org(twin.copy)
            org.d['work_items'].append(f.item('maintenance-item', 'New item'))
            store.save_org(org)
            with orgtx.org_tx(twin.copy, sections=['work_items']) as tx:
                item = next(w for w in tx.d['work_items'] if w['slug'] == 'maintenance-item')
                item.update(title='Edited item', rev=2, status='done')
            with orgtx.org_tx(twin.copy, sections=['work_items'], logs=['work_items_archive']) as tx:
                item = tx.d['work_items'].pop(2)
                item['archived_at'] = f.AT
                store.log_append(tx.d, 'work_items_archive', item)
            archived = store.load_org(twin.copy).d['work_items_archive']
            self.assertEqual([(w['slug'], w['title']) for w in archived],
                             [('maintenance-item', 'Edited item')])
            with f.dbconn.connect(f.RUNTIME, database) as raw:
                saved = raw.execute("SELECT title,status,archived_at IS NOT NULL FROM "
                                    "orgtree.work_items WHERE slug='maintenance-item'").fetchone()
                self.assertEqual(saved, ('Edited item', 'done', True))
            with orgtx.org_tx(twin.copy, sections=['work_items'], logs=['work_items_archive']) as tx:
                tx.d['work_items_archive'].pop(0)
            loaded = store.load_org(twin.copy)
            self.assertEqual([w['slug'] for w in loaded.d['work_items']],
                             ['fix-the-thing', 'second-item'])
            self.assertEqual(loaded.d['work_items_archive'], [])
            with f.dbconn.connect(f.RUNTIME, database) as raw:
                self.assertEqual(raw.execute("SELECT count(*) FROM orgtree.work_items "
                                             "WHERE slug='maintenance-item'").fetchone()[0], 0)
            self.assertEqual([w['slug'] for w in store.load_org(twin.copy).d['work_items']],
                             ['fix-the-thing', 'second-item'])
        self.assertTrue(any('orgtree.work_items' in q for q in statements))

    def test_refused_save_keeps_the_docket_unchanged_without_maintenance(self):
        twin = f.Twins('maintenance rollback')
        with f.storage(True), forbid_legacy_sql():
            before = f.document(twin.copy)
            with self.assertRaisesRegex(ValueError, 'abort docket save'):
                with orgtx.org_tx(twin.copy, sections=['work_items']) as tx:
                    tx.d['work_items'][0]['title'] = 'Must not commit'
                    raise ValueError('abort docket save')
            self.assertEqual(f.document(twin.copy), before)


if __name__ == '__main__':
    unittest.main()
