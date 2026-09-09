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
if Path(store.DATA_ROOT).resolve() != Path(_root.name).resolve():
    # `DATA_ROOT` binds at import time. Under `unittest discover`, another
    # test module sharing this process may have already bound it to ITS
    # root before this file's import ran — declare inert rather than
    # asserting, so that shows up as a skip, not an opaque loader error.
    raise unittest.SkipTest(
        "store.DATA_ROOT already bound elsewhere in this process; "
        "run this file on its own (see tests/test_transcript_lookup.py)")


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

    def test_clear_makes_the_doc_falsy(self):
        # clear() leaves the section in `_present` (by design, so a later
        # `__contains__`/materialize can't resurrect it) while also adding
        # it to `_dropped` — __bool__ must read that as empty, not present.
        doc = store.LazyDoc("somebody")
        doc._present.add("mail_log")
        self.assertTrue(bool(doc))
        doc.clear()
        self.assertFalse(bool(doc))
        self.assertIn("mail_log", doc._present)

    def test_deleting_the_last_present_section_makes_the_doc_falsy(self):
        doc = store.LazyDoc("somebody")
        doc._present.add("mail_log")
        dict.__setitem__(doc, "mail_log", [])
        self.assertTrue(bool(doc))
        del doc["mail_log"]
        self.assertFalse(bool(doc))

    def test_popping_the_last_present_section_makes_the_doc_falsy(self):
        doc = store.LazyDoc("somebody")
        doc._present.add("mail_log")
        dict.__setitem__(doc, "mail_log", [])
        doc.pop("mail_log")
        self.assertFalse(bool(doc))

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
