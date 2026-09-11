"""Appending to a big append-only log must not cost the whole log.

Every lifecycle op (hire, retire, move) appends to `events` and `notice_log`
and reads neither. Reaching them through `d[sect].append(...)` materialised the
whole section — a `json.loads` per stored row on the way in and a `_dumps` per
stored row on the way out — so one new row cost a full round trip of every row
ever written. Measured 2026-09-11 on the operator's org (19,049 `events` rows,
1,815 `notice_log` rows): 21.4k JSON rows and ~185 ms per op, against 0.5k rows
and ~74 ms once `store.log_append` takes the buffered path.

The assertions here are CALL COUNTS, not durations: a duration test on a build
machine is noise, and a count is what actually regresses if someone reintroduces
the item lookup.

Three things have to hold together, and each guards a different way of being
wrong:

  cheap        an append-only op must not scale with the log's length
  honest       a reader must still see every row, in order, after a reload —
               "cheap" is trivially satisfiable by not writing at all
  unweakened   a NESTED edit to an existing entry must still persist, and an op
               that reads the log must still pay the full cost. That is the
               property `_write_log_rows` re-serialises for, and the buffered
               path is only sound while nobody has looked.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

_root = tempfile.TemporaryDirectory(prefix='v2-append-log-')
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name, USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import store  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

if Path(store.DATA_ROOT).resolve() != Path(_root.name).resolve():
    raise unittest.SkipTest(
        "store.DATA_ROOT already bound elsewhere in this process; "
        "run this file on its own (see tests/test_lazydoc_bool.py)")

SEEDED = 400        # rows put in `events` before each measurement


def tearDownModule():
    for slug in list(_SLUGS):
        store._POOL.close_all(slug)
    _root.cleanup()


_SLUGS = []


class _Counter:
    """Counts every JSON row crossing the store boundary, both directions."""

    def __enter__(self):
        import json
        self.loads = self.dumps = 0
        self._json = json
        self._oloads, self._odumps = json.loads, store._dumps

        def counted_loads(s, *a, **kw):
            self.loads += 1
            return self._oloads(s, *a, **kw)

        def counted_dumps(v):
            self.dumps += 1
            return self._odumps(v)

        json.loads = counted_loads
        store.json.loads = counted_loads
        store._dumps = counted_dumps
        return self

    def __exit__(self, *a):
        self._json.loads = self._oloads
        store.json.loads = self._oloads
        store._dumps = self._odumps

    @property
    def rows(self):
        return self.loads + self.dumps


class AppendOnlyLogTests(unittest.TestCase):

    def _org(self, name, seed=SEEDED):
        """A slug whose `events` log already holds `seed` synthetic rows.

        `self.base` records how many rows were in it BEFORE seeding: creating
        an org and hiring the anchor log events of their own, so no test may
        assume the log starts empty.
        """
        org = store.create_org(name)
        store.save_org(org)
        slug = org.d['slug']
        _SLUGS.append(slug)
        o = store.load_org(slug)
        o.hire(USER, None, 'haiku', 0, 'anchor', charter='anchor')
        store.save_org(o)
        o = store.load_org(slug)
        self.base = len(o.d['events'])
        self.seed = seed
        for i in range(seed):
            o.d['events'].append(
                {'at': '2026-01-01T00:00:00Z', 'op': 'seed', 'i': i})
        store.save_org(o)
        return slug

    # -- cheap ------------------------------------------------------------
    def _op_rows(self, slug, body):
        with _Counter() as c:
            o = store.load_org(slug)
            body(o)
            store.save_org(o)
        return c.rows

    def test_lifecycle_op_cost_does_not_grow_with_the_log(self):
        """The load-bearing assertion, written as a SLOPE rather than an
        absolute count: the same op against a log ten times longer must cost
        about the same. An absolute threshold has to be picked against one
        org's shape and silently stops discriminating when that shape changes;
        a slope cannot pass vacuously, because the small arm is the control
        for the large one."""
        small = self._org('Append Slope Small', seed=200)
        large = self._org('Append Slope Large', seed=2000)
        for label, body in (
                ('hire', lambda o: o.hire(USER, 'anchor', 'haiku', 0, 'fresh',
                                          charter='fresh')),
                ('notice', lambda o: o._notify(['anchor'], 'a notice')),
        ):
            a = self._op_rows(small, body)
            b = self._op_rows(large, body)
            self.assertLess(
                b - a, 200,
                f'{label}: {a} JSON rows at 200 log rows but {b} at 2000 — the '
                f'op is paying for the log it appends to')

    def test_move_and_retire_do_not_grow_with_the_log_either(self):
        def arm(seed):
            slug = self._org(f'Append Slope Lifecycle {seed}', seed=seed)
            o = store.load_org(slug)
            a = o.hire(USER, 'anchor', 'haiku', 0, 'a', charter='a')['node']
            o.hire(USER, 'anchor', 'haiku', 0, 'b', charter='b')
            store.save_org(o)
            return (slug,
                    self._op_rows(slug, lambda x: x.move(USER, a, 'b')),
                    self._op_rows(slug, lambda x: x.retire(USER, a)))

        _, mv_s, rt_s = arm(200)
        _, mv_l, rt_l = arm(2000)
        self.assertLess(mv_l - mv_s, 200, f'move: {mv_s} rows → {mv_l} rows')
        self.assertLess(rt_l - rt_s, 200, f'retire: {rt_s} rows → {rt_l} rows')

    # -- honest -----------------------------------------------------------
    def test_appended_rows_are_durable_and_ordered(self):
        slug = self._org('Append Durable')
        o = store.load_org(slug)
        o.hire(USER, 'anchor', 'haiku', 0, 'fresh', charter='fresh')
        store.save_org(o)
        reread = store.load_org(slug)
        events = list(reread.d['events'])
        self.assertEqual(len(events), self.base + self.seed + 1)
        seeds = [e for e in events if e.get('op') == 'seed']
        self.assertEqual([e['i'] for e in seeds], list(range(self.seed)))
        self.assertEqual(events[-1]['op'], 'hire')

    def test_two_saves_without_a_read_keep_both_appends(self):
        slug = self._org('Append Twice')
        for name in ('one', 'two'):
            o = store.load_org(slug)
            o.hire(USER, 'anchor', 'haiku', 0, name, charter=name)
            store.save_org(o)
        events = list(store.load_org(slug).d['events'])
        self.assertEqual(len(events), self.base + self.seed + 2)
        self.assertEqual([e['op'] for e in events[-2:]], ['hire', 'hire'])

    def test_appends_in_one_document_survive_a_second_save(self):
        """The buffer is flushed by the save; a second save of the SAME object
        must not write the rows again (that was the duplication risk)."""
        slug = self._org('Append Resave')
        o = store.load_org(slug)
        o.hire(USER, 'anchor', 'haiku', 0, 'once', charter='once')
        store.save_org(o)
        store.save_org(o)
        events = list(store.load_org(slug).d['events'])
        self.assertEqual(len(events), self.base + self.seed + 1)

    def test_append_then_read_in_the_same_document_sees_the_new_row(self):
        slug = self._org('Append Then Read')
        o = store.load_org(slug)
        o.hire(USER, 'anchor', 'haiku', 0, 'fresh', charter='fresh')
        # the buffer has not been flushed yet — the reader must still see it
        self.assertEqual(list(o.d['events'])[-1]['op'], 'hire')
        self.assertEqual(len(o.d['events']), self.base + self.seed + 1)
        store.save_org(o)
        self.assertEqual(len(store.load_org(slug).d['events']),
                         self.base + self.seed + 1)

    def test_a_section_with_no_rows_yet_is_created_by_appending(self):
        org = store.create_org('Append Fresh Section')
        store.save_org(org)
        slug = org.d['slug']
        _SLUGS.append(slug)
        o = store.load_org(slug)
        self.assertNotIn('watchdog_history', o.d)
        store.log_append(o.d, 'watchdog_history', {'at': 'x', 'n': 1})
        store.save_org(o)
        self.assertEqual(list(store.load_org(slug).d['watchdog_history']),
                         [{'at': 'x', 'n': 1}])

    # -- unweakened -------------------------------------------------------
    def test_a_nested_edit_to_an_existing_entry_still_persists(self):
        """`_write_log_rows` re-serialises every entry so that an in-place edit
        no list method can see still reaches the database. Buffering must not
        cost that: reading the section opts back into the full path."""
        slug = self._org('Append Nested Edit')
        o = store.load_org(slug)
        o.d['events'][3]['op'] = 'edited-in-place'
        o.hire(USER, 'anchor', 'haiku', 0, 'fresh', charter='fresh')
        store.save_org(o)
        events = list(store.load_org(slug).d['events'])
        self.assertEqual(events[3]['op'], 'edited-in-place')
        self.assertEqual(events[-1]['op'], 'hire')

    def test_reading_the_log_still_pays_the_full_cost(self):
        """Positive control for the cheapness assertions above. If this arm
        were also cheap, the fast path would be skipping work it must do —
        and `test_a_nested_edit...` would be the failure nobody saw coming."""
        slug = self._org('Append Reader Control')
        with _Counter() as c:
            o = store.load_org(slug)
            self.assertEqual(len(o.d['events']), self.base + self.seed)  # a real read
            o.hire(USER, 'anchor', 'haiku', 0, 'fresh', charter='fresh')
            store.save_org(o)
        self.assertGreater(c.loads, self.seed, 'the reader arm did not load the log')
        self.assertGreater(c.dumps, self.seed, 'the reader arm did not rewrite the log')

    def test_replacing_the_section_discards_buffered_rows(self):
        """The one way buffering could DUPLICATE a write: assign a new list to
        the section after a row was buffered for it, and the save writes the
        new list AND inserts the buffered row beside it."""
        slug = self._org('Append Then Replace', seed=50)
        o = store.load_org(slug)
        store.log_append(o.d, 'events', {'at': 'x', 'op': 'buffered'})
        o.d['events'] = [{'at': 'y', 'op': 'replacement'}]
        store.save_org(o)
        self.assertEqual(list(store.load_org(slug).d['events']),
                         [{'at': 'y', 'op': 'replacement'}])

    def test_deleting_the_section_discards_buffered_rows(self):
        slug = self._org('Append Then Delete')
        o = store.load_org(slug)
        store.log_append(o.d, 'events', {'at': 'x', 'op': 'doomed'})
        del o.d['events']
        store.save_org(o)
        self.assertNotIn('events', store.load_org(slug).d)

    def test_a_blobbed_section_is_not_taken_down_the_fast_path(self):
        """A section whose stored value had the wrong shape lives in `doc` as a
        blob (`_write_lazy`), which has to be rewritten whole. Appending to one
        must materialise rather than insert rows beside a blob that would still
        shadow them on the next load.

        `d['events']` is `None` here, so BOTH the old `d[sect].append(row)` and
        the new `log_append` raise `AttributeError` — that equivalence IS the
        assertion. What must not happen is the row being silently buffered and
        written as a row under a blob that outranks it."""
        org = store.create_org('Append Blob Shape')
        store.save_org(org)
        slug = org.d['slug']
        _SLUGS.append(slug)
        o = store.load_org(slug)
        o.d['events'] = None                    # stored as a doc blob
        store.save_org(o)

        o = store.load_org(slug)
        self.assertIsNone(o.d['events'])
        with self.assertRaises(AttributeError):
            store.log_append(o.d, 'events', {'at': 'x', 'op': 'after-blob'})
        self.assertEqual(getattr(o.d, '_pending', {}), {})
        store.save_org(o)
        self.assertIsNone(store.load_org(slug).d['events'])


if __name__ == '__main__':
    unittest.main()
