"""halt.txn joins an enclosing transaction only when it holds every named row.

PG-3d splits mail/delivering/notices into one row per owner. A caller names
such a row as (section, owner); org_tx locks it as `section\\x1fowner`, and a
lock on the whole container covers every owner row. The join check must
judge coverage by those same rules (PG-3e-A, eca3b08 and its follow-up).
"""
import os
import tempfile
import types
import unittest

_data = tempfile.TemporaryDirectory(prefix="orgtree-pg3e-halt-join-")
os.environ["ORGTREE_DATA"] = _data.name

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.backend.orgtree import halt, orgtx, store

assert str(store.DATA_ROOT).lower().startswith(_data.name.lower())
SEP = store.SPLIT_SEP


def enclosing(lock_sections=(), share_sections=(), nodes=("worker",)):
    """A stand-in for the enclosing transaction: only the lock sets matter."""
    return types.SimpleNamespace(
        slug="join-org", lock_nodes=frozenset(nodes), share_nodes=frozenset(),
        lock_sections=frozenset(lock_sections),
        share_sections=frozenset(share_sections), logs=frozenset())


class HaltJoinCoverage(unittest.TestCase):
    def join(self, tx, **rows):
        token = halt._current.set(halt._Ctx(tx))
        try:
            with halt.txn("join-org", nodes=["worker"], **rows) as got:
                return got
        finally:
            halt._current.reset(token)

    def test_owner_row_named_as_a_pair_joins_the_gate_that_locked_it(self):
        tx = enclosing(lock_sections={"mail" + SEP + "worker"},
                       share_sections={"mail"})
        self.assertIs(self.join(tx, sections=[("mail", "worker")]), tx)

    def test_a_held_container_covers_its_owner_rows(self):
        tx = enclosing(lock_sections={"mail"})
        self.assertIs(self.join(tx, sections=[("mail", "worker")]), tx)

    def test_another_owners_row_does_not_cover(self):
        tx = enclosing(lock_sections={"mail" + SEP + "other"},
                       share_sections={"mail"})
        with self.assertRaises(orgtx.OrgTxError):
            self.join(tx, sections=[("mail", "worker")])

    def test_an_unrelated_section_does_not_cover(self):
        tx = enclosing(lock_sections={"notices"})
        with self.assertRaises(orgtx.OrgTxError):
            self.join(tx, sections=[("mail", "worker")])

    def test_owner_row_lock_does_not_cover_the_whole_container(self):
        tx = enclosing(lock_sections={"mail" + SEP + "worker"},
                       share_sections={"mail"})
        with self.assertRaises(orgtx.OrgTxError):
            self.join(tx, sections=["mail"])


if __name__ == "__main__":
    unittest.main()
