"""A message only READS `audiences` unless it will grant one: FOR SHARE then.

n1000-burst-27-of-messages-fail-with-locktimeout, step 2: every message door
transaction held the org-wide `audiences` list FOR UPDATE, so every send in the
org waited on every other. `post_mail` writes it only for the outside-mail
auto-grant and the §7.3 reply grant (a strict, non-parent ancestor messaging a
descendant that holds no audience to it yet); `message_spec` predicts that from
the snapshot and otherwise takes the list FOR SHARE. A wrong "no" is refused at
save (UnlockedWrite) and pgdoor re-runs the call holding it FOR UPDATE, rolled
back first, so the grant lands exactly once. Actual PostgreSQL via test_pgstore.

Run:  python tools/run-python-verification.py tests/test_message_audience_locks_pg.py
"""
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import test_pgstore as f
from orgtree import maildoor, mailtx, orgtx, pgdoor, store

# boss > lead > worker; boss > peer
PARENT = {'boss': None, 'lead': 'boss', 'worker': 'lead', 'peer': 'boss'}


def tearDownModule():
    f.tearDownModule()


def snapshot(audiences=()):
    def ancestors(n):
        out, p = [], PARENT[n]
        while p is not None:
            out.append(p); p = PARENT[p]
        return out
    return SimpleNamespace(
        is_ancestor=lambda a, n: a in ancestors(n),
        node=lambda n: {'parent': PARENT[n]},
        _has_audience=lambda grantee, grantor: (grantee, grantor) in set(audiences))


def spec_for(sender, to, snap=None):
    call = SimpleNamespace(node=sender)
    with patch.object(maildoor, '_resolve_on_snapshot', lambda s, t, **kw: [t] if t else []), \
         patch.object(maildoor, '_with_path', lambda spec, s, caller, *o: spec):
        return maildoor.message_spec(snap or snapshot(), call, {'to': to})


def exclusive(spec):
    return 'audiences' in spec.sections and 'audiences' not in spec.share_sections


class Prediction(unittest.TestCase):
    def test_ordinary_sends_only_share_the_list(self):
        for sender, to in (('boss', 'lead'), ('lead', 'boss'), ('lead', 'peer'), ('worker', 'lead')):
            with self.subTest(sender=sender, to=to):
                spec = spec_for(sender, to)
                self.assertIn('audiences', spec.share_sections)
                self.assertNotIn('audiences', spec.sections)

    def test_a_reply_grant_takes_it_for_update(self):
        # boss -> worker: a strict, non-parent ancestor; worker holds no audience to boss
        self.assertTrue(exclusive(spec_for('boss', 'worker')))

    def test_an_existing_reply_audience_needs_no_write(self):
        spec = spec_for('boss', 'worker', snapshot([('worker', 'boss')]))
        self.assertIn('audiences', spec.share_sections)

    def test_outside_mail_and_an_unresolved_recipient_take_it_for_update(self):
        self.assertTrue(exclusive(spec_for('boss', '@net:elsewhere')))
        self.assertTrue(exclusive(spec_for('boss', '')))

    def test_mail_to_the_user_only_shares_it(self):
        self.assertIn('audiences', spec_for('boss', mailtx.USER).share_sections)


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class OnPostgres(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        self.slug = f._fresh_org('audlock-' + self._testMethodName[-12:])

    def rows(self, to, shared=True):
        rows = mailtx.owner_notices(mailtx.send_rows(to), to)
        return mailtx.shared_audiences(rows) if shared else rows

    def held_while(self, first, second):
        held, release, failed = threading.Event(), threading.Event(), []

        def holder():
            try:
                with orgtx.org_tx(self.slug, **first):
                    held.set(); release.wait(15)
            except Exception as e:                            # noqa: BLE001
                failed.append(e); held.set()
        t = threading.Thread(target=holder); t.start()
        try:
            self.assertTrue(held.wait(15)); self.assertFalse(failed, failed)
            with orgtx.org_tx(self.slug, lock_timeout=1, retries=0, **second):
                pass
        finally:
            release.set(); t.join(20)

    def test_two_reading_sends_do_not_wait_on_each_other(self):
        self.held_while(self.rows('b'), self.rows('c'))

    def test_control_the_exclusive_list_made_them_wait(self):
        with self.assertRaises(orgtx.LockTimeout):
            self.held_while(self.rows('b', shared=False), self.rows('c', shared=False))

    def test_a_wrong_no_is_refused_and_rerun_holding_it_exactly_once(self):
        """The refuse-and-retry path: the body writes the list under a spec
        that only shared it; pgdoor re-runs it once, FOR UPDATE, and the
        grant is stored once."""
        rows = self.rows('b')
        spec = pgdoor.TxSpec(**{k: tuple(v) for k, v in rows.items()})
        seen = []

        def step(h, spec_now):
            seen.append(('audiences' in spec_now.sections, 'audiences' in spec_now.share_sections))
            h.org.d['audiences'].append({'grantee': 'b', 'grantor': 'a', 'granted_at': 'now',
                                         'reason': 'a messaged directly'})
            return 'sent'

        _h, out = pgdoor._run(self.slug, spec, step)
        self.assertEqual(out, 'sent')
        self.assertEqual(seen, [(False, True), (True, False)], 'shared first, then FOR UPDATE once')
        stored = [a for a in store.load_org(self.slug).d['audiences']
                  if a['grantee'] == 'b' and a['grantor'] == 'a']
        self.assertEqual(len(stored), 1, 'the refused attempt was rolled back')


if __name__ == '__main__':
    unittest.main()
