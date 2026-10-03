"""Static checks of the one-database-per-org layout (no database needed).

What it proves:
  * database names: the product prefix, every pattern of design §2.10, the
    legacy database `orgtree` matching none of them, the 63-byte limit, and a
    bad test prefix refused;
  * the admin connection (Q10, design §2.11): its environment variable is read
    by orgdb/lifecycle.py alone among the engine's modules, and only the
    database bracket (engine/pg_process.py) may set it;
  * no engine module spells a database name of the new layout itself: names
    come from orgdb/names.py, so a test or rehearsal prefix always applies.

Run:  python tools/run-python-verification.py tests/test_orgdb_static.py
"""

import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree.orgdb import lifecycle, names

REPO = Path(__file__).resolve().parent.parent
ENGINE = REPO / 'engine'
ORGTREE = ENGINE / 'backend' / 'orgtree'


def _python_files(root: Path) -> list[Path]:
    return [p for p in root.rglob('*.py') if '__pycache__' not in p.parts]


class Names(unittest.TestCase):
    def test_product_names(self) -> None:
        with patch.dict(os.environ, {names.PREFIX_ENV: ''}):
            self.assertEqual(names.prefix(), 'orgtree_')
            self.assertEqual(names.app(), 'orgtree_app')
            self.assertEqual(names.org(7), 'orgtree_org_7')
            self.assertEqual(names.stage(7, 3), 'orgtree_stage_7_3')
            self.assertEqual(names.trash(7, '20261002t154800'), 'orgtree_trash_7_20261002t154800')
            for name, kind in (('orgtree_app', 'app'), ('orgtree_org_7', 'org'),
                               ('orgtree_stage_7_3', 'stage'),
                               ('orgtree_trash_7_20261002t154800', 'trash'),
                               ('orgtree', None), ('orgtree_org_x', None), ('postgres', None),
                               ('t1_org_7', None)):
                self.assertEqual(names.kind(name), kind, name)

    def test_test_prefix_and_limits(self) -> None:
        with patch.dict(os.environ, {names.PREFIX_ENV: 't123_'}):
            self.assertEqual(names.org(1), 't123_org_1')
            self.assertEqual(names.kind('orgtree_org_1'), None)
        for bad in ('T1_', 't1', '1t_', 't-1_', 'orgtree', 'x' * 30 + '_'):
            with patch.dict(os.environ, {names.PREFIX_ENV: bad}):
                with self.assertRaises(ValueError, msg=bad):
                    names.prefix()
        with self.assertRaises(ValueError):
            names.stage(10 ** 18, 10 ** 18, 'a' * 24 + '_')
        with self.assertRaises(ValueError):
            names.trash(1, '2026-10-02')
        with self.assertRaises(ValueError):
            names.org(-1)


class AdminConnection(unittest.TestCase):
    def test_only_lifecycle_reads_the_admin_conninfo(self) -> None:
        needle = lifecycle.ADMIN_ENV
        # devguard names it only to drop it from an agent child's environment (A7b, G3-A2)
        allowed = {ORGTREE / 'orgdb' / 'lifecycle.py', ENGINE / 'pg_process.py',
                   ORGTREE / 'devguard.py'}
        offenders = [str(p.relative_to(REPO)) for p in _python_files(ENGINE)
                     if p not in allowed and needle in p.read_text(encoding='utf-8')]
        self.assertEqual(offenders, [])
        from orgtree import devguard
        self.assertIn(needle, devguard.ENGINE_STORE_VARS)
        self.assertIn('os.environ.get(ADMIN_ENV',
                      (ORGTREE / 'orgdb' / 'lifecycle.py').read_text(encoding='utf-8'))

    def test_no_module_spells_a_new_database_name(self) -> None:
        spelled = re.compile(r"""['"]orgtree_(app|org_|stage_|trash_)""")
        offenders = [str(p.relative_to(REPO)) for p in _python_files(ENGINE)
                     if p != ORGTREE / 'orgdb' / 'names.py'
                     and spelled.search(p.read_text(encoding='utf-8'))]
        self.assertEqual(offenders, [])


if __name__ == '__main__':
    unittest.main()
