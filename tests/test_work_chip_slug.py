"""The desk's "open in the work docket" button must carry a NAME.

User report 2026-09-11: with the docket pinned and nothing selected, pressing
that button on an event filled the detail pane with the ticket's whole record.
The docket was telling the truth — it was handed that text as the name to find
and said it could not find it. The chip was built with `str(result["item"])`,
and `orgtree_work get` answers with the item OBJECT under that key, so the
button asked the docket to open a Python dict repr.

These tests take the result shapes from the REAL tool calls rather than from
fixtures written to match the parser, because the parser's mistake was exactly
an assumption about those shapes.
"""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

_root = tempfile.TemporaryDirectory(prefix='work-chip-slug-')
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name, USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import api, ledger, store, supervisor
assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()

ORG = 'work-chip-slug'


def chips(org, nid, results):
    """Run journal records through the real chat reader and return its chips.

    `results` is a list of (tool name, result body, is_error).
    """
    records = []
    for i, (name, body, failed) in enumerate(results):
        records.extend([
            {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
                {'type': 'tool_use', 'id': str(i), 'name': name,
                 'input': {'action': 'get'}}]}},
            {'type': 'user', 'message': {'role': 'user', 'content': [
                {'type': 'tool_result', 'tool_use_id': str(i), 'is_error': failed,
                 'content': body}]}},
        ])
    out = supervisor._read_chat_source(
        org, nid, hold_back=False, _path=Path(_root.name) / 'fixture.jsonl',
        _lines=[json.dumps(r) + '\n' for r in records], _prompt_views={})
    return [t for m in out['messages'] for t in m.get('tools', [])]


class WorkChipSlugTests(unittest.TestCase):
    made = 0

    def setUp(self):
        # an org of its own per test: they mutate the item they read back
        WorkChipSlugTests.made += 1
        self.org_slug = f'{ORG}-{WorkChipSlugTests.made}'
        self.org = store.create_org(self.org_slug)
        self.org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        self.nid = 'worker'
        self.org.work_create(ledger.USER, 'Ship the thing',
                             objective='A problem, then a plan.', owner=self.nid)
        self.slug = self.org.d['work_items'][-1]['slug']
        store.save_org(self.org)

    def tearDown(self):
        store._POOL.close_all(self.org_slug)

    def call(self, action, **args):
        """One real `orgtree_work` call, returning what the agent would see."""
        body = api.AgentCall(org=self.org_slug, node=self.nid, tool='orgtree_work',
                             args={'action': action, 'slug': self.slug, **args})
        a = dict(body.args)
        if action in ('list', 'get', 'verify'):
            return api._work_read_call(body, a)
        org = store.load_org(self.org_slug)
        r = api._work_mutate(org, self.nid, a)
        store.save_org(org)
        self.org = store.load_org(self.org_slug)
        return r

    def test_the_result_shapes_the_chip_reads_are_not_one_shape(self):
        """THE MISTAKE, stated as a fact about the API rather than a guess."""
        mutation = self.call('update', done_so_far=['a step'], working_on_next=[])
        self.assertIsInstance(mutation['item'], str)
        self.assertEqual(mutation['item'], self.slug)

        read = self.call('get')
        # a MAPPING under the same key — this is what str() turned into prose
        self.assertIsInstance(read['item'], dict)
        self.assertEqual(read['item']['slug'], self.slug)

        listing = self.call('list')
        self.assertNotIn('item', listing, 'a listing has no single item')

    def test_the_button_carries_the_name_whichever_shape_answered(self):
        mutation = json.dumps(self.call('update', done_so_far=['a step'],
                                        working_on_next=[]))
        read = json.dumps(self.call('get'))
        got = chips(self.org, self.nid, [
            ('mcp__orgtree__orgtree_work', mutation, False),
            # the unprefixed name is how the codex and antigravity lanes
            # journal the same call — one parser serves every provider
            ('orgtree_work', read, False),
        ])
        self.assertEqual([t.get('work') for t in got],
                         [{'slug': self.slug}, {'slug': self.slug}])
        for t in got:
            self.assertNotIn('{', t['work']['slug'],
                             'a record was stringified into the name again')

    def test_a_shape_with_no_name_in_it_gets_no_button(self):
        """⚠ THE CONTROL. Silence is the only honest answer here: a button
        that opens nothing is worse than no button, and it is what put a
        record on the reader's screen."""
        bodies = [
            json.dumps({'item': {'rev': 3, 'title': 'no slug in here'}}),
            json.dumps({'item': {'slug': '   '}}),
            json.dumps({'item': 7}),
            json.dumps({'item': ['a-list']}),
            json.dumps({'item': None}),
            json.dumps({'item': ''}),
            json.dumps({'items': [{'slug': 'a-listing'}]}),
            'not json at all',
        ]
        got = chips(self.org, self.nid,
                    [('orgtree_work', b, False) for b in bodies])
        self.assertEqual(len(got), len(bodies), 'the chips themselves must survive')
        self.assertEqual([t for t in got if 'work' in t], [])

    def test_a_failed_call_still_offers_nothing_to_open(self):
        body = json.dumps({'item': self.slug})
        got = chips(self.org, self.nid, [
            ('orgtree_work', body, True),
            ('some_other_tool', body, False),
        ])
        self.assertEqual([t for t in got if 'work' in t], [])
        # POSITIVE CONTROL: the same body on a successful orgtree_work call
        # DOES produce the button, so the two assertions above are about the
        # error and the tool name rather than about an unreadable body
        ok = chips(self.org, self.nid, [('orgtree_work', body, False)])
        self.assertEqual([t.get('work') for t in ok], [{'slug': self.slug}])


if __name__ == '__main__':
    unittest.main()
