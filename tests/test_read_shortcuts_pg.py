"""N1000 read shortcuts on real PostgreSQL: the desk's polled reads do only the
work their answer needs, and no shortcut can hide a real change.

- notifications: an org's notices are reused while the change journal proves
  their inputs untouched; after ANY change the cached answer must equal a
  fresh, uncached build, including a commit made by another process.
- the docket list's 304 is decided by ONE statement that must agree with the
  full conditional path on every change the list can show (every case of
  test_pg_work_list_etag runs again with that check), and must refuse while
  any health gate is closed.

Actual PostgreSQL (disposable, via test_pgstore).
Run:  python tools/run-python-verification.py tests/test_read_shortcuts_pg.py
"""
import json
import unittest
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import test_pg_lazy_rows as lazy
import test_pg_work_list_etag as etag_tests
from orgtree import desktop_notifications as dn, orgtx, pgfeed, store, worklist


def tearDownModule():
    f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class NoticesCache(unittest.TestCase):
    setUpClass = lazy.LazyRows.setUpClass
    raw = lazy.LazyRows.raw

    def setUp(self):
        lazy.LazyRows.setUp(self)
        # as the engine does when its revision feed starts: this process's own
        # org_tx commits are known to be local (without it every commit reads
        # as foreign and every poll rebuilds, which is correct but not the
        # engine's behaviour)
        listener = lambda c: pgfeed.note_local(c.slug, c.revision)   # noqa: E731
        orgtx.commit_listeners.append(listener)
        self.addCleanup(orgtx.commit_listeners.remove, listener)
        org = store.load_org(self.slug)
        for nid in list(org.nodes)[:10]:
            org.nodes[nid]['state'] = 'live'   # asks and freezes show for live agents
        store.save_org(org)
        with orgtx.org_tx(self.slug, nodes=['n0']):
            pass                        # stamp the heal epoch: on-demand loads
        dn._cache.clear()
        self.addCleanup(dn._cache.clear)

    def cached(self):
        return [r for r in dn.notices(limit=1000)['notices'] if r['org'] == self.slug]

    def fresh(self):
        with patch.object(dn, '_CACHE_ON', False):
            return [r for r in dn.notices(limit=1000)['notices'] if r['org'] == self.slug]

    def edit(self, fn):
        org = store.load_org(self.slug)
        fn(org)
        store.save_org(org)

    def changes(self, fn, control=True):
        """Warm the cache, change something, then cached must equal fresh."""
        self.cached()
        before = self.fresh()
        fn()
        after = self.fresh()
        if control:
            self.assertNotEqual(after, before, 'control: the change is visible')
        self.assertEqual(self.cached(), after)
        self.assertEqual(self.cached(), after, 'and stays equal once re-cached')

    def test_a_warm_poll_loads_no_org(self):
        self.edit(lambda o: o.d.__setitem__('asks', [
            {'id': 'q1', 'node': 'n1', 'status': 'open', 'question': 'Which?'}]))
        first = self.cached()
        self.assertEqual([r['kind'] for r in first], ['question'], 'control')
        with patch.object(store, 'load_runtime_org', side_effect=AssertionError('loaded')):
            self.assertEqual(self.cached(), first)

    def test_an_unrelated_node_write_reloads_only_for_frozen_agents(self):
        self.edit(lambda o: o.d.__setitem__('asks', [
            {'id': 'q1', 'node': 'n1', 'status': 'open', 'question': 'Which?'}]))
        self.cached()
        with orgtx.org_tx(self.slug, nodes=['n7']) as tx:
            tx.org.nodes['n7']['note'] = 'x'
        with patch.object(dn, '_attention', side_effect=AssertionError('attention rebuilt')), \
             patch.object(store, 'load_runtime_org', side_effect=AssertionError('org loaded')):
            self.assertEqual([r['kind'] for r in self.cached()], ['question'])

    def test_frozen_agents_without_a_load_equal_the_fresh_projection(self):
        self.cached()

        def freeze_two():
            for nid, at in (('n4', '2026-09-29T00:00:00Z'), ('n6', '2026-09-29T00:01:00Z')):
                with orgtx.org_tx(self.slug, nodes=[nid]) as tx:
                    tx.org.nodes[nid]['frozen'] = {'at': at}
                    tx.org.nodes[nid]['generation'] = 5
        with patch.object(store, 'load_runtime_org', wraps=store.load_runtime_org) as loads:
            self.changes(freeze_two)
        mine = [c for c in loads.call_args_list if c.args[0] == self.slug]
        self.assertEqual(len(mine), 2, 'only the two uncached fresh() builds load the org')

    def test_an_org_that_is_not_heal_clean_loads_for_frozen_agents(self):
        self.cached()
        with self.raw() as raw:
            raw.execute("DELETE FROM meta WHERE key='heal_epoch'")

        def freeze():
            with orgtx.org_tx(self.slug, nodes=['n4']) as tx:
                tx.org.nodes['n4']['frozen'] = {'at': '2026-09-29T00:00:00Z'}
            with self.raw() as raw:          # org_tx re-stamps; keep it unstamped
                raw.execute("DELETE FROM meta WHERE key='heal_epoch'")
        with patch.object(dn, '_frozen_direct', side_effect=AssertionError('decoded without heal')):
            self.changes(freeze)

    def test_open_ask(self):
        self.changes(lambda: self.edit(lambda o: o.d.__setitem__('asks', [
            {'id': 'q1', 'node': 'n1', 'status': 'open', 'question': 'Which?'}])))

    def test_the_asking_agent_leaves(self):
        self.edit(lambda o: o.d.__setitem__('asks', [
            {'id': 'q1', 'node': 'n1', 'status': 'open', 'question': 'Which?'}]))

        def leave():
            with orgtx.org_tx(self.slug, nodes=['n1']) as tx:
                tx.org.nodes['n1']['state'] = 'archived'
        self.changes(leave)

    def test_mail_to_the_user(self):
        self.changes(lambda: self.edit(lambda o: o.d.setdefault('user_inbox', []).append(
            {'id': 'u1', 'from': 'n2', 'body': 'hi', 'urgent': True, 'urgent_reason': 'now'})))

    def test_work_item_attention(self):
        self.edit(lambda o: o.d.__setitem__('work_items', [
            {'slug': 'w', 'title': 'W', 'owner': {'node': 'n1'}}]))

        def flag(o):
            o.d['work_items'][0]['manual_attention'] = {'set_rev': 1, 'reason': 'look'}
        self.changes(lambda: self.edit(flag))

    def test_presented_document(self):
        self.changes(lambda: self.edit(lambda o: o.d.setdefault('documents', []).append(
            {'id': 'd1', 'title': 'Plan', 'node': 'n3'})))

    def test_freeze_and_thaw(self):
        def freeze():
            with orgtx.org_tx(self.slug, nodes=['n4']) as tx:
                tx.org.nodes['n4']['frozen'] = {'at': '2026-09-29T00:00:00Z'}
        self.changes(freeze)

        def thaw():
            with orgtx.org_tx(self.slug, nodes=['n4']) as tx:
                tx.org.nodes['n4']['frozen'] = None
        self.changes(thaw)

    def test_an_agent_added_frozen(self):
        # a node INSERT is structural: it names no updated row, so only the
        # structural flag says the frozen part (and any ask on it) may differ
        def hire():
            org = store.load_org(self.slug)
            org.d['nodes']['fresh'] = lazy.node('fresh', state='live',
                                                frozen={'at': '2026-09-29T01:00:00Z'})
            store.save_org(org)
        self.changes(hire)

    def test_the_asking_agent_is_deleted(self):
        self.edit(lambda o: o.d.__setitem__('asks', [
            {'id': 'q1', 'node': 'n9', 'status': 'open', 'question': 'Which?'}]))

        def delete():
            org = store.load_org(self.slug)
            del org.d['nodes']['n9']
            store.save_org(org)
        self.changes(delete)

    # transcript-db-review-astra f3: an insert/delete ALONE is also a blob
    # mark; only a commit that ALSO updates another node row reaches the
    # structural check on its own
    def test_the_asking_agent_is_deleted_with_another_node_updated(self):
        self.edit(lambda o: o.d.__setitem__('asks', [
            {'id': 'q1', 'node': 'n9', 'status': 'open', 'question': 'Which?'}]))

        def delete():
            org = store.load_org(self.slug)
            del org.d['nodes']['n9']
            org.nodes['n7']['note'] = 'x'
            store.save_org(org)
        self.changes(delete)

    def test_an_agent_added_frozen_with_another_node_updated(self):
        def hire():
            org = store.load_org(self.slug)
            org.d['nodes']['fresh'] = lazy.node('fresh', state='live',
                                                frozen={'at': '2026-09-29T01:00:00Z'})
            org.nodes['n7']['note'] = 'y'
            store.save_org(org)
        self.changes(hire)

    def test_renaming_the_org_retitles_unsigned_mail(self):
        # f4(a): mail with no 'from' is titled with the org's name
        self.edit(lambda o: o.d.setdefault('user_inbox', []).append({'id': 'u2', 'body': 'hi'}))
        self.changes(lambda: self.edit(lambda o: o.d.__setitem__('name', 'Renamed org')))

    def test_a_commit_by_another_process_is_seen(self):
        self.edit(lambda o: o.d.__setitem__('asks', []))

        def foreign():
            asks = [{'id': 'q9', 'node': 'n2', 'status': 'open', 'question': 'From elsewhere'}]
            with self.raw() as raw:
                raw.execute("UPDATE doc SET val=%s WHERE key='asks'", (json.dumps(asks),))
                raw.execute('UPDATE public.orgs SET revision=revision+1 WHERE org_id=%s', (self.oid,))
        self.changes(foreign)

    def test_an_unknown_change_rebuilds(self):
        self.cached()
        store.external_change(self.slug)
        with patch.object(dn, '_attention', wraps=dn._attention) as built:
            self.cached()
        self.assertEqual(built.call_count, 1)

    def test_switch_off_is_the_old_projection(self):
        self.edit(lambda o: o.d.__setitem__('documents', [{'id': 'd1', 'title': 'Plan', 'node': 'n3'}]))
        self.assertEqual(self.cached(), self.fresh())
        self.assertEqual([r['kind'] for r in self.fresh()], ['document'])


@unittest.skipUnless(f.ADMIN, 'disposable PG not configured: NOT RUN')
class FastUnchanged(etag_tests.ForegroundEtag):
    """Every ForegroundEtag case again, with the one-statement check held to
    the full path's answer at every read, and to a refusal after every change."""

    def fast(self, tag, backlogged=False, now=None):
        return worklist.foreground_unchanged(
            self.slug, backlogged=backlogged, since=tag,
            now_ts=self.now if now is None else now)

    def state(self, **kw):
        tag, rev = super().state(**kw)
        if kw.get('viewer', None) in (None,):
            self.assertTrue(self.fast(tag, kw.get('backlogged', False), kw.get('now')),
                            'fast check disagrees with the full path')
        return tag, rev

    def moves(self, mutate):
        self.seed()
        before = self.state(backlogged=True)
        mutate(); self.refresh()
        after = self.state(backlogged=True)
        self.assertNotEqual(after[1], before[1], 'body did not change (bad test)')
        self.assertFalse(self.fast(before[0], True), 'fast check hid a change')

    # transcript-db-review-astra f2: a gate's own SQL can fire the catalog
    # triggers (revision+1, ready=false, dirty rows), which would refuse the
    # tag whatever the gate does. So every other piece of catalog state is put
    # back after the gate is applied: only the gate can make fast() refuse.
    STATE = ('work_index_state', 'work_read_state', 'work_list_state')
    DIRTY = ('work_read_dirty', 'work_list_dirty')

    def catalog(self):
        rows = {t: self.c.execute(f'SELECT to_jsonb(x) FROM {self.s}.{t} x').fetchone()[0]
                for t in self.STATE}
        dirty = {t: [r[0] for r in self.c.execute(f'SELECT slug FROM {self.s}.{t}')]
                 for t in self.DIRTY}
        return rows, dirty

    def restore(self, snap, keep=None):
        rows, dirty = snap
        for t, row in rows.items():
            if t == keep:
                continue
            cols = [k for k in row if k != 'singleton']
            self.c.execute(f"UPDATE {self.s}.{t} SET ({','.join(cols)}) = (SELECT {','.join(cols)} "
                           f"FROM jsonb_populate_record(NULL::{self.s}.{t}, %s)) WHERE singleton",
                           (json.dumps(row),))
        for t, slugs in dirty.items():
            if t == keep:
                continue
            self.c.execute(f'DELETE FROM {self.s}.{t}')
            for slug in slugs:
                self.c.execute(f'INSERT INTO {self.s}.{t}(slug) VALUES(%s)', (slug,))

    def gate(self, apply, undo=None, keep=None):
        self.seed()
        tag, _ = self.state()
        snap = self.catalog()
        self.c.execute(apply.format(s=self.s))
        self.restore(snap, keep)
        self.assertFalse(self.fast(tag), apply)
        # control: with the gate undone and the catalog as it was, the same
        # tag passes again -- so the gate alone decided the refusal above
        if undo:
            self.c.execute(undo.format(s=self.s))
        self.restore(snap)
        self.assertTrue(self.fast(tag), 'control: undone gate still refused ' + apply)

    def test_gate_access_not_ready(self):
        self.gate("UPDATE {s}.work_read_state SET ready=false", keep='work_read_state')

    def test_gate_questions_dirty(self):
        self.gate("UPDATE {s}.work_read_state SET questions_dirty=true", keep='work_read_state')

    def test_gate_access_dirty_row(self):
        self.gate("INSERT INTO {s}.work_read_dirty(slug) VALUES('one')", keep='work_read_dirty')

    def test_gate_list_dirty_row(self):
        self.gate("INSERT INTO {s}.work_list_dirty(slug) VALUES('one')", keep='work_list_dirty')

    def test_gate_list_not_ready(self):
        self.gate("UPDATE {s}.work_list_state SET ready=false", keep='work_list_state')

    def test_gate_index_invalid(self):
        self.gate("UPDATE {s}.work_index_state SET valid=false", keep='work_index_state')

    def test_gate_unsupported_row(self):
        self.gate("UPDATE {s}.work_index SET summary=jsonb_set(summary,'{{_query,order_supported}}','false') "
                  "WHERE slug='one'",
                  "UPDATE {s}.work_index SET summary=jsonb_set(summary,'{{_query,order_supported}}','true') "
                  "WHERE slug='one'")

    def test_gate_legacy_blob(self):
        self.gate("INSERT INTO {s}.doc VALUES('work_scope_log','[]')",
                  "DELETE FROM {s}.doc WHERE key='work_scope_log'")

    def test_gate_schema_version(self):
        old = self.c.execute(f"SELECT val FROM {self.s}.meta WHERE key='schema_version'").fetchone()[0]
        self.gate("DELETE FROM {s}.meta WHERE key='schema_version'",
                  "INSERT INTO {s}.meta(key,val) VALUES('schema_version', '" + str(old).replace("'", "''") + "')")

    def test_the_unsupported_row_check_uses_its_partial_index(self):
        # a seq scan of every summary cost 11 ms / 6634 buffers per docket read
        # for 933 items on the live org copy; ORDER BY slug lets the planner
        # use work_query_unsupported, alone and inside the one-statement check
        from orgtree import workquery
        self.seed()
        t = f'{self.s}.work_index'
        import psycopg
        with self.c.transaction():
            # a realistic size (4 rows are cheapest to scan whatever the
            # shape), inside a transaction rolled back below
            self.c.execute(
                f"INSERT INTO {t} SELECT (jsonb_populate_record(NULL::{t}, to_jsonb(w) || "
                f"jsonb_build_object('slug', w.slug || '-' || g, 'source_key', w.source_key || '-' || g))).* "
                f"FROM {t} w, generate_series(1, 1500) g WHERE w.slug = 'one'")
            self.c.execute(f'ANALYZE {t}')
            for sql in (f'SELECT 1 FROM {t} WHERE {workquery._UNSUPPORTED_ROW}',
                        f'SELECT (SELECT 1 FROM {t} WHERE {workquery._UNSUPPORTED_ROW}) IS NULL'):
                plan = json.dumps(self.c.execute('EXPLAIN (FORMAT JSON) ' + sql).fetchone()[0])
                self.assertIn('work_query_unsupported', plan, sql)
                self.assertNotIn('Seq Scan', plan, sql)
            # control: the old shape really is the seq scan this replaced
            old = f'SELECT (EXISTS (SELECT 1 FROM {t} WHERE {workquery._UNSUPPORTED} LIMIT 1))'
            self.assertIn('Seq Scan', json.dumps(self.c.execute('EXPLAIN (FORMAT JSON) ' + old).fetchone()[0]))
            raise psycopg.Rollback()

    def test_not_a_foreground_tag_or_another_view(self):
        self.seed()
        tag, _ = self.state()
        self.assertFalse(self.fast(''))
        self.assertFalse(self.fast('"deadbeef"'))
        self.assertFalse(self.fast(tag, backlogged=True), 'the backlog view has its own tag')

    def test_the_route_answers_304_without_the_full_path(self):
        import asyncio
        from starlette.requests import Request
        from orgtree import api
        self.seed()
        tag, _ = self.state()

        def request(etag):
            return Request({'type': 'http', 'method': 'GET', 'path': '/', 'query_string': b'',
                            'headers': [(b'if-none-match', etag.encode())]})
        with patch.object(worklist, 'foreground_conditional', side_effect=AssertionError('full path')), \
             patch('time.time', return_value=self.now):
            r = asyncio.run(api._work_foreground_route(self.slug, 0, request(tag), 0))
        self.assertEqual((r.status_code, r.headers['etag']), (304, tag))
        with patch('time.time', return_value=self.now):
            r = asyncio.run(api._work_foreground_route(self.slug, 0, request('"fstale"'), 0))
        self.assertEqual(r.status_code, 200)


if __name__ == '__main__':
    unittest.main()
