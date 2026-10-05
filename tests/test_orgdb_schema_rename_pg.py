"""Native rename continuity and name-based docket authority on disposable PG.

Uses both the legacy store and a converted copy, plus an org born natively.
The source fixture is shared; every rename/save and permission check is real.
Run only under the heavy P03 lock with owned disposable PostgreSQL URLs.
"""

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import copy
import inspect
import json
import unittest
from unittest.mock import patch

import test_orgdb_compat_pg as f
from orgtree import ledger, orgtx, staffdoor, store
from orgtree.orgdb import registry, renames
from orgtree.orgdb.compat import rows as native_rows


def setUpModule():
    f.setUpModule()
    if f.ADMIN and f.RUNTIME:
        store.claim_data_root()


def tearDownModule():
    f.tearDownModule()


def exact(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), default=str)


def populate(org):
    """Public hires/docket writes, with one historical generation and recheck seat."""
    org.nodes.clear()
    for key in ('mail', 'mail_log', 'notices', 'turn_log', 'steer_attempts'):
        org.d[key] = {}
    org.d['work_items'] = []
    org.d['work_items_archive'] = []
    org.d['asks'] = []
    org.d['watchdogs'] = []
    org.hire(ledger.USER, None, 'haiku', 30, 'boss')
    for name in ('worker', 'owner', 'peer', 'taken'):
        org.hire(ledger.USER, 'boss', 'haiku', 2 if name == 'worker' else 0, name)
    org.hire(ledger.USER, 'worker', 'haiku', 0, 'child')
    org.nodes['worker']['generation'] = 1
    bearer = copy.deepcopy(org.nodes['worker'])
    bearer.update(state='archived', generation=0, grant=0, successor='worker')
    bearer.pop('predecessor', None)
    org.nodes['worker@0'] = bearer
    org.nodes['worker']['predecessor'] = 'worker@0'
    org.nodes['worker']['scope']['tools'] = {'bash': True, 'edit': True, 'mcp': ['test']}
    org.nodes['worker']['last_turn_mcp_tools'] = ['kept-tool', 'kept-tool']
    recent = {'n': 1, 'cost': 0.5, 'cost_unknown_fields': ['input', 'input'],
              'model_usage_key': {'asked': 'm', 'matched': True, 'keys': ['b', 'a']}}
    org.nodes['worker']['turns'] = [copy.deepcopy(recent)]
    org.nodes['worker']['turn_seq'] = 1
    org.d['turn_log'] = {'worker': [copy.deepcopy(recent)]}
    org.d['mail'] = {'worker': [{'id': 'kept-mail', 'from': 'boss', 'body': 'unchanged', 'at': f.AT}]}
    org.d['mail_log'] = {'worker': [{'id': 'kept-archive', 'from': 'peer', 'body': 'authored', 'at': f.AT}],
                         'worker@0': [{'id': 'bearer-mail', 'from': 'boss', 'body': 'older', 'at': f.AT}]}
    org.work_create('worker', 'Owned item', objective='Problem. Solution.', owner='worker')
    owned = org.d['work_items'][-1]
    org.work_create('owner', 'Reviewed item', objective='Problem. Solution.', owner='owner')
    reviewed = org.d['work_items'][-1]
    org.work_review_grant(ledger.USER, 'worker', [reviewed['slug']])
    reviewed['reviewer'] = org._work_holder('worker')
    reviewed['holders'].insert(0, org._work_holder_row('worker', ledger.USER))
    owned['reviewer'] = org._work_holder('peer')
    # A genuine recheck-shaped record: the original owner and reviewer are
    # required to match exactly. Renaming either must not make a new seat.
    owned['review_seats'] = [{
        'reviewer': 'peer', 'holder': org._work_holder('peer'),
        'recheck_owner': org._work_holder('worker'), 'state': 'granted',
        'granted_by': ledger.USER, 'at': f.AT, 'note': 'same reviewer only',
    }]
    artifact = org.work_artifact_record('boss', owned['slug'], 'probe.txt', 5,
                                        'probe.txt', 'a' * 64, scope='named')
    org.work_artifact_grant('boss', owned['slug'], artifact['id'], 'worker')
    return org


def prepare_legacy(slug):
    org = populate(store.load_org(slug))
    store.save_org(org)


def item(org, name):
    return next(row for row in org._work_all() if row['slug'] == name)


def outcome(fn):
    """Keep the public result or the exact public refusal, not only a boolean."""
    try:
        return ('result', fn())
    except ledger.LedgerError as error:
        return ('refusal', str(error))


def authorities(org):
    """Public docket/file reads plus the ledger's naming and holder decisions."""
    owned, reviewed = item(org, 'owned-item'), item(org, 'reviewed-item')
    artifact = owned['artifacts'][0]['id']
    actors = ('boss', 'owner', 'peer', 'worker', 'renamed', 'child')
    return {
        actor: {
            'owned_get': outcome(lambda a=actor: org.work_get(a, 'owned-item', now_ts=0)),
            'reviewed_get': outcome(lambda a=actor: org.work_get(a, 'reviewed-item', now_ts=0)),
            'artifact': outcome(lambda a=actor: org.work_artifact_for_read(a, 'owned-item', artifact)),
            'owner_manage': org._work_can_manage(actor, owned),
            'reviewed_read': org._work_can_read(actor, reviewed),
            'owned_seats': sorted(org._work_review_seat_nodes(owned)),
            'reviewed_seats': sorted(org._work_review_seat_nodes(reviewed)),
            'named_before': org._work_had_review_seat(reviewed, actor),
            'grant_live': org._work_grant_live(owned['artifacts'][0], actor),
            'prior_holder': org.work_item_read_grant(actor, 'worker'),
        } for actor in actors
    }


def ids(slug):
    with registry.connection(slug) as raw:
        return dict(raw.execute('SELECT name,id FROM orgtree.agents WHERE NOT tombstone').fetchall())


def role_links(slug):
    """Seven current references, addressed by their original logical occurrence."""
    with registry.connection(slug) as raw:
        return {
            'items': raw.execute('SELECT slug,owner_agent_id,reviewer_agent_id '
                                 'FROM orgtree.work_items ORDER BY slug').fetchall(),
            'holders': raw.execute('SELECT w.slug,h.pos,h.agent_id FROM orgtree.work_item_holders h '
                                   'JOIN orgtree.work_items w ON w.id=h.item_id ORDER BY w.slug,h.pos').fetchall(),
            'seats': raw.execute('SELECT w.slug,s.seq,s.reviewer_agent_id,s.holder_agent_id,'
                                 's.recheck_owner_agent_id FROM orgtree.work_item_review_seats s '
                                 'JOIN orgtree.work_items w ON w.id=s.item_id ORDER BY w.slug,s.seq').fetchall(),
            'grants': raw.execute('SELECT g.artifact_id,g.pos,g.agent_id '
                                  'FROM orgtree.work_item_artifact_grants g ORDER BY g.artifact_id,g.pos').fetchall(),
        }


def rows(slug, tables=None):
    """Exact physical rows, including IDs and revision stamps, sorted as text."""
    from psycopg import sql
    with registry.connection(slug) as raw:
        tables = tables or [name for name, in raw.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='orgtree' ORDER BY tablename").fetchall()]
        return {name: sorted(row[0] for row in raw.execute(sql.SQL(
            'SELECT row_to_json(t)::text FROM orgtree.{} t').format(sql.Identifier(name))).fetchall())
                for name in tables}


def baselines(org):
    doc = org.d
    return copy.deepcopy({key: getattr(doc, key) for key in (
        '_snap_doc', '_snap_nodes', '_snap_logs', '_deferred_doc')})


@f.needs_pg
class NativeRename(unittest.TestCase):
    def twins(self):
        return f.Twins('schema-rename-' + self._testMethodName, before=prepare_legacy)

    def native(self):
        with f.storage(True):
            org = populate(store.create_org('native-' + self._testMethodName))
            store.save_org(org)
        return org.d['slug']

    def kept_children(self, slug):
        # Name/title are header changes. Tool, runtime, log, turn-child and
        # mailbox rows retain their physical IDs/owners and exact contents.
        result = rows(slug, ('tool_lists', 'tool_list_items', 'agent_mcp_servers', 'agent_runtime',
                          'agent_turns', 'agent_turn_cost_unknown_fields',
                          'agent_turn_model_usage_keys', 'mail', 'mail_log'))
        for table in ('mail', 'mail_log'):
            result[table] = [row for row in result[table]
                             if json.loads(row)['public_id'] in ('kept-mail', 'kept-archive', 'bearer-mail')]
        return result

    def assert_kept(self, slug, before, new='renamed'):
        after = ids(slug)
        self.assertEqual(after[new], before['worker'])
        self.assertEqual(after[new + '@0'], before['worker@0'])
        self.assertEqual(after['child'], before['child'])
        if new != 'worker':
            self.assertNotIn('worker@0', after)

    def test_converted_rename_keeps_seven_role_links_and_exact_legacy_api_authority(self):
        twins = self.twins()
        with f.storage(True):
            before, links, children = ids(twins.copy), role_links(twins.copy), self.kept_children(twins.copy)
            # Make sure all seven roles are populated before testing them.
            self.assertTrue(all(value is not None for row in links['seats'] for value in row[2:4]))
            self.assertEqual(links['seats'][0][4], before['worker'])
            self.assertTrue(links['grants'])
            self.assertEqual(links['grants'][0][2], before['worker'])
        snapshots = {}
        for on, slug in ((False, twins.legacy), (True, twins.copy)):
            with f.storage(on):
                org = store.load_org(slug)
                snapshots[on] = authorities(org)
                org.rename(ledger.USER, 'worker', 'renamed')
                store.save_org(org)
                snapshots[(on, 'after')] = authorities(store.load_org(slug))
        self.assertEqual(exact(snapshots[False]), exact(snapshots[True]))
        self.assertEqual(exact(snapshots[(False, 'after')]), exact(snapshots[(True, 'after')]))
        after = snapshots[(True, 'after')]['renamed']
        self.assertTrue(after['owner_manage'])
        self.assertTrue(after['reviewed_read'])
        self.assertFalse(after['named_before'])
        self.assertFalse(after['grant_live'])
        self.assertEqual(after['artifact'][0], 'refusal')
        with f.storage(True):
            self.assert_kept(twins.copy, before)
            self.assertEqual(role_links(twins.copy), links)
            self.assertEqual(self.kept_children(twins.copy), children)

    def test_org_born_natively_keeps_rows_and_child_data_on_real_save(self):
        slug = self.native()
        with f.storage(True):
            before, links, children = ids(slug), role_links(slug), self.kept_children(slug)
            self.assertEqual(links['items'][0][1], before['worker'])
            self.assertEqual(links['items'][1][2], before['worker'])
            self.assertEqual(links['grants'][0][2], before['worker'])
            self.assertEqual(links['seats'][0][4], before['worker'])
            self.assertEqual(links['seats'][1][2:4], (before['worker'], before['worker']))
            self.assertEqual(links['holders'][0][2], before['worker'])
            org = store.load_org(slug)
            org.rename(ledger.USER, 'worker', 'renamed')
            store.save_org(org)
            self.assert_kept(slug, before)
            self.assertEqual(role_links(slug), links)
            self.assertEqual(self.kept_children(slug), children)
            loaded = store.load_org(slug)
            self.assertEqual(loaded.nodes['child']['parent'], 'renamed')
            self.assertEqual(loaded.nodes['renamed']['predecessor'], 'renamed@0')
            self.assertEqual(loaded.nodes['renamed@0']['successor'], 'renamed')
            self.assertNotIn('_native_rename_intent', org.__dict__)
            self.assertNotIn('_native_rename_intent', dict(org.d))

    def test_deleted_target_tombstones_are_never_revived_or_reinserted(self):
        slug = self.native()
        with f.storage(True):
            org = store.load_org(slug)
            org.delete(ledger.USER, 'taken')
            store.save_org(org)
            before = ids(slug)
            with registry.connection(slug) as raw:
                tombs = raw.execute('SELECT id,row_to_json(a)::text FROM orgtree.agents a '
                                    "WHERE name='taken' AND tombstone ORDER BY id").fetchall()
            self.assertTrue(tombs)
            org = store.load_org(slug)
            org.rename(ledger.USER, 'worker', 'taken')
            store.save_org(org)
            self.assert_kept(slug, before, 'taken')
            with registry.connection(slug) as raw:
                after = raw.execute('SELECT id,row_to_json(a)::text FROM orgtree.agents a '
                                     'WHERE id=ANY(%s) ORDER BY id', ([row[0] for row in tombs],)).fetchall()
            self.assertEqual(after, tombs)

    def test_same_save_delete_of_live_target_is_explicitly_refused_without_any_write(self):
        slug = self.native()
        with f.storage(True):
            org = store.load_org(slug)
            before = rows(slug)
            org.delete(ledger.USER, 'taken')
            org.rename(ledger.USER, 'worker', 'taken')
            snaps = baselines(org)
            with self.assertRaisesRegex(store.StaleWrite, 'still taken'):
                store.save_org(org)
            self.assertEqual(rows(slug), before)
            self.assertEqual(baselines(org), snaps)
            self.assertFalse(hasattr(org, '_native_rename_intent'))

    def test_old_name_hire_has_a_new_row_and_legacy_name_based_authority(self):
        twins = self.twins()
        with f.storage(True):
            before, links = ids(twins.copy), role_links(twins.copy)
        results = {}
        for on, slug in ((False, twins.legacy), (True, twins.copy)):
            with f.storage(on):
                org = store.load_org(slug)
                org.rename(ledger.USER, 'worker', 'renamed')
                store.save_org(org)
                if on:
                    with orgtx.org_tx(slug, nodes=['boss', 'worker'],
                                      structural_roots=['boss', 'worker'],
                                      sections=staffdoor.HIRE_SECTIONS,
                                      share_sections=staffdoor.HIRE_SETTINGS,
                                      logs=staffdoor.HIRE_LOGS) as tx:
                        tx.org.hire(ledger.USER, 'boss', 'haiku', 0, 'worker')
                else:
                    org.hire(ledger.USER, 'boss', 'haiku', 0, 'worker')
                    store.save_org(org)
                results[on] = authorities(store.load_org(slug))
        self.assertEqual(exact(results[False]), exact(results[True]))
        with f.storage(True):
            self.assert_kept(twins.copy, before)
            self.assertNotEqual(ids(twins.copy)['worker'], before['worker'])
            self.assertEqual(role_links(twins.copy), links)

    def test_two_unsaved_renames_back_to_original_preserve_rows_and_membership(self):
        slug = self.native()
        with f.storage(True):
            before, links, children = ids(slug), role_links(slug), self.kept_children(slug)
            org = store.load_org(slug)
            org.rename(ledger.USER, 'worker', 'renamed')
            org.rename(ledger.USER, 'renamed', 'worker')
            store.save_org(org)
            self.assertEqual(ids(slug), before)
            self.assertEqual(role_links(slug), links)
            self.assertEqual(self.kept_children(slug), children)
            self.assertFalse(hasattr(org, '_native_rename_intent'))

    def test_two_committed_renames_back_to_original_preserve_rows_and_membership(self):
        slug = self.native()
        with f.storage(True):
            before, links, children = ids(slug), role_links(slug), self.kept_children(slug)
            owner_order = {sect: list(store.load_org(slug).d[sect])
                           for sect in ('turn_log', 'mail_log')}
            for old, new in (('worker', 'renamed'), ('renamed', 'worker')):
                org = store.load_org(slug)
                org.rename(ledger.USER, old, new)
                store.save_org(org)
                loaded = store.load_org(slug)
                for sect, owners in owner_order.items():
                    self.assertEqual(list(loaded.d[sect]),
                                     [new + owner[len('worker'):] if owner == 'worker' or owner.startswith('worker@')
                                      else owner for owner in owners])
            self.assertEqual(ids(slug), before)
            self.assertEqual(role_links(slug), links)
            self.assertEqual(self.kept_children(slug), children)

    def test_native_writer_order_fault_exposes_same_save_current_reference_tombstone(self):
        source = inspect.getsource(store._write_doc)
        early = "if getattr(conn, 'orgdb', False):\n        write_nodes()"
        late = "if not getattr(conn, 'orgdb', False):\n        write_nodes()"
        self.assertEqual(source.count(early), 1)
        self.assertEqual(source.count(late), 1)
        faulty = source.replace(early, 'if False:\n        write_nodes()').replace(
            late, 'if True:\n        write_nodes()')
        namespace = dict(vars(store))
        exec(compile(faulty, '<planted-doc-before-agent-write>', 'exec'), namespace)
        with patch.object(store, '_write_doc', namespace['_write_doc']):
            slug = self.native()
        with f.storage(True):
            before, links = ids(slug), role_links(slug)
            with self.assertRaises(AssertionError):
                self.assertEqual(links['items'][0][1], before['worker'])
            with registry.connection(slug) as raw:
                broken = raw.execute('SELECT tombstone FROM orgtree.agents WHERE id=%s',
                                      (links['items'][0][1],)).fetchone()
            self.assertEqual(broken, (True,))

    def test_section_only_owner_version_fault_keeps_an_old_name_after_rename(self):
        slug = self.native()
        real = native_rows.meta_get
        def section_only_version(conn, key):
            got = real(conn, key)
            if got is not None and key.startswith('owners:'):
                marker = native_rows.section_row(conn, key[len('owners:'):])
                return (marker[2], got[1])
            return got
        with f.storage(True):
            with patch.object(native_rows, 'meta_get', side_effect=section_only_version):
                org = store.load_org(slug)
                self.assertEqual(list(org.d['turn_log']), ['worker'])
                org.rename(ledger.USER, 'worker', 'renamed')
                store.save_org(org)
                stale_owners = list(store.load_org(slug).d['turn_log'])
                self.assertEqual(stale_owners, ['worker'])
                with self.assertRaises(AssertionError):
                    self.assertEqual(stale_owners, ['renamed'])
            self.assertEqual(list(store.load_org(slug).d['turn_log']), ['renamed'])

    def test_late_cas_failure_rolls_back_rows_and_baselines_then_retry_succeeds(self):
        slug = self.native()
        with f.storage(True):
            org = store.load_org(slug)
            original = store.rollback_copy(org.d)
            before = rows(slug)
            org.rename(ledger.USER, 'worker', 'renamed')
            snaps = baselines(org)
            reached = []
            def fail_cas(conn, statement, params, what):
                row = conn.raw.execute("SELECT id FROM orgtree.agents WHERE name='renamed' AND NOT tombstone").fetchone()
                self.assertIsNotNone(row, 'fault must execute after the physical rename')
                reached.append(what)
                raise store.StaleWrite('planted late CAS failure')
            with patch.object(store, '_cas', side_effect=fail_cas):
                with self.assertRaisesRegex(store.StaleWrite, 'planted late CAS failure'):
                    store.save_org(org)
            self.assertTrue(reached)
            self.assertEqual(rows(slug), before)
            self.assertEqual(baselines(org), snaps)
            self.assertFalse(hasattr(org, '_native_rename_intent'))
            org.d = original
            org.rename(ledger.USER, 'worker', 'renamed')
            store.save_org(org)
            self.assert_kept(slug, dict((json.loads(row)['name'], json.loads(row)['id'])
                                      for row in before['agents'] if not json.loads(row)['tombstone']))

    def test_concurrent_node_write_refuses_stale_rename_and_changes_no_other_rows(self):
        slug = self.native()
        with f.storage(True):
            stale = store.load_org(slug)
            stale.rename(ledger.USER, 'worker', 'renamed')
            snaps = baselines(stale)
            other = store.load_org(slug)
            other.nodes['child']['title'] = 'concurrent value'
            store.save_org(other)
            committed = rows(slug)
            with self.assertRaisesRegex(store.StaleWrite, 'changed before rename'):
                store.save_org(stale)
            self.assertEqual(rows(slug), committed)
            self.assertEqual(baselines(stale), snaps)

    def test_concurrent_owner_section_write_refuses_after_rename_and_rolls_it_back(self):
        slug = self.native()
        with f.storage(True):
            stale = store.load_org(slug)
            stale.rename(ledger.USER, 'worker', 'renamed')
            snaps = baselines(stale)
            other = store.load_org(slug)
            other.d['mail']['worker'][0]['body'] = 'concurrent mail'
            store.save_org(other)
            committed = rows(slug)
            with self.assertRaises(store.StaleWrite):
                store.save_org(stale)
            self.assertEqual(rows(slug), committed)
            self.assertEqual(baselines(stale), snaps)

    def test_missing_prepass_fault_is_caught_by_physical_identity_control(self):
        slug = self.native()
        with f.storage(True):
            before = ids(slug)
            org = store.load_org(slug)
            org.rename(ledger.USER, 'worker', 'renamed')
            reached = []
            def no_prepass(conn, doc, lazy, intent, changes):
                reached.append(True)
                return lazy
            with patch.object(renames, 'prepass', side_effect=no_prepass):
                try:
                    store.save_org(org)
                except store.StaleWrite:
                    pass
                else:
                    with self.assertRaises(AssertionError):
                        self.assert_kept(slug, before)
            self.assertTrue(reached)

    def test_missing_handoff_fault_is_caught_and_restored_save_succeeds(self):
        slug = self.native()
        with f.storage(True):
            org = store.load_org(slug)
            original = store.rollback_copy(org.d)
            before = rows(slug)
            org.rename(ledger.USER, 'worker', 'renamed')
            snaps = baselines(org)
            real, reached = renames.prepass, []
            def no_handoff(conn, doc, lazy, intent, changes):
                real(conn, doc, lazy, intent, changes)
                reached.append(True)
                return lazy
            with patch.object(renames, 'prepass', side_effect=no_handoff):
                with self.assertRaises(store.StaleWrite):
                    store.save_org(org)
            self.assertTrue(reached)
            self.assertEqual(rows(slug), before)
            self.assertEqual(baselines(org), snaps)
            org.d = original
            org.rename(ledger.USER, 'worker', 'renamed')
            store.save_org(org)
            self.assertIn('renamed', ids(slug))


if __name__ == '__main__':
    unittest.main()
