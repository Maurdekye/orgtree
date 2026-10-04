"""Reached converted engine/API rehearsal controls on an owned disposable PG."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as f
from test_rehearse_orgdb import r
from orgtree import ledger, store, workdetail
from orgtree.orgdb import agents


def setUpModule():
    f.setUpModule()


def tearDownModule():
    f.tearDownModule()


def seed(slug):
    f.populate(slug)
    org = store.load_org(slug)
    org.nodes['dev']['turns'] = [{'n': n, 'cost_unknown_fields': ['cost', 'cost'],
        'model_usage_key': {'asked': 'm', 'matched': True, 'keys': ['b', 'a']}}
        for n in range(1, 11)]
    org.nodes['dev']['turn_est_cost'] = ['f', 1.25, -0.001]
    item = org.d['work_items'][0]
    item['delivery'] = {'committed': {'at': f.AT, 'ref': 'a' * 40, 'by': ledger.USER}}
    item['review_seats'] = [{'reviewer': 'ops', 'holder': org._work_holder('ops'),
        'granted_by': ledger.USER, 'at': f.AT, 'state': 'granted'}]
    archived = f.item('older', 'Older')
    archived.update(status='done', archived_at=f.AT)
    org.d['work_items_archive'] = [archived]
    store.save_org(org)


@f.needs_pg
class ConvertedReaderControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.twin = f.Twins('rehearsal-readers', before=seed)
        with f.storage(False):
            cls.source = f.document(cls.twin.legacy)
        cls.source['slug'] = cls.twin.copy

    def compare(self, folder):
        source = Path(folder) / 'source.json'
        output = Path(folder) / 'load.json'
        source.write_text(json.dumps(self.source), encoding='utf-8')
        args = SimpleNamespace(load_slug=self.twin.copy, load_source=source, load_output=output)
        with f.storage(True):
            self.assertEqual(r.load_compare(args), 0)
        result = json.loads(output.read_text(encoding='utf-8'))
        verifier = r.module('reader_control_verifier', r.REPO / 'tools/orgdb_verify.py')
        r.check_load_result(result, {k: v for k, v in self.source.items()
                                    if k not in verifier.IGNORED_DEFAULT})
        return result

    def test_actual_full_load_and_all_native_agent_list_and_detail_reads_match(self):
        with tempfile.TemporaryDirectory() as folder:
            result = self.compare(folder)
        self.assertEqual(result['agents_compared'], 3)
        self.assertEqual(result['docket_lists_compared'], 1)
        self.assertEqual(result['docket_details_compared'], 3)

    def test_reached_agent_turn_child_fault_is_rejected_and_restored(self):
        original = agents.rows
        reached = []
        def broken(raw, names):
            rows = original(raw, names)
            reached.append(bool(rows['dev']['node']['turns'][0]['cost_unknown_fields']))
            rows['dev']['node']['turns'][0]['cost_unknown_fields'].pop()
            return rows
        before = copy.deepcopy(self.source)
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(agents, 'rows', broken), \
                    self.assertRaisesRegex(RuntimeError, 'native agent output differs'):
                self.compare(folder)
            self.assertFalse((Path(folder) / 'load.json').exists())
            self.compare(folder)
        self.assertEqual(reached, [True])
        self.assertEqual(self.source, before)

    def test_reached_public_delivery_fault_is_rejected_and_restored(self):
        original = workdetail.get
        reached = []
        def broken(*args, **kwargs):
            result = original(*args, **kwargs)
            if 'delivery' in result:
                reached.append(bool(result['delivery']['committed']))
                result['delivery']['committed']['ref'] = 'b' * 40
            return result
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(workdetail, 'get', broken), \
                    self.assertRaisesRegex(RuntimeError, 'native docket detail differs'):
                self.compare(folder)
            self.assertFalse((Path(folder) / 'load.json').exists())
            self.compare(folder)
        self.assertEqual(reached, [True])


if __name__ == '__main__':
    unittest.main()
