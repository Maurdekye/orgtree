"""Deferred receipt mapping must never silently serialize an empty view."""
import copy
import json
import unittest
from unittest.mock import patch
from orgtree import receiptmapping as maps, receiptrows
from test_receiptrows import receipt


class ReceiptMapping(unittest.TestCase):
    def setUp(self):
        self.source={'z':{'first':receipt('z','first','a'),'second':receipt('z','second','b')},
                     'other':{'op':receipt('other','op','x')}}
        self.calls=[]
        def read(slug,revision,query,params):
            self.calls.append((query,params)); self.assertEqual((slug,revision),('fixture',3))
            if query=='SELECT 1 FROM receipt_owners LIMIT 1': return [(1,)]
            if query.startswith('SELECT owner,nrows,version'):
                return [(owner,len(entries),1) for owner,entries in self.source.items()]
            if query.startswith('SELECT nrows,version'):
                return [(len(self.source[params[0]]),1)] if params[0] in self.source else []
            if query.startswith('SELECT token,val'):
                return [(key,receiptrows.dumps(value)) for key,value in self.source[params[0]].items()]
            if query.startswith('SELECT val'):
                owner,key=params
                return [(receiptrows.dumps(self.source[owner][key]),)] if key in self.source.get(owner,{}) else []
            raise AssertionError(query)
        self.patch=patch.object(maps,'_read',side_effect=read); self.patch.start(); self.addCleanup(self.patch.stop)
        self.view=maps.ReceiptSection('fixture',3)

    def test_keyed_read_fetches_only_owner_and_operation(self):
        self.assertEqual(self.view['z']['first'],self.source['z']['first'])
        self.assertEqual(len(self.calls),2)
        self.assertTrue(all('other' not in args for _,args in self.calls))
        self.assertEqual(self.view['z']['first'],self.source['z']['first'])
        self.assertEqual(len(self.calls),2)

    def test_nested_mutation_keeps_exact_compare_baseline(self):
        owner=self.view['z']; item=owner['first']; item['extension']['note']='changed'
        changes=owner.changed()
        self.assertEqual(len(changes),1)
        key,new,old=changes[0]
        self.assertEqual(key,'first'); self.assertEqual(old,receiptrows.dumps(self.source['z']['first']))
        self.assertEqual(json.loads(new)['extension']['note'],'changed')
        self.assertEqual(len(self.calls),2)

    def test_new_receipt_does_not_enumerate_old_receipts(self):
        owner=self.view['z']; owner['new']=receipt('z','new','fresh')
        self.assertEqual(len(owner),3); self.assertEqual(len(self.calls),2)
        self.assertEqual(owner.changed()[0][2],None)
        self.assertFalse(any('ORDER BY' in query for query,_ in self.calls))

    def test_explicit_materialization_preserves_order_and_edits(self):
        self.view['z']['second']['extension']['note']='edited'
        full=self.view.plain()
        expected=copy.deepcopy(self.source); expected['z']['second']['extension']['note']='edited'
        self.assertEqual(full,expected); self.assertEqual(list(full['z']),['first','second'])
        self.assertEqual(json.loads(json.dumps(full)),expected)

    def test_direct_json_refuses_instead_of_silently_dropping_cold_data(self):
        with self.assertRaises(TypeError): json.dumps(self.view)
        self.assertEqual(self.calls,[])

    def test_copy_is_detached_and_keeps_write_baselines(self):
        detached=copy.deepcopy(self.view)
        detached['z']['first']['outcome']='reclaimed'
        self.assertEqual(self.view['z']['first']['outcome'],'confirmed')
        self.assertEqual(len(detached['z'].changed()),1)

    def test_cold_equality_resolves_both_operands(self):
        other=maps.ReceiptSection('fixture',3)
        self.assertEqual(self.view,other)
        self.assertFalse(self.view!=other)
        other['z']['first']['outcome']='reclaimed'
        self.assertNotEqual(self.view,other)

    def test_delete_existing_and_new_preserves_length_and_baselines(self):
        owner=self.view['z']; del owner['first']; owner['new']=receipt('z','new','n'); del owner['new']
        self.assertEqual(len(owner),1); self.assertEqual(owner.deleted,{'first'})
        self.assertEqual(owner.plain(),{'second':self.source['z']['second']})

    def test_negative_lookup_is_cached_and_owner_replacement_is_explicit(self):
        self.assertIsNone(self.view.get('missing')); self.assertIsNone(self.view.get('missing'))
        self.assertEqual(len(self.calls),1)
        self.view.setdefault('missing',{})['op']=receipt('missing','op','tok')
        self.assertIn('missing',self.view.replaced)
        self.assertEqual(self.view.plain()['missing']['op']['node'],'missing')


if __name__=='__main__': unittest.main()
