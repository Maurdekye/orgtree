"""Docket write boundaries; no database or engine startup."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT/'engine'/'backend'/'orgtree'/'orgdb'


class DocketWrites(unittest.TestCase):
    def test_every_work_item_encode_uses_the_shared_row_keys_helper(self):
        calls = []
        for path in BACKEND.rglob('*.py'):
            for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
                if not isinstance(node,ast.Call) or not isinstance(node.func,ast.Attribute) or node.func.attr!='encode' or len(node.args)<3:
                    continue
                spec = node.args[0]
                if not ((isinstance(spec,ast.Name) and spec.id=='WORK_ITEM') or
                        (isinstance(spec,ast.Attribute) and spec.attr=='WORK_ITEM')):
                    continue
                calls.append((path.relative_to(ROOT).as_posix(),node.lineno))
                with self.subTest(path=calls[-1][0],line=node.lineno):
                    keys = node.args[2]
                    self.assertIsInstance(keys,ast.Call)
                    self.assertEqual(getattr(keys.func,'id',getattr(keys.func,'attr',None)),'row_keys')
                    self.assertEqual(ast.dump(keys.args[0]),ast.dump(node.args[1]))
        self.assertEqual({p for p,_ in calls},{
            'engine/backend/orgtree/orgdb/docket_events.py'})

    def test_generic_archive_encoders_use_the_same_helper(self):
        tree = ast.parse((BACKEND/'compat'/'rows.py').read_text(encoding='utf-8'))
        for name in ('log_insert','log_replace'):
            function = next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
            with self.subTest(function=name):
                branches = [n for n in ast.walk(function) if isinstance(n,ast.If) and
                    isinstance(n.test,ast.Compare) and isinstance(n.test.left,ast.Attribute) and
                    n.test.left.attr=='kind' and ast.literal_eval(n.test.comparators[0])=='archive']
                self.assertEqual(len(branches),1)
                assignments = [n for n in ast.walk(branches[0]) if isinstance(n,ast.Assign) and
                    any(isinstance(t,ast.Name) and t.id=='keys' for t in n.targets)]
                self.assertTrue(any(isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Attribute)
                    and n.value.func.attr=='row_keys' for n in assignments))


if __name__=='__main__':
    unittest.main()
