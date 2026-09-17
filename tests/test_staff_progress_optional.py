"""Staffing an existing ticket is itself the readable update.

`orgtree_staff` action='update' was refusing an otherwise complete hire +
assignment whenever the caller omitted both progress lists — the generic
"both empty says nothing the user can read" rule, applied to a call whose
substantive content is the handover. These tests pin the fix and, just as
importantly, everything the fix must NOT change: explicit lists still replace,
a standalone `orgtree_work update` still has to say something, and the whole
staffing is still one transaction that either lands or leaves nothing.

Everything runs through the real doors — `api.agent_call` for the composite,
`ledger.Org` for the ledger rule — on isolated fixture data.
"""
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

# ⚠ the real installation must never be touched: this suite hires through the
# real dispatch, so it writes scratch folders and org documents
FX = tempfile.mkdtemp(prefix='staff-progress-')
os.environ['ORGTREE_DATA'] = str(Path(FX) / 'data')
os.environ['HOME'] = str(Path(FX) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'staff-progress-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import api, ledger, mcptool, store, supervisor          # noqa: E402
from starlette.requests import Request                               # noqa: E402

assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

#: the no-defaults hire rule wants every switch stated; none is the subject here
NO_TOOLS = {'bash': False, 'web': False, 'edit': False, 'subagents': False,
            'mcp': []}
#: the exact shape the coordinator's staffing batch was refused on: an existing
#: slug, a status, a full hire configuration, and NO progress arguments
SEAT = {'tier': 'haiku', 'charter': 'do the assigned work', 'add_dirs': [],
        'tools': NO_TOOLS, 'org_visibility': 'self'}
slugs = []


def tearDownModule():
    for s in slugs:
        store._POOL.close_all(s)


class StaffProgressOptional(unittest.TestCase):
    def setUp(self):
        self.slug = 'staffprog-' + uuid.uuid4().hex[:8]
        slugs.append(self.slug)
        self.org = store.create_org(self.slug)
        self.org.hire(ledger.USER, None, 'opus', 20, 'manager',
                      add_dirs=[], tools={}, charter='fixture')
        store.save_org(self.org)
        # ⚠ NEITHER GATE IS THE SUBJECT. The provider gate refuses a hire on a
        # machine with no CLI signed in — every fixture is one — and it fires
        # before anything measured here. The drive would spawn that CLI in a
        # background thread long after the assertion it belongs to has passed.
        for mod, name in ((api, 'provider_hire_gate'),):
            p = patch.object(mod, name, lambda *a, **k: None)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(supervisor, 'send_message', lambda *a, **k: {})
        p.start()
        self.addCleanup(p.stop)

    # ---- doors ---------------------------------------------------------
    def call(self, tool, actor='manager', **args):
        """One real agent tool call, through the door a live agent lands on."""
        body = api.AgentCall(org=self.slug, node=actor, tool=tool, args=args)
        out = api.agent_call(body, Request({'type': 'http', 'headers': []}))
        self.org = store.load_org(self.slug)
        return out

    def item(self, title='Existing ticket', **kw):
        org = store.load_org(self.slug)
        created = org.work_create('manager', title,
                                  'the problem, then the solution', **kw)
        store.save_org(org)
        return str(created['slug'])

    def read(self, wid):
        return store.load_org(self.slug).work_get('manager', wid)

    def staff(self, wid, name, **extra):
        return self.call('orgtree_staff', action='update', slug=wid,
                         name=name, **{**SEAT, **extra})

    # ── §1 the exact refused call now succeeds, and preserves ────────────
    def test_s1_staffing_without_progress_succeeds_and_preserves(self):
        """THE REGRESSION. action=update, existing slug, status in_progress,
        a hire configuration, and no progress fields — the shape every one of
        the coordinator's ten staffing calls was refused on."""
        wid = self.item(done_so_far=['found the bug'],
                        working_on_next=['fix it'])

        out = self.staff(wid, 'implementer', status='in_progress')

        self.assertEqual(out['updated'], wid)
        self.assertEqual(out['assigned_to'], out['node'])
        after = self.read(wid)
        self.assertEqual(after['status'], 'in_progress')
        self.assertEqual(after['owner']['node'], out['node'])
        # PRESERVED, not cleared and not rewritten
        self.assertEqual(after['done_so_far'], ['found the bug'])
        self.assertEqual(after['working_on_next'], ['fix it'])
        # nothing was generated: there was something to carry forward
        self.assertIsNone(out.get('staffing_boundary'))

    def test_s1b_preservation_needs_no_status_either(self):
        """The status is not what makes it legal — the staffing is."""
        wid = self.item(done_so_far=['scoped it'])

        out = self.staff(wid, 'worker')

        after = self.read(wid)
        self.assertEqual(after['done_so_far'], ['scoped it'])
        self.assertEqual(after['owner']['node'], out['node'])

    # ── §2 an empty item gets a readable boundary, not a refusal ─────────
    def test_s2_empty_summaries_generate_a_staffing_boundary(self):
        wid = self.item('Untouched ticket')
        self.assertEqual(self.read(wid)['done_so_far'], [])
        self.assertEqual(self.read(wid)['working_on_next'], [])

        out = self.staff(wid, 'starter', status='in_progress')

        after = self.read(wid)
        generated = ledger.Org.STAFFING_BOUNDARY.format(node=out['node'])
        self.assertEqual(after['working_on_next'], [generated])
        self.assertEqual(after['done_so_far'], [])
        # it SAYS what happened and who acts next — that is its whole job
        self.assertIn('Staffed', generated)
        self.assertIn(out['node'], generated)
        # and the caller is told the words came from the backend, not from it
        self.assertEqual(out['staffing_boundary'], generated)

    def test_s2b_the_generated_line_is_an_ordinary_entry_afterwards(self):
        """Nothing downstream treats it specially: the owner's own next update
        replaces it exactly as it would replace anything the caller wrote."""
        wid = self.item('Untouched ticket')
        out = self.staff(wid, 'starter')
        nid = str(out['node'])

        org = store.load_org(self.slug)
        org.work_update(nid, wid, ['did the thing'], ['ship it'])
        store.save_org(org)

        self.assertEqual(self.read(wid)['working_on_next'], ['ship it'])

    # ── §3 explicit fields keep ordinary replacement semantics ──────────
    def test_s3_explicit_progress_replaces_as_it_always_did(self):
        wid = self.item(done_so_far=['old done'], working_on_next=['old next'])

        out = self.staff(wid, 'replacer', done_so_far=['new done'],
                         working_on_next=['new next'])

        after = self.read(wid)
        self.assertEqual(after['done_so_far'], ['new done'])
        self.assertEqual(after['working_on_next'], ['new next'])
        self.assertIsNone(out.get('staffing_boundary'))

    def test_s3b_one_supplied_list_still_clears_the_other(self):
        """⚠ THE DELIBERATE EDGE. Preservation is for a call that states NO
        progress at all. A staffing that states one of the two is stating the
        complete summary, exactly as every other update does — otherwise the
        same arguments would mean different things on orgtree_staff and on
        orgtree_work, which is worse than the boilerplate this removed."""
        wid = self.item(done_so_far=['old done'], working_on_next=['old next'])

        self.staff(wid, 'partial', working_on_next=['only this'])

        after = self.read(wid)
        self.assertEqual(after['working_on_next'], ['only this'])
        self.assertEqual(after['done_so_far'], [])

    def test_s3c_explicitly_empty_pair_is_still_refused(self):
        """Sending `[]` is an explicit clear, not an omission, and clearing an
        item to say nothing is exactly what the rule exists to stop."""
        wid = self.item(done_so_far=['old done'])

        with self.assertRaises(Exception) as ctx:
            self.staff(wid, 'clearer', done_so_far=[], working_on_next=[])

        self.assertIn('at least one entry', str(getattr(ctx.exception, 'detail',
                                                        ctx.exception)))
        self.assertEqual(self.read(wid)['done_so_far'], ['old done'])

    # ── §4 the standalone rule ──────────────────────────────────────────
    def test_s4_standalone_work_update_preserves_on_status_only(self):
        wid = self.item(done_so_far=['something'], working_on_next=['next step'])

        out = self.call('orgtree_work', action='update', slug=wid,
                        status='in_progress')

        self.assertEqual(out['updated'], wid)
        self.assertEqual(self.read(wid)['status'], 'in_progress')
        self.assertEqual(self.read(wid)['done_so_far'], ['something'])
        self.assertEqual(self.read(wid)['working_on_next'], ['next step'])

        # but an update that changes no state and sends no progress still has to say something
        with self.assertRaises(Exception) as ctx:
            self.call('orgtree_work', action='update', slug=wid)

        self.assertIn('nothing the user can read',
                      str(getattr(ctx.exception, 'detail', ctx.exception)))

    def test_s4b_the_ledger_kwarg_is_unreachable_from_orgtree_work(self):
        """`staffed_to` is not a caller argument. orgtree_work's dispatch names
        every parameter it forwards, and a client that puts the name in its
        args is REFUSED rather than obeyed.

        ⚠ IT USED TO BE REFUSED BY ACCIDENT, and the accident is what this
        assertion originally read. The name was dropped on the floor, so the
        call arrived at the ledger as an update carrying no progress at all and
        died on the both-empty rule — a refusal that never mentioned the
        argument the client actually sent. Since the acceptance-field fix
        (2026-09-17), `update` refuses any argument it does not consume and
        names it: the bypass is still unreachable, and now the client is told
        which of its arguments was the problem instead of being pointed at a
        rule it did not break."""
        wid = self.item(done_so_far=['something'])

        with self.assertRaises(Exception) as ctx:
            self.call('orgtree_work', action='update', slug=wid,
                      staffed_to='manager')

        msg = str(getattr(ctx.exception, 'detail', ctx.exception))
        self.assertIn('staffed_to', msg)
        self.assertIn('does not write', msg)
        self.assertIn('NOTHING WAS WRITTEN', msg)
        # and the item is untouched: the staffing bypass bought nothing
        self.assertEqual(self.read(wid)['done_so_far'], ['something'])
        self.assertNotIn('staffed_to',
                         mcptool_schema('orgtree_work'))
        self.assertNotIn('staffed_to', mcptool_schema('orgtree_staff'))

    # ── §5 rehire, and the states that must keep behaving ───────────────
    def test_s5_rehire_staffing_preserves_the_same_way(self):
        wid = self.item(done_so_far=['half done'], working_on_next=['finish'])
        org = store.load_org(self.slug)
        org.hire('manager', 'manager', 'haiku', 0, 'veteran',
                 add_dirs=[], tools=NO_TOOLS, org_visibility='self',
                 charter='fixture')
        org.retire('manager', 'veteran')
        store.save_org(org)

        out = self.call('orgtree_staff', action='update', slug=wid,
                        node='veteran', staff_mode='rehire',
                        status='in_progress')

        self.assertEqual(out['assigned_to'], 'veteran')
        after = self.read(wid)
        self.assertEqual(after['owner']['node'], 'veteran')
        self.assertEqual(after['done_so_far'], ['half done'])
        self.assertEqual(after['working_on_next'], ['finish'])

    def test_s5b_rehire_of_an_empty_item_generates_the_boundary(self):
        wid = self.item('Fresh ticket')
        org = store.load_org(self.slug)
        org.hire('manager', 'manager', 'haiku', 0, 'veteran2',
                 add_dirs=[], tools=NO_TOOLS, org_visibility='self',
                 charter='fixture')
        org.retire('manager', 'veteran2')
        store.save_org(org)

        out = self.call('orgtree_staff', action='update', slug=wid,
                        node='veteran2', staff_mode='rehire')

        self.assertEqual(
            self.read(wid)['working_on_next'],
            [ledger.Org.STAFFING_BOUNDARY.format(node='veteran2')])
        self.assertEqual(out['staffing_boundary'],
                         ledger.Org.STAFFING_BOUNDARY.format(node='veteran2'))

    def test_s5c_backlogged_is_opened_by_the_staffing_as_before(self):
        """Assignment starts a backlogged item; preservation must not have
        moved that transition."""
        wid = self.item('Unstarted', status='backlogged')

        out = self.staff(wid, 'opener')

        after = self.read(wid)
        self.assertEqual(after['status'], 'open')
        self.assertEqual(after['owner']['node'], out['node'])
        # and the boundary was written, because a backlogged item has nothing
        # stored to carry forward
        self.assertEqual(
            after['working_on_next'],
            [ledger.Org.STAFFING_BOUNDARY.format(node=out['node'])])

    def test_s5d_review_status_still_requires_its_reviewer(self):
        """A staffing cannot smuggle an item into review without naming who
        checks it — the transition's own rule, untouched."""
        wid = self.item(done_so_far=['built it'])

        with self.assertRaises(Exception) as ctx:
            self.staff(wid, 'reviewee', status='review')

        self.assertIn('review', str(getattr(ctx.exception, 'detail',
                                            ctx.exception)).lower())
        self.assertEqual(self.read(wid)['status'], 'open')

    # ── §6 atomicity: a refusal leaves no seat, no owner, no progress ────
    def test_s6_item_refusal_rolls_back_the_seat(self):
        """The item write happens AFTER the seat is created. A refusal there
        must leave no hire behind — the seat, the assignment, the progress
        mutation and the mail are one transaction."""
        wid = self.item(done_so_far=['built it'])
        before = set(store.load_org(self.slug).d['nodes'])

        with self.assertRaises(Exception):
            # `review` without a reviewer refuses inside work_update, i.e.
            # strictly after _hire_seat has already made the seat
            self.staff(wid, 'ghost', status='review')

        org = store.load_org(self.slug)
        self.assertEqual(set(org.d['nodes']), before)
        # ⚠ NOT IN `nodes` AT ALL, which is the assertion that means something:
        # a retired agent is not removed from `nodes`, it stays there with
        # state='archived'. So "the seat was rolled back" is exactly "the key
        # is absent", and a rolled-back hire must not be sitting archived
        # either.
        self.assertNotIn('ghost', org.d['nodes'])
        after = self.read(wid)
        self.assertEqual(after['done_so_far'], ['built it'])
        self.assertEqual(after['owner']['node'], 'manager')

    def test_s6b_unknown_item_refuses_before_any_seat_exists(self):
        before = set(store.load_org(self.slug).d['nodes'])

        with self.assertRaises(Exception):
            self.staff('no-such-ticket', 'phantom')

        self.assertEqual(set(store.load_org(self.slug).d['nodes']), before)

    def test_s6c_a_seat_refusal_leaves_the_item_exactly_as_it_was(self):
        """The mirror case: the seat half refuses, so the item is never
        touched — no owner change, no progress mutation, no status move."""
        wid = self.item(done_so_far=['built it'], working_on_next=['land it'])

        with self.assertRaises(Exception):
            # a hire with no charter is refused by the seat helper
            self.call('orgtree_staff', action='update', slug=wid,
                      name='charterless', tier='haiku', add_dirs=[],
                      tools=NO_TOOLS, org_visibility='self',
                      status='in_progress')

        after = self.read(wid)
        self.assertEqual(after['status'], 'open')
        self.assertEqual(after['owner']['node'], 'manager')
        self.assertEqual(after['done_so_far'], ['built it'])
        self.assertEqual(after['working_on_next'], ['land it'])
        self.assertNotIn('charterless', store.load_org(self.slug).d['nodes'])

    def test_s6d_a_rehire_refusal_puts_the_archived_seat_back(self):
        """⚠ THE HARDER HALF OF ROLLBACK, and the one the tests above do not
        reach. On a HIRE, "leave nothing behind" means a seat was never made.
        On a REHIRE it means an agent that was ALREADY THERE, archived, must
        end up archived again with its record intact — a restore rather than
        an absence, on a different code path. (Raised by quick-staff's
        independent review probe; my own §6 only refused on fresh hires.)"""
        wid = self.item(done_so_far=['half done'], working_on_next=['finish'])
        org = store.load_org(self.slug)
        org.hire('manager', 'manager', 'haiku', 0, 'comeback',
                 add_dirs=[], tools=NO_TOOLS, org_visibility='self',
                 charter='fixture')
        org.retire('manager', 'comeback')
        store.save_org(org)
        before = store.load_org(self.slug)
        # a retired agent stays in `nodes` carrying state='archived' — there is
        # no separate archive table, so "still archived" is a state assertion
        self.assertEqual(before.d['nodes']['comeback']['state'], 'archived')
        record_before = dict(before.d['nodes']['comeback'])
        keys_before = set(before.d['nodes'])

        with self.assertRaises(Exception):
            # refuses inside work_update — strictly AFTER _rehire_seat has
            # already brought the agent back out of the archive
            self.call('orgtree_staff', action='update', slug=wid,
                      node='comeback', staff_mode='rehire', status='review')

        org = store.load_org(self.slug)
        # archived again, not left live and not destroyed
        self.assertEqual(org.d['nodes']['comeback']['state'], 'archived')
        self.assertEqual(set(org.d['nodes']), keys_before)
        # and its stored record is the one it had, field for field — a restore,
        # not a rebuilt stub that merely happens to be archived
        self.assertEqual(dict(org.d['nodes']['comeback']), record_before)
        # the item never moved either
        after = self.read(wid)
        self.assertEqual(after['status'], 'open')
        self.assertEqual(after['owner']['node'], 'manager')
        self.assertEqual(after['done_so_far'], ['half done'])
        self.assertEqual(after['working_on_next'], ['finish'])

    def test_s6e_a_refused_rehire_that_renamed_says_the_rename_stuck(self):
        """⚠ THE ONE DOCUMENTED EXCEPTION TO ALL-OR-NOTHING, pinned here so it
        stays documented rather than becoming a surprise. A rehire's RENAME
        runs before the transaction and outside it, so a later refusal cannot
        undo it. api.agent_call does not hide that: it says so and names the
        id to retry against, instead of letting the caller retry under a name
        that no longer exists. Nothing ELSE is applied, and the seat is still
        archived."""
        wid = self.item(done_so_far=['half done'])
        org = store.load_org(self.slug)
        org.hire('manager', 'manager', 'haiku', 0, 'oldname',
                 add_dirs=[], tools=NO_TOOLS, org_visibility='self',
                 charter='fixture')
        org.retire('manager', 'oldname')
        store.save_org(org)

        with self.assertRaises(Exception) as ctx:
            self.call('orgtree_staff', action='update', slug=wid,
                      node='oldname', staff_mode='rehire', name='newname',
                      status='review')

        detail = str(getattr(ctx.exception, 'detail', ctx.exception))
        self.assertIn('RENAME', detail)
        self.assertIn('newname', detail)
        org = store.load_org(self.slug)
        # renamed, still archived, and NOT started
        self.assertIn('newname', org.d['nodes'])
        self.assertEqual(org.d['nodes']['newname']['state'], 'archived')
        self.assertNotIn('oldname', org.d['nodes'])
        # and the item is untouched, which is the part that matters here
        after = self.read(wid)
        self.assertEqual(after['status'], 'open')
        self.assertEqual(after['owner']['node'], 'manager')
        self.assertEqual(after['done_so_far'], ['half done'])

    # ── §7 the guidance says so ─────────────────────────────────────────
    def test_s7_the_tool_card_tells_callers_progress_is_optional(self):
        card = next(t for t in mcptool.TOOLS
                    if t['name'] == 'orgtree_staff')['description']
        self.assertIn('OPTIONAL HERE', card)
        self.assertIn('PRESERVED', card)
        self.assertIn('REPLACE', card)
        # and it must not leave the standalone rule ambiguous
        self.assertIn('orgtree_work update still has to', card)

    def test_s7b_the_two_properties_say_it_too(self):
        props = mcptool_schema('orgtree_staff')
        for field in ('done_so_far', 'working_on_next'):
            with self.subTest(field=field):
                self.assertIn('OPTIONAL', props[field]['description'].upper())
                self.assertIn('preserve', props[field]['description'].lower())


def mcptool_schema(tool):
    return next(t for t in mcptool.TOOLS
                if t['name'] == tool)['inputSchema']['properties']


if __name__ == '__main__':
    unittest.main()
