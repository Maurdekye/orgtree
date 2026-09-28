"""A local orgtree_message locks its recipients' notice boxes, not the org's.

n1000-burst-27-of-messages-fail-with-locktimeout, step 1: every message door
transaction held the WHOLE `notices` section FOR UPDATE, so every send in the
org waited on every other (and on turns, which already take the shared form).
A local send now holds the section FOR SHARE and only its recipients' boxes
FOR UPDATE; outside mail, which may notify a replaced audience holder, keeps
the whole section. Actual PostgreSQL via test_pgstore.

Run:  python tools/run-python-verification.py tests/test_message_notice_locks_pg.py
"""
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import test_pgstore as f
from orgtree import maildoor, mailtx, orgtx, pgdoor, store


def tearDownModule():
    f.tearDownModule()


def spec_for(to):
    call = SimpleNamespace(node='a')
    with patch.object(maildoor, '_resolve_on_snapshot', lambda snap, t, **kw: [t]), \
         patch.object(maildoor, '_with_path', lambda spec, snap, caller, *o: spec):
        return maildoor.message_spec(object(), call, {'to': to})


class Spec(unittest.TestCase):
    def test_a_local_send_locks_only_its_recipients_box(self):
        spec = spec_for('b')
        self.assertNotIn('notices', spec.sections)
        self.assertIn(('notices', 'b'), spec.sections)
        self.assertIn('notices', spec.share_sections)

    def test_mail_to_the_user_takes_no_agent_box(self):
        spec = spec_for(mailtx.USER)
        self.assertNotIn('notices', spec.sections)
        self.assertFalse([s for s in spec.sections if isinstance(s, tuple) and s[0] == 'notices'])
        self.assertIn('notices', spec.share_sections)

    def test_outside_mail_keeps_the_whole_section(self):
        for to in ('@net:elsewhere', '@org:other'):
            with self.subTest(to=to):
                spec = spec_for(to)
                self.assertIn('notices', spec.sections)

    def test_the_lock_plan_is_shared_container_plus_exclusive_box(self):
        spec = spec_for('b')
        rows, containers = orgtx._section_names(spec.sections, 'sections')
        self.assertIn('noticesb', rows)
        self.assertNotIn('notices', rows)
        self.assertIn('notices', containers)


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class Concurrency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        self.slug = f._fresh_org('noticelock-' + self._testMethodName[-12:])

    def rows(self, to, narrowed=True):
        rows = mailtx.send_rows(to)
        if narrowed:
            rows = mailtx.owner_notices(rows, to)
        # step 1 isolates `notices`; `audiences` is step 2
        rows['sections'] = [s for s in rows['sections'] if s != 'audiences']
        return rows

    def held_while(self, first, second):
        """Hold a tx on `first`'s rows; open one on `second`'s with a 1 s wait."""
        held, release, failed = threading.Event(), threading.Event(), []

        def holder():
            try:
                with orgtx.org_tx(self.slug, **first):
                    held.set()
                    release.wait(15)
            except Exception as e:                            # noqa: BLE001
                failed.append(e); held.set()
        t = threading.Thread(target=holder); t.start()
        try:
            self.assertTrue(held.wait(15)); self.assertFalse(failed, failed)
            with orgtx.org_tx(self.slug, lock_timeout=1, retries=0, **second):
                pass
        finally:
            release.set(); t.join(20)

    def test_sends_to_different_recipients_do_not_wait_on_each_other(self):
        self.held_while(self.rows('b'), self.rows('c'))

    def test_control_the_whole_section_made_them_wait(self):
        with self.assertRaises(orgtx.LockTimeout):
            self.held_while(self.rows('b', narrowed=False), self.rows('c', narrowed=False))

    def test_sends_to_the_same_recipient_still_serialize(self):
        with self.assertRaises(orgtx.LockTimeout):
            self.held_while(self.rows('b'), self.rows('b'))


if __name__ == '__main__':
    unittest.main()
