"""Custody receipts locked per owner -- only where receipts are rows.

n1000-burst-27-of-messages-fail-with-locktimeout, step 3: every delivery
confirmation and reclaim held the org-wide `mail_transitions` section FOR
UPDATE, so every delivery in the org queued on every other. Confirm/reclaim
now declare ("mail_transitions", nid). On an org whose receipts are ROWS
(store.RECEIPT_ROWS and converted) that is the custody writer's own per-owner
key, so a second tx on the owner queues up front and other owners pass. On an
unconverted org `mail_transitions` is ONE doc blob, and the transaction takes
the whole section exactly as before (orgtx._receipt_scope; coordinator ruling
2026-09-28 08:01Z). Actual PostgreSQL via the receipt-rows fixture.

Run:  python tools/run-python-verification.py tests/test_receipt_owner_locks_pg.py
"""
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import test_pg_receiptrows as fixture
from test_receiptrows import receipt
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import halt, mailtx, orgtx, receiptstore, store
from orgtree.stateprobe import SaveChanges

SEP = store.SPLIT_SEP
OWNER = store.RECEIPT_KEY + SEP


def tearDownModule():
    fixture.tearDownModule()


def tx_with(sections=(), share=()):
    rows, parents = orgtx._section_names(list(sections), 'sections')
    srows, sparents = orgtx._section_names(list(share), 'share_sections')
    return SimpleNamespace(lock_sections=frozenset(rows),
                           share_sections=frozenset(srows | sparents | parents) - frozenset(rows),
                           whole=False, all_nodes=False, lock_nodes=frozenset(), share_nodes=frozenset(),
                           logs=frozenset(),
                           org=None, d={})


class Names(unittest.TestCase):
    def test_a_receipt_owner_is_its_own_row_under_a_shared_container(self):
        rows, parents = orgtx._section_names([(store.RECEIPT_KEY, 'b')], 'sections')
        self.assertEqual(rows, {OWNER + 'b'})
        self.assertEqual(parents, {store.RECEIPT_KEY})

    def test_confirm_and_reclaim_declare_their_own_owner(self):
        self.assertIn((store.RECEIPT_KEY, 'b'), mailtx.confirm_rows('b')['sections'])
        self.assertIn((store.RECEIPT_KEY, 'b'), mailtx.reclaim_rows('b')['sections'])
        self.assertNotIn(store.RECEIPT_KEY, mailtx.confirm_rows('b')['sections'])


class Scope(unittest.TestCase):
    def test_an_unconverted_org_takes_the_whole_section(self):
        tx = tx_with(sections=[(store.RECEIPT_KEY, 'b'), ('delivering', 'b')])
        orgtx._receipt_scope(tx, converted=False)
        self.assertIn(store.RECEIPT_KEY, tx.lock_sections)
        self.assertFalse({s for s in tx.lock_sections if s.startswith(OWNER)})
        self.assertNotIn(store.RECEIPT_KEY, tx.share_sections)
        self.assertIn('delivering' + SEP + 'b', tx.lock_sections, 'other rows untouched')

    def test_a_converted_org_keeps_the_owner_lock(self):
        tx = tx_with(sections=[(store.RECEIPT_KEY, 'b')])
        orgtx._receipt_scope(tx, converted=True)
        self.assertEqual(tx.lock_sections, {OWNER + 'b'})
        self.assertIn(store.RECEIPT_KEY, tx.share_sections)


class WriteCheck(unittest.TestCase):
    def check(self, tx, key):
        changes = SaveChanges()
        changes.doc_upserts.append(key)
        return orgtx._disallowed(tx, changes)

    def test_an_owners_write_needs_that_owner_or_the_whole_section(self):
        self.assertEqual(self.check(tx_with([(store.RECEIPT_KEY, 'b')]), OWNER + 'b'), ())
        self.assertEqual(self.check(tx_with([store.RECEIPT_KEY]), OWNER + 'b'), ())
        self.assertEqual(self.check(tx_with([(store.RECEIPT_KEY, 'a')]), OWNER + 'b'),
                         (('section', OWNER + 'b'),))

    def test_a_blob_write_still_needs_the_whole_section(self):
        self.assertEqual(self.check(tx_with([(store.RECEIPT_KEY, 'b')]), store.RECEIPT_KEY),
                         (('section', store.RECEIPT_KEY),))

    def test_a_halt_join_asking_for_an_owner_is_covered_by_the_whole_section(self):
        outer = tx_with([store.RECEIPT_KEY])
        self.assertEqual(halt._covers(outer, frozenset(), frozenset({OWNER + 'b'}), frozenset(),
                                      frozenset(), frozenset()), [])
        other = tx_with([(store.RECEIPT_KEY, 'a')])
        self.assertTrue(halt._covers(other, frozenset(), frozenset({OWNER + 'b'}), frozenset(),
                                     frozenset(), frozenset()))


class _PgBase(unittest.TestCase):
    raw = fixture.ReceiptStorage.raw
    exported = fixture.ReceiptStorage.exported

    @classmethod
    def setUpClass(cls):
        fixture.ReceiptStorage.setUpClass()

    def setUp(self):
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        fixture.ReceiptStorage.setUp(self)

    def held_while(self, first, second):
        """Hold a tx on `first`; open one on `second` with a 1 s lock wait."""
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

    @staticmethod
    def owner(nid):
        return {'sections': [(store.RECEIPT_KEY, nid)]}


@unittest.skipUnless(fixture.f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class BlobOrg(_PgBase):
    """RECEIPT_ROWS off, as in production today: nothing changes."""

    def setUp(self):
        switch = patch.object(store, 'RECEIPT_ROWS', False); switch.start()
        self.addCleanup(switch.stop)
        super().setUp()

    def test_different_owners_still_serialize_on_the_whole_section(self):
        with self.assertRaises(orgtx.LockTimeout):
            self.held_while(self.owner('z'), self.owner('empty'))

    def test_a_receipt_write_declared_per_owner_still_commits(self):
        with orgtx.org_tx(self.slug, **self.owner('z')) as tx:
            tx.org.d['mail_transitions']['z']['added'] = receipt('z', 'added', 'tok')
        self.assertIn('added', store.load_org(self.slug).d['mail_transitions']['z'])


@unittest.skipUnless(fixture.f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class FlagOnUnconvertedOrg(BlobOrg):
    """RECEIPT_ROWS on, this org NOT converted yet: the rollout state while
    orgs convert one by one. Its receipts are still one blob, so it must keep
    the whole-section lock (pg-workitems' landing condition on 7a9143f: the
    org's own meta row decides, not the flag alone)."""

    def setUp(self):
        switch = patch.object(store, 'RECEIPT_ROWS', True); switch.start()
        self.addCleanup(switch.stop)
        _PgBase.setUp(self)
        with self.raw() as raw:
            self.assertIsNone(raw.execute("SELECT 1 FROM meta WHERE key = %s",
                                          (store._META_RECEIPT_ROWS,)).fetchone(),
                              'control: the fixture org is not converted')


@unittest.skipUnless(fixture.f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class ConvertedOrg(_PgBase):
    """RECEIPT_ROWS on and the org converted: owners lock independently."""

    def setUp(self):
        switch = patch.object(store, 'RECEIPT_ROWS', True); switch.start()
        self.addCleanup(switch.stop)
        super().setUp()
        with self.raw() as raw:
            self.assertIsNotNone(receiptstore.convert(raw, self.oid))

    def test_different_owners_do_not_wait_on_each_other(self):
        self.held_while(self.owner('z'), self.owner('empty'))

    def test_the_owner_lock_is_the_custody_writers_key(self):
        with self.raw() as raw:
            sql = orgtx._lock_block(raw, 7, [('section', OWNER + 'z', True)])
        self.assertIn("hashtext('org_7')", sql)
        self.assertIn("hashtext('receipt-owner:z')", sql)
        self.assertNotIn('FROM doc', sql)

    def test_the_same_owner_queues_up_front(self):
        # MUST 2: the owner lock locks something real, so the second waits
        # here rather than failing later at the writer's version check
        with self.assertRaises(orgtx.LockTimeout):
            self.held_while(self.owner('z'), self.owner('z'))

    def test_a_whole_section_holder_excludes_owner_lockers(self):
        with self.assertRaises(orgtx.LockTimeout):
            self.held_while({'sections': [store.RECEIPT_KEY]}, self.owner('z'))

    def test_an_owner_writes_its_receipts_and_not_anothers(self):
        with orgtx.org_tx(self.slug, **self.owner('z')) as tx:
            tx.org.d['mail_transitions']['z']['added'] = receipt('z', 'added', 'tok')
        self.assertIn('added', self.export()['z'])
        with self.assertRaises(orgtx.UnlockedWrite):
            with orgtx.org_tx(self.slug, **self.owner('z')) as tx:
                tx.org.d['mail_transitions']['empty']['stray'] = receipt('empty', 'stray', 'x')
        self.assertNotIn('stray', self.export()['empty'])

    def export(self):
        with self.raw() as raw:
            return self.exported(raw)


if __name__ == '__main__':
    unittest.main()
