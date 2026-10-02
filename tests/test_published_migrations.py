"""Published legacy migrations must keep the exact LF bytes upgrading stores know."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
PUBLISHED = json.loads((ROOT / 'tests/fixtures/upgrade-paths/published-migrations.json').read_text())
MIGRATIONS = ROOT / 'engine/backend/orgtree/pg_migrations'


class PublishedMigrations(unittest.TestCase):
    def test_0001_through_0020_keep_the_published_checksums(self):
        expected = PUBLISHED['3.1.0']['migrations']
        self.assertEqual(len(expected), 20)
        self.assertEqual([int(n[:4]) for n in sorted(expected)], list(range(1, 21)))
        self.assertEqual({p.name for p in MIGRATIONS.glob('*.sql')
                          if p.name[:4].isdigit() and int(p.name[:4]) <= 20}, set(expected))
        for name, checksum in expected.items():
            with self.subTest(migration=name):
                self.assertTrue((MIGRATIONS / name).is_file(), name)
                got = hashlib.sha256((MIGRATIONS / name).read_bytes().replace(b'\r\n', b'\n')).hexdigest()
                self.assertEqual(got, checksum, name)

    def test_all_3_0_releases_ship_the_same_19_migrations(self):
        expected = PUBLISHED['3.0.9']['migrations']
        self.assertEqual(len(expected), 19)
        for n in range(10):
            self.assertEqual(PUBLISHED[f'3.0.{n}']['migrations'], expected)
        self.assertEqual({k: v for k, v in PUBLISHED['3.1.0']['migrations'].items()
                          if int(k[:4]) <= 19}, expected)


if __name__ == '__main__':
    unittest.main()
