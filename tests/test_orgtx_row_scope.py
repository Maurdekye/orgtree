"""Row scoping must save nested edits, including references retained at load."""
import copy
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
            captured['node'] = org.node('n0')
            captured['nested'] = captured['node']['payload']['items']
            captured['section'] = org.d['extra']['items']
        with patch.object(Org, '_initialize_doc', initialize):
            with orgtx.org_tx(self.slug, nodes=['n0'], sections=['extra']):
                captured['nested'].append(2)
                captured['node']['name'] = 'retained'
                captured['section'].append(3)
        self.assertEqual(self.stored()['name'], 'retained')
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

    def test_copy_has_independent_marks_and_values(self):
        org = store.load_org(self.slug)
        duplicate = copy.deepcopy(org.d)
        duplicate['nodes']['n0']['payload']['items'].append(4)
        self.assertEqual(org.node('n0')['payload']['items'], [1])
        self.assertIsNot(duplicate['nodes']['n0']._mutation,
                         org.node('n0')._mutation)

    def test_default_off_uses_original_node_dicts(self):
        with patch.object(store, 'ORGTX_RESCOPE', False):
            org = store.load_org(self.slug)
            self.assertIs(type(org.node('n0')), dict)
            self.assertTrue(org.nodes._touched_all)


class SwitchDelivery(unittest.TestCase):
    def test_runner_delivers_controls(self):
        self.assertEqual(store.ORGTX_RESCOPE,
                         os.environ.get('ORGTREE_ORGTX_RESCOPE', '').strip() == '1')
        self.assertEqual(store._SCOPED_VERIFY,
                         os.environ.get('ORGTREE_SCOPED_SAVE_VERIFY', '').strip() == '1')


if __name__ == '__main__':
    unittest.main()
