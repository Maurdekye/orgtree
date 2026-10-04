"""The section mappers of the one-database-per-org layout (design §5.2 step 3).

No database: encode_document -> decode_document in memory. test_orgdb_mappers_pg.py repeats
it through a real org database.

What it proves:
  * completeness: the sections own exactly the engine's registered keys (NODE_KEYED_SECTIONS
    plus the two legacy-only keys) minus IGNORED_LEGACY_KEYS, but for the kept `sandbox`, and
    no key twice;
  * frozen org migration 0002_document.sql matches the original mapper layout,
    and the runtime mapper layout matches the schema after all later migrations;
  * a synthetic document exercising every section kind round-trips exactly as canonical JSON,
    with its top-level key order: settings (present, absent, null), nodes with parent,
    predecessor and successor names (one naming no node: a tombstone), shared tool lists,
    by-agent lists with an orphan key, an empty list and a null owner value, by-agent maps,
    maps of records and of scalars, string lists, both docket lists with nested children,
    a null container, an empty container, and an unregistered key (org_extra);
  * the removed features' keys (kiosk, spend freeze, disk...) are not converted and are
    reported when they hold a value; `sandbox` is converted exactly (the former-sandbox
    catch-up reads it after the upgrade);
  * unforeseen shapes raise ShapeError: a list section that is not a list, a record that is
    not an object, a node id twice.

Run:  python tools/run-python-verification.py tests/test_orgdb_mappers.py
"""

import copy
import json
from pathlib import Path
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger
from orgtree.orgdb import codec, mappers, sections

MIGRATION = (Path(__file__).resolve().parent.parent / 'engine' / 'backend' / 'orgtree'
             / 'pg_migrations' / 'org' / '0002_document.sql')


def canon(v):
    return json.dumps(v, sort_keys=True)


def node(**kw):
    base = {'session_id': 's', 'seat_id': 'seat', 'model': 'm', 'parent': None, 'grant': 5,
            'state': 'live', 'title': 't', 'charter': None, 'created': '2026-10-02T10:00:00.000Z',
            'archived_at': None, 'ui_order': 1.0, 'generation': 0, 'lineage': 'l',
            'scope': {'permission_mode': 'p', 'add_dirs': [{'path': 'x', 'mode': 'rw'}],
                      'tools': {'bash': True, 'mcp': ['a', 'b']}},
            'turns': [{'n': 1, 'at': '2026-10-02T10:00:00.000Z', 'cost': 0.5, 'route': {'r': 1}}],
            'frozen': None}
    base.update(kw)
    return base


def document():
    tools = ['orgtree_message', 'orgtree_work']
    return {
        'version': 3, 'slug': 'acme', 'name': 'Acme', 'created': '2026-01-01T00:00:00Z',
        'killswitch': None, 'tiers': {'opus': 15, 'haiku': 0.25}, 'models': {'opus': 'o-5'},
        'kiosk': {'token': 'old'}, 'spend_frozen': None, 'disk': {'quota_gb': 5},
        'sandbox': {'enabled': True, 'image': 'orgtree/agent'},
        'nodes': {
            'boss': node(last_turn_mcp_tools=tools, mailbox_id='mb1', mail_seq=3, halt={},
                         inflight=False),
            'x': node(parent='boss', successor='x@0', last_turn_mcp_tools=list(tools),
                      frozen={'until': 1}, charter='do it', team_charter=None,
                      halt_queue=[{'_halt_id': 'h', 'toks': ['t1'], 'mail_ids': [], 'at': 1.5}]),
            'x@0': node(parent='gone-boss', predecessor='x', state='archived',
                        archived_at='2026-10-01T00:00:00.000Z', generation=1,
                        mail_drain={'ids': ['m1'], 'failures': 0}, surprise_field=[1]),
        },
        'mail': {'boss': [{'id': 'm1', 'from': 'x', 'body': 'hi', 'at': '2026-10-02T10:00:00.000Z'}],
                 'x': [], 'x#orphan-abc123def456': [{'id': 'm2', 'body': 'old'}], 'x@0': None},
        'steer_attempts': {'x': {'d1': {'at': '2026-10-02T10:00:00.000Z', 'toks': ['a']},
                                 'd2': {}}},
        'turn_log': {'x': [{'n': 1, 'cost': 1.5, 'ms': None}]},
        '_migrations': {'heal_a': {'at': '2026-09-01T00:00:00.000Z', 'healed': ['x']}},
        'work_items': [{'slug': 'a-thing', 'owner': {'node': 'x', 'generation': 0, 'born': 'b'},
                        'history': [{'at': '2026-10-02T10:00:00.000Z', 'op': 'create',
                                     'by': {'node': 'boss'}, 'from': None}],
                        'acceptance': [{'text': 'works', 'check_history': [{'result': 'passed'}]}],
                        'findings': [{'id': 'f1', 'decisions': [{'note': 'n'}]}],
                        'participants': ['boss']}],
        'work_items_archive': [{'slug': 'old-thing', 'archived_at': '2026-09-01T00:00:00.000Z'}],
        'work_deleted_names': ['gone-thing'],
        'events': [{'op': 'hire', 'actor': 'boss', 'detail': {'k': [1, None]}}],
        'asks': [],
        'audiences': None,
        'hand_edited_default': {'anything': True},
        'auto_resume': True,
    }


def round_trip(doc):
    rows, ctx, report = sections.encode_document(doc, mappers.sections(),
                                                 ignored=mappers.ignored_keys())
    back = sections.decode_document(rows, mappers.sections(), sections.Context())
    return back, rows, ctx, report


class Completeness(unittest.TestCase):
    def test_sections_own_exactly_the_registered_keys(self):
        owned = [k for s in mappers.sections() for k in s.keys]
        self.assertEqual(len(owned), len(set(owned)))
        self.assertEqual(set(owned), mappers.registered_keys())
        self.assertTrue(set(mappers.ignored_keys()).isdisjoint(owned))
        self.assertIn('sandbox', owned)                              # kept (KEPT_LEGACY)
        self.assertEqual(set(mappers.ignored_keys()) | set(mappers.KEPT_LEGACY),
                         set(ledger.IGNORED_LEGACY_KEYS))

    def test_migration_is_the_generated_schema(self):
        text = MIGRATION.read_text(encoding='utf-8')
        body = '\n'.join(l for l in text.splitlines() if not l.startswith('--')).strip()
        want = '\n\n'.join(s.rstrip(';') + ';' for s in mappers.ddl())
        self.assertEqual(body, want, 'regenerate 0002_document.sql from mappers.ddl()')

    def test_current_mapper_columns_equal_their_final_migrated_types(self):
        from test_orgdb_verify_static import schema, _TYPES
        have = schema()
        wrong = []
        for section in mappers.sections():
            for root in section.tables:
                for table, entry in root.layout().items():
                    columns = entry['keys'] + entry['columns']
                    if entry['extra']:
                        columns += (('extra', 'json'),)
                    for column, kind in columns:
                        expected = _TYPES.get(kind, kind)
                        actual = have.get(table, {}).get(column)
                        if actual != expected:
                            wrong.append((table, column, expected, actual))
        self.assertEqual(wrong, [])


class RoundTrip(unittest.TestCase):
    def test_every_section_kind(self):
        doc = document()
        back, rows, ctx, report = round_trip(copy.deepcopy(doc))
        want = {k: v for k, v in doc.items() if k not in mappers.ignored_keys()}
        self.assertEqual(canon(back), canon(want))
        self.assertEqual(list(back), list(want))                     # key order kept
        self.assertEqual(sorted(ctx.tombstones), ['gone-boss', 'x#orphan-abc123def456'])
        self.assertEqual(report['ignored'], {'kiosk': True, 'spend_frozen': False, 'disk': True})
        self.assertEqual(back['sandbox'], doc['sandbox'])
        self.assertEqual(report['extra_keys'], ['hand_edited_default'])
        self.assertEqual(len(rows['tool_lists']), 1)                 # one shared list
        # A stale current role may name an identity-specific tombstone beside
        # a live namesake. Structural references still use the ordinary node.
        agents = {r['name']: r for r in reversed(rows['agents'])}
        self.assertEqual(agents['x']['parent_id'], agents['boss']['id'])
        self.assertEqual(agents['x@0']['parent_id'], agents['gone-boss']['id'])
        self.assertTrue(agents['gone-boss']['tombstone'])
        self.assertTrue(agents['x']['is_frozen'])
        # present but empty is not set: the engine reads these fields by truthiness
        self.assertEqual((agents['boss']['is_halted'], agents['boss']['is_inflight'],
                          agents['boss']['is_frozen']), (False, False, False))
        self.assertIsNotNone(agents['x@0']['extra'])                 # surprise_field, exact
        sect = {r['key']: r['state'] for r in rows['org_sections']}
        self.assertEqual((sect['audiences'], sect['asks'], sect['killswitch']), ('n', 'v', 'v'))
        owners = {(r['section'], r['agent_id']): r['state'] for r in rows['org_section_owners']}
        self.assertEqual(owners[('mail', agents['x@0']['id'])], 'n')
        self.assertEqual(owners[('mail', agents['x']['id'])], 'l')

    def test_minimal_and_empty_documents(self):
        for doc in ({}, {'nodes': {}}, {'slug': 'only'}, {'mail': {}}, {'nodes': None}):
            with self.subTest(doc=doc):
                back = round_trip(copy.deepcopy(doc))[0]
                self.assertEqual(canon(back), canon(doc))
                self.assertEqual(list(back), list(doc))

    def test_unforeseen_shapes_refuse(self):
        for doc in ({'asks': {'not': 'a list'}}, {'asks': ['not an object']},
                    {'nodes': {'a': 'not an object'}}, {'mail': ['a list']},
                    {'mail': {'a': [1]}}, {'steer_attempts': {'a': {'k': 'not an object'}}},
                    {'work_items': [None]}, {'tiers': ['a list']},
                    {'work_deleted_names': [1]}, {'unregistered': float('nan')}):
            with self.subTest(doc=doc), self.assertRaises(codec.ShapeError):
                round_trip(doc)


class WatchdogSilence(unittest.TestCase):
    """watchdog-sol's silence alarms (watchdog_config): fire_mode, quiet_period_s and
    silence_since convert into typed columns, sparse as the engine writes them."""

    T = '2026-10-02T10:00:00.000Z'               # ledger.now()'s canonical text

    def document(self):
        from orgtree import watchdog_config
        silence = {'id': 'w2', 'owner': 'x', 'name': 'quiet', 'kind': 'activity', 'target': 'x',
                   'interval_s': 60, 'state': 'armed', 'at': self.T,
                   **watchdog_config.settings('silence', 600, self.T)}
        event = {'id': 'w1', 'owner': 'x', 'name': 'logs', 'kind': 'file', 'target': 'a.log',
                 'interval_s': 60, 'state': 'armed', 'at': self.T,
                 **watchdog_config.settings(None, None, self.T)}
        tomb = {'id': 'w3', 'owner': 'x', 'name': 'once', 'kind': 'file', 'target': 'b.log',
                'interval_s': 60, 'at': self.T, **watchdog_config.projection(event),
                'spent_at': self.T, 'fired': 1}
        superseded = {'id': 'w4', 'owner': 'x', 'name': 'wait', 'kind': 'activity', 'target': 'x',
                      'interval_s': 60, 'at': self.T, **watchdog_config.projection(silence),
                      'spent_at': self.T, 'state': 'superseded', 'superseded_by': 'boss',
                      'reason': 'obsolete', 'once': True}
        return {'nodes': {'x': node()}, 'watchdogs': [event, silence],
                'watchdog_tombs': [tomb, superseded], 'watchdog_history': []}

    def test_the_fields_are_typed_columns_and_round_trip_exactly(self):
        doc = self.document()
        self.assertNotIn('fire_mode', doc['watchdogs'][0])        # event mode writes nothing
        self.assertEqual(doc['watchdog_tombs'][0]['fire_mode'], 'event')   # a tomb says so
        back, rows, _, _ = round_trip(copy.deepcopy(doc))
        self.assertEqual(canon(back), canon(doc))
        dogs = {r['public_id']: r for r in rows['watchdogs']}
        tombs = {r['public_id']: r for r in rows['watchdog_tombs']}
        for r in [*dogs.values(), *tombs.values()]:
            self.assertIsNone(r.get('extra'), r['public_id'])     # nothing left untyped
        self.assertEqual((dogs['w2']['fire_mode'], dogs['w2']['quiet_period_s']), ('silence', 600))
        self.assertEqual(dogs['w2']['silence_since'], codec.parse_ts(self.T))
        self.assertIsNone(dogs['w2'].get('silence_since_text'))  # canonical: no text kept
        self.assertEqual([dogs['w1'].get(c) for c in ('fire_mode', 'quiet_period_s', 'silence_since')],
                         [None, None, None])
        self.assertEqual((tombs['w3']['fire_mode'], tombs['w3'].get('quiet_period_s')), ('event', None))
        self.assertEqual((tombs['w4']['fire_mode'], tombs['w4']['quiet_period_s'],
                          tombs['w4']['state'], tombs['w4']['once']), ('silence', 600, 'superseded', True))

    def test_a_non_canonical_stamp_keeps_its_text(self):
        doc = self.document()
        doc['watchdogs'][1]['silence_since'] = '2026-10-02T10:00:00Z'
        back, rows, _, _ = round_trip(copy.deepcopy(doc))
        self.assertEqual(canon(back), canon(doc))
        dog = next(r for r in rows['watchdogs'] if r['public_id'] == 'w2')
        self.assertEqual(dog['silence_since_text'], '2026-10-02T10:00:00Z')


if __name__ == '__main__':
    unittest.main()
