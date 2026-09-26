"""The native startup digest reads an unchanged instruction file once.

scale (scale-runtime slice B, 2026-09-26): the keeper recomputes every
seat's identity on every pass, and `native_startup_context_digest` opened,
read and hashed each seat's CLAUDE.md chain, granted-dir roots, rules and
MEMORY.md prefix every time (~30% of non-idle samples at 20 seats). Each
file's contribution is now cached against its (st_mtime_ns, st_size).

  * SAME DIGEST: the cached digest equals a cold (cache-cleared) digest over
    a tree with imports, a granted dir, startup and path-scoped rules, and a
    MEMORY.md, and it still changes when any one of those files changes.
  * NO RE-READ: a second pass over unchanged files opens nothing.
  * EDITS ARE SEEN: a same-size edit with a new mtime changes the digest on
    the next pass; so does a size change, a new file and a removed file.

Run:  python tools/run-python-verification.py tests/test_warmpool_digest_cache.py
"""
import builtins
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v3-digestcache-', ignore_cleanup_errors=True)
R = Path(_root.name)
(R / 'data').mkdir()
(R / 'home').mkdir()
os.environ.update(ORGTREE_DATA=str(R / 'data'), HOME=str(R / 'home'),
                  USERPROFILE=str(R / 'home'), ORGTREE_STORE='sqlite')

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from orgtree import supervisor, warmpool  # noqa: E402

HOME = R / 'home'
CWD = R / 'scratch' / 'seat'
GRANT = R / 'grant'


def tearDownModule() -> None:
    _root.cleanup()


def write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(text.encode('utf-8'))


def bump(p: Path, text: str) -> None:
    """Rewrite with the SAME size and a strictly later mtime."""
    st = p.stat()
    assert len(text.encode('utf-8')) == st.st_size
    p.write_bytes(text.encode('utf-8'))
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000))


ORG = SimpleNamespace(d={'slug': 'dc'},
                      nodes={'seat': {'scope': {'add_dirs': [{'path': str(GRANT)}]}}})


def digest() -> str:
    return warmpool.native_startup_context_digest(ORG, 'seat')


def cold() -> str:
    getattr(warmpool, '_DIGEST_FILE_CACHE', {}).clear()
    return digest()


class DigestCache(unittest.TestCase):
    def setUp(self) -> None:
        self.p = patch.object(supervisor, 'scratch_dir', lambda slug, nid: str(CWD))
        self.p.start()
        CWD.mkdir(parents=True, exist_ok=True)
        write(HOME / '.claude' / 'CLAUDE.md', 'user notes @imp.md\n')
        write(HOME / '.claude' / 'imp.md', 'imported AAAA\n')
        write(CWD / 'CLAUDE.md', 'seat notes\n')
        write(GRANT / 'CLAUDE.md', 'grant charter\n')
        write(CWD / '.claude' / 'rules' / 'start.md', 'always on\n')
        write(CWD / '.claude' / 'rules' / 'lazy.md', '---\npaths: src/**\n---\nlazy\n')
        mem = HOME / '.claude' / 'projects' / supervisor._cli_project_dir(
            os.path.abspath(str(CWD))) / 'memory' / 'MEMORY.md'
        write(mem, '- memory line\n')
        self.mem = mem

    def tearDown(self) -> None:
        self.p.stop()

    def test_cached_digest_equals_a_cold_digest(self) -> None:
        c = cold()
        self.assertEqual(digest(), c)
        self.assertEqual(digest(), cold())

    def test_a_warm_pass_opens_no_file(self) -> None:
        cold()
        real = builtins.open
        opened: list[str] = []

        def spy(file, *a, **k):
            opened.append(str(file))
            return real(file, *a, **k)
        with patch.object(builtins, 'open', spy):
            digest()
        self.assertEqual(opened, [])

    def test_every_kind_of_edit_is_seen_on_the_next_pass(self) -> None:
        cases = [
            ('same-size seat note', lambda: bump(CWD / 'CLAUDE.md', 'SEAT notes\n')),
            ('same-size import', lambda: bump(HOME / '.claude' / 'imp.md', 'imported BBBB\n')),
            ('granted root grows', lambda: write(GRANT / 'CLAUDE.md', 'grant charter v2\n')),
            ('startup rule', lambda: bump(CWD / '.claude' / 'rules' / 'start.md', 'ALWAYS on\n')),
            ('memory', lambda: bump(self.mem, '- MEMORY line\n')),
            ('new local file', lambda: write(CWD / 'CLAUDE.local.md', 'local\n')),
            ('removed file', lambda: (CWD / 'CLAUDE.md').unlink()),
        ]
        for name, edit in cases:
            with self.subTest(name):
                before = digest()
                edit()
                after = digest()
                self.assertNotEqual(after, before, name)
                self.assertEqual(after, cold(), name)

    def test_a_path_scoped_rule_edit_moves_nothing(self) -> None:
        before = cold()
        bump(CWD / '.claude' / 'rules' / 'lazy.md', '---\npaths: src/**\n---\nLAZY\n')
        self.assertEqual(digest(), before)


if __name__ == '__main__':
    unittest.main()
