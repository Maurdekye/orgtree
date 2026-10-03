"""Question-link catalog flags survive forced checks and rollback."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import unittest

import test_orgdb_docket_pg as fixture
from orgtree.orgdb import conn


setUpModule = fixture.setUpModule


@unittest.skipUnless(fixture.ADMIN and fixture.RUNTIME, 'disposable PostgreSQL URLs required')
class ForcedQuestionChecks(unittest.TestCase):
    def test_redefer_count_once_and_discard_rolled_back_flags(self):
        with conn.connect(fixture.ADMIN, fixture.DATABASE) as raw:
            key, original = raw.execute(
                'SELECT ask_id,item_slug FROM orgtree.docket_question_links ORDER BY ask_id LIMIT 1'
            ).fetchone()
            def revision():
                return raw.execute('SELECT docket_rev FROM orgtree.org_revision').fetchone()[0]
            def update(value):
                raw.execute('UPDATE orgtree.docket_question_links SET item_slug=%s WHERE ask_id=%s',
                            (value, key))
            before = revision()
            with raw.transaction():
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                update('forced-question')
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                self.assertEqual(revision(), before+1)
                with self.assertRaisesRegex(RuntimeError, 'discard change'), raw.transaction():
                    update('discarded-question')
                    raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                    raise RuntimeError('discard change')
                self.assertEqual(revision(), before+1)
                update(original)
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                self.assertEqual(revision(), before+1)
            self.assertEqual(revision(), before+1)

            # A rolled-back forced flush must not suppress the next transaction
            # on this same connection.
            with self.assertRaisesRegex(RuntimeError, 'discard transaction'), raw.transaction():
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                update('forced-question')
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                raise RuntimeError('discard transaction')
            self.assertEqual(revision(), before+1)
            with raw.transaction():
                raw.execute('SET CONSTRAINTS ALL IMMEDIATE')
                update(original)
            self.assertEqual(revision(), before+2)


if __name__ == '__main__':
    unittest.main()
