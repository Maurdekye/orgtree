"""Org enum coverage, exact legacy preservation and record-named conversion reports."""

import json
from pathlib import Path
import re
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree.orgdb import codec, enums, mappers, sections
from orgtree.orgdb.convert.accounts import ACCOUNT, ORG_ACCOUNT, ORG_MARK, ORG_AUDIT, OrgAccounts
from orgtree.orgdb.mappers import agents, docket
from orgtree.orgdb import docket_relations
from orgtree import ledger, opreceipts, registry, workevidence, workitems

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'engine/backend/orgtree/pg_migrations/org'


def entries(include_markers=False):
    return list(enums.columns(mappers.sections() + [OrgAccounts()], include_markers=include_markers))


def native_entries():
    """Authored enum sets plus native-only tags and explicit container markers."""
    result = [dict(entry) for entry in entries(True)]
    for section in mappers.sections() + [OrgAccounts()]:
        for root in section.tables:
            for table, layout in root.layout().items():
                if layout['spec'] is None:
                    continue
                for column, values in codec.tagged(layout['spec']):
                    marker = next(e for e in result if e['table'] == table
                                  and e['column'] == column.removesuffix('_kind') + '_is')
                    result.append(dict(marker, column=column, values=values, kind='tag'))
    placements = {('work_items', source + '_events_is'): codec.MARKER_VALUES['obj']
                  for source in docket.EVENT_SOURCES}
    placements.update({('work_items', col + '_is'): codec.MARKER_VALUES['obj']
                       for col in docket.CURRENT_POINTERS.values()})
    placements.update({
        ('org_accounts', 'marks_is'): codec.MARKER_VALUES['obj'],
        ('org_accounts', 'spend_is'): codec.MARKER_VALUES['obj'],
        ('work_items', 'review_seats_is'): codec.MARKER_VALUES['list'],
        ('work_item_artifacts', 'grants_is'): codec.MARKER_VALUES['list'],
        ('work_item_delivery', 'claim_is'): codec.MARKER_VALUES['obj'],
        ('work_item_delivery', 'stage'): docket_relations.STAGES,
    })
    result.extend(dict(table=table, column=column, values=values, kind='manual',
                       nullable=(table != 'work_item_delivery'))
                  for (table, column), values in placements.items())
    return result


def entry_row(rows, entry):
    """Select the real source event, rather than an unrelated event's NULL columns."""
    candidates = rows.get(entry['table'], [])
    if entry['table'] == 'work_item_events':
        candidates = [row for row in candidates if row['source'] == entry['path'][0]]
    if len(candidates) != 1:
        raise AssertionError(f"expected one witness for {entry['table']}.{entry['column']}, got {len(candidates)}")
    return candidates[0]


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
        elif field.kind in ('obj', 'turn_usage'):
            out[field.key] = sample(field.spec, bad)
        elif field.kind == 'principal':
            out[field.key] = {'node': 'boss'}
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
            item = dict(sample(docket.WORK_ITEM, bad), slug='one')
            item.update({source: [sample(spec, bad)]
                         for source, spec in docket.SOURCE_SPECS.items()})
            item['review_seats'] = [sample(docket_relations.SEAT, bad)]
            item['delivery'] = {'committed': sample(docket_relations.DELIVERY, bad)}
            for artifact in item['artifacts']:
                artifact['grants'] = [sample(docket_relations.GRANT, bad)]
            doc['work_items'] = [item]
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
                    self.assertEqual(None if bad else entry['values'][0],
                                     entry_row(rows, entry)[entry['column']])
            reports = enums.misfits('acme', rows, secs)
            self.assertEqual(len(entries()) if bad else 0, len(reports))
            back = sections.decode_document(rows, secs, sections.Context())
            self.assertEqual(json.dumps(doc, sort_keys=True), json.dumps(back, sort_keys=True))
            self.assertEqual(side.part, side.read_back)

    def test_event_witness_requires_the_matching_source_row(self):
        doc, secs, _ = fixture()
        rows, _, _ = sections.encode_document(doc, secs)
        events = [entry for entry in entries(True) if entry['table'] == 'work_item_events']
        self.assertEqual(33, len(events))
        for entry in events:
            with self.subTest(column=entry['column']):
                witness = entry_row(rows, entry)
                self.assertEqual(entry['path'][0], witness['source'])
                missing = dict(rows, work_item_events=[row for row in rows['work_item_events']
                                                       if row['source'] != witness['source']])
                with self.assertRaisesRegex(AssertionError, 'expected one witness'):
                    entry_row(missing, entry)


class EnumMigration(unittest.TestCase):
    def test_migration_covers_exactly_the_mapper_sets(self):
        from test_orgdb_verify_static import schema
        final = schema()
        pattern = (r'ALTER TABLE orgtree\."?(\w+)"? ADD CONSTRAINT "?(\w+)"?\s+'
                   r'CHECK\s*\("?(\w+)"? IN \(([^;]+)\)\);')
        dropped = r'ALTER TABLE orgtree\."?(\w+)"? DROP (COLUMN|CONSTRAINT) "?(\w+)"?;'
        dropped_table = r'DROP TABLE orgtree\."?(\w+)"?;'
        tokens = re.compile(f'(?:{pattern})|(?:{dropped})|(?:{dropped_table})')
        actual = {}
        for migration in sorted(MIGRATIONS.glob('*.sql')):
            text = migration.read_text(encoding='utf-8')
            for match in tokens.finditer(text):
                table, name, col, values, drop_table, drop_kind, drop_name, gone_table = match.groups()
                if gone_table:
                    actual = {key: val for key, val in actual.items() if key[0] != gone_table}
                    continue
                if drop_table:
                    if drop_kind == 'COLUMN':
                        actual.pop((drop_table, drop_name), None)
                    else:
                        actual = {key: val for key, val in actual.items()
                                  if f'{key[0]}_{key[1]}_enum' != drop_name}
                    continue
                self.assertEqual(f'{table}_{col}_enum', name)
                self.assertLessEqual(len(name), 63)
                # Later migrations drop the old child tables and parent markers.
                if col not in final.get(table, {}):
                    continue
                vals = tuple(v.replace("''", "'") for v in re.findall(r"'((?:''|[^'])*)'", values))
                self.assertNotIn((table, col), actual)
                actual[table, col] = vals
        expected = {(e['table'], e['column']): e['values']
                    for e in native_entries() if e['kind'] != 'manual'}
        self.assertEqual(expected, actual)
        text = (MIGRATIONS / '0009_enum_checks.sql').read_text(encoding='utf-8')
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
            ('work_item_events', 'evidence_kind'): ledger.Org.WORK_EVIDENCE_KINDS,
            ('work_item_findings', 'disposition'): ledger.Org.WORK_DISPOSITIONS,
            ('work_item_events', 'history_stage'): workitems.STAGES,
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
                    if entry['spec'].field(entry['path'][0]).kind == 'membership' and value == []:
                        with self.assertRaisesRegex(ValueError, 'membership reader must supply'):
                            codec.decode(entry['spec'], row, codec.Children({}, {}), (1,))
                        doc = {'nodes': {'boss': source}}
                        secs = mappers.sections()
                        owned, _, _ = sections.encode_document(doc, secs)
                        self.assertEqual(doc, sections.decode_document(owned, secs, sections.Context()))
                        continue
                    back = codec.decode(entry['spec'], row, codec.Children({}, {}), (1,))
                    self.assertEqual(source, back)
        self.assertEqual(('n', 'o', 'x'), codec.MARKER_VALUES['obj'])
        self.assertEqual(('n', 'l', 'x'), codec.MARKER_VALUES['list'])

    def test_legacy_deleted_state_is_a_reported_misfit(self):
        entry = next(e for e in entries() if (e['table'], e['column']) == ('agents', 'state'))
        self.assertEqual(('live', 'archived', 'unrecoverable', 'deleted'), entry['values'])
        self.assertEqual(('live', 'archived', 'unrecoverable'), agents.HOT.field('state').values)
        source = {'nodes': {'boss': {'state': 'deleted'}}}
        secs = mappers.sections()
        rows, _, _ = sections.encode_document(source, secs)
        row = rows['agents'][0]
        back = sections.decode_document(rows, secs, sections.Context())
        self.assertIsNone(row['state'])
        self.assertEqual(source, back)
        self.assertEqual([dict(org='acme', table='agents', record={'id': 1},
                               field='state', column='state')], enums.misfits('acme', rows, secs))
        internal = {}
        agents.encode_tombstone('former', 2, {'state': 'deleted'}, internal)
        self.assertEqual('deleted', internal['agents'][0]['state'])
        self.assertEqual([], enums.misfits('acme', internal, secs))


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
