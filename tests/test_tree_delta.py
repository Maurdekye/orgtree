"""Tree wire patches preserve every field, topology, and replay watermarks."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401
from orgtree import tree_delta as wire


class TreeDelta(unittest.TestCase):
    def setUp(self):
        self.old = {'sync_rev': 1, 'org_rev': 4, 'slug': 'x',
            'asks': [{'question': 'Visible question'}],
            'roots': [{'id': 'a', 'scope': {'tools': {'edit': True}},
                'charter': 'Visible charter\n' * 100, 'last_status': None,
                'children': [{'id': 'b', 'state': 'archived', 'detail': False,
                              'charter_line': 'Summary', 'children': []}]}]}

    def apply(self, old, delta):
        # Independent protocol reconstruction, including deletion/topology.
        rows = wire.flatten(copy.deepcopy(old))
        for nid in delta['removed']:
            del rows[nid]
        def patch(value, change):
            value.update(change['set'])
            for key in change['remove']:
                value.pop(key, None)
        for nid, change in delta['nodes'].items():
            patch(rows.setdefault(nid, {}), change)
        out = copy.deepcopy(old)
        out['roots'] = [n['id'] for n in old['roots']]
        patch(out, delta['top'])
        def build(nid):
            return {**rows[nid], 'children': [build(n) for n in rows[nid]['children']]}
        out['roots'] = [build(n) for n in out['roots']]
        return out

    def check(self, new):
        before = copy.deepcopy(self.old)
        delta = wire.delta(self.old, new, wire.revision(self.old), wire.revision(new))
        self.assertEqual(self.apply(self.old, delta), new)
        self.assertEqual(self.old, before)
        return delta

    def test_content_revision_ignores_only_replay_watermarks(self):
        new = copy.deepcopy(self.old)
        new.update(sync_rev=9, org_rev=20)
        self.assertEqual(wire.revision(self.old), wire.revision(new))
        new['roots'][0]['last_status'] = {'summary': 'Changed'}
        self.assertNotEqual(wire.revision(self.old), wire.revision(new))

    def test_status_delta_does_not_repeat_charter_or_scope(self):
        new = copy.deepcopy(self.old)
        new['roots'][0]['last_status'] = {'summary': 'Working'}
        new['sync_rev'] = 8
        delta = self.check(new)
        self.assertEqual(set(delta['nodes']), {'a'})
        self.assertEqual(set(delta['nodes']['a']['set']), {'last_status'})
        self.assertEqual(delta['top']['set'], {'sync_rev': 8})
        self.assertLess(len(wire.encode(delta)), len(wire.encode(new))/2)

    def test_reparent_insert_remove_and_deleted_fields(self):
        new = copy.deepcopy(self.old)
        a = new['roots'][0]
        del a['scope']
        a['children'] = []
        new['roots'] = [{'id':'new','children':[a]}]
        del new['asks']
        delta = self.check(new)
        self.assertEqual(delta['removed'], ['b'])
        self.assertEqual(delta['nodes']['a']['remove'], ['scope'])
        self.assertIn('asks', delta['top']['remove'])

    def test_arbitrary_future_fields_survive_full_and_delta(self):
        new = copy.deepcopy(self.old)
        new['future'] = {'array':[False, None, 0, {'unicode':'שלום'}]}
        new['roots'][0]['future'] = new['future']
        self.check(new)
        self.assertEqual(wire.full(new, wire.revision(new))['tree'], new)

    def test_nested_boolean_and_number_are_distinct_json_values(self):
        self.old['roots'][0]['future'] = {'value':[True]}
        new = copy.deepcopy(self.old)
        new['roots'][0]['future']['value'] = [1]
        patch = self.check(new)
        self.assertEqual(patch['nodes']['a']['set']['future'], {'value':[1]})


if __name__ == '__main__':
    unittest.main()
