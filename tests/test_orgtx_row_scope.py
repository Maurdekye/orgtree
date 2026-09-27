"""Row scoping must save nested edits, including references retained at load."""
import copy
import json
import pickle
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='e-row-scope-', ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_temp.name, ORGTREE_STORE='sqlite', ORGTREE_ROW_CAS='1')
import import_provenance  # noqa: F401
from orgtree import orgtx, store
from orgtree.ledger import Org


class ConstructionRows(unittest.TestCase):
    def setUp(self):
        self.flags = patch.multiple(store, ORGTX_RESCOPE=True, _SCOPED_SAVE=True,
                                    _SCOPED_VERIFY=False)
        self.flags.start()
        self.addCleanup(self.flags.stop)
        orgtx.use_backend(orgtx.SeamBackend())
        org = store.create_org(self._testMethodName.replace('_', '-'))
        self.slug = org.d['slug']
        for i in range(20):
            nid = f'n{i}'
            org.d['nodes'][nid] = {'id': nid, 'name': nid, 'parent': None,
                                   'children': [], 'payload': {'items': [1]}}
        org.d['extra'] = {'items': [1]}
        store.save_org(org)
        store.save_org(store.load_org(self.slug))

    def stored(self, nid='n0'):
        # Fresh load, not the Org that was edited.
        return store._load_sqlite_org(self.slug).nodes[nid]

    def test_only_changed_node_is_dumped(self):
        dumped = []
        real = store._dumps
        def counted(value):
            if isinstance(value, dict) and value.get('id') in {f'n{i}' for i in range(20)}:
                dumped.append(value['id'])
            return real(value)
        with patch.object(store, '_dumps', counted):
            with orgtx.org_tx(self.slug, nodes=['n0']) as tx:
                tx.org.node('n0')['payload']['items'].append(2)
        self.assertTrue(dumped, 'the save must actually serialize the changed row')
        self.assertEqual(set(dumped), {'n0'})
        self.assertEqual(self.stored()['payload']['items'], [1, 2])

    def test_constructor_reference_mutation_is_stored(self):
        captured = {}
        real = Org._initialize_doc
        def initialize(org, doc):
            real(org, doc)
            captured['node'] = org.node('n1')
            captured['nested'] = org.node('n0')['payload']['items']
            captured['section'] = org.d['extra']['items']
        with patch.object(Org, '_initialize_doc', initialize):
            with orgtx.org_tx(self.slug, nodes=['n0', 'n1'], sections=['extra']):
                captured['nested'].append(2)
                captured['node']['name'] = 'retained'
                captured['section'].append(3)
        self.assertEqual(self.stored('n1')['name'], 'retained')
        self.assertEqual(self.stored()['payload']['items'], [1, 2])
        self.assertEqual(store.load_org(self.slug).d['extra']['items'], [1, 3])

    def test_undeclared_nested_write_rolls_back(self):
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug, nodes=['n0']) as tx:
                tx.org.node('n1')['payload']['items'].append(2)
        self.assertEqual(self.stored('n1')['payload']['items'], [1])

    def test_stale_node_is_refused(self):
        old = store.load_org(self.slug)
        new = store.load_org(self.slug)
        new.node('n0')['name'] = 'new'
        store.save_org(new)
        old.node('n0')['payload']['items'].append(2)
        with self.assertRaises(store.StaleWrite):
            store.save_org(old)
        self.assertEqual(self.stored()['name'], 'new')
        self.assertEqual(self.stored()['payload']['items'], [1])

    def test_real_construction_heal_persists(self):
        org = store.load_org(self.slug)
        org.node('n0')['scope']['add_dirs'] = ['C:/legacy']
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=['n1']) as tx:
            tx.org.node('n1')['name'] = 'updated'
        self.assertEqual(self.stored()['scope']['add_dirs'],
                         [{'path': 'C:/legacy', 'mode': 'rw'}])
        self.assertEqual(self.stored('n1')['name'], 'updated')

    def test_assigned_container_keeps_external_alias(self):
        with orgtx.org_tx(self.slug, nodes=['n0']) as tx:
            value = {'items': []}
            tx.org.node('n0')['payload'] = value
            self.assertIs(tx.org.node('n0')['payload'], value)
            value['items'].append(7)
        self.assertEqual(self.stored()['payload'], {'items': [7]})

    def test_iterable_slice_external_alias_is_stored(self):
        for enabled in (False, True):
            for extended in (False, True):
                for rhs_kind in ('tuple', 'generator', 'list'):
                    with self.subTest(enabled=enabled, extended=extended, rhs=rhs_kind):
                        external = {'value': 1}
                        other = {'value': 3}
                        with patch.object(store, 'ORGTX_RESCOPE', enabled):
                            with orgtx.org_tx(self.slug, nodes=['n0']) as tx:
                                items = tx.org.node('n0')['payload']['items']
                                items.clear()
                                items.extend([0, 0, 0, 0])
                                source = [external, other] if extended else [external]
                                rhs = (tuple(source) if rhs_kind == 'tuple' else
                                       (v for v in source) if rhs_kind == 'generator' else source)
                                if extended:
                                    items[::2] = rhs
                                else:
                                    items[:] = rhs
                                observed = items[0]
                                same_object = observed is external
                                external['value'] = 2
                            # Commit first so the failing control proves data loss,
                            # rather than stopping at the in-memory identity check.
                            self.assertEqual(self.stored()['payload']['items'][0]['value'], 2)
                            self.assertTrue(same_object)

    def test_copy_has_independent_marks_and_values(self):
        org = store.load_org(self.slug)
        duplicate = copy.deepcopy(org.d)
        duplicate['nodes']['n0']['payload']['items'].append(4)
        self.assertEqual(org.node('n0')['payload']['items'], [1])
        self.assertIsNot(duplicate['nodes']['n0']._mutation,
                         org.node('n0')._mutation)

    def test_nested_read_paths_keep_live_references(self):
        # Each accessor exposes a nested dict still owned by the node. Edits
        # through any resulting reference must re-mark it after a clean reset.
        accessors = [lambda v: v[0], lambda v: v[:][0], lambda v: next(iter(v)),
                     lambda v: next(reversed(v)), lambda v: v.copy()[0],
                     lambda v: (v + [])[0], lambda v: ([] + v)[0],
                     lambda v: (v * 2)[0], lambda v: (2 * v)[0]]
        for accessor in accessors:
            with self.subTest(accessor=accessor):
                mark = store._NodeMutation()
                node = store._track_node_value({'rows': [{'value': 1}]}, mark)
                reference = accessor(node['rows'])
                mark.dirty = False
                reference['value'] = 2
                self.assertTrue(mark.dirty)
                self.assertEqual(node['rows'][0]['value'], 2)
        for accessor in (lambda d: d['nested'], lambda d: d.get('nested'),
                         lambda d: d.setdefault('nested', {}),
                         lambda d: next(iter(d.values())),
                         lambda d: next(iter(d.items()))[1],
                         lambda d: d.copy()['nested'],
                         lambda d: dict(d)['nested'],
                         lambda d: (d | {})['nested'],
                         lambda d: ({} | d)['nested']):
            with self.subTest(accessor=accessor):
                mark = store._NodeMutation()
                node = store._track_node_value({'nested': {'value': 1}}, mark)
                reference = accessor(node)
                mark.dirty = False
                reference['value'] = 2
                self.assertTrue(mark.dirty)
                self.assertEqual(node['nested']['value'], 2)

    def test_nested_repetition_preserves_identity(self):
        mark = store._NodeMutation()
        values = store._track_node_value([{'value': 1}], mark)
        values *= 2
        self.assertIs(values[0], values[1])
        held = []
        values.sort(key=lambda value: held.append(value) or value['value'])
        mark.dirty = False
        held[0]['value'] = 3
        self.assertTrue(mark.dirty)
        self.assertEqual(values[1]['value'], 3)

    def test_unread_nested_values_are_not_wrapped(self):
        mark = store._NodeMutation()
        node = store._track_node_value({'nested': {'rows': [1, 2, 3]}}, mark)
        self.assertIs(type(dict.__getitem__(node, 'nested')), dict)
        nested = node['nested']
        self.assertIsInstance(nested, store._NodeDict)
        self.assertIs(type(dict.__getitem__(nested, 'rows')), list)

    def test_pickle_preserves_shared_nested_mutation_marks(self):
        org = store._load_sqlite_org(self.slug)
        nodes = pickle.loads(pickle.dumps(org.nodes))
        node = nodes['n0']
        nested = node['payload']['items']
        self.assertIs(node._mutation, nested._mutation)
        nodes._mark_clear()
        nested.append(3)
        self.assertIn('n0', nodes._changed())
        self.assertEqual(node['payload']['items'], [1, 3])

    def test_default_off_uses_original_node_dicts(self):
        with patch.object(store, 'ORGTX_RESCOPE', False):
            org = store.load_org(self.slug)
            self.assertIs(type(org.node('n0')), dict)
            self.assertTrue(org.nodes._touched_all)


    def seed_items(self):
        org = store.load_org(self.slug)
        items = [{'slug': 'item', 'title': 'Example',
                  'notification_attention_active': False,
                  'notification_attention_epoch': 1, 'payload': {'items': [1]}}]
        org.d['work_items'] = items
        store.save_org(org)
        store.load_org(self.slug)  # establishes the content certificate
        return items

    def test_work_items_deferred_and_equal_when_read(self):
        items = self.seed_items()
        org = store._load_sqlite_org(self.slug)
        self.assertIn('work_items', org.d)
        self.assertFalse(dict.__contains__(org.d, 'work_items'))
        raw = org.d._snap_doc['work_items']
        real = store.json.loads
        decoded = []
        def loads(value, *args, **kwargs):
            if value == raw:
                decoded.append(value)
            return real(value, *args, **kwargs)
        with patch.object(store.json, 'loads', loads):
            with orgtx.org_tx(self.slug, nodes=['n0']) as tx:
                tx.org.node('n0')['name'] = 'edited'
        self.assertEqual(decoded, [], 'untouched warmed work_items must not decode')
        self.assertEqual(org.d['work_items'], items)
        self.assertEqual(store._load_sqlite_org(self.slug).d['work_items'], items)

    def test_deferred_work_items_nested_edit_is_saved(self):
        self.seed_items()
        with orgtx.org_tx(self.slug, sections=['work_items']) as tx:
            tx.d['work_items'][0]['payload']['items'].append(2)
        self.assertEqual(store._load_sqlite_org(self.slug).d['work_items'][0]
                         ['payload']['items'], [1, 2])

    def test_deferred_work_items_undeclared_edit_refused(self):
        self.seed_items()
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug, nodes=['n0']) as tx:
                tx.d['work_items'][0]['title'] = 'lost'
        self.assertEqual(store._load_sqlite_org(self.slug).d['work_items'][0]
                         ['title'], 'Example')

    def test_deferred_work_items_replacement_and_deletion(self):
        self.seed_items()
        with orgtx.org_tx(self.slug, sections=['work_items']) as tx:
            tx.d['work_items'] = []
        self.assertEqual(store._load_sqlite_org(self.slug).d['work_items'], [])
        store.load_org(self.slug)
        with orgtx.org_tx(self.slug, sections=['work_items']) as tx:
            self.assertEqual(tx.d.pop('work_items'), [])
        self.assertNotIn('work_items', store._load_sqlite_org(self.slug).d)

    def test_deferred_work_items_changed_legacy_content_heals(self):
        items = self.seed_items()
        del items[0]['notification_attention_active']
        # An older writer may replace the row. A slug/revision-only cache must
        # not certify this new content from the previous row's certificate.
        with store._POOL.acquire(self.slug) as conn:
            conn.execute('UPDATE doc SET val=? WHERE key=?',
                         (json.dumps(items), 'work_items'))
        with orgtx.org_tx(self.slug, nodes=['n0']) as tx:
            self.assertIn('notification_attention_active', tx.d['work_items'][0])
            tx.org.node('n0')['name'] = 'edited'
        with store._POOL.acquire(self.slug) as conn:
            saved = json.loads(conn.execute(
                "SELECT val FROM doc WHERE key='work_items'").fetchone()[0])
        self.assertIn('notification_attention_active', saved[0])

    def test_deferred_copy_export_and_clear_keep_dict_semantics(self):
        items = self.seed_items()
        org = store._load_sqlite_org(self.slug)
        duplicate = copy.deepcopy(org.d)
        self.assertEqual(duplicate['work_items'], items)
        with store._POOL.acquire(self.slug) as conn:
            self.assertEqual(store.reconstruct_full(conn)['work_items'], items)
        org = store._load_sqlite_org(self.slug)
        org.d.clear()
        self.assertNotIn('work_items', org.d)
        self.assertFalse(org.d)

    def test_node_mutator_surfaces_keep_retained_marks(self):
        org = store._load_sqlite_org(self.slug)
        node = org.node('n0')
        values = node['payload']['items']
        payload = node['payload']
        mutations = [lambda: payload.update(extra=1),
                     lambda: payload.setdefault('second', []),
                     lambda: payload.__ior__({'third': 3}),
                     lambda: payload.pop('extra'),
                     lambda: payload.__delitem__('third'),
                     lambda: payload.popitem(),
                     lambda: values.append(2), lambda: values.extend([3]),
                     lambda: values.insert(0, 0), lambda: values.__setitem__(0, 4),
                     lambda: values.__setitem__(slice(0, 1), [5]),
                     lambda: values.reverse(), lambda: values.sort(),
                     lambda: values.__iadd__([6]), lambda: values.__imul__(2),
                     lambda: values.remove(6), lambda: values.pop(),
                     lambda: values.__delitem__(slice(0, 1)),
                     lambda: values.extend(values), lambda: values.clear(),
                     lambda: payload.clear()]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                org.nodes._mark_clear()
                node._mutation.aliased = False  # isolate each mutator's mark
                mutate()
                self.assertIn('n0', org.nodes._changed())

class SwitchDelivery(unittest.TestCase):
    def test_runner_delivers_controls(self):
        self.assertEqual(store.ORGTX_RESCOPE,
                         os.environ.get('ORGTREE_ORGTX_RESCOPE', '').strip() == '1')
        self.assertEqual(store._SCOPED_VERIFY,
                         os.environ.get('ORGTREE_SCOPED_SAVE_VERIFY', '').strip() == '1')


if __name__ == '__main__':
    unittest.main()
