"""Registry writers are inventoried and may never acquire the revision row."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import ast
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / 'engine/backend/orgtree'
WRITERS = frozenset({'_claim_in', '_step', '_release', 'take_over', '_insert_row',
    'set_legacy_source', '_mark_unavailable', 'note_retry_failure', '_cancel_create',
    '_set_state', '_resume_purge'})


def strings(node):
    return ' '.join(n.value for n in ast.walk(node) if isinstance(n, ast.Constant)
                    and isinstance(n.value, str))


def inventory():
    result = set()
    for path in BACKEND.rglob('*.py'):
        tree = ast.parse(path.read_text(encoding='utf-8'))
        # Function-local literals include f-string constant chunks. Exclude
        # enclosing classes/modules to attribute every writer exactly once.
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                text = strings(node)
                if re.search(r'(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+orgtree\.orgs\b', text, re.I):
                    result.add((path.relative_to(BACKEND).as_posix(), node.name))
    return result


class RegistryLockOrder(unittest.TestCase):
    def test_all_registry_writers_remain_lifecycle_owned(self):
        self.assertEqual(inventory(), {('orgdb/lifecycle.py', name) for name in WRITERS})
        source = (BACKEND / 'orgdb/lifecycle.py').read_text(encoding='utf-8')
        self.assertNotRegex(source.lower(), r'registry_revision|set\s+constraints.*immediate')

    def test_no_python_writer_or_locker_of_revision_singleton(self):
        for path in BACKEND.rglob('*.py'):
            source = strings(ast.parse(path.read_text(encoding='utf-8')))
            self.assertNotRegex(source, r'(?i)(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+orgtree\.registry_revision')
            self.assertNotRegex(source, r'(?i)registry_revision\s+(?:\w+\s+)?FOR\s+(?:UPDATE|SHARE)')

    def test_flush_only_updates_revision_then_notifies_and_statement_redefers(self):
        sql = (BACKEND / 'pg_migrations/app/0005_app_feed.sql').read_text(encoding='utf-8')
        flush = sql.split('AS $fn$')[1].split('$fn$;')[0]
        self.assertEqual(len(re.findall(r'UPDATE\s+orgtree.registry_revision', flush)), 1)
        self.assertNotRegex(flush, r'(?i)\b(?:FROM|JOIN|UPDATE|INTO)\s+orgtree\.(?!registry_revision)')
        self.assertLess(flush.index('UPDATE orgtree.registry_revision'), flush.index("pg_notify('app_rev'"))
        self.assertIn('DEFERRABLE INITIALLY DEFERRED FOR EACH ROW', sql)
        self.assertIn('SET CONSTRAINTS orgtree.registry_flush DEFERRED', sql)
        self.assertIn('BEFORE INSERT OR UPDATE OR DELETE ON orgtree.orgs', sql)


if __name__ == '__main__':
    unittest.main()
