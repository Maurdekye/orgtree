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
            'engine/backend/orgtree/orgdb/mappers/docket.py',
            'engine/backend/orgtree/orgdb/compat/rows.py'})


if __name__=='__main__':
    unittest.main()
