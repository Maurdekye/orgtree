"""Org enum coverage, exact legacy preservation and record-named conversion reports."""

import json
from pathlib import Path
import re
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree.orgdb import codec, enums, mappers, sections
from orgtree.orgdb.convert.accounts import ACCOUNT, ORG_ACCOUNT, ORG_MARK, ORG_AUDIT, OrgAccounts
from orgtree.orgdb.mappers import agents, docket
from orgtree import ledger, opreceipts, registry, workevidence, workitems

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'engine/backend/orgtree/pg_migrations/org/0009_enum_checks.sql'


def entries(include_markers=False):
    return list(enums.columns(mappers.sections() + [OrgAccounts()], include_markers=include_markers))


def record(path, value):
    out = value
    for key in reversed(path):
        out = {key: out}
    return out


def encoded(entry, value):
    source = record(entry['path'], value)
    keys = {key: 1 for key in entry['keys']}
    out = {}
    codec.encode(entry['spec'], source, keys, out)
    row = out[entry['table']][0]
    decoded = codec.decode(entry['spec'], row, None, tuple(keys.values()))
    return source, row, decoded, out


def sample(spec, bad=False):
    """A record covering nested enum fields and every child record table."""
    out = {}
    for field in spec.fields:
        if field.values:
            out[field.key] = 'zz-out-of-set' if bad else field.values[0]
        elif field.kind == 'obj':
            out[field.key] = sample(field.spec, bad)
        elif field.kind == 'list' and field.spec:
            out[field.key] = [sample(field.spec, bad)]
    return out


def fixture(bad=False):
    secs = mappers.sections()
    doc = {'slug': 'acme'}
    for section in secs:
        if not any(list(codec.enumerated(lay['spec'])) or list(codec.markers(lay['spec'])) for table in section.tables
                   for lay in table.layout().values() if lay['spec']):
            continue
        if isinstance(section, sections.Settings):
            doc.update(sample(section.spec, bad))
        elif isinstance(section, agents.Nodes):
            rec = {}
            for table in section.tables:
                rec.update(sample(table.spec, bad))
            doc['nodes'] = {'boss': rec}
        elif isinstance(section, docket.Docket):
            doc['work_items'] = [dict(sample(section.tables[0].spec, bad), slug='one')]
        elif isinstance(section, sections.RecordList):
            doc[section.key] = [sample(section.t.spec, bad)]
        elif isinstance(section, sections.ByAgentLists):
            doc[section.key] = {'boss': [sample(section.t.spec, bad)]}
        elif isinstance(section, sections.ByAgentMaps):
            doc[section.key] = {'boss': {'key': sample(section.t.spec, bad)}}
        elif isinstance(section, sections.ByAgentRecords):
            doc[section.key] = {'boss': sample(section.t.spec, bad)}
        elif isinstance(section, sections.Map):
            doc[section.key] = {'key': sample(section.t.spec, bad)}
        else:
            raise AssertionError(type(section))
    account = dict(sample(ORG_ACCOUNT, bad), id='claude-1', origin_org='acme',
                   marks={'pooled': sample(ORG_MARK, bad)})
    side = OrgAccounts({'accounts': [account], 'mark_audit': [sample(ORG_AUDIT, bad)]})
    return doc, secs + [side], side


class EnumCodec(unittest.TestCase):
    def test_values_are_distinct_text_members_on_text_only(self):
        for kind, values in [('int', ('a',)), ('text', ['a']), ('text', []),
                             ('text', ('a', 'a')), ('text', ('a', 7)),
                             ('text', ('a\0',))]:
            with self.subTest(kind=kind, values=values), self.assertRaises(ValueError):
                codec.Field('kind', kind, values=values)

    def test_every_declared_member_uses_its_column(self):
        checks = entries()
        self.assertGreaterEqual(len(checks), 80)
        for entry in checks:
            for value in entry['values']:
                with self.subTest(table=entry['table'], column=entry['column'], value=value):
                    source, row, decoded, _ = encoded(entry, value)
                    self.assertEqual(value, row[entry['column']])
                    self.assertIsNone(row.get('extra'))
                    self.assertEqual(source, decoded)

    def test_every_column_preserves_bad_members_and_shapes(self):
        for entry in entries():
            for value in ('zz-out-of-set', '', 7, False, [], {'x': 1}, 'a\0'):
                if value in entry['values']:
                    continue
                with self.subTest(table=entry['table'], column=entry['column'], value=value):
                    source, row, decoded, _ = encoded(entry, value)
                    self.assertIsNone(row[entry['column']])
                    self.assertIn('extra', row)
                    # JSON equality alone would equate numeric 0 and False.
                    self.assertEqual(json.dumps(source, sort_keys=True),
                                     json.dumps(decoded, sort_keys=True))

    def test_null_and_absent_keep_their_original_presence(self):
        for entry in entries():
            with self.subTest(table=entry['table'], column=entry['column']):
                source, row, decoded, out = encoded(entry, None)
                self.assertIsNone(row[entry['column']])
                self.assertEqual(source, decoded)
                self.assertEqual([], enums.misfits('acme', out, mappers.sections() + [OrgAccounts()]))
                out = {}
                codec.encode(entry['spec'], {}, {key: 1 for key in entry['keys']}, out)
                self.assertEqual({}, codec.decode(entry['spec'], out[entry['table']][0], None, (1,)))

    def test_app_account_codec_is_unchanged(self):
        self.assertEqual([], list(codec.enumerated(ACCOUNT)))
        self.assertGreater(len(list(enums.columns([OrgAccounts()]))), 0)

    def test_physical_fixture_covers_every_enum_column(self):
        for bad in (False, True):
            doc, secs, side = fixture(bad)
            rows, _, _ = sections.encode_document(doc, secs)
            for entry in entries():
                with self.subTest(bad=bad, table=entry['table'], column=entry['column']):
                    self.assertGreater(len(rows.get(entry['table'], [])), 0)
                    self.assertEqual(None if bad else entry['values'][0],
                                     rows[entry['table']][0][entry['column']])
            reports = enums.misfits('acme', rows, secs)
            self.assertEqual(len(entries()) if bad else 0, len(reports))
            back = sections.decode_document(rows, secs, sections.Context())
            self.assertEqual(json.dumps(doc, sort_keys=True), json.dumps(back, sort_keys=True))
            self.assertEqual(side.part, side.read_back)


class EnumMigration(unittest.TestCase):
    def test_migration_covers_exactly_the_mapper_sets(self):
        text = MIGRATION.read_text(encoding='utf-8')
        pattern = (r'ALTER TABLE orgtree\.(\w+) ADD CONSTRAINT (\w+)\s+'
                   r'CHECK \("(\w+)" IN \(([^;]+)\)\);')
        actual = {}
        for table, name, col, values in re.findall(pattern, text):
            self.assertEqual(f'{table}_{col}_enum', name)
            self.assertLessEqual(len(name), 63)
            vals = tuple(v.replace("''", "'") for v in re.findall(r"'((?:''|[^'])*)'", values))
            self.assertNotIn((table, col), actual)
            actual[table, col] = vals
        expected = {(e['table'], e['column']): e['values'] for e in entries(True)}
        self.assertEqual(expected, actual)
        stripped = re.sub(r'--[^\n]*', '', text)
        self.assertEqual('', re.sub(pattern, '', stripped).strip())
        self.assertNotIn('NOT VALID', text)

    def test_important_writer_sets_are_pinned(self):
        values = {(e['table'], e['column']): e['values'] for e in entries()}
        self.assertEqual(('armed', 'paused'), values['watchdogs', 'state'])
        self.assertEqual(('pending', 'granted', 'withdrawn', 'declined'),
                         values['work_item_review_seat_requests', 'state'])
        self.assertEqual(('turn', 'steer', 'manual_fetch'), values['delivery_batches', 'mode'])
        self.assertEqual(('applied', 'fenced'), values['op_receipts', 'outcome'])
        self.assertEqual(('code', 'non-code'), values['work_items', 'kind'])

    def test_enum_sets_match_public_writer_validation_constants(self):
        values = {(e['table'], e['column']): e['values'] for e in entries()}
        for key, writer_set in {
            ('agents', 'scope_permission_mode'): ledger.PM_LEVELS,
            ('agents', 'scope_org_visibility'): ledger.VIS_LEVELS,
            ('scope_request_items', 'tool'): ledger.TOOL_KEYS,
            ('work_items', 'status'): ledger.Org.WORK_STATUSES,
            ('work_item_evidence', 'kind'): ledger.Org.WORK_EVIDENCE_KINDS,
            ('work_item_findings', 'disposition'): ledger.Org.WORK_DISPOSITIONS,
            ('work_item_history', 'stage'): workitems.STAGES,
            ('work_item_acceptance', 'checked_classification'): workevidence.ACCEPTANCE_CLASSES,
            ('work_item_acceptance', 'checked_execution'): workevidence.EXECUTION,
            ('work_item_acceptance', 'checked_result'): workevidence.RESULTS,
            ('org_accounts', 'provider'): registry.PROVIDERS,
            ('org_accounts', 'credential_kind'): registry.CREDENTIAL_KINDS,
            ('org_accounts', 'auth'): registry.AUTH_STATES,
            ('org_account_marks', 'provenance'): registry.PROVENANCE,
            ('op_receipts', 'cls'): (opreceipts.TX, opreceipts.TX_POST,
                                    opreceipts.PRE, opreceipts.UNROLLED, opreceipts.NONE),
        }.items():
            with self.subTest(column=key):
                self.assertEqual(set(writer_set), set(values[key]))

    def test_every_codec_shape_marker_has_its_exact_check(self):
        all_columns = entries(True)
        markers = {(e['table'], e['column']): e for e in all_columns if e['kind'] == 'marker'}
        expected = set()
        for sec in mappers.sections() + [OrgAccounts()]:
            for root in sec.tables:
                for table, lay in root.layout().items():
                    expected.update((table, col) for col, typ in lay['columns'] if col.endswith('_is'))
        self.assertEqual(expected, set(markers))
        for entry in markers.values():
            for value in (None, {}, [], 7):
                with self.subTest(table=entry['table'], column=entry['column'], value=value):
                    source = record(entry['path'], value)
                    rows = {}
                    codec.encode(entry['spec'], source, {k: 1 for k in entry['keys']}, rows)
                    row = rows[entry['table']][0]
                    self.assertIn(row[entry['column']], entry['values'])
                    back = codec.decode(entry['spec'], row, codec.Children({}, {}), (1,))
                    self.assertEqual(source, back)
        self.assertEqual(('n', 'o', 'x'), codec.MARKER_VALUES['obj'])
        self.assertEqual(('n', 'l', 'x'), codec.MARKER_VALUES['list'])

    def test_legacy_deleted_state_is_a_reported_misfit(self):
        entry = next(e for e in entries() if (e['table'], e['column']) == ('agents', 'state'))
        self.assertEqual(('live', 'archived', 'unrecoverable'), entry['values'])
        source, row, back, rows = encoded(entry, 'deleted')
        self.assertIsNone(row['state'])
        self.assertEqual(source, back)
        self.assertEqual('state', enums.misfits('acme', rows, mappers.sections())[0]['field'])


class EnumReports(unittest.TestCase):
    def test_every_misfit_names_org_record_and_field_without_value(self):
        secs = mappers.sections() + [OrgAccounts()]
        for entry in entries():
            with self.subTest(table=entry['table'], column=entry['column']):
                _, _, _, out = encoded(entry, 'private-out-of-set')
                reports = enums.misfits('acme', out, secs)
                self.assertEqual([dict(org='acme', table=entry['table'],
                                       record={key: 1 for key in entry['keys']},
                                       field='.'.join(entry['path']), column=entry['column'])], reports)
                self.assertNotIn('private-out-of-set', json.dumps(reports))

    def test_agent_and_nested_child_record_locations(self):
        doc = {'slug': 'acme', 'nodes': {'boss': {'state': 'zz-state'}},
               'work_items': [{'slug': 'one', 'kind': 'code', 'acceptance': [
                   {'text': 'condition', 'check_history': [{'result': 7}]}]}]}
        secs = mappers.sections()
        rows, _, _ = sections.encode_document(doc, secs)
        reports = enums.misfits('acme', rows, secs)
        self.assertEqual({'agents', 'work_item_acceptance_checks'}, {r['table'] for r in reports})
        child = next(r for r in reports if r['table'] == 'work_item_acceptance_checks')
        self.assertEqual({'item_id': 1, 'pos': 0, 'pos_2': 0}, child['record'])
        self.assertEqual('result', child['field'])


if __name__ == '__main__':
    unittest.main()
