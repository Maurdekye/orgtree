"""Physical row contracts, including independent stored-value oracles."""
import copy
import json
import sqlite3
import unittest
from unittest.mock import patch
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import store, workrows
from orgtree.stateprobe import SaveChanges


def items():
    return [{"slug": "one", "notification_attention_active": False, "nested": {"values": [1]}, "rev": 1},
            {"slug": "two", "notification_attention_active": False, "nested": {"values": [2]}, "rev": 1}]


class WorkRows(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:", isolation_level=None)
        self.conn.executescript(store._DDL)
        self.pg = patch.object(store, "STORE_BACKEND", "postgres"); self.pg.start()
        self.cas = patch.object(store, "_ROW_CAS", True); self.cas.start()
        self.save({"slug": "rows", "nodes": {}, "work_items": items()})
        store._meta_set(self.conn, "schema_version", store._SCHEMA_VERSION)

    def tearDown(self):
        self.cas.stop(); self.pg.stop(); self.conn.close()

    def save(self, doc):
        change = SaveChanges()
        self.conn.execute("BEGIN")
        try:
            result = store._write_doc(self.conn, doc, doc if isinstance(doc, store.LazyDoc) else None, change)
            self.conn.execute("COMMIT")
            return change, result
        except BaseException:
            self.conn.execute("ROLLBACK"); raise

    def load(self):
        return store._load_lazy(self.conn, "rows")

    def read(self):
        return workrows.assemble(dict(self.conn.execute("SELECT key,val FROM doc WHERE key='work_items' OR substr(key,1,11)=?", (workrows.PREFIX,))))

    def test_nested_edit_only_one_row_and_no_header(self):
        d = self.load(); d['work_items'][0]['nested']['values'].append(3)
        change, _ = self.save(d)
        self.assertEqual(change.doc_upserts, [workrows.PREFIX+'one'])
        self.assertEqual(self.read()[0]['nested']['values'], [1,3])
        self.assertEqual(self.read()[1], items()[1])

    def test_unchanged_item_not_serialized_by_attention(self):
        from orgtree.notification_state import reconcile_attention
        d=self.load(); d['work_items'][0]['rev']=2
        reconcile_attention(d)
        encoded=[]; original=store._dumps
        def dumps(value):
            if isinstance(value, dict) and 'slug' in value: encoded.append(value['slug'])
            return original(value)
        with patch.object(store, '_dumps', dumps): self.save(d)
        self.assertEqual(encoded, ['one'])
        self.assertEqual(self.read()[0]['rev'],2)

    def test_stale_same_item_rolls_back_other_changes(self):
        old=self.load(); new=self.load()
        new['work_items'][0]['rev']=2; self.save(new)
        old['work_items'][1]['rev']=9; old['work_items'][0]['rev']=3
        old['work_items'].reverse() # ensures another update before conflict
        with self.assertRaises(store.StaleWrite): self.save(old)
        self.assertEqual([(x['slug'],x['rev']) for x in self.read()], [('one',2),('two',1)])

    def test_different_item_stale_snapshots_merge(self):
        a=self.load(); b=self.load()
        a['work_items'][0]['rev']=2; b['work_items'][1]['rev']=3
        self.save(a); self.save(b)
        self.assertEqual([x['rev'] for x in self.read()], [2,3])

    def test_header_conflict_and_delete_conflict(self):
        old=self.load(); new=self.load(); new['work_items'].reverse(); self.save(new)
        old['work_items'].append({'slug':'three'})
        with self.assertRaises(store.StaleWrite): self.save(old)
        old=self.load(); new=self.load(); new['work_items'][0]['rev']=4; self.save(new)
        del old['work_items'][0]
        with self.assertRaises(store.StaleWrite): self.save(old)
        self.assertEqual([x['slug'] for x in self.read()], ['two','one'])

    def test_insert_duplicate_cas(self):
        old=self.load()
        old['work_items'].append({'slug':'three'})
        self.conn.execute('INSERT INTO doc VALUES(?,?)',(workrows.PREFIX+'three','{"slug":"three","value":2}'))
        with self.assertRaises(store.StaleWrite): self.save(old)
        self.assertEqual(workrows.ids_from_header(self.conn.execute("SELECT val FROM doc WHERE key='work_items'").fetchone()[0]), ['one','two'])

    def test_external_slice_alias_and_type_change_persist(self):
        d=self.load(); external={'value':1}
        values=d['work_items'][0]['nested']['values']; values[:]=(external,)
        observed=values[0]; external['value']=2
        d['work_items'][1]['rev']=True
        self.save(d)
        self.assertEqual(self.read()[0]['nested']['values'], [{'value':2}])
        self.assertIs(self.read()[1]['rev'],True)

    def test_plain_replacement_reorder_delete_and_deepcopy(self):
        d=copy.deepcopy(self.load()); d['work_items']=[d['work_items'][1],{'slug':'three','rev':3}]
        self.save(d)
        self.assertEqual([x['slug'] for x in self.read()], ['two','three'])
        self.assertIsNone(self.conn.execute('SELECT val FROM doc WHERE key=?',(workrows.PREFIX+'one',)).fetchone())

    def test_sqlite_keeps_blob_and_unknown_pg_shapes_refuse(self):
        with patch.object(store,'STORE_BACKEND','sqlite'):
            self.assertEqual(set(store._split_rows('work_items',items())),{'work_items'})
        for value in ({},None,[{'slug':'a'},{'slug':'a'}],[{'slug':''}],[{'slug':'a\x1fb'}]):
            with self.subTest(value=value), self.assertRaises(ValueError): store._split_rows('work_items',value)

    def test_transform_count_checksum_and_corruption(self):
        raw={'work_items':json.dumps(items()),'other':'{"untouched":  1}'}
        rows,check=workrows.transform(raw)
        self.assertEqual(check,workrows.checksum(items()))
        self.assertEqual(rows['other'],raw['other'])
        self.assertEqual(workrows.assemble({k:v for k,v in rows.items() if k!='other'}),items())
        for corrupt in ({workrows.PREFIX+'one':'{}'}, {'work_items':'{}'},
                        {**rows,workrows.PREFIX+'extra':'{}'},
                        {**rows,workrows.PREFIX+'one':'{"slug":"wrong"}'}):
            with self.subTest(corrupt=corrupt), self.assertRaises(ValueError): workrows.transform(corrupt)
        self.assertNotEqual(workrows.checksum([{'slug':'a','v':1}]),workrows.checksum([{'slug':'a','v':True}]))


if __name__=='__main__': unittest.main()
