"""Engine startup does not decode the retired history (engine-startup-cost-
must-not-grow-with-retired-h), on real PostgreSQL with ORGTREE_LAZY_ROWS.

At N1000 with 10x retired history the engine never became ready: the startup
passes walked every node row (reconcile, the stamp-wakes save hook, mail
drain discovery, the restart-wake pass, halt recovery) and `list_orgs()`
decoded every node and owner row of every org to count them. The passes now
name their rows with one server-side query and decode only those. What these
prove, each against the answer the whole walk gives:
  * `live_node_ids` / `node_ids_with` / `node_field_values` /
    `section_owners` answer as the walk does, decode only the rows they
    name, and see this transaction's own edits, additions and deletions;
  * `list_orgs()` decodes no node row even for a stale heal epoch, and still
    skips an org that refuses to load;
  * reconcile decodes the live rows only and still acts on retired rows that
    carry what it acts on (the remote-control flag, a spent pardon), and the
    transcript roots still include a retired node's account;
  * a whole-org save stamps a frozen row nobody decoded, without a walk;
  * mail-drain discovery tracks live seats with a demand, not retired ones;
  * the API-key cutover still cleans an org holding its fields, and loads no
    node row for one that holds none.

Run:  python tools/run-python-verification.py tests/test_startup_retired_history_pg.py
"""
import contextlib
import json
import unittest
import uuid
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import (ledger, maildrain, orgtx, pgstore, registry, registry_migration,
                     store, supervisor)

TOOLS = {'bash': False, 'edit': False, 'web': False, 'subagents': False, 'mcp': []}
LIVE = ['coord', 'w0', 'w1', 'w2']
RETIRED = [f'r{i}' for i in range(20)]


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class StartupReadsLiveRows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        flags = patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True)
        flags.start()
        self.addCleanup(flags.stop)
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        org = store.create_org('boot-' + uuid.uuid4().hex[:10])
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'haiku', 0, 'coord', add_dirs=[], tools=TOOLS,
                 org_visibility='self', charter='c')
        for w in LIVE[1:] + RETIRED:
            org.hire(ledger.USER, 'coord', 'haiku', 0, w, add_dirs=[], tools=TOOLS,
                     org_visibility='self', charter='c')
        for r in RETIRED:
            org.retire(ledger.USER, r)
        store.save_org(org)
        with pgstore.connect() as raw:
            self.oid = raw.execute('SELECT org_id FROM public.orgs WHERE slug=%s',
                                   (self.slug,)).fetchone()[0]
        self.stamp()

    # -- helpers ----------------------------------------------------------
    @contextlib.contextmanager
    def raw(self):
        with pgstore.connect() as raw:
            raw.execute('BEGIN')
            raw.execute(f'SET LOCAL search_path TO org_{self.oid},public')
            try:
                yield raw
            except BaseException:
                raw.execute('ROLLBACK')
                raise
            else:
                raw.execute('COMMIT')

    def stamp(self):
        with orgtx.org_tx(self.slug, nodes=['coord']):
            pass
        with self.raw() as raw:
            row = raw.execute("SELECT val FROM meta WHERE key='heal_epoch'").fetchone()
        self.assertEqual(row[0] if row else None, store.heal_epoch())

    def edit(self, fn):
        """Change stored rows through a whole save (then re-stamp)."""
        org = store.load_org(self.slug)
        fn(org)
        store.save_org(org)
        self.stamp()

    def whole(self):
        return store.load_org(self.slug)

    def stats(self):
        return dict(store.LAZY_ROWS_STATS)

    def delta(self, before):
        return {k: store.LAZY_ROWS_STATS.get(k, 0) - before.get(k, 0)
                for k in store.LAZY_ROWS_STATS}

    def decoded(self, org):
        return set(dict.keys(dict.get(org.d, 'nodes')))

    # -- the helpers answer as the walk does, decoding only what they name --
    def test_live_node_ids_equal_the_walk_and_decode_only_live_rows(self):
        want = [k for k, n in self.whole().nodes.items() if n.get('state') == 'live']
        self.assertEqual(sorted(want), sorted(LIVE))
        view = store.load_runtime_org(self.slug)
        self.assertIsInstance(dict.get(view.d, 'nodes'), store.LazyNodesMap)
        before = self.stats()
        self.assertEqual(store.live_node_ids(view), want)
        self.assertEqual(self.decoded(view), set(LIVE))
        self.assertEqual(self.delta(before)['fallbacks'], 0)

    def test_node_ids_with_names_retired_rows_carrying_the_field_only(self):
        def mark(org):
            org.nodes['r3']['remote_controlled'] = {'pid': 4242}
            org.nodes['w1']['remote_controlled'] = {'pid': 1}
            org.nodes['r5']['remote_controlled'] = None       # null: not carried
        self.edit(mark)
        view = store.load_runtime_org(self.slug)
        got = store.node_ids_with(view, 'remote_controlled')
        want = [k for k, n in self.whole().nodes.items()
                if n.get('remote_controlled') is not None]
        self.assertEqual(got, want)
        self.assertEqual(sorted(got), ['r3', 'w1'])
        self.assertEqual(self.decoded(view), {'r3', 'w1'})

    def test_the_transaction_sees_its_own_edits_additions_and_deletions(self):
        class Abort(Exception):
            pass
        with self.assertRaises(Abort):
            with orgtx.org_tx(self.slug, whole=True) as tx:
                nodes = tx.org.nodes
                nodes['r7']['state'] = 'live'           # decoded and changed here
                del nodes['w2']                          # deleted here
                nodes['fresh'] = {**nodes['w0'], 'id': 'fresh', 'name': 'fresh'}  # added
                ids = store.live_node_ids(tx.org)
                self.assertIn('r7', ids)
                self.assertIn('fresh', ids)
                self.assertNotIn('w2', ids)
                nodes['w0']['halt'] = {'phase': 'halting'}
                self.assertIn('w0', store.node_ids_with(tx.org, 'halt'))
                raise Abort()                            # nothing is committed

    def test_node_field_values_reads_retired_bindings_without_decoding(self):
        def bind(org):
            org.nodes['r9']['account'] = 'acct-retired'
            org.nodes['w0']['account'] = 'acct-live'
        self.edit(bind)
        view = store.load_runtime_org(self.slug)
        got = store.node_field_values(view, 'account')
        want = {n['account'] for n in self.whole().nodes.values()
                if isinstance(n.get('account'), str)}
        self.assertEqual(got, want)
        self.assertTrue({'acct-retired', 'acct-live'} <= got)
        self.assertEqual(self.decoded(view), set())

    def test_section_owners_lists_owners_without_reading_their_rows(self):
        def attempts(org):
            org.d.setdefault('steer_attempts', {})['r2'] = {'d1': {'state': 'x'}}
            org.d['steer_attempts']['w0'] = {'d2': {'state': 'y'}}
        self.edit(attempts)
        with orgtx.org_tx(self.slug, logs=['steer_attempts']) as tx:
            sec = tx.org.d.get('steer_attempts')
            self.assertEqual(sorted(store.section_owners(sec)), ['r2', 'w0'])
            self.assertEqual(sec._unmaterialized(), {'r2', 'w0'}, 'an owner row was read')

    # -- the listing ------------------------------------------------------
    def test_list_orgs_decodes_no_node_row_even_for_a_stale_epoch(self):
        whole = self.whole()
        want = store._summary_row(self.slug, whole.d)
        with self.raw() as raw:
            raw.execute("DELETE FROM meta WHERE key='heal_epoch'")
        before = self.stats()
        with patch.object(store.LazyNodesMap, '_decode',
                          side_effect=AssertionError('a node row was decoded')):
            rows = [r for r in store.list_orgs() if r['slug'] == self.slug]
        self.assertEqual(rows, [want])
        self.assertEqual(want['live'], len(LIVE))
        self.assertEqual(want['nodes'], len(LIVE) + len(RETIRED))
        d = self.delta(before)
        self.assertEqual(d.get('epoch_fallbacks', 0), 0)
        self.assertGreaterEqual(d['listing_loads'], 1)

    def test_list_orgs_still_skips_an_org_that_refuses_to_load(self):
        with self.raw() as raw:
            raw.execute("INSERT INTO meta(key, val) VALUES('receipt_rows', '1')")
        with patch.object(store, 'RECEIPT_ROWS', False):
            with self.assertRaises(ledger.LedgerError):
                store.load_org(self.slug)
            self.assertNotIn(self.slug, [r['slug'] for r in store.list_orgs()])
        with self.raw() as raw:
            raw.execute("DELETE FROM meta WHERE key='receipt_rows'")

    # -- reconcile --------------------------------------------------------
    def test_reconcile_decodes_live_rows_and_acts_on_retired_ones_holding_its_fields(self):
        def mark(org):
            org.nodes['r4']['remote_controlled'] = {'pid': None}
            org.nodes['r6']['session_unrun'] = True
        self.edit(mark)
        r6_session = self.whole().nodes['r6']['session_id']
        decoded = []
        real = store.LazyNodesMap._decode

        def spy(nodes, nid, raw, index):
            decoded.append(nid)
            return real(nodes, nid, raw, index)
        before = self.stats()
        with patch.object(store.LazyNodesMap, '_decode', spy), \
                patch.object(supervisor, '_transcript_evidence',
                             return_value={r6_session: 'x.jsonl'}), \
                patch.object(supervisor, 'send_message'):
            supervisor.reconcile(self.slug, active_only=True)
        org = self.whole()
        self.assertNotIn('remote_controlled', org.nodes['r4'], 'retired flag not popped')
        self.assertNotIn('session_unrun', org.nodes['r6'], 'spent pardon kept')
        self.assertEqual(self.delta(before)['fallbacks'], 0, 'a walk decoded the table')
        untouched = set(RETIRED) - {'r4', 'r6'}
        self.assertFalse(untouched & set(decoded), sorted(untouched & set(decoded)))

    def test_transcript_roots_include_a_retired_nodes_account(self):
        self.edit(lambda org: org.nodes['r8'].__setitem__('account', 'acct-r8'))
        asked = []

        def get_account(aid):
            return {'provider': 'claude', 'credential': {'kind': 'managed', 'path': f'/prof/{aid}'}}

        def index(root, strict=False):
            asked.append(root)
            return {}
        view = store.load_runtime_org(self.slug)
        with patch.object(registry, 'get_account', side_effect=get_account), \
                patch.object(supervisor, '_legacy_transcript_evidence', return_value={}), \
                patch.object(supervisor, 'transcript_index', side_effect=index):
            supervisor._transcript_evidence(view)
        self.assertIn('/prof/acct-r8', asked)
        self.assertNotIn('r8', self.decoded(view))

    # -- the save hook ----------------------------------------------------
    def test_a_whole_org_save_visits_frozen_rows_without_a_walk(self):
        self.edit(lambda org: org.nodes['r11'].__setitem__('frozen', {'reason': 'limit', 'tag': 'r11'}))
        seen = []
        before = self.stats()
        with patch.object(supervisor, 'commit_node_wake',
                          side_effect=lambda n: seen.append(n['frozen'].get('tag'))):
            with orgtx.org_tx(self.slug, whole=True) as tx:
                tx.org.nodes['w0']['charter'] = 'changed'
        self.assertEqual(seen, ['r11'])
        self.assertEqual(self.delta(before)['fallbacks'], 0)

    # -- mail drain discovery --------------------------------------------
    def test_discovery_tracks_live_seats_with_a_demand_only(self):
        def demand(org):
            org.d['mail_drain_version'] = 1
            org.nodes['w1']['mail_drain'] = {'at': 1}
            org.nodes['r1']['mail_drain'] = {'at': 1}
        self.edit(demand)
        with maildrain._pending_lock:
            maildrain._pending.clear()
        before = self.stats()
        self.assertTrue(maildrain.discover())
        with maildrain._pending_lock:
            mine = sorted(n for s, n in maildrain._pending if s == self.slug)
        self.assertEqual(mine, ['w1'])
        self.assertEqual(self.delta(before)['fallbacks'], 0)

    # -- the API-key cutover ---------------------------------------------
    def test_cutover_cleans_an_org_holding_its_fields_and_skips_the_rest(self):
        self.edit(lambda org: org.d.__setitem__('api_fallback', True))
        other = store.create_org('boot-' + uuid.uuid4().hex[:10])
        store.save_org(other)
        with self.raw() as raw:
            raw.execute("DELETE FROM meta WHERE key='heal_epoch'")
        with patch.object(registry_migration, 'apikey_cutover_done', return_value=False):
            before = self.stats()
            report = registry_migration.run_apikey_cutover()
        self.assertIn(self.slug, report['cleaned_orgs'])
        self.assertNotIn('api_fallback', self.whole().d)
        self.assertNotIn(other.d['slug'], report['cleaned_orgs'])
        self.assertGreaterEqual(self.delta(before)['listing_loads'], 2)


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class RetiredRowsStillReached(StartupReadsLiveRows):
    """pg-supervisor-a's review of 33c6879: the walks that must still reach a
    RETIRED row (or a row changed in this transaction), each pinned."""

    # run only these, not the inherited tests again
    locals().update({n: None for n in dir(StartupReadsLiveRows) if n.startswith('test_')})

    class Abort(Exception):
        pass

    def test_halt_recovery_reaches_a_retired_row_holding_a_halt(self):   # S11
        from orgtree import halt
        self.edit(lambda org: org.nodes['r13'].__setitem__('halt', {'phase': 'halting'}))
        self.addCleanup(supervisor._state.pop, (self.slug, 'r13'), None)
        with self.assertRaises(self.Abort):
            with orgtx.org_tx(self.slug, whole=True) as tx:
                with patch.object(halt, '_settled', return_value=False):
                    halt.recover(tx.org)
                raise self.Abort()
        self.assertTrue(supervisor.state(self.slug, 'r13').get('halt_requested'))

    def test_reconcile_resumes_a_retired_halt_queue_and_kills_a_retired_pid(self):  # S12, S19
        def mark(org):
            org.nodes['r14']['halt_queue'] = [{'kind': 'x'}]
            org.nodes['r4']['remote_controlled'] = {'pid': 4242}
        self.edit(mark)
        resumed, killed = [], []

        def kill(pid):
            # FR-01: the kill must PRECEDE the pop of the flag. A pid missed
            # before the transaction is still killed after the commit
            # (`_kill_late`), so record whether the stored row still held the
            # flag at the moment of the kill.
            with self.raw() as raw:
                val = raw.execute("SELECT val FROM nodes WHERE id='r4'").fetchone()[0]
            killed.append((pid, 'remote_controlled' in json.loads(val)))
        with patch.object(supervisor.halt, 'resume_pending',
                          side_effect=lambda slug, nid: resumed.append(nid)), \
                patch.object(supervisor, '_reconcile_kill', side_effect=kill), \
                patch.object(supervisor, '_transcript_evidence', return_value={}), \
                patch.object(supervisor, 'send_message'):
            supervisor.reconcile(self.slug, active_only=True)
        self.assertIn('r14', resumed)
        self.assertIn((4242, True), killed, 'the retired pid was not killed before the pop')
        self.assertNotIn('remote_controlled', self.whole().nodes['r4'])

    def test_the_settle_reaches_a_retired_delivery_journal_owner(self):  # S10
        self.edit(lambda org: org.d.setdefault('delivering', {}).__setitem__(
            'r15', [{'tok': 't-r15', 'mail_ids': ['m1']}]))
        settled = []
        self.addCleanup(supervisor._state.pop, (self.slug, 'r15'), None)
        with patch.object(supervisor, '_reconcile_mail_journal', return_value=1), \
                patch.object(supervisor.mailruntime, 'resolve_reclaims',
                             side_effect=lambda org, st, nid=None: settled.append(nid) or {}), \
                patch.object(supervisor.mailruntime, 'settle_confirmation',
                             return_value=frozenset()), \
                patch.object(supervisor, '_transcript_evidence', return_value={}), \
                patch.object(supervisor, 'send_message'):
            supervisor.reconcile(self.slug, active_only=True)
        self.assertIn('r15', settled)
        self.assertTrue(set(LIVE) <= set(settled))
        self.assertFalse((set(RETIRED) - {'r15'}) & set(settled))

    def test_restart_wake_drops_an_armed_wake_of_a_retired_seat(self):   # S18
        from orgtree import restart_wake
        key = f'{self.slug}:r16'
        d = restart_wake._wakes_read()
        d.setdefault('wakes', {})[key] = {'org': self.slug, 'node': 'r16', 'mode': 'one_shot'}
        restart_wake._wakes_write(d)
        restart_wake._reset_startup_done_for_tests()
        self.addCleanup(restart_wake._reset_startup_done_for_tests)
        sent = []
        with patch.object(supervisor, 'send_message',
                          side_effect=lambda slug, nid, *a, **k: sent.append((slug, nid))):
            out = restart_wake.on_backend_startup()
        self.assertIn(key, [f"{w['org']}:{w['node']}" for w in out['dropped']])
        self.assertNotIn((self.slug, 'r16'), sent)
        self.assertNotIn(key, restart_wake._wakes_read().get('wakes') or {})

    def test_cutover_still_skips_a_sandboxed_keyless_org(self):   # S17
        self.edit(lambda org: org.d.__setitem__('sandbox', {'image': 'x'}))
        row = registry.create_account(
            'claude', f'org key ({self.slug})',
            {'kind': 'token', 'token_ref': f'org-api-key:{self.slug}'},
            origin_org=self.slug)
        with patch.object(registry_migration, 'apikey_cutover_done', return_value=False):
            report = registry_migration.run_apikey_cutover()
        self.assertIn(self.slug, report['skipped_sandboxed'])
        self.assertNotIn(row['id'], report['orphaned_rows'])
        self.assertNotEqual(registry.get_account(row['id']).get('auth'), 'unauthenticated')

    def test_a_row_changed_here_so_it_no_longer_qualifies_is_excluded(self):   # S3
        self.edit(lambda org: org.nodes['w1'].__setitem__('halt', {'phase': 'halting'}))
        with self.assertRaises(self.Abort):
            with orgtx.org_tx(self.slug, whole=True) as tx:
                nodes = tx.org.nodes
                nodes['w1'].pop('halt')                  # decoded, no longer carries it
                nodes['w2']['state'] = 'archived'        # decoded, no longer live
                self.assertNotIn('w1', store.node_ids_with(tx.org, 'halt'))
                self.assertNotIn('w2', store.live_node_ids(tx.org))
                raise self.Abort()

    def test_field_values_and_owners_follow_this_transaction(self):   # S5, S6, S7
        def setup(org):
            org.nodes['w0']['account'] = 'acct-old'
            org.d.setdefault('steer_attempts', {})['r2'] = {'d1': {'state': 'x'}}
        self.edit(setup)
        with self.assertRaises(self.Abort):
            with orgtx.org_tx(self.slug, whole=True) as tx:
                tx.org.nodes['w1']['account'] = 'acct-new'     # decoded binding changed
                self.assertIn('acct-new', store.node_field_values(tx.org, 'account'))
                sec = tx.org.d.get('steer_attempts')
                sec['w3x'] = {'d9': {'state': 'y'}}             # owner added here
                del sec['r2']                                   # owner dropped here
                owners = store.section_owners(sec)
                self.assertIn('w3x', owners)
                self.assertNotIn('r2', owners)
                raise self.Abort()


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class StaleEpochProofSkipsSplitRows(StartupReadsLiveRows):
    """A new build's first transaction on an org (its heal epoch not stamped)
    loads the node table whole to prove the org heal-clean, and so does the
    heal it may commit first; neither decodes the split sections' owner rows
    (attempt 11: the retired agents' notices made this load ~5 GB)."""

    locals().update({n: None for n in dir(StartupReadsLiveRows) if n.startswith('test_')})

    class Abort(Exception):
        pass

    def setUp(self):
        super().setUp()

        def boxes(org):
            for i, nid in enumerate(LIVE + RETIRED):
                org.d.setdefault('notices', {})[nid] = [
                    {'id': f'n{i}', 'body': f'notice for {nid}', 'at': 1}]
            org.d.setdefault('mail', {})['r0'] = [{'id': 'm1', 'body': 'x', 'from': 'coord'}]
        self.edit(boxes)
        self.notices = {k: list(v) for k, v in self.whole().d['notices'].items()}
        self.assertEqual(len(self.notices), len(LIVE) + len(RETIRED))

    def unstamp(self):
        with self.raw() as raw:
            raw.execute("DELETE FROM meta WHERE key='heal_epoch'")

    def epoch(self):
        with self.raw() as raw:
            row = raw.execute("SELECT val FROM meta WHERE key='heal_epoch'").fetchone()
        return row[0] if row else None

    @contextlib.contextmanager
    def watch_loads(self):
        """Every lazy_work load's doc, and every split owner row decoded."""
        loads, owners = [], []
        real_load, real_decode = store._load_lazy, store.LazySplitSection._decode

        def load(conn, slug, *a, **k):
            d = real_load(conn, slug, *a, **k)
            if slug == self.slug:
                loads.append((k.get('lazy_work', False), type(dict.get(d, 'notices')),
                              type(dict.get(d, 'nodes'))))
            return d

        def decode(sec, owner, raw):
            owners.append((sec._sect, owner))
            return real_decode(sec, owner, raw)
        with patch.object(store, '_load_lazy', load), \
                patch.object(store.LazySplitSection, '_decode', decode):
            yield loads, owners

    def test_the_proof_loads_nodes_whole_and_no_split_owner_row(self):
        self.unstamp()
        before = self.stats()
        with self.watch_loads() as (loads, owners):
            with orgtx.org_tx(self.slug, nodes=['coord']) as tx:
                self.assertNotIsInstance(dict.get(tx.org.d, 'nodes'), store.LazyNodesMap)
                self.assertEqual(set(dict.keys(dict.get(tx.org.d, 'nodes'))),
                                 set(LIVE + RETIRED), 'the proof must decode every node')
        self.assertEqual(owners, [], 'a split owner row was decoded')
        self.assertEqual(loads, [(True, store.LazySplitSection, store.NodesMap)])
        self.assertEqual(self.delta(before)['epoch_fallbacks'], 1)
        self.assertEqual(self.epoch(), store.heal_epoch(), 'the proof did not stamp')
        self.assertEqual(self.whole().d['notices'], self.notices)

    def test_a_heal_found_by_the_proof_is_saved_without_the_split_rows(self):
        with self.raw() as raw:
            for nid in ('r3', 'w1'):
                val = json.loads(raw.execute('SELECT val FROM nodes WHERE id=%s',
                                             (nid,)).fetchone()[0])
                val['queued_msgs'] = ['legacy']          # the load heal pops it
                raw.execute('UPDATE nodes SET val=%s WHERE id=%s', (json.dumps(val), nid))
            xmins = dict(raw.execute(
                "SELECT key, xmin::text FROM doc WHERE starts_with(key, 'notices')").fetchall())
        self.unstamp()
        heals = []
        real_heal = orgtx._heal

        def heal(slug, *a):
            heals.append(a)
            return real_heal(slug, *a)
        with self.watch_loads() as (loads, owners), patch.object(orgtx, '_heal', heal):
            with orgtx.org_tx(self.slug, nodes=['coord']):
                pass
        self.assertEqual(heals, [(True,)], 'the heal did not run as a stale-epoch heal')
        self.assertEqual(owners, [])
        self.assertEqual(len(loads), 3, loads)          # attempt, heal, retry
        for got in loads:
            self.assertEqual(got, (True, store.LazySplitSection, store.NodesMap))
        with self.raw() as raw:
            for nid in ('r3', 'w1'):
                val = json.loads(raw.execute('SELECT val FROM nodes WHERE id=%s',
                                             (nid,)).fetchone()[0])
                self.assertNotIn('queued_msgs', val, f'{nid}: heal not saved')
            after = dict(raw.execute(
                "SELECT key, xmin::text FROM doc WHERE starts_with(key, 'notices')").fetchall())
        self.assertEqual(after, xmins, 'the heal rewrote split owner rows')
        self.assertEqual(self.epoch(), store.heal_epoch())
        self.assertEqual(self.whole().d['notices'], self.notices)

    def test_a_split_row_written_in_the_proof_transaction_is_saved(self):
        self.unstamp()
        with orgtx.org_tx(self.slug, whole=True) as tx:
            self.assertIsInstance(dict.get(tx.org.d, 'notices'), store.LazySplitSection)
            tx.org.d['notices']['r2'].append({'id': 'new', 'body': 'b', 'at': 2})
            tx.org.d['notices']['fresh'] = [{'id': 'f', 'body': 'f', 'at': 3}]
            del tx.org.d['notices']['r5']
        want = dict(self.notices)
        want['r2'] = want['r2'] + [{'id': 'new', 'body': 'b', 'at': 2}]
        want['fresh'] = [{'id': 'f', 'body': 'f', 'at': 3}]
        del want['r5']
        self.assertEqual(self.whole().d['notices'], want)
        self.assertEqual(self.epoch(), store.heal_epoch())

    def test_an_id_less_mail_box_still_heals_when_decoded_after_the_proof(self):
        with self.raw() as raw:
            raw.execute('UPDATE doc SET val=%s WHERE key=%s',
                        (json.dumps([{'body': 'x', 'from': 'coord'}]), 'mail\x1fr0'))
        self.unstamp()
        with orgtx.org_tx(self.slug, nodes=['coord']):
            pass
        self.assertEqual(self.epoch(), store.heal_epoch())
        view = store.load_runtime_org(self.slug)
        self.assertIn('id', view.d['mail']['r0'][0])


if __name__ == '__main__':
    unittest.main()
