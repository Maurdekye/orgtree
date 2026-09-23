"""The scope record must never freeze an item's description.

THE DEFECT (reported from the organization on the user's other machine, on
their item `plan-public-session-booking-and-payment-system` at rev 190).
`Org.WORK_SCOPE_MAX` capped the append-only scope record at 100 rows BY
REFUSAL. Every description change and every ruling appends a row, so at the
cap `objective`, `objective_append` and `decision` were all refused — and the
refusal's own advice ("consolidate the settled rulings into the description")
is itself a scope append, so following the instruction produced the same
error a second time. There was no path out from inside the tool.

Worse than the freeze: nothing announced it. The item still rendered a
description, which had simply stopped being the whole of the scope, and a
later reader had no way to tell a complete description from one truncated in
time.

WHAT THIS SUITE PINS:

  §1  THE DEAD END, reproduced as it was — the three refusals and the
      circular remedy — against the guard's pre-relief behaviour. This
      section does not depend on the fix; it is the bug, kept executable.
  §2  THE RELIEF VALVE. At the cap an append rolls the OLDEST rows over into
      `scope_archive` instead of refusing. Every row survives verbatim:
      same seq, same text, same before/after, same supersession pointers.
      Nothing is summarised, nothing is erased, and the description is
      writable again.
  §3  WHAT THE ROLLOVER PRESERVES. `supersedes` still resolves onto an
      archived row, the archived row still gains its back-pointer, and the
      complete record — live plus archive — reads in one unbroken sequence.
  §4  THE DECLARATION, WHERE THE DESCRIPTION IS READ. An item whose
      description is not the complete standalone scope carries that fact in
      `objective_notice`, beside `objective`, in `get`, in `list` and in the
      compact projection — not only at the moment a write fails.
  §5  ORDINARY ITEMS SAY NOTHING. An item under the cap has no notice, so
      the notice means something when it is there.
  §6  THE MAIL THAT HANDS THE ITEM OVER carries it too — that mail is the
      next agent's first reading of the description.
"""
import contextlib
import os
import tempfile
import unittest
import uuid
from pathlib import Path

# ⚠ ORGTREE_DATA BEFORE the first orgtree import: `store.DATA_ROOT` binds at
# import time. The assert below is the proof, not the intention.
fx = tempfile.TemporaryDirectory(prefix='scope-cap-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'scope-cap-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import events, ledger, store                            # noqa: E402
from orgtree import events_render                                    # noqa: E402,F401
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

slugs: list[str] = []


def tearDownModule() -> None:
    for s in slugs:
        store._POOL.close_all(s)


class ScopeCapBase(unittest.TestCase):
    def setUp(self) -> None:
        slug = 'scopecap-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.slug = slug
        self.agent = self.hire('worker')

    def hire(self, name: str, parent: str | None = None) -> str:
        name = f'{name}-{uuid.uuid4().hex[:4]}'
        self.org.hire(ledger.USER if parent is None else parent, parent,
                      'haiku', 0, name, add_dirs=[],
                      tools={'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []},
                      org_visibility='self', charter='fixture agent')
        store.save_org(self.org)
        return name

    def item_at_cap(self, *, spare: int = 0) -> str:
        """An item holding exactly WORK_SCOPE_MAX - spare scope rows."""
        it = self.org.work_create(self.agent, 'Capped', 'problem, then solution')
        wid = it['slug']
        for i in range(self.org.WORK_SCOPE_MAX - spare):
            self.org.work_decision(self.agent, wid, f'ruling number {i}')
        return wid

    @contextlib.contextmanager
    def refusing_guard(self):
        """The pre-relief guard, restored for the length of a block.

        `_work_scope_room` is the one gate all three routes pass through, and
        `relief=False` is its old behaviour kept executable. Patching it here
        rather than shipping a switch in the product means the dead end is
        reproduced through the real `work_update` / `work_decision` code paths
        without the product carrying a way to re-enter it.
        """
        cls = type(self.org)
        original = cls._work_scope_room

        def refusing(s, it, adding=1, **kw):
            return original(s, it, adding, relief=False)

        cls._work_scope_room = refusing
        try:
            yield
        finally:
            cls._work_scope_room = original

    def age_to_refusing_build(self, wid: str) -> None:
        """Make an item look as one filled by the build that refused.

        `scope_guard` is stamped by every scope append THIS build makes, so an
        item that reached the cap without one reached it under the refusing
        build — which is exactly the item whose description silently stopped
        being complete. Removing the stamp is how that state is reproduced;
        the real instances of it are already on disk.
        """
        it, _ = self.org._work_get_for(self.agent, wid)
        it.pop('scope_guard', None)
        it.pop('scope_frozen', None)


class TheDeadEnd(ScopeCapBase):
    """§1 — the bug as it was, reproduced against the guard itself.

    `_work_scope_room` is the guard. These cases call it directly with the
    refusing behaviour it had, so the reproduction survives the fix instead
    of being deleted by it: what the fix changes is that no CALLER reaches
    this state any more, not that the refusal text was wrong.
    """

    def test_s1_the_guard_refused_a_full_record(self) -> None:
        wid = self.item_at_cap()
        it, _ = self.org._work_get_for(self.agent, wid)
        self.assertEqual(len(it.get('scope') or []), self.org.WORK_SCOPE_MAX)

        with self.assertRaises(ledger.LedgerError) as caught:
            self.org._work_scope_room(it, relief=False)
        msg = str(caught.exception)
        self.assertIn(str(self.org.WORK_SCOPE_MAX), msg)
        # THE CIRCULARITY, in the refusal's own words: the remedy it names
        # is `objective`, and `objective` is a scope append.
        self.assertIn('objective', msg)

    def test_s1b_all_three_routes_went_through_that_one_guard(self) -> None:
        """Description rewrite, description append and ruling: one gate.

        This is why the remedy was circular. It is asserted structurally —
        each route is driven with relief disabled — so the test states the
        shape of the dead end rather than a single error string.
        """
        wid = self.item_at_cap()
        calls = {
            # the remedy the refusal itself names, and it is refused
            'objective': lambda: self.org.work_update(
                self.agent, wid, ['x'], [], objective='a new whole spec'),
            'objective_append': lambda: self.org.work_update(
                self.agent, wid, ['x'], [], objective_append='one more rule'),
            'decision': lambda: self.org.work_decision(
                self.agent, wid, 'a ruling nobody could record'),
        }
        with self.refusing_guard():
            for route, call in calls.items():
                with self.subTest(route=route):
                    with self.assertRaises(ledger.LedgerError) as caught:
                        call()
                    self.assertIn('Consolidate', str(caught.exception))

    def test_s1c_the_refusal_left_the_item_untouched(self) -> None:
        """A refusal that had half-written the item would be worse still."""
        wid = self.item_at_cap()
        before = self.org.work_get(self.agent, wid)
        with self.refusing_guard():
            with self.assertRaises(ledger.LedgerError):
                self.org.work_update(self.agent, wid, ['x'], [],
                                     objective='a new whole spec')
        after = self.org.work_get(self.agent, wid)
        self.assertEqual(before['rev'], after['rev'])
        self.assertEqual(before['objective'], after['objective'])


class TheReliefValve(ScopeCapBase):
    """§2 — at the cap, the record rolls over instead of freezing."""

    def test_s2_the_description_is_writable_at_the_cap(self) -> None:
        wid = self.item_at_cap()
        self.org.work_update(self.agent, wid, ['spec narrowed'], [],
                             objective='Perform the migration, do not plan it.')
        got = self.org.work_get(self.agent, wid)
        self.assertEqual(got['objective'],
                         'Perform the migration, do not plan it.')

    def test_s2b_a_ruling_can_still_be_recorded_at_the_cap(self) -> None:
        wid = self.item_at_cap()
        res = self.org.work_decision(self.agent, wid, 'the operator narrowed it')
        self.assertGreater(int(res['decision']), self.org.WORK_SCOPE_MAX)

    def test_s2c_objective_append_works_at_the_cap(self) -> None:
        wid = self.item_at_cap()
        self.org.work_update(self.agent, wid, ['widened'], [],
                             objective_append='One more rule, added later.')
        self.assertTrue(self.org.work_get(self.agent, wid)['objective']
                        .endswith('One more rule, added later.'))

    def test_s2d_nothing_is_erased_and_nothing_is_summarised(self) -> None:
        """The whole point: rollover is not truncation and not folding."""
        wid = self.item_at_cap()
        before = self.org.work_get(self.agent, wid)
        kept = {int(r['seq']): dict(r) for r in before['scope']}

        for i in range(10):
            self.org.work_decision(self.agent, wid, f'later ruling {i}')

        after = self.org.work_get(self.agent, wid)
        whole = {int(r['seq']): r
                 for r in list(after['scope_archive']) + list(after['scope'])}
        self.assertEqual(len(whole), self.org.WORK_SCOPE_MAX + 10)
        for seq, row in kept.items():
            self.assertIn(seq, whole, f'scope row {seq} stopped existing')
            for field in ('at', 'by', 'kind', 'text', 'before', 'after', 'mode'):
                if field in row:
                    self.assertEqual(whole[seq].get(field), row[field],
                                     f'scope row {seq}.{field} was rewritten')
        # and the live list is still bounded — this is a rollover, not a
        # quiet removal of the cap
        self.assertLessEqual(len(after['scope']), self.org.WORK_SCOPE_MAX)

    def test_s2e_the_rollover_is_disclosed_on_the_record_itself(self) -> None:
        wid = self.item_at_cap()
        self.org.work_decision(self.agent, wid, 'the first one past the cap')
        got = self.org.work_get(self.agent, wid)
        summary = got['scope_archive_summary']
        self.assertGreater(int(summary['count']), 0)
        self.assertEqual(int(summary['count']), len(got['scope_archive']))
        self.assertEqual(int(summary['first_seq']), 1)


class WhatTheRolloverPreserves(ScopeCapBase):
    """§3 — supersession still works across the archive boundary."""

    def test_s3_supersedes_resolves_onto_an_archived_row(self) -> None:
        wid = self.item_at_cap()
        first = self.org.work_get(self.agent, wid)['scope'][0]
        for i in range(self.org.WORK_SCOPE_MAX):     # push `first` into archive
            self.org.work_decision(self.agent, wid, f'filler {i}')
        got = self.org.work_get(self.agent, wid)
        self.assertTrue(any(int(r['seq']) == int(first['seq'])
                            for r in got['scope_archive']),
                        'the fixture did not archive the row it needs to')

        res = self.org.work_decision(self.agent, wid, 'replaces the very first',
                                     supersedes=int(first['seq']))

        got = self.org.work_get(self.agent, wid)
        archived = next(r for r in got['scope_archive']
                        if int(r['seq']) == int(first['seq']))
        self.assertEqual(int(archived['superseded_by']), int(res['decision']))
        self.assertEqual(archived['text'], first['text'],
                         'the superseded row\'s own text must never change')

    def test_s3b_the_previous_objective_row_is_found_in_the_archive(self) -> None:
        """`_work_scope_last` must see past the live window.

        Otherwise a description rewrite after a rollover would supersede
        nothing, and the chain of description versions would break in two.
        """
        it = self.org.work_create(self.agent, 'Chained', 'version one')
        wid = it['slug']
        self.org.work_update(self.agent, wid, ['v2'], [], objective='version two')
        obj_seq = int(self.org.work_get(self.agent, wid)['scope'][0]['seq'])
        for i in range(self.org.WORK_SCOPE_MAX + 5):
            self.org.work_decision(self.agent, wid, f'filler {i}')

        self.org.work_update(self.agent, wid, ['v3'], [], objective='version three')

        got = self.org.work_get(self.agent, wid)
        whole = list(got['scope_archive']) + list(got['scope'])
        old = next(r for r in whole if int(r['seq']) == obj_seq)
        newest = next(r for r in reversed(whole) if r['kind'] == 'objective')
        self.assertEqual(int(newest['supersedes']), obj_seq)
        self.assertEqual(int(old['superseded_by']), int(newest['seq']))
        self.assertEqual(old['after'], 'version two')

    def test_s3c_seqs_stay_unique_gapless_and_ordered(self) -> None:
        wid = self.item_at_cap()
        for i in range(37):
            self.org.work_decision(self.agent, wid, f'later {i}')
        got = self.org.work_get(self.agent, wid)
        seqs = [int(r['seq'])
                for r in list(got['scope_archive']) + list(got['scope'])]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(seqs, list(range(1, self.org.WORK_SCOPE_MAX + 38)))

    def test_s3d_the_archive_survives_save_and_load(self) -> None:
        wid = self.item_at_cap()
        for i in range(5):
            self.org.work_decision(self.agent, wid, f'past the cap {i}')
        expected = self.org.work_get(self.agent, wid)
        store.save_org(self.org)
        store._POOL.close_all(self.slug)

        reloaded = store.load_org(self.slug).work_get(self.agent, wid)

        self.assertEqual(reloaded['scope_archive'], expected['scope_archive'])
        self.assertEqual(reloaded['scope'], expected['scope'])


class TheDeclaration(ScopeCapBase):
    """§4 — an incomplete description says so where it is read."""

    def test_s4_a_rolled_over_item_carries_a_notice_beside_objective(self) -> None:
        wid = self.item_at_cap()
        self.org.work_decision(self.agent, wid, 'one past the cap')
        got = self.org.work_get(self.agent, wid)
        notice = got['objective_notice']
        self.assertIsNotNone(notice,
                             'the description does not say the record rolled over')
        self.assertIn('scope_archive', str(notice['detail']))
        self.assertEqual(notice['kind'], 'rolled_over')

    def test_s4b_a_frozen_item_says_the_description_is_not_complete(self) -> None:
        """The pre-fix failure, declared rather than silent.

        An item stranded at the cap by the refusing build has rulings that
        were never recorded anywhere on it. The fix cannot recover that text
        — nothing can — but it must stop the item from reading as a complete
        specification to the next agent that picks it up. This is the case
        that matters most, because it is the state the real items are in.
        """
        wid = self.item_at_cap()
        self.age_to_refusing_build(wid)

        notice = self.org.work_get(self.agent, wid)['objective_notice']

        self.assertIsNotNone(notice, 'a frozen item still reads as complete')
        self.assertEqual(notice['kind'], 'incomplete')
        self.assertIn('not the complete', str(notice['headline']).lower())
        self.assertIn('REFUSED', str(notice['detail']))

    def test_s4b2_a_frozen_item_can_be_written_to_again(self) -> None:
        """Declaring it is not enough — the freeze must also lift."""
        wid = self.item_at_cap()
        self.age_to_refusing_build(wid)

        self.org.work_update(self.agent, wid, ['unfrozen'], [],
                             objective='Perform the migration, do not plan it.')

        got = self.org.work_get(self.agent, wid)
        self.assertEqual(got['objective'],
                         'Perform the migration, do not plan it.')
        self.assertEqual(len(got['scope_archive']) + len(got['scope']),
                         self.org.WORK_SCOPE_MAX + 1)

    def test_s4c_the_notice_travels_with_list_and_compact(self) -> None:
        """Wherever a reader meets the description, the notice is beside it."""
        wid = self.item_at_cap()
        self.org.work_decision(self.agent, wid, 'one past the cap')

        listed = next(w for w in self.org.work_list(self.agent)['items']
                      if w['slug'] == wid)
        self.assertIsNotNone(listed['objective_notice'])

        compact = self.org.work_get(self.agent, wid, compact=True)
        self.assertIsNotNone(compact['objective_notice'])
        self.assertIsNotNone(compact['requested_scope']['objective_notice'],
                             'the compact description group omits the notice')

    def test_s4d_a_later_successful_write_does_not_clear_a_freeze(self) -> None:
        """The rulings lost to a refusal are still lost.

        Relief makes the item writable again; it does not retrieve what was
        never recorded. The notice therefore persists, and says why.
        """
        wid = self.item_at_cap()
        self.age_to_refusing_build(wid)

        self.org.work_update(self.agent, wid, ['recovered'], [],
                             objective='a spec that did land')
        for i in range(5):
            self.org.work_decision(self.agent, wid, f'and more after it {i}')

        notice = self.org.work_get(self.agent, wid)['objective_notice']
        self.assertEqual(notice['kind'], 'incomplete',
                         'the freeze was forgotten by the write that relieved it')
        self.assertIsNotNone(notice['at'],
                             'the moment the freeze was found is not recorded')


class TheDeclarationReachesTheMail(ScopeCapBase):
    """§6 — the mail that HANDS AN ITEM OVER carries the description, so it
    carries the warning about the description.

    This is the surface the reporting organization named: "the next agent to
    pick the item up reads the description first and has no reason to look
    further". That agent's first reading is this mail. An excerpt marker does
    not cover it — that says there is more of this description, not that there
    is scope which is not in the description at all.
    """

    def _assigned_body(self, wid: str) -> str:
        it, _ = self.org._work_get_for(self.agent, wid)
        return events.render_agent(events.mint(
            'docket.assigned', {'kind': 'agent', 'id': 'coordinator'},
            self.org.work_item_ref(it),
            owner='worker', previous_owner=None, assigner='coordinator',
            status=str(it.get('status') or 'open'),
            objective=str(it.get('objective') or ''),
            objective_notice=self.org._work_notice_line(it),
            done_so_far=[], working_on_next=[]))

    def test_s6_a_frozen_item_warns_in_the_assignment_mail(self) -> None:
        wid = self.item_at_cap()
        self.age_to_refusing_build(wid)
        body = self._assigned_body(wid)
        self.assertIn('NOT the complete scope', body)
        # and it is above the description, not appended after it
        self.assertLess(body.index('NOT the complete scope'),
                        body.index('problem, then solution'))

    def test_s6b_a_rolled_over_item_points_at_the_archive_in_mail(self) -> None:
        wid = self.item_at_cap()
        self.org.work_decision(self.agent, wid, 'one past the cap')
        self.assertIn('scope_archive', self._assigned_body(wid))

    def test_s6c_an_ordinary_item_reads_exactly_as_it_always_did(self) -> None:
        """The regression guard on every mail body already frozen elsewhere."""
        it = self.org.work_create(self.agent, 'Ordinary', 'problem, then solution')
        body = self._assigned_body(it['slug'])
        self.assertIn('Description: problem, then solution', body)
        self.assertNotIn('complete scope', body)
        self.assertNotIn('scope_archive', body)

    def test_s6d_the_ledger_actually_supplies_it_on_a_real_assignment(self) -> None:
        """Not just the renderer: the assigning path must pass the value.

        `_assigned_body` above mints the event by hand, which would pass even
        if the ledger never filled the field in. This drives the real
        `work_assign` and reads what landed in the agent's inbox.
        """
        wid = self.item_at_cap()
        self.age_to_refusing_build(wid)
        other = self.hire('taker')
        self.org.work_assign(ledger.USER, wid, other)   # the user may assign anywhere

        bodies = [str(m.get('body') or '') for m in self.org.take_mail(other)]

        self.assertTrue(any('NOT the complete scope' in b for b in bodies),
                        f'the assignment mail did not carry the notice: {bodies}')


class OrdinaryItemsSayNothing(ScopeCapBase):
    """§5 — the notice is absent when the description IS the whole scope."""

    def test_s5_a_fresh_item_has_no_notice(self) -> None:
        it = self.org.work_create(self.agent, 'Ordinary', 'problem, then solution')
        got = self.org.work_get(self.agent, it['slug'])
        self.assertIsNone(got['objective_notice'])
        self.assertEqual(got['scope_archive'], [])

    def test_s5b_an_item_just_under_the_cap_has_no_notice(self) -> None:
        wid = self.item_at_cap(spare=1)
        self.org.work_decision(self.agent, wid, 'the last one that fits')
        got = self.org.work_get(self.agent, wid)
        self.assertEqual(len(got['scope']), self.org.WORK_SCOPE_MAX)
        self.assertEqual(got['scope_archive'], [])
        self.assertIsNone(got['objective_notice'])


if __name__ == '__main__':
    unittest.main()
