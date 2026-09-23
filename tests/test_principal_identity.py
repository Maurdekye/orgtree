"""P04a-1: the seat, not the reusable name, owns per-node records (closed).

A node key is the slugified name and is REUSED once a name is freed. This
tranche makes storage ownership follow the seat on rename, gives every
legacy seat its `seat_id` at load, binds the inbox cursor and new manual
records/attempts to that seat, and REPORTS (never mutates) rows no current
seat can claim. It changes no credential, purges nothing and opens no door
(scope-p04 r2 §5). Synthetic stores and a fake runtime only; every assertion
that matters reads the document back from disk. The negative-control harness
in the author's scratch removes one guarantee at a time and shows the test
that names it fails.
"""
import copy
import itertools
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import typing
import unittest

_root = tempfile.TemporaryDirectory(prefix='principal-identity-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
import import_provenance  # noqa: F401
from orgtree import inbox, ledger, mailruntime, opreceipts, schema, store, supervisor as sup

assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()
SLUGS = []
W = 'worker'
LIVE = 'op-live'
OLD = '2000-01-01T00:00:00Z'
_SERIAL = itertools.count()
CLASSES = {'rekey', 'delete_only', 'keep', 'org'}
BY_NODE = [k for k, (c, shape, _) in ledger.NODE_KEYED_SECTIONS.items()
           if c == 'rekey' and shape == 'by_node' and k != 'nodes']


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


def unclassified(keys):
    return sorted(k for k in keys if k not in ledger.NODE_KEYED_SECTIONS)


def source_keys():
    """Top-level keys the backend reads or writes through an org document
    by literal name (`org.d["x"]`, `self.d.setdefault("x", ...)`, ...)."""
    pat = re.compile(r"""\b(?:self|org|o|morg)\.d(?:\.setdefault\(|\[|\.get\(|\.pop\()\s*['"]([a-z_][a-z0-9_]*)['"]""")
    root = Path(ledger.__file__).resolve().parent
    return {m.group(1) for f in root.glob('*.py')
            for m in pat.finditer(f.read_text(encoding='utf-8'))}


class PrincipalIdentityTests(unittest.TestCase):
    def setUp(self):
        org = store.create_org(f"pid-{self._testMethodName.replace('_', '-')[:44]}-{next(_SERIAL)}")
        self.slug = org.d['slug']
        SLUGS.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        org.hire(ledger.USER, None, 'haiku', 0, 'boss')
        store.save_org(org)
        self.n = 0

    def tearDown(self):
        for nid in (W, 'renamed'):
            sup._state.pop((self.slug, nid), None)
        opreceipts.forget_custody(store.DATA_ROOT, self.slug)
        store._POOL.close_all(self.slug)

    # ------------------------------------------------------------ fixtures
    def load(self):
        return store.load_org(self.slug)

    def canonical(self):
        return json.dumps(self.load().d, sort_keys=True, ensure_ascii=False, default=str)

    def deposit(self, count=1, to=W):
        org = self.load()
        ids = []
        for _ in range(count):
            self.n += 1
            mid = f'm{self.n:04d}'
            org.deposit_mail(to, {'id': mid, 'message_id': mid, 'operation_id': 'op-' + mid,
                                  'from': 'boss', 'kind': 'message', 'body': 'hello',
                                  'at': ledger.now()})
            ids.append(mid)
        store.save_org(org)
        return ids

    def begin(self, nid=W):
        st = sup.state(self.slug, nid)
        org = self.load()
        with sup._state_lock:
            st['lifecycle_operation_id'] = LIVE
            st['busy'] = True
            mailruntime.register(st, org, nid, attempt=LIVE, toks=[])
        return st

    def end(self, st, nid=W):
        with sup._state_lock:
            mailruntime.release(st, attempt=LIVE)
        sup._fold_back_undelivered(self.slug, nid, keep_toks=[])
        with sup._state_lock:
            st.pop('lifecycle_operation_id', None)
            st['busy'] = False

    def populate(self):
        """Every per-node record a seat can own, written by the real writers
        where they exist: mail, a keyed manual fetch (journal batch, attempt,
        receipt), its fold-back (transition receipt), a steer attempt, a turn
        error, a notice and a presented document."""
        ids = self.deposit(2)
        st = self.begin()
        with store.DOC_LOCK:
            epoch = opreceipts.custody(self.load().d, store.DATA_ROOT, self.slug)[0]
        out = sup.manual_fetch(self.slug, W, 0, ids[:1], op_key=opreceipts.mint_key(),
                               op_epoch=epoch)
        self.assertTrue(out['ok'], out)
        self.end(st)
        st = self.begin()
        out = sup.manual_fetch(self.slug, W, 0, ids[1:])   # stays journaled
        self.assertTrue(out['ok'], out)
        with sup._state_lock:
            mailruntime.release(st, attempt=LIVE)
            st['busy'] = False
        org = self.load()
        sup._steer_attempts(org, W)['d-steer'] = {'tok': 't-steer', 'at': OLD}
        org.d.setdefault('turn_error_log', {}).setdefault(W, []).append(
            {'at': OLD, 'text': 'fixture error'})
        org.d.setdefault('notices', {}).setdefault(W, []).append(
            {'at': OLD, 'text': 'fixture notice'})
        org.d.setdefault('mail_log', {}).setdefault(W, []).append(
            {'id': 'log0001', 'from': 'boss', 'body': 'archived', 'at': OLD})
        org.d.setdefault('steered_log', {}).setdefault(W, []).append({'at': OLD})
        org.d.setdefault('documents', []).append(
            {'id': 'doc-1', 'node': W, 'title': 't', 'body': 'b', 'at': OLD})
        org.d.setdefault('watchdog_tombs', []).append(
            {'id': 'dog-1', 'owner': W, 'name': 'spent', 'spent_at': OLD})
        store.save_org(org)
        org = self.load()
        for key in BY_NODE:
            self.assertIn(W, org.d.get(key) or {}, f'fixture does not exercise {key}')
        return org

    # -------------------------------------------------------------- census
    def test_census_classifies_every_section(self):
        org = self.populate()
        keys = set(typing.get_type_hints(schema.OrgDoc, include_extras=False))
        for name in ('ROWED', 'DICT_LOGS', 'KEYED_DICT_LOGS', 'LIST_LOGS', 'LAZY_SECTIONS'):
            keys |= set(getattr(store, name))
        keys |= set(dict.keys(org.d)) | set(org.d.keys())
        scanned = source_keys()
        self.assertIn('watchdog_tombs', scanned)
        keys |= scanned
        self.assertIn('steer_attempts', keys)
        self.assertEqual(unclassified(keys), [])
        for key, (cls, shape, on_delete) in ledger.NODE_KEYED_SECTIONS.items():
            self.assertIn(cls, CLASSES, key)
            self.assertIn(shape, {'by_node', 'row_field', 'none'}, key)
            self.assertEqual(cls == 'org', shape == 'none', key)
            self.assertIn(on_delete, {'purged', 'left', 'marked', 'kept'}, key)
        # the census is a real gate: an unseen section is reported
        self.assertEqual(unclassified(keys | {'new_per_node_section'}), ['new_per_node_section'])
        # delete's own behaviour matches the recorded on_delete column
        org.delete(ledger.USER, W)
        for key in BY_NODE:
            left = W in (org.d.get(key) or {})
            self.assertEqual(left, ledger.NODE_KEYED_SECTIONS[key][2] == 'left', key)

    # -------------------------------------------------------------- rename
    def test_rename_moves_every_rekey_section(self):
        org = self.populate()
        before = {k: copy.deepcopy((org.d.get(k) or {}).get(W)) for k in BY_NODE}
        seat, mailbox = org.node(W)['seat_id'], org.node(W)['mailbox_id']
        rows = len([r for r in org.d['op_receipts'] if r.get('node') == W])
        self.assertGreater(rows, 0)
        org.rename(ledger.USER, W, 'renamed')
        store.save_org(org)
        org = self.load()
        for key in BY_NODE:
            box = org.d.get(key) or {}
            self.assertNotIn(W, box, key)
            moved = box.get('renamed')
            if key == 'notices':           # rename itself notifies the renamed seat
                moved = moved[:len(before[key])]
            if key == 'mail_transitions':  # a receipt names its node: it follows
                for receipt in before[key].values():
                    receipt['node'] = 'renamed'
            self.assertEqual(json.dumps(moved, sort_keys=True, default=str),
                             json.dumps(before[key], sort_keys=True, default=str), key)
        self.assertEqual([t['owner'] for t in org.d['watchdog_tombs']], ['renamed'])
        for receipt in org.d['mail_transitions']['renamed'].values():
            self.assertEqual(receipt['node'], 'renamed')
        self.assertEqual(len([r for r in org.d['op_receipts'] if r.get('node') == 'renamed']), rows)
        self.assertEqual([d['node'] for d in org.d['documents'] if d['id'] == 'doc-1'], ['renamed'])
        self.assertEqual((org.node('renamed')['seat_id'], org.node('renamed')['mailbox_id']),
                         (seat, mailbox))
        # the settle reader still sees the moved positive receipts as this node's
        self.assertTrue(mailruntime.settled_tokens(org, 'renamed',
                                                   outcomes={'reclaimed', 'confirmed'}))
        self.assertEqual(org.orphans(), [])

    def test_rename_then_namesake_inherits_nothing(self):
        org = self.populate()
        org.rename(ledger.USER, W, 'renamed')
        store.save_org(org)
        org = self.load()
        org.hire(ledger.USER, None, 'haiku', 0, W)
        store.save_org(org)
        org = self.load()
        self.assertNotEqual(org.node(W)['seat_id'], org.node('renamed')['seat_id'])
        for key in BY_NODE:
            self.assertNotIn(W, org.d.get(key) or {}, key)
        self.assertFalse([r for r in org.d['op_receipts'] if r.get('node') == W])
        self.assertFalse([d for d in org.d.get('documents') or [] if d.get('node') == W])
        listed = inbox.build_list(org, W, {}, generation=0)
        self.assertEqual(listed['rows'], [])
        self.assertEqual(org.orphans(), [])

    LEFT = ('delivering', 'turn_error_log', 'mail_transitions', 'steer_attempts', 'manual_attempts')

    def own_rows(self, nid):
        """Rows for `nid` in every section delete leaves behind, plus a
        receipt, a document and a spent-watchdog tomb naming it."""
        org = self.load()
        org.d.setdefault('delivering', {}).setdefault(nid, []).append(
            {'tok': 't-' + nid, 'at': OLD, 'mail': [], 'via': 'turn'})
        org.d.setdefault('turn_error_log', {}).setdefault(nid, []).append({'at': OLD, 'text': nid})
        org.d.setdefault('mail_transitions', {}).setdefault(nid, {})['op-' + nid] = {
            'node': nid, 'operation': 'op-' + nid, 'outcome': 'reclaimed', 'before': {}}
        sup._steer_attempts(org, nid)['d-' + nid] = {'tok': 's-' + nid, 'at': OLD}
        org.d.setdefault('manual_attempts', {}).setdefault(nid, {})['mf-' + nid] = {
            'v': 1, 'at': OLD, 'tok': 'm-' + nid, 'delivery_id': 'mf-' + nid}
        opreceipts.append(org.d, opreceipts.row(
            op_id='r-' + nid, node=nid, generation=0, key='k-' + nid, mint_ms=0,
            tool=inbox.TOOL, args={'action': 'fetch'}, cls=opreceipts.TX,
            outcome='applied', at=OLD, result={'ok': True}))
        org.d.setdefault('documents', []).append(
            {'id': 'doc-' + nid, 'node': nid, 'title': 't', 'body': 'b', 'at': OLD})
        org.d.setdefault('watchdog_tombs', []).append(
            {'id': 'dog-' + nid, 'owner': nid, 'name': 'spent', 'spent_at': OLD})
        store.save_org(org)
        org = self.load()
        return {k: json.dumps(org.d[k][nid], sort_keys=True, default=str) for k in self.LEFT}

    def assert_quarantined(self, old_rows, cause, arriving_seat):
        org = self.load()
        index = org.d.get('orphan_keys') or {}
        qs = [q for q, rec in index.items() if rec.get('from') == W]
        self.assertEqual(len(qs), 1, index)
        q = qs[0]
        rec = index[q]
        self.assertEqual((rec['cause'], rec['arriving_seat'], rec['owner']),
                         (cause, arriving_seat, None))
        self.assertTrue(q.startswith(W + '#orphan-') and '#' not in ledger.slugify(q))
        self.assertNotIn(q, org.nodes)
        for k in self.LEFT:              # moved whole and unchanged
            self.assertEqual(json.dumps(org.d[k][q], sort_keys=True, default=str), old_rows[k], k)
        for key, field in (('op_receipts', 'node'), ('documents', 'node'), ('watchdog_tombs', 'owner')):
            moved = [r for r in org.d[key] if r.get('orphaned_from') == W]
            self.assertTrue(moved and all(r[field] == q for r in moved), key)
        rid = next(r for r in org.d['op_receipts'] if r.get('orphaned_from') == W)
        self.assertEqual(rid['fp_node'], W)
        reported = {f['section'] for f in org.orphans() if f['key'] == q}
        self.assertTrue(set(self.LEFT) <= reported, reported)
        # nothing of the old seat is readable as the new one's
        self.assertFalse([r for r in org.d['op_receipts'] if r.get('node') == W
                          and r.get('key') == 'k-' + W])
        self.assertIsNone(inbox.gone_state(org, W, 'mf-' + W)['content_state'] == 'confirmed' or None)
        return q

    def test_rename_onto_freed_name_quarantines_leftovers(self):
        # reviewer r5: both seats hold rows; the deleted seat's survive, set aside
        mine = self.own_rows(W)
        org = self.load()
        org.hire(ledger.USER, None, 'haiku', 0, 'other')
        store.save_org(org)
        theirs = self.own_rows('other')
        org = self.load()
        seat = org.node('other')['seat_id']
        org.delete(ledger.USER, W)
        store.save_org(org)
        org = self.load()
        out = org.rename(ledger.USER, 'other', W)
        store.save_org(org)
        q = self.assert_quarantined(mine, 'rename_onto_freed_key', seat)
        self.assertEqual(out['quarantined'], [q])
        org = self.load()
        for k in self.LEFT:              # the renamed seat's own rows, intact
            self.assertEqual(json.dumps(org.d[k][W], sort_keys=True, default=str),
                             theirs[k].replace('"node": "other"', '"node": "' + W + '"')
                             if k == 'mail_transitions' else theirs[k], k)
        # idempotent: a reload and another save set nothing else aside
        before = self.canonical()
        store.save_org(self.load())
        self.assertEqual(self.canonical(), before)
        self.assertEqual(len(self.load().d['orphan_keys']), 1)

    def test_rename_with_no_rows_inherits_nothing(self):
        mine = self.own_rows(W)
        org = self.load()
        org.hire(ledger.USER, None, 'haiku', 0, 'blank')
        store.save_org(org)
        org = self.load()
        seat = org.node('blank')['seat_id']
        org.delete(ledger.USER, W)
        org.rename(ledger.USER, 'blank', W)
        store.save_org(org)
        self.assert_quarantined(mine, 'rename_onto_freed_key', seat)
        org = self.load()
        for k in self.LEFT:
            self.assertNotIn(W, org.d.get(k) or {}, k)
        self.assertEqual(org.orphans(), [f for f in org.orphans() if '#orphan-' in str(f['key'])])

    def test_hire_onto_freed_name_quarantines_leftovers(self):
        mine = self.own_rows(W)
        org = self.load()
        org.delete(ledger.USER, W)
        org.d.setdefault('turn_error_log', {})[W + '@0'] = [{'at': OLD, 'text': 'lineage'}]
        store.save_org(org)
        org = self.load()
        org.hire(ledger.USER, None, 'haiku', 0, W)
        store.save_org(org)
        org = self.load()
        self.assert_quarantined(mine, 'hire_onto_freed_key', org.node(W)['seat_id'])
        lineage = [q for q, rec in org.d['orphan_keys'].items() if rec['from'] == W + '@0']
        self.assertEqual(len(lineage), 1)
        for k in self.LEFT:
            self.assertNotIn(W, org.d.get(k) or {}, k)
        self.assertNotIn(W + '@0', org.d['turn_error_log'])

    def test_refused_rename_sets_nothing_aside(self):
        self.own_rows(W)
        org = self.load()
        org.hire(ledger.USER, None, 'haiku', 0, 'other')
        org.delete(ledger.USER, W)
        org.node('other')['halt'] = {'phase': 'halting'}
        store.save_org(org)
        before = self.canonical()
        org = self.load()
        with self.assertRaises(ledger.LedgerError):
            # onto the freed name, but refused (halt settling): nothing moves
            org.rename(ledger.USER, 'other', W)
        self.assertNotIn('orphan_keys', org.d)
        self.assertEqual(self.canonical(), before)

    # ------------------------------------------------------------ backfill
    def legacy_org(self):
        org = self.load()
        org.hire(ledger.USER, None, 'haiku', 0, 'kept')
        org._archive_session_in_place(W)          # W@0: a lineage predecessor
        org._archive_session_in_place('boss')     # boss@0
        store.save_org(org)
        org = self.load()
        self.assertEqual(org.node(W + '@0')['seat_id'], org.node(W)['seat_id'])
        kept = org.node('kept')['seat_id']
        for nid in (W, W + '@0', 'boss'):          # boss@0 keeps its copy
            org.node(nid).pop('seat_id')
        org.d['_migrations'].pop(org.SEAT_ID_MIGRATION, None)
        store.save_org(org)
        return kept

    def test_backfill_seat_ids_durable_idempotent(self):
        kept = self.legacy_org()
        first = self.load()
        seats = {k: first.node(k).get('seat_id') for k in (W, W + '@0', 'boss', 'boss@0', 'kept')}
        self.assertTrue(all(seats.values()))
        self.assertEqual(seats[W], seats[W + '@0'])                 # one principal per lineage
        self.assertEqual(seats[W], ledger.Org.legacy_seat_id(W, first.node(W)))
        self.assertEqual(seats['boss'], seats['boss@0'])            # head adopts its stack's seat
        self.assertEqual(seats['kept'], kept)                       # present ids never change
        self.assertEqual(len({seats[W], seats['boss'], seats['kept']}), 3)
        marker = first.d['_migrations'].get(ledger.Org.SEAT_ID_MIGRATION) or {}
        self.assertEqual((marker.get('minted'), marker.get('shared')), (1, 2))
        # deterministic before any save: every construction agrees
        second = self.load()
        self.assertEqual({k: second.node(k)['seat_id'] for k in seats}, seats)
        store.save_org(second)
        third = self.load()
        self.assertEqual({k: third.node(k)['seat_id'] for k in seats}, seats)
        saved = third.d['_migrations'][ledger.Org.SEAT_ID_MIGRATION]
        self.assertEqual((saved['minted'], saved['shared']), (1, 2))
        self.assertEqual(self.load().d['_migrations'][ledger.Org.SEAT_ID_MIGRATION], saved)
        before = self.canonical()
        store.save_org(self.load())
        self.assertEqual(self.canonical(), before)

    def test_backfill_persists_on_next_save(self):
        self.legacy_org()
        org = self.load()
        seat = org.node(W).get('seat_id')
        self.assertTrue(seat)
        store.save_org(org)
        with store.DOC_LOCK:
            raw = store._load_sqlite_org(self.slug) if store.STORE_BACKEND == 'sqlite' else None
        if raw is not None:
            self.assertEqual(raw.node(W)['seat_id'], seat)
        self.assertEqual(self.load().node(W)['seat_id'], seat)

    # -------------------------------------------------------------- cursor
    def two_page_cursor(self, nid=W):
        org = self.load()
        first = inbox.build_list(org, nid, {}, generation=org.node(nid)['generation'], limit=1)
        self.assertTrue(first['ok'] and first['next_cursor'], first)
        return first['next_cursor']

    def test_cursor_bound_to_seat_with_absent_mailboxes(self):
        org = self.load()
        seat = org.node(W)['seat_id']
        self.assertNotIn('mailbox_id', org.node(W))
        cursor = inbox.encode_cursor(None, 0, [0, 0, '', 0], seat)
        self.assertTrue(inbox.build_list(org, W, {}, generation=0, cursor=cursor)['ok'])
        org.delete(ledger.USER, W)
        org.hire(ledger.USER, None, 'haiku', 0, W)
        store.save_org(org)
        org = self.load()
        self.assertNotEqual(org.node(W)['seat_id'], seat)
        self.assertNotIn('mailbox_id', org.node(W))
        out = inbox.build_list(org, W, {}, generation=0, cursor=cursor)
        self.assertEqual(out.get('error'), 'cursor_stale', out)
        legacy = inbox.encode_cursor(None, 0, [0, 0, '', 0])      # issued before the seat
        self.assertEqual(inbox.build_list(org, W, {}, generation=0, cursor=legacy).get('error'),
                         'cursor_stale')

    def test_same_seat_cursor_survives_rename_and_rehire(self):
        self.deposit(3)
        cursor = self.two_page_cursor()
        org = self.load()
        org.rename(ledger.USER, W, 'renamed')
        store.save_org(org)
        org = self.load()
        self.assertTrue(inbox.build_list(org, 'renamed', {}, generation=0, cursor=cursor)['ok'])
        org.retire(ledger.USER, 'renamed')
        store.save_org(org)
        org = self.load()
        org.rehire(ledger.USER, 'renamed')
        store.save_org(org)
        org = self.load()
        gen = org.node('renamed')['generation']
        out = inbox.build_list(org, 'renamed', {}, generation=gen, cursor=cursor)
        self.assertTrue(out['ok'] if gen == 0 else out.get('error') == 'cursor_stale', out)

    def test_compaction_keeps_seat_and_issues_fresh_cursors(self):
        self.deposit(3)
        org = self.load()
        seat, mailbox = org.node(W)['seat_id'], org.node(W)['mailbox_id']
        old = self.two_page_cursor()
        org.cheap_compact(ledger.USER, W)
        store.save_org(org)
        org = self.load()
        gen = org.node(W)['generation']
        self.assertEqual((org.node(W)['seat_id'], org.node(W)['mailbox_id']), (seat, mailbox))
        self.assertGreater(gen, 0)
        # the generation binding predates P04a-1 and still applies
        self.assertEqual(inbox.build_list(org, W, {}, generation=gen, cursor=old).get('error'),
                         'cursor_stale')
        fresh = self.two_page_cursor()
        self.assertTrue(inbox.build_list(self.load(), W, {}, generation=gen, cursor=fresh)['ok'])

    # ------------------------------------------------ manual record / attempt
    def journaled_manual_row(self, seat_field):
        """One manual journal batch for W stamped (or not) with `seat_field`."""
        self.deposit(1)
        org = self.load()
        box = org.d['mail'][W]
        mail, org.d['mail'][W] = box[:1], box[1:]
        tok = sup._journal_drain(org, W, mail, None, via='turn',
                                 mode=mailruntime.CUSTODY_MANUAL_FETCH)
        row = next(b for b in org.d['delivering'][W] if b.get('tok') == tok)
        ident = {'mailbox': org.node(W)['mailbox_id'], 'generation': 0,
                 'session': 'sess', 'attempt': LIVE}
        record = inbox.manual_record(ident, engine=mailruntime.ENGINE_INSTANCE,
                                     delivery_id='mf-fixture', mail=mail, seat='x')
        if seat_field is None:
            record.pop('seat')
        else:
            record['seat'] = seat_field
        row['manual'] = record
        store.save_org(org)
        return mail[0]['id']

    def test_real_fetch_stamps_seat_on_record_and_attempt(self):
        org = self.populate()
        seat = org.node(W)['seat_id']
        rows = [b for b in org.d['delivering'][W] if isinstance(b.get('manual'), dict)]
        self.assertTrue(rows)
        self.assertTrue(all(b['manual'].get('seat') == seat for b in rows))
        self.assertTrue(all(a.get('seat') == seat for a in org.d['manual_attempts'][W].values()))

    def test_chunk_refuses_other_seat_and_keeps_legacy_rows(self):
        mid = self.journaled_manual_row(seat_field='another-seat')
        out = sup._chunk_answer(self.load(), W, 0, 'mf-fixture', mid, 0)
        self.assertEqual((out.get('content'), out.get('content_state')), (None, 'unavailable'))

    def test_chunk_serves_same_seat_and_unstamped_legacy_row(self):
        mid = self.journaled_manual_row(seat_field=self.load().node(W)['seat_id'])
        self.assertEqual(sup._chunk_answer(self.load(), W, 0, 'mf-fixture', mid, 0)['content'],
                         'hello')
        org = self.load()
        for b in org.d['delivering'][W]:
            b['manual'].pop('seat', None)
        store.save_org(org)
        self.assertEqual(sup._chunk_answer(self.load(), W, 0, 'mf-fixture', mid, 0)['content'],
                         'hello')

    def test_gone_state_refuses_other_seat_attempt(self):
        org = self.load()
        att = inbox.attempt_record({'mailbox': 'mb', 'generation': 0, 'seat': 'another-seat',
                                    'plan': {}}, tok='t', at=OLD, op_key=None, op_id=None)
        att['resolved'] = 'confirmed'
        self.assertEqual(att.get('seat'), 'another-seat')
        org.d.setdefault('manual_attempts', {})[W] = {'mf-old': att}
        store.save_org(org)
        self.assertEqual(inbox.gone_state(self.load(), W, 'mf-old'),
                         {'content_state': 'unavailable', 'attempt_recorded': False})
        org = self.load()
        org.d['manual_attempts'][W]['mf-old']['seat'] = org.node(W)['seat_id']
        store.save_org(org)
        self.assertEqual(inbox.gone_state(self.load(), W, 'mf-old')['content_state'], 'confirmed')
        org = self.load()
        org.d['manual_attempts'][W]['mf-old'].pop('seat')          # legacy: unstamped
        store.save_org(org)
        self.assertEqual(inbox.gone_state(self.load(), W, 'mf-old')['content_state'], 'confirmed')

    # ------------------------------------------------------------- orphans
    def test_orphan_detector_reports_without_mutation(self):
        org = self.populate()
        org.delete(ledger.USER, W)
        store.save_org(org)
        before = self.canonical()
        org = self.load()
        found = org.orphans()
        missing = {f['section'] for f in found if f['reason'] == 'missing_node'}
        self.assertEqual(missing, {k for k in BY_NODE if ledger.NODE_KEYED_SECTIONS[k][2] == 'left'}
                         | {'op_receipts', 'documents'})
        self.assertEqual(org.orphans(), found)
        store.save_org(org)
        self.assertEqual(self.canonical(), before)
        # a same-name successor: its hire sets the old rows aside (F1), and a
        # foreign stamp that is already under a live key (written before
        # P04a-1) is reported as a stamp mismatch
        org = self.load()
        org.hire(ledger.USER, None, 'haiku', 0, W)
        org.d.setdefault('manual_attempts', {}).setdefault(W, {})['mf-legacy'] = {
            'mailbox': 'feedfacecafe', 'seat': 'another-seat', 'generation': 0}
        store.save_org(org)
        before = self.canonical()
        org = self.load()
        found = org.orphans()
        mismatched = {(f['section'], tuple(f['fields'])) for f in found
                      if f['reason'] == 'stamp_mismatch'}
        self.assertEqual(mismatched, {('manual_attempts', ('mailbox', 'seat'))})
        self.assertTrue({f['section'] for f in found if '#orphan-' in str(f['key'])}
                        >= {'delivering', 'manual_attempts'})
        store.save_org(org)
        self.assertEqual(self.canonical(), before)
        # and the successor's own list does not show the old seat's batch
        self.assertEqual(inbox.build_list(self.load(), W, {}, generation=0)['rows'], [])


if __name__ == '__main__':
    unittest.main()
