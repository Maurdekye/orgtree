"""LazyDoc truthiness must never materialize a lazy section — the same trap
SectionMap.__bool__ already documents, but LazyDoc lacked the override.
`local_net_slugs`'s `(loaded or {})` hit exactly this on an already-loaded
org, materializing every lazy section to answer one truthiness check."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix='v2-lazydoc-bool-')
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name, USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import store  # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


def tearDownModule():
    store._POOL.close_all('bool-trap-org')
    _root.cleanup()


class LazyDocBoolTests(unittest.TestCase):
    def test_bare_doc_is_falsy_without_materializing(self):
        doc = store.LazyDoc("nobody")
        self.assertFalse(doc)
        self.assertEqual(doc._unmaterialized(), set())

    def test_present_lazy_section_is_truthy_without_materializing(self):
        doc = store.LazyDoc("somebody")
        doc._present.add("mail_log")
        self.assertTrue(bool(doc))
        self.assertTrue(doc or False)
        # the whole point: __bool__ must not have loaded the section
        self.assertFalse(dict.__contains__(doc, "mail_log"))

    def test_raw_key_is_truthy_without_materializing(self):
        doc = store.LazyDoc("somebody")
        dict.__setitem__(doc, "slug", "somebody")
        self.assertTrue(bool(doc))
        self.assertEqual(doc._unmaterialized(), set())

    def test_local_net_slugs_does_not_materialize_the_passed_org(self):
        org = store.create_org("Bool Trap Org")
        slug = org.d["slug"]

        fresh = store.load_org(slug)
        # `create_org` seeds a founding event, so this lazy section is on
        # record but a fresh load has not touched it yet.
        before = fresh.d._unmaterialized()
        self.assertTrue(before, "fixture org has no lazy section to guard")

        store.local_net_slugs(fresh.d)

        self.assertEqual(
            fresh.d._unmaterialized(), before,
            "local_net_slugs materialized a lazy section it never reads")


if __name__ == "__main__":
    unittest.main()
