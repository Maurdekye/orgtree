"""pgstore.read_marker caches the org id per marker file and never answers
with a stale one.

N1000 profile (2026-09-28): every connection checkout opened and JSON-parsed
its org's `.pg` marker, 11.9 CPU-seconds over the run. read_marker now keeps
(file id, size, mtime) -> org_id and answers from that while a stat still
matches. What this proves, with real files and no database:
  * a repeated read does not open the file (the saving is real);
  * file deleted (or moved to the trash, as delete_org does) -> None;
  * org re-created at the same path (_write_marker) -> the new id;
  * the file replaced by ANOTHER org's marker with the same size and the
    same mtime (only the file id differs) -> the new id;
  * an in-place rewrite that changes only the mtime, or only the size
    -> the new id.

Run:  python tools/run-python-verification.py tests/test_pg_marker_cache.py
"""
import builtins
import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import pgstore


def _raw_write(path, org_id, slug):
    with open(path, 'wb') as f:
        f.write(json.dumps({'org_id': org_id, 'slug': slug}).encode('utf-8'))


class MarkerCache(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='marker-cache-')
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.path = os.path.join(self.dir, 'acme.pg')
        pgstore._write_marker(self.path, 'acme', 101)
        pgstore._marker_cache.clear()

    def opens(self, fn):
        """(result, how many times the marker file was opened)."""
        real, n = builtins.open, [0]

        def counting(file, *a, **k):
            if os.path.abspath(str(file)) == os.path.abspath(self.path):
                n[0] += 1
            return real(file, *a, **k)
        with patch.object(builtins, 'open', counting):
            out = fn()
        return out, n[0]

    def test_repeated_read_is_served_without_opening_the_file(self):
        self.assertEqual(self.opens(lambda: pgstore.read_marker(self.path)), (101, 1))
        self.assertEqual(self.opens(lambda: [pgstore.read_marker(self.path) for _ in range(50)]),
                         ([101] * 50, 0))

    def test_deleted_file_answers_none(self):
        self.assertEqual(pgstore.read_marker(self.path), 101)
        os.remove(self.path)
        self.assertIsNone(pgstore.read_marker(self.path))
        self.assertNotIn(self.path, pgstore._marker_cache)

    def test_moved_to_trash_then_org_recreated_at_same_path(self):
        self.assertEqual(pgstore.read_marker(self.path), 101)
        trash = os.path.join(self.dir, 'trash-acme.pg')
        os.replace(self.path, trash)                       # delete_org's move
        self.assertIsNone(pgstore.read_marker(self.path))
        pgstore._write_marker(self.path, 'acme', 202)      # a new org, same name
        self.assertEqual(pgstore.read_marker(self.path), 202)
        self.assertEqual(pgstore.read_marker(trash), 101)

    def test_replaced_by_another_orgs_marker_same_size_same_mtime(self):
        self.assertEqual(pgstore.read_marker(self.path), 101)
        st = os.stat(self.path)
        other = os.path.join(self.dir, 'other.pg')
        _raw_write(other, 909, 'acme')                     # same length as 101/acme
        os.utime(other, ns=(st.st_atime_ns, st.st_mtime_ns))
        os.replace(other, self.path)                       # e.g. restored over it
        st2 = os.stat(self.path)
        self.assertEqual((st2.st_size, st2.st_mtime_ns), (st.st_size, st.st_mtime_ns),
                         'the control: only the file id may differ')
        self.assertNotEqual(st2.st_ino, st.st_ino)
        self.assertEqual(pgstore.read_marker(self.path), 909)

    def test_in_place_rewrite_same_size_new_mtime(self):
        self.assertEqual(pgstore.read_marker(self.path), 101)
        st = os.stat(self.path)
        with open(self.path, 'r+b') as f:
            f.write(json.dumps({'org_id': 303, 'slug': 'acme'}).encode('utf-8'))
        os.utime(self.path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
        st2 = os.stat(self.path)
        self.assertEqual((st2.st_ino, st2.st_size), (st.st_ino, st.st_size),
                         'the control: only the mtime may differ')
        self.assertEqual(pgstore.read_marker(self.path), 303)

    def test_in_place_rewrite_new_size_same_mtime(self):
        self.assertEqual(pgstore.read_marker(self.path), 101)
        st = os.stat(self.path)
        with open(self.path, 'r+b') as f:
            f.write(json.dumps({'org_id': 40404, 'slug': 'acme'}).encode('utf-8'))
        os.utime(self.path, ns=(st.st_atime_ns, st.st_mtime_ns))
        st2 = os.stat(self.path)
        self.assertEqual((st2.st_ino, st2.st_mtime_ns), (st.st_ino, st.st_mtime_ns),
                         'the control: only the size may differ')
        self.assertEqual(pgstore.read_marker(self.path), 40404)

    def test_missing_file_never_read(self):
        self.assertIsNone(pgstore.read_marker(os.path.join(self.dir, 'nobody.pg')))


if __name__ == '__main__':
    unittest.main()
