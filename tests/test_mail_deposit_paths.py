"""Every door that CREATES agent mail goes through one deposit path, and every
door that only MOVES it does not.

The failure this guards against is not dramatic: someone adds a producer, writes
`d["mail"][nid].append(...)` beside it because that is what the neighbouring
code does, and the message arrives with no receive ordinal at all. Nothing
breaks, nothing is logged, and the mailbox quietly stops being able to say what
arrived first. So the coverage here is in two layers — each producer is driven
for real and its ordinal checked, AND the module set is audited at source level
so a TENTH raw writer fails this file rather than being discovered later.

Each producer also keeps its own semantics, and those are asserted next to the
ordinal rather than assumed: a one-shot watchdog still removes itself and
tombstones itself in the same breath as its mail, an alert still refuses to
touch `fired`, the self-heal announcement still writes no archive copy, and the
restart notice still replaces an unread predecessor in place while taking a new
ordinal of its own.

Nothing here restarts a backend, starts a service or touches a provider: the
restart cases drive `restart_wake.on_backend_startup()` against a throwaway data
root with a synthetic boot record, which is the harness the existing restart
notice tests already use.
"""
from __future__ import annotations

import ast
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='mail-deposit-paths-')
_data = Path(_root.name) / 'data'; _data.mkdir()
_home = Path(_root.name) / 'home'; _home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home),
                  USERPROFILE=str(_home), ORGTREE_V2_TOKEN='operator')
for _key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_key, None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app
load_app()
from orgtree import ledger, restart_wake, store, supervisor as sup

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), store.DATA_ROOT

BACKEND = Path(import_provenance.origin_of('orgtree')).parent
SHA = '0123456789abcdef0123456789abcdef01234567'
SLUGS: list[str] = []


def tearDownModule():
    """Same minted-slug rule as test_mail_receive_order: close the pool under
    the slug `create_org` produced, then remove the root strictly.

    The swallowed `OSError` that used to live here was written off as Windows
    noise near exit. It was not: three methods hold uppercase, `create_org`
    lowercased them, and the close missed the pooled connection entirely. A
    silent except is how that stayed invisible while the module reported OK.
    """
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class Base(unittest.TestCase):
    def setUp(self):
        self.org = store.create_org(self._testMethodName.replace('_', '-')[:58])
        self.slug = self.org.d['slug']       # what was minted, not what was asked for
        SLUGS.append(self.slug)
        self.org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        store.save_org(self.org)

    def box(self, to='worker', org=None):
        return ((org or self.org).d.get('mail') or {}).get(to) or []

    def archive(self, to='worker', org=None):
        return ((org or self.org).d.get('mail_log') or {}).get(to) or []

    def assert_deposited(self, row, seq, to='worker', org=None):
        """One fresh deposit: the ordinal, its provenance, and the mailbox it
        belongs to — the three facts a later stage reads."""
        node = (org or self.org).node(to)
        self.assertEqual(row.get('recv_seq'), seq)
        self.assertEqual(row.get('seq_origin'), 'deposit')
        self.assertEqual(row.get('mailbox'), node.get('mailbox_id'))
        self.assertEqual(node.get('mail_seq'), seq)


class LedgerDoors(Base):
    def test_post_mail(self):
        self.org.post_mail(ledger.USER, 'worker', 'hello')
        self.assert_deposited(self.box()[0], 1)
        self.assertEqual(self.archive()[0]['recv_seq'], 1)

    def test_post_mail_keeps_the_user_sent_copy_of_the_same_message(self):
        self.org.post_mail(ledger.USER, 'worker', 'hello')
        sent = self.org.d.get('user_outbox') or []
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]['recv_seq'], self.box()[0]['recv_seq'])
        self.assertEqual(sent[0]['to'], 'worker')

    def restart_ev(self):
        return {'v': 1, 'variant': 'runtime.restart_notice',
                'actor': {'kind': 'system', 'id': '@system'},
                'object': {'kind': 'build', 'commit': SHA, 'short': SHA[:7],
                           'dirty': False, 'pid': 1, 'provenance': 'source'},
                'engine_authored': True,
                'started_at': '2026-09-22T00:00:00Z',
                'prev_pid': None, 'branch': None, 'version': None}

    def test_post_event(self):
        # the typed front door: it forwards to post_mail, so what is checked
        # here is that the forwarding did not lose the deposit
        self.org.post_event(ledger.SYSTEM, 'worker', self.restart_ev(),
                            kind='notice')
        self.assert_deposited(self.box()[0], 1)
        self.assertEqual(self.archive()[0]['recv_seq'], 1)

    def test_append_system_mail(self):
        returned = self.org.append_system_mail(
            'worker', self.restart_ev(), kind='notice')
        self.assert_deposited(self.box()[0], 1)
        self.assertEqual(returned['recv_seq'], 1)
        self.assertEqual(self.archive()[0]['recv_seq'], 1)

    def test_append_system_mail_returns_an_object_the_mailbox_does_not_share(self):
        # pre-existing property: the caller drives with the returned entry, and
        # mutating it must not reach into the durable box row
        returned = self.org.append_system_mail(
            'worker', self.restart_ev(), kind='notice')
        returned['body'] = 'MUTATED'
        self.assertNotEqual(self.box()[0]['body'], 'MUTATED')

    def test_post_external_mail_numbers_each_holder_mailbox_for_itself(self):
        self.org.hire(ledger.USER, None, 'haiku', 0, 'holder-two')
        self.org.post_mail(ledger.USER, 'worker', 'earlier')
        tops = self.org.post_external_mail('@org:peer', 'from outside')
        self.assertTrue(tops)
        for nid in tops:
            row = self.box(nid)[-1]
            self.assertEqual(row['seq_origin'], 'deposit')
            self.assertEqual(row['mailbox'], self.org.node(nid)['mailbox_id'])
            self.assertEqual(row['recv_seq'], self.org.node(nid)['mail_seq'])
        if 'worker' in tops:
            # a receive ordinal is the RECEIVER's fact: the mailbox that
            # already had one message numbers this one 2, whatever its
            # co-recipients numbered theirs
            self.assertEqual(self.box('worker')[-1]['recv_seq'], 2)


class WatchdogDoors(Base):
    def arm(self, once=False):
        w = self.org.watchdog_create('worker', 'dog', 'file',
                                     str(_data / 'watched.txt'), once=once)
        return str(w['id'])

    def test_watchdog_fire(self):
        wid = self.arm()
        self.org.watchdog_fire(wid, 'gist', 'the dog fired')
        self.assert_deposited(self.box()[0], 1)
        self.assertEqual(self.archive()[0]['recv_seq'], 1)

    def test_a_one_shot_fire_still_mails_AND_removes_AND_tombstones(self):
        # D-200: these are one transaction. The deposit door must not have
        # split them, so all four facts are asserted together.
        wid = self.arm(once=True)
        self.org.watchdog_fire(wid, 'gist', 'spent')
        self.assert_deposited(self.box()[0], 1)
        self.assertEqual([w for w in self.org.d.get('watchdogs') or []
                          if w['id'] == wid], [])
        self.assertEqual([t['id'] for t in self.org.d.get('watchdog_tombs') or []],
                         [wid])

    def test_watchdog_alert(self):
        wid = self.arm()
        self.org.watchdog_alert(wid, 'the subject went quiet')
        self.assert_deposited(self.box()[0], 1)
        self.assertEqual(self.archive()[0]['recv_seq'], 1)

    def test_an_alert_still_refuses_to_look_like_a_fire(self):
        wid = self.arm()
        self.org.watchdog_alert(wid, 'quiet')
        dog = next(w for w in self.org.d['watchdogs'] if w['id'] == wid)
        self.assertEqual(int(dog.get('fired') or 0), 0)
        self.assertEqual(dog['state'], 'armed')

    def test_a_fire_and_an_alert_share_one_ascending_sequence(self):
        wid = self.arm()
        self.org.watchdog_fire(wid, 'g', 'fired')
        self.org.watchdog_alert(wid, 'quiet')
        self.assertEqual([m['recv_seq'] for m in self.box()], [1, 2])


class SupervisorDoors(Base):
    def test_the_working_checkup_deposits_through_the_door(self):
        with patch.object(sup, '_working_checkup_eligible', return_value=True), \
                patch.object(sup, '_working_checkup_anchor', return_value=1.0):
            # 1.0, not 0.0: the reserve treats a falsy anchor as a legacy row
            # with no stamp and conservatively refuses rather than firing
            mid = sup._working_checkup_reserve(
                self.slug, 'worker', sup.WORKING_CHECKUP_AFTER_S + 1000.0)
        self.assertIsNotNone(mid)
        org = store.load_org(self.slug)
        row = next(m for m in self.box('worker', org) if m['id'] == mid)
        self.assert_deposited(row, 1, org=org)
        self.assertEqual(self.archive('worker', org)[-1]['id'], mid)

    def test_a_producer_that_keeps_no_archive_copy_still_gets_an_ordinal(self):
        # the self-heal invariant announcement's shape: box only, by design
        self.org.deposit_mail('worker', {
            'id': 'inv1', 'from': ledger.SYSTEM, 'kind': 'notice',
            'at': '2026-09-22T00:00:00.000Z', 'body': '(orgtree) healed'},
            archive=False)
        self.assert_deposited(self.box()[0], 1)
        self.assertEqual(self.archive(), [])


class RestartNoticeDoor(Base):
    def sweep(self, pid=1344):
        restart_wake._reset_boot_build_info_for_tests({
            'commit': SHA, 'commit_short': SHA[:7], 'branch': None,
            'dirty': False, 'backend_pid': pid, 'provenance': 'source',
            'version': None, 'started_at': '2026-09-22T00:00:00Z'})
        restart_wake._reset_startup_done_for_tests()
        restart_wake.on_backend_startup()
        return store.load_org(self.slug)

    def tearDown(self):
        restart_wake._reset_boot_build_info_for_tests()
        restart_wake._reset_startup_done_for_tests()

    def notices(self, org):
        return [m for m in self.box('worker', org) if m.get('restart_notice')]

    def test_the_passive_notice_takes_a_receive_ordinal(self):
        org = self.sweep()
        rows = self.notices(org)
        self.assertEqual(len(rows), 1)
        self.assert_deposited(rows[0], 1, org=org)

    def test_a_superseding_notice_is_a_NEW_message_with_a_NEW_ordinal(self):
        org = self.sweep(pid=1)
        first = self.notices(org)[0]
        org = self.sweep(pid=2)
        rows = self.notices(org)
        # still exactly one unread notice — the replacement behaviour
        self.assertEqual(len(rows), 1)
        self.assertNotEqual(rows[0]['id'], first['id'])
        # ...and it is a new arrival, so it is numbered as one
        self.assert_deposited(rows[0], 2, org=org)

    def test_superseding_replaces_in_place_and_disturbs_no_other_row(self):
        self.org.post_mail(ledger.USER, 'worker', 'before')
        store.save_org(self.org)
        org = self.sweep(pid=1)
        before = [(m['id'], m.get('recv_seq')) for m in self.box('worker', org)]
        org = self.sweep(pid=2)
        after = [(m['id'], m.get('recv_seq')) for m in self.box('worker', org)]
        self.assertEqual(len(after), len(before))
        # the ordinary message is untouched, id and ordinal alike
        self.assertEqual(after[0], before[0])
        # only the notice slot changed, and it changed to a new message
        self.assertNotEqual(after[1][0], before[1][0])
        self.assertGreater(after[1][1], before[1][1])

    def test_the_archive_keeps_BOTH_notices_because_both_were_received(self):
        org = self.sweep(pid=1)
        first = self.notices(org)[0]['id']
        org = self.sweep(pid=2)
        archived = [m['id'] for m in self.archive('worker', org)]
        self.assertIn(first, archived)
        self.assertEqual(len(archived), 2)

    def test_the_100_entry_archive_tail_is_still_enforced(self):
        org = store.load_org(self.slug)
        log = org.d.setdefault('mail_log', {}).setdefault('worker', [])
        log.extend({'id': f'old{i}', 'from': 'x', 'kind': 'notice',
                    'at': '2020-01-01T00:00:00.000Z', 'body': 'old'}
                   for i in range(150))
        store.save_org(org)
        org = self.sweep()
        self.assertEqual(len(self.archive('worker', org)), 100)
        self.assertTrue(self.archive('worker', org)[-1].get('restart_notice'))


class TheDoorIsTheOnlyDoor(unittest.TestCase):
    """Source-level audit. Behavioural tests prove the doors that EXIST are
    routed; this proves no tenth one was added beside them."""

    #: Every site in the backend that reaches the mailbox TABLE directly,
    #: with what each one is for. Anything not on this list is a new raw
    #: writer and must be routed through the door (or added here, with a
    #: reason, if it genuinely is not a deposit).
    KNOWN_SITES = [
        # the door, and the movement helper — the only two that may append
        ('ledger.py', 'self.d.setdefault("mail", {})).setdefault(to, [])'),
        ('ledger.py', 'self.d.setdefault("mail", {})).setdefault(to, [])'),
        # REMOVAL, not deposit: node_mail_retract drops a row by id
        ('api.py', 'org.d["mail"][nid] = kept'),
        # READ OVERLAY, not deposit: the sqlite tail replaces the in-memory
        # box wholesale so one snapshot renders the pending view
        ('api.py', 'org.d.setdefault("mail", {})[nid] = snap_box'),
        # REMOVAL, not deposit: restart reconciliation drops rows already
        # covered by a journal batch before folding that batch back
        ('supervisor.py',
         'org.d["mail"][nid] = [m for m in box if str(m.get("id")) not in in_box]'),
    ]

    def mail_table_sites(self):
        out = []
        for path in sorted(BACKEND.glob('*.py')):
            for line in path.read_text(encoding='utf-8').splitlines():
                text = line.strip()
                if '.d["mail"][' in text or '.d.setdefault("mail"' in text:
                    out.append((path.name, text))
        return out

    def test_no_site_reaches_the_mail_table_outside_the_known_set(self):
        found = sorted(self.mail_table_sites())
        self.assertEqual(
            found, sorted(self.KNOWN_SITES),
            'the mailbox table grew a direct writer. If it CREATES mail it '
            'must go through Org.deposit_mail; if it MOVES mail it must go '
            'through Org.reinsert_mail; if it is neither, add it to '
            'KNOWN_SITES with the reason.')

    def test_ledgers_two_sites_are_inside_the_door_and_the_mover(self):
        # stronger than matching the text: the two lines that reach the table
        # must be lexically INSIDE those two methods, so moving the table
        # access out into a third helper fails here too
        src = (BACKEND / 'ledger.py').read_text(encoding='utf-8')
        lines = src.splitlines()
        hits = [i for i, text in enumerate(lines, 1)
                if '.d.setdefault("mail"' in text or '.d["mail"][' in text]
        org = next(n for n in ast.walk(ast.parse(src))
                   if isinstance(n, ast.ClassDef) and n.name == 'Org')
        owners = set()
        for hit in hits:
            owner = next((f.name for f in org.body
                          if isinstance(f, ast.FunctionDef)
                          and f.lineno <= hit <= (f.end_lineno or f.lineno)),
                         None)
            owners.add(owner)
        self.assertEqual(owners, {'deposit_mail', 'reinsert_mail'})

    def test_the_door_and_the_movement_helper_are_where_they_are_claimed(self):
        tree = ast.parse((BACKEND / 'ledger.py').read_text(encoding='utf-8'))
        org = next(n for n in ast.walk(tree)
                   if isinstance(n, ast.ClassDef) and n.name == 'Org')
        methods = {n.name for n in org.body if isinstance(n, ast.FunctionDef)}
        for name in ('deposit_mail', 'reinsert_mail', 'mailbox_identity',
                     'mail_seq_state', 'mailbox_in_receive_order',
                     'migrate_mail_receive_order', '_allocate_recv_seq',
                     '_assigned_recv_max'):
            self.assertIn(name, methods)

    def test_every_creation_site_calls_the_door_and_no_movement_site_does(self):
        found = {}
        for path in sorted(BACKEND.glob('*.py')):
            src = path.read_text(encoding='utf-8')
            found[path.name] = (src.count('deposit_mail('),
                                src.count('reinsert_mail('))
        # ledger: 1 definition + 5 of its own creation doors; 1 definition of
        # the movement helper
        self.assertEqual(found['ledger.py'], (6, 1))
        # supervisor: checkup, docket reminder, invariant announcement — and
        # the one fold-back primitive `_fold_back_locked`, which MOVES and
        # therefore never deposits; restart recovery now folds through it too
        self.assertEqual(found['supervisor.py'], (3, 1))
        # restart_wake: the passive startup notice
        self.assertEqual(found['restart_wake.py'], (1, 0))
        self.assertEqual(
            sorted(n for n, c in found.items() if c != (0, 0)),
            ['ledger.py', 'restart_wake.py', 'supervisor.py'])

    def test_the_announcement_site_still_declares_that_it_keeps_no_archive(self):
        src = (BACKEND / 'supervisor.py').read_text(encoding='utf-8')
        self.assertIn('archive=False)', src)

    def test_the_restart_notice_site_still_declares_its_own_retention(self):
        src = (BACKEND / 'restart_wake.py').read_text(encoding='utf-8')
        self.assertIn('archive_keep=100', src)
        self.assertIn('supersede=supersedes', src)


if __name__ == '__main__':
    unittest.main()
