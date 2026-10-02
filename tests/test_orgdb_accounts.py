"""accounts-registry.json into the app database and the orgs' own databases (design §2.10,
§5.2 "Accounts"): no database.

test_orgdb_accounts_pg.py repeats the round trips through real app and org databases.

What it proves:
  * a registry with every field registry.py writes (credential kinds, identity, marks with both
    provenances, apikey spend, aliases, both counter maps, the cutover and migration stamps,
    the mark audit) round-trips exactly as canonical JSON: the machine-wide rows to the app
    tables, the rows with an origin_org split out per org;
  * unknown fields, values of another shape and U+0000 land in extra and the report names the
    tables that needed it; containers of another shape (marks, spend, credential, aliases,
    counters, the audit, accounts itself) are kept whole; nulls stay nulls; an unknown
    top-level key is kept whole; the epoch stamps keep their exact number (and type) beside a
    microsecond instant; the real copy's shape round-trips;
  * shapes no writer makes refuse (ShapeError): an account that is not an object with a text
    id, two accounts with one id, a NaN; a damaged file raises (it refuses the start);
  * OrgAccounts round-trips an org's restricted rows and its check reports a changed row;
  * 0002_accounts.sql has exactly the columns the specs write, and app_settings has every
    column the conversion sets.

Run:  python tools/run-python-verification.py tests/test_orgdb_accounts.py
"""

import copy
import datetime as dt
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree.orgdb import codec, sections
from orgtree.orgdb.convert import accounts

MIGRATIONS = Path(__file__).resolve().parent.parent / 'engine' / 'backend' / 'orgtree' / 'pg_migrations'
EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)


def canon(v) -> str:
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def mark(until, provenance='observed', **extra) -> dict:
    return {'until': until, 'window': '5h', 'observed_at': until - 3600.5, 'provenance': provenance,
            **extra}


def registry() -> dict:
    """Every field registry.py and registry_migration.py write, with synthetic values."""
    return {
        'version': 1,
        'accounts': [
            {'id': 'openai-1', 'provider': 'openai', 'harness': 'codex-cli',
             'label': 'openai (machine login)', 'credential': {'kind': 'imported', 'path': 'C:/u/.codex'},
             'identity': {'account_digest': 'd1', 'lane': 'chatgpt'}, 'auth': 'authenticated',
             'marks': {'openai:plan': mark(1759400000.1234567),
                       'openai:reserve': mark(1759401000.5, 'inferred')},
             'tint_ordinal': 1, 'created_at': 1759300000.9876543, 'registered_from': 'migration:ambient'},
            {'id': 'claude-1', 'provider': 'claude', 'harness': 'claude-code', 'label': 'claude-1',
             'credential': {'kind': 'imported', 'path': 'C:/u/.claude', 'default_config': True},
             'identity': {}, 'auth': 'unobserved', 'marks': {}, 'tint_ordinal': 1,
             'created_at': 1759300001.25, 'registered_from': ''},
            {'id': 'claude-2', 'provider': 'claude', 'harness': 'claude-code', 'label': 'org key (acme)',
             'credential': {'kind': 'apikey', 'token_ref': 'tok-acme'}, 'identity': {},
             'auth': 'authenticated', 'marks': {'pooled': mark(1759402000.0),
                                                 'fable': mark(1759402000.0, 'inferred')},
             'tint_ordinal': 2, 'created_at': 1759300002.0, 'registered_from': 'migration:apikey-cutover',
             'origin_org': 'acme', 'mode': 'apikey', 'enabled': True,
             'spend': {'usd_total': 12.75, 'turns': 7, 'since': 1759000000.0, 'updated_at': 1759400000.25}},
            {'id': 'claude-3', 'provider': 'claude', 'harness': 'claude-code', 'label': 'org key (beta)',
             'credential': {'kind': 'token', 'token_ref': 'org-api-key:beta'}, 'identity': {},
             'auth': 'unauthenticated', 'marks': {}, 'tint_ordinal': 3, 'created_at': 1759300003.5,
             'registered_from': 'migration:org-key', 'origin_org': 'beta'},
            {'id': 'claude-4', 'provider': 'claude', 'harness': 'claude-code', 'label': 'key a\x00b',
             'credential': {'kind': 'managed', 'path': 'D:/profiles/c4', 'surprise': 1},
             'identity': {'nul': 'x\x00y'}, 'auth': 'authenticated', 'mode': 'apikey', 'enabled': 'yes',
             'marks': {'pooled': mark(1.0, 'inferred', surprise=[1, None])}, 'spend': None,
             'tint_ordinal': 4.0, 'created_at': 1759300004, 'registered_from': 'ui',
             'origin_org': '', 'future_field': [1, {'a': None}]},
            {'id': 'google-1', 'provider': 'google', 'harness': 'agy', 'label': None,
             'credential': 'flat', 'identity': None, 'auth': 'unobserved',
             'marks': ['not', 'a', 'map'], 'spend': 'junk', 'tint_ordinal': 1,
             'created_at': 1759300005.0, 'registered_from': 'ui', 'origin_org': None},
        ],
        'aliases': {'primary': 'claude-1', 'acme-key': 'claude-2', 'odd': 5},
        'id_counters': {'claude': 4, 'openai': 1, 'google': 1},
        'tint_counters': {'claude': 4, 'openai': 1, 'xai': 2.0},
        'apikey_cutover_at': 1759400000.1234567,
        'migrated_at': 1759300000,
        'mark_audit': [{'at': 1759400001.5, 'actor': 'user', 'org': 'acme', 'via': 'ui',
                        'account': 'claude-1', 'source': 'registry', 'pool': 'pooled',
                        'cleared': {'pooled': mark(1759402000.0)}, 'kept': {}, 'reason': 'stale',
                        'later_field': 1}],
        'future_top': {'x': [1, 2]},
        'nulled': None,
    }


def round_trip(doc: dict) -> tuple[dict, dict, dict, dict]:
    rows, restricted, report = accounts.encode_registry(copy.deepcopy(doc))
    return accounts.decode_registry(rows), rows, restricted, report


class RegistryRoundTrip(unittest.TestCase):
    def test_every_field_round_trips_and_restricted_rows_split_out(self) -> None:
        doc = registry()
        back, rows, restricted, report = round_trip(doc)
        machine, by_org = accounts.split_registry(doc)
        self.assertEqual(canon(back), canon(machine))
        self.assertEqual(list(back), list(doc))                       # top-level order kept
        self.assertEqual([a['id'] for a in back['accounts']], ['openai-1', 'claude-1', 'claude-4', 'google-1'])
        self.assertEqual({k: [r['id'] for r in v] for k, v in restricted.items()},
                         {'acme': ['claude-2'], 'beta': ['claude-3']})
        self.assertEqual(canon(restricted), canon(by_org))
        app_ids = {r.get('id') or r.get('account_id') for t in ('accounts', 'account_marks', 'account_spend')
                   for r in rows[t]}
        self.assertEqual(app_ids, {'openai-1', 'claude-1', 'claude-4', 'google-1'})   # no trace of them
        self.assertEqual(report['machine_wide'], 4)
        self.assertEqual(report['accounts'], 6)
        self.assertEqual(report['restricted'], {'acme': 1, 'beta': 1})
        self.assertEqual(report['kept_whole'], ['future_top'])
        self.assertEqual(report['aliases_to_restricted'], ['acme-key'])
        self.assertEqual(report['rows_with_extra'], {'accounts': 2, 'account_marks': 1,
                                                     'account_aliases': 1, 'account_counters': 1,
                                                     'account_mark_audit': 1})
        keys = {r['key']: r['state'] for r in rows['account_registry_keys']}
        self.assertEqual(keys['nulled'], 'n')
        self.assertEqual(keys['future_top'], 'x')
        self.assertEqual(keys['accounts'], 'v')

    def test_typed_columns_hold_the_values(self) -> None:
        _, rows, _, _ = round_trip(registry())
        acc = {r['id']: r for r in rows['accounts']}
        self.assertEqual((acc['openai-1']['marks_is'], acc['openai-1']['spend_is']), ('o', None))
        self.assertEqual((acc['claude-4']['marks_is'], acc['claude-4']['spend_is']), ('o', 'n'))
        self.assertEqual((acc['google-1']['marks_is'], acc['google-1']['spend_is']), ('x', 'x'))
        self.assertEqual(acc['claude-1']['credential_default_config'], True)
        self.assertEqual(acc['openai-1']['created_at'], 1759300000.9876543)
        self.assertEqual(acc['google-1']['credential_is'], 'x')
        extra4 = acc['claude-4']['extra'].obj
        self.assertEqual(extra4, {'label': 'key a\x00b', 'credential': {'surprise': 1},
                                  'enabled': 'yes', 'tint_ordinal': 4.0, 'created_at': 1759300004,
                                  'origin_org': '', 'future_field': [1, {'a': None}]})
        self.assertEqual(acc['claude-4']['identity'].obj, {'nul': 'x\x00y'})   # a json column keeps it
        marks = {(m['account_id'], m['pool']): m for m in rows['account_marks']}
        self.assertEqual(sorted(marks), [('claude-4', 'pooled'), ('openai-1', 'openai:plan'),
                                         ('openai-1', 'openai:reserve')])
        self.assertEqual(marks[('openai-1', 'openai:plan')]['until'], 1759400000.1234567)
        self.assertEqual(marks[('claude-4', 'pooled')]['extra'].obj, {'surprise': [1, None]})
        counters = {c['provider']: c for c in rows['account_counters']}
        self.assertEqual((counters['google']['id_counter'], counters['google']['tint_counter']), (1, None))
        self.assertEqual(counters['xai']['extra'].obj, {'tint_counter': 2.0})
        settings = rows['app_settings'][0]
        self.assertEqual(settings['accounts_version'], 1)
        self.assertEqual(settings['apikey_cutover_at_text'], '1759400000.1234567')
        self.assertEqual(settings['apikey_cutover_at'], EPOCH + dt.timedelta(seconds=1759400000.1234567))
        self.assertEqual(settings['accounts_migrated_at_text'], '1759300000')
        self.assertEqual(json.loads(settings['accounts_migrated_at_text']), 1759300000)

    def test_the_real_copys_shape_round_trips(self) -> None:
        # the live registry's shape (values synthetic): one openai row with two marks, no
        # aliases, two counter maps, the apikey cutover stamp
        doc = {'version': 1, 'accounts': [{
            'id': 'openai-1', 'provider': 'openai', 'harness': 'codex-cli', 'label': 'x',
            'credential': {'kind': 'imported', 'path': 'p'}, 'identity': {'account_digest': 'd', 'lane': 'l'},
            'auth': 'authenticated', 'marks': {'openai:plan': mark(1759400000.75),
                                               'openai:reserve': mark(1759400001.5)},
            'tint_ordinal': 1, 'created_at': 1759000000.123, 'registered_from': 'migration:ambient'}],
            'aliases': {}, 'id_counters': {'claude': 1, 'openai': 1},
            'tint_counters': {'claude': 1, 'openai': 1}, 'apikey_cutover_at': 1759300000.4567}
        back, rows, restricted, report = round_trip(doc)
        self.assertEqual(canon(back), canon(doc))
        self.assertEqual(restricted, {})
        self.assertEqual(report['rows_with_extra'], {})
        self.assertEqual(report['kept_whole'], [])

    def test_top_level_shapes_are_kept_whole_or_null(self) -> None:
        for doc in ({}, {'version': '1'}, {'version': True}, {'version': 2 ** 40},
                    {'accounts': None}, {'accounts': {'not': 'a list'}}, {'aliases': ['x']},
                    {'aliases': {'a\x00': 'x'}}, {'id_counters': {'claude': 'two'}},
                    {'mark_audit': [1]}, {'mark_audit': None}, {'apikey_cutover_at': 'yesterday'},
                    {'apikey_cutover_at': True}, {'apikey_cutover_at': 1e300},
                    {'migrated_at': -86400.5}, {'accounts': [], 'aliases': {}, 'id_counters': {}}):
            with self.subTest(doc=doc):
                back = round_trip(doc)[0]
                self.assertEqual(canon(back), canon(doc))
        self.assertEqual(round_trip({'accounts': {'x': 1}})[3]['machine_wide'], 0)

    def test_shapes_no_writer_makes_refuse(self) -> None:
        base = registry()
        bad_rows = ([1], [{'provider': 'claude'}], [{'id': ''}], [{'id': 7}], [{'id': 'a\x00'}],
                    [{'id': 'claude-1'}, {'id': 'claude-1', 'origin_org': 'acme'}],
                    [{'id': 'x', 'created_at': float('nan')}])
        for rows in bad_rows:
            with self.subTest(rows=rows), self.assertRaises(codec.ShapeError):
                accounts.encode_registry({**base, 'accounts': rows})
        with self.assertRaises(codec.ShapeError):
            accounts.encode_registry({'unknown': float('inf')})
        with self.assertRaises(codec.ShapeError):
            accounts.encode_registry({'a\x00': 1})


class OrgAccounts(unittest.TestCase):
    def test_restricted_rows_round_trip_and_a_change_is_reported(self) -> None:
        source = accounts.split_registry(registry())[1]['acme'] + [
            {'id': 'claude-9', 'origin_org': 'acme', 'marks': None, 'spend': {'turns': 'many'},
             'surprise': True, 'label': 'z\x00'}]
        sec = accounts.OrgAccounts(source)
        rows, _, _ = sections.encode_document({}, [sec])
        self.assertEqual([r['ord'] for r in rows['org_accounts']], [0, 1])
        self.assertEqual(rows['org_accounts'][0]['origin_org'], 'acme')
        self.assertEqual(len(rows['org_account_marks']), 2)
        self.assertEqual(rows['org_account_spend'][1]['extra'].obj, {'turns': 'many'})
        back = accounts.decode_org_accounts(rows)
        self.assertEqual(canon(back), canon(source))
        self.assertEqual(accounts.check_org_accounts(source, rows), [])
        sections.decode_document(rows, [sec], sections.Context())
        self.assertEqual(canon(sec.read_back), canon(source))
        bad = copy.deepcopy(rows)
        bad['org_account_marks'][0]['window'] = '1h'
        found = accounts.check_org_accounts(source, bad)
        self.assertEqual(found[0]['missing'], ['claude-2'])
        self.assertEqual(found[0]['unexpected'], ['claude-2'])
        with self.assertRaises(codec.ShapeError):
            accounts.OrgAccounts([{'id': 'a'}, {'id': 'a'}])


class RegistryFile(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix='orgdb-accounts-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_read_registry(self) -> None:
        path = self.tmp / accounts.REGISTRY_FILE
        self.assertIsNone(accounts.read_registry(str(path)))
        path.write_text(json.dumps(registry(), indent=1), encoding='utf-8')
        self.assertEqual(canon(accounts.read_registry(str(path))), canon(registry()))
        path.write_text('{"version": 1, "accounts": [', encoding='utf-8')
        with self.assertRaises(ValueError):              # a fault in the file refuses the start
            accounts.read_registry(str(path))
        path.write_text('[]', encoding='utf-8')
        with self.assertRaises(codec.ShapeError):
            accounts.read_registry(str(path))

    def test_claude_profiles(self) -> None:
        self.assertEqual(accounts.claude_profiles(registry()), ['C:/u/.claude', 'D:/profiles/c4'])
        self.assertEqual(accounts.claude_profiles({'accounts': [1, None, {'provider': 'claude'}]}), [])


def migration_columns(text: str) -> dict[str, list[str]]:
    out = {}
    for m in re.finditer(r'CREATE TABLE orgtree\.(\w+) \((.*?)\n\);', text, re.S):
        cols = []
        for line in m.group(2).split('\n'):
            line = line.strip().rstrip(',')
            if not line or line.startswith(('--', 'PRIMARY KEY', 'CONSTRAINT', 'UNIQUE', 'FOREIGN')):
                continue
            cols.append(line.split()[0].strip('"'))
        out[m.group(1)] = cols
    return out


def table_columns(t) -> list[str]:
    lay = t.layout()[t.spec.table]
    given = [rc.split()[0].strip('"') for rc in t.record_columns]
    return (given + [c for c, _ in lay['keys'] if c not in given] + [c for c, _ in lay['columns']]
            + (['extra'] if lay['extra'] else []))


class Migration(unittest.TestCase):
    def test_0002_has_exactly_the_columns_the_specs_write(self) -> None:
        text = (MIGRATIONS / 'app' / '0002_accounts.sql').read_text(encoding='utf-8')
        want = {t.spec.table: sorted(table_columns(t))
                for t in (accounts.ACCOUNTS, accounts.MARKS, accounts.SPENDS, accounts.ALIASES,
                          accounts.COUNTERS, accounts.AUDITS)}
        want[accounts.KEYS_TABLE] = sorted(['key', 'ord', 'state', 'val'])
        got = {k: sorted(v) for k, v in migration_columns(text).items()}
        self.assertEqual(got, want)
        self.assertEqual(list(want), [t for t in accounts.APP_TABLES])

    def test_app_settings_has_every_column_the_conversion_sets(self) -> None:
        text = '\n'.join((MIGRATIONS / 'app' / n).read_text(encoding='utf-8')
                         for n in ('0001_registry.sql', '0002_accounts.sql'))
        settings = migration_columns(text)['app_settings']
        added = re.findall(r'ADD COLUMN (\w+)', text)
        for col in accounts.SETTINGS_COLUMNS:
            self.assertIn(col, settings + added)


if __name__ == '__main__':
    unittest.main()
