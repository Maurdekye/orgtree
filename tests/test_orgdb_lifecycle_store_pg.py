"""The store's org lifecycle entry points with the storage switch on (piece A7b, umbrella
decision 27): restoring a trashed org, a writer queued behind a delete, and racing creates.

Needs a DISPOSABLE PostgreSQL (never a live one), as tests/test_orgdb_compat_pg.py, whose
fixture this module uses (its legacy database, prefix, data root and lifecycle):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every test SKIPS: a skip is not a pass.

What it proves:
  * store.restore_trashed_org brings a deleted org back active under its own name and id,
    with its document and its folders; tools/restore-org.py does the same from the command
    line (a child process), lists the trash, and refuses what it cannot do with exit 1;
  * a restore is refused while another org has the name, and needs an id when several
    trashed orgs had it;
  * A1: a writer queued on the org lock while a delete trashes the org is told the org is
    gone (LedgerError), not a raw connection error;
  * A2: a create that loses a race for its name (to a create already made, one being made, or
    one inserting at the same moment) is told the name exists, and never writes into the other
    org.
The restore of an org 3.1.0 trashed (converted as trashed) is in tests/test_orgdb_convert_pg.py.

Run:  python tools/run-python-verification.py tests/test_orgdb_lifecycle_store_pg.py
"""

import json
import os
from pathlib import Path
import subprocess
import threading
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import child_python
import test_orgdb_compat_pg as fx
from orgtree import orgtx, store
from orgtree.ledger import LedgerError
from orgtree.orgdb import lifecycle, names, registry

setUpModule = fx.setUpModule
tearDownModule = fx.tearDownModule
TOOL = Path(__file__).resolve().parent.parent / 'tools' / 'restore-org.py'


def tool(*args: str) -> subprocess.CompletedProcess:
    """tools/restore-org.py as a person runs it, on this module's data root and cluster."""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('PYTHON', 'ORGTREE_'))}
    env.update(ORGTREE_PG_ADMIN_CONNINFO=fx.ADMIN,
               ORGTREE_PG_CONNINFO=fx._with_db(fx.RUNTIME, fx.LEGACY),
               ORGTREE_ORGDB_PREFIX=fx.PREFIX, HOME=str(fx.HOME), USERPROFILE=str(fx.HOME),
               PYTHONIOENCODING='utf-8')
    return subprocess.run(child_python.argv(str(TOOL), '--root', str(fx.DATA), *args), env=env,
                          capture_output=True, text=True, encoding='utf-8', timeout=300)


def make(name: str, note: str) -> str:
    """A new org with a lead node and a file in its workspace."""
    org = store.create_org(name)
    slug = org.d['slug']
    org.d['nodes']['lead'] = {'id': 'lead', 'name': 'lead', 'parent': None, 'children': [],
                              'state': 'live', 'seat_id': f'seat-{slug}'}
    store.save_org(org)
    (Path(store.workspace_dir(slug)) / 'note.txt').write_text(note, encoding='utf-8')
    return slug


@fx.needs_pg
class Restore(unittest.TestCase):
    def test_a_deleted_org_comes_back_with_its_document_and_folders(self) -> None:
        with fx.storage(True):
            slug = make('Come Back', 'mine')
            want = fx.document(slug)
            org_id = registry.lookup(slug)[0]
            store.delete_org(slug)
            self.assertEqual([t['org_id'] for t in store.trashed_orgs(slug)], [org_id])
            out = store.restore_trashed_org(slug)
            self.assertEqual((out['org_id'], out['state'], out['reason']), (org_id, 'active', None))
            self.assertEqual(registry.lookup(slug)[:3],
                             (org_id, names.org(org_id, fx.PREFIX), 'active'))
            self.assertEqual(fx.same_but_slug(want, fx.document(slug)), [])
            ws = Path(store.workspace_dir(slug))
            self.assertEqual((ws / 'note.txt').read_text(encoding='utf-8'), 'mine')
            self.assertEqual(store.trashed_orgs(slug), [])
            self.assertEqual([p.name for p in (fx.DATA / 'deleted').iterdir()
                              if p.name.startswith(f'{slug}-')], [])   # the trash folder is gone
            store.save_org(store.load_org(slug))                        # and it is writable

    def test_the_tool_lists_the_trash_and_restores_from_the_command_line(self) -> None:
        with fx.storage(True):
            slug = make('By Hand', 'kept')
            want = fx.document(slug)
            org_id = registry.lookup(slug)[0]
            store.delete_org(slug)
        r = tool('--list')
        self.assertEqual(r.returncode, 0, r.stderr[-3000:])
        self.assertIn(org_id, [t['org_id'] for t in json.loads(r.stdout)['trashed']])
        r = tool(slug)
        self.assertEqual(r.returncode, 0, r.stderr[-3000:])
        out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual((out['org_id'], out['state']), (org_id, 'active'))
        with fx.storage(True):
            self.assertEqual(fx.same_but_slug(want, fx.document(slug)), [])
            self.assertEqual((Path(store.workspace_dir(slug)) / 'note.txt').read_text(encoding='utf-8'),
                             'kept')
        r = tool(slug)                                       # nothing of that name is trashed now
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('REFUSED: no trashed org is named', r.stderr)
        r = tool()
        self.assertEqual(r.returncode, 2, r.stderr)

    def test_a_restore_is_refused_while_another_org_has_the_name(self) -> None:
        with fx.storage(True):
            slug = make('Taken Again', 'old')
            old = registry.lookup(slug)[0]
            store.delete_org(slug)
            again = make('Taken Again', 'new')
            self.assertEqual(again, slug)
            new = registry.lookup(slug)[0]
            with self.assertRaisesRegex(LedgerError, 'another org is named'):
                store.restore_trashed_org(slug)
            self.assertEqual([t['org_id'] for t in store.trashed_orgs(slug)], [old])
            self.assertEqual(registry.lookup(slug)[0], new)
            self.assertEqual((Path(store.workspace_dir(slug)) / 'note.txt').read_text(encoding='utf-8'),
                             'new')
            store.delete_org(slug)                       # the name is free again: the old one
            # two trashed orgs of one name now: an id picks one
            with self.assertRaisesRegex(LedgerError, '2 trashed orgs are named'):
                store.restore_trashed_org(slug)
            with self.assertRaisesRegex(LedgerError, 'is not a trashed org named'):
                store.restore_trashed_org(slug, org_id=999999)
            out = store.restore_trashed_org(slug, org_id=old)
            self.assertEqual((out['org_id'], out['state']), (old, 'active'))
            self.assertEqual((Path(store.workspace_dir(slug)) / 'note.txt').read_text(encoding='utf-8'),
                             'old')
            self.assertEqual([t['org_id'] for t in store.trashed_orgs(slug)], [new])


@fx.needs_pg
class DeleteRace(unittest.TestCase):
    def test_a_writer_queued_behind_a_delete_finds_the_org_gone(self) -> None:
        # A1: the delete holds org_exclusive and is paused before its trash begins; a writer
        # passes the registry check and queues on the org lock; the trash then fences the
        # runtime off, which ends the writer's connection. The writer is told the org is gone
        original = lifecycle.Lifecycle._resume_trash
        paused, release = threading.Event(), threading.Event()
        out: dict = {}

        def slow(self_, claim, **kw):
            if threading.current_thread().name == 'deleter':
                paused.set()
                release.wait(30)
            return original(self_, claim, **kw)
        with fx.storage(True), patch.object(lifecycle.Lifecycle, '_resume_trash', slow):
            slug = make('Gone Under A Writer', 'x')
            db = registry.lookup(slug)[1]

            def deleter() -> None:
                try:
                    store.delete_org(slug)
                    out['delete'] = 'done'
                except BaseException as e:       # noqa: BLE001  the outcome under test
                    out['delete'] = e

            def writer() -> None:
                try:
                    with orgtx.org_tx(slug, sections=['asks']):
                        pass
                    out['writer'] = 'committed'
                except BaseException as e:       # noqa: BLE001  the outcome under test
                    out['writer'] = e
            d = threading.Thread(target=deleter, name='deleter')
            d.start()
            try:
                self.assertTrue(paused.wait(30), 'the delete never reached its trash')
                w = threading.Thread(target=writer)
                w.start()
                self.assertTrue(fx.wait_for(lambda: fx.lock_waiters(db) > 0),
                                'the writer never queued on the org lock')
            finally:
                release.set()
                d.join(60)
            w.join(60)
        self.assertEqual(out['delete'], 'done')
        self.assertIsInstance(out['writer'], LedgerError, repr(out['writer']))
        self.assertIn('no such org', str(out['writer']))


@fx.needs_pg
class CreateRace(unittest.TestCase):
    def run_create(self, out: dict, key: str, name: str, prepare=None) -> threading.Thread:
        def go() -> None:
            try:
                out[key] = store.create_org(name, prepare=prepare).d['slug']
            except BaseException as e:           # noqa: BLE001  the outcome under test
                out[key] = e
        th = threading.Thread(target=go, name=key)
        th.start()
        return th

    def assert_already_exists(self, e: object) -> None:
        self.assertIsInstance(e, LedgerError, repr(e))
        self.assertIn('already exists', str(e))

    def test_a_create_that_loses_to_a_create_already_made_is_refused_and_writes_nothing(self) -> None:
        # the loser passed its name check, then the winner made the org: the loser's creating
        # save must not write its new document into the winner's org
        entered, release = threading.Event(), threading.Event()
        out: dict = {}

        def wait(org) -> None:
            entered.set()
            release.wait(30)
        with fx.storage(True):
            loser = self.run_create(out, 'loser', 'Made First', wait)
            try:
                self.assertTrue(entered.wait(30))
                slug = make('Made First', 'winner')
                want = fx.document(slug)
            finally:
                release.set()
                loser.join(60)
            self.assert_already_exists(out['loser'])
            self.assertEqual(fx.same_but_slug(want, fx.document(slug)), [])

    def test_a_create_that_finds_its_name_being_made_is_refused(self) -> None:
        # the winner's registry row is 'provisioning' when the loser's creating save opens
        original = lifecycle.Lifecycle.begin_create
        made, finish = threading.Event(), threading.Event()
        entered, release = threading.Event(), threading.Event()
        out: dict = {}

        def slow_begin(self_, slug, **kw):
            build = original(self_, slug, **kw)
            if threading.current_thread().name == 'winner':
                made.set()
                finish.wait(30)
            return build

        def wait(org) -> None:
            entered.set()
            release.wait(30)
        with fx.storage(True), patch.object(lifecycle.Lifecycle, 'begin_create', slow_begin):
            loser = self.run_create(out, 'loser', 'Being Made', wait)
            winner = None
            try:
                self.assertTrue(entered.wait(30))
                winner = self.run_create(out, 'winner', 'Being Made')
                self.assertTrue(made.wait(30))
                release.set()
                loser.join(60)
            finally:
                release.set()
                finish.set()
                loser.join(60)
                if winner is not None:
                    winner.join(60)
        self.assert_already_exists(out['loser'])
        self.assertEqual(out['winner'], 'being-made')

    def test_two_creates_that_both_find_the_name_free_leave_one_org(self) -> None:
        # both pass every check; the registry's unique name refuses the second insert
        original = lifecycle.Lifecycle.begin_create
        meet = threading.Barrier(2, timeout=30)
        out: dict = {}

        def both(self_, slug, **kw):
            meet.wait()
            return original(self_, slug, **kw)
        with fx.storage(True), patch.object(lifecycle.Lifecycle, 'begin_create', both):
            a = self.run_create(out, 'a', 'Both Free')
            b = self.run_create(out, 'b', 'Both Free')
            a.join(60)
            b.join(60)
        made = [k for k in ('a', 'b') if out[k] == 'both-free']
        self.assertEqual(len(made), 1, out)
        self.assert_already_exists(out['b' if made == ['a'] else 'a'])
        with fx.storage(True):
            self.assertEqual(registry.lookup('both-free')[2], 'active')


@fx.needs_pg
class RenameWithMailbox(unittest.TestCase):
    """A7b batch 2 (G2-A3): renaming an agent that has a mailbox identity, as nearly every live
    agent has (its first deposit mints one; every engine start deposits a restart notice). The
    rename's save writes the new name's agent row, which carries the same mailbox id, and the
    org database keeps one mailbox per agent (unique index agents_mailbox)."""

    def test_an_agent_with_mail_is_renamed_with_its_mailbox_and_its_inbox(self) -> None:
        from orgtree import ledger, supervisor, warmpool
        with fx.storage(True):
            org = store.create_org('Rename Mail')
            slug = org.d['slug']
            org.hire(ledger.USER, None, 'luna', 0, 'boss')
            org.hire(ledger.USER, 'boss', 'luna', 0, 'alpha')
            org.hire(ledger.USER, 'alpha', 'luna', 0, 'kid')
            store.save_org(org)
            org = store.load_org(slug)
            org.post_mail('boss', 'alpha', 'hello')
            store.save_org(org)
            mailbox = store.load_org(slug).node('alpha').get('mailbox_id')
            self.assertTrue(mailbox)
            with patch.object(warmpool, 'kill_node'), patch.object(supervisor, 'notify'):
                out = supervisor.rename_node(slug, 'alpha', 'beta', actor=ledger.USER)
            self.assertEqual(out['node'], 'beta')
            o = store.load_org(slug)
            self.assertNotIn('alpha', o.nodes)
            self.assertEqual(o.node('beta').get('mailbox_id'), mailbox)
            self.assertEqual(o.node('kid')['parent'], 'beta')
            self.assertEqual([m.get('body') for m in o.d['mail'].get('beta', [])], ['hello'])
            self.assertNotIn('alpha', o.d['mail'])


if __name__ == '__main__':
    unittest.main()
