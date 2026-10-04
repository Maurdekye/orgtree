"""The independent destination verifier, without a database (design §5.4 check 1, f16).

What it proves:
  * independence, by a source scan: tools/orgdb_verify.py imports nothing from orgtree.orgdb,
    in any form (import, from-import, relative, importlib, __import__, a path string), and in
    fact nothing outside the standard library and psycopg; the scan itself is shown to catch
    each of those forms in a planted source;
  * completeness: the verifier handles exactly ledger.NODE_KEYED_SECTIONS plus the two
    legacy-only keys and the kept `sandbox`, and ignores exactly the rest of
    ledger.IGNORED_LEGACY_KEYS by default;
  * its correspondence matches the destination schema (org migrations 0001 and 0002): every
    column it names exists with the type of its declared kind, and every column of every
    document table is one it reads, so a new column cannot go unverified;
  * its value rules: exact JSON types, numeric int versus float, timestamps as instants with
    the strict / readable / unreadable classes, and the U+0000 rule.

Run:  python tools/run-python-verification.py tests/test_orgdb_verify_static.py
"""

import ast
import datetime as dt
import importlib.util
from pathlib import Path
import re
import sys
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger

REPO = Path(__file__).resolve().parent.parent
VERIFIER = REPO / 'tools' / 'orgdb_verify.py'
MIGRATIONS = REPO / 'engine' / 'backend' / 'orgtree' / 'pg_migrations' / 'org'

_SPEC = importlib.util.spec_from_file_location('orgdb_verify', VERIFIER)
ov = importlib.util.module_from_spec(_SPEC)
sys.modules['orgdb_verify'] = ov
_SPEC.loader.exec_module(ov)

ALLOWED_IMPORTS = {'__future__', 'argparse', 'collections', 'datetime', 'decimal', 'hashlib',
                   'json', 'math', 'os', 'pathlib', 're', 'sys', 'typing', 'psycopg'}
#: names and attributes that load code by name at run time (re.compile is not one)
DYNAMIC_NAMES = {'importlib', '__import__', 'exec', 'eval', 'compile', 'runpy', 'execfile',
                 'import_module'}
DYNAMIC_ATTRS = {'import_module', 'spec_from_file_location', 'load_module', 'exec_module',
                 '__import__', 'run_module', 'run_path'}


def _docstrings(tree: ast.AST) -> set[int]:
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, 'body', [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                    and isinstance(body[0].value.value, str):
                out.add(id(body[0].value))
    return out


def scan(source: str) -> list[str]:
    """Every way ``source`` could reach orgtree.orgdb (or anything but the stdlib and psycopg)."""
    tree = ast.parse(source)
    docs = _docstrings(tree)
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if 'orgdb' in a.name or a.name.split('.')[0] not in ALLOWED_IMPORTS:
                    found.append(f'import {a.name}')
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ''
            names = [a.name for a in node.names]
            if node.level or 'orgdb' in mod or any('orgdb' in n for n in names) \
                    or mod.split('.')[0] not in ALLOWED_IMPORTS:
                found.append(f'from {"." * node.level}{mod} import {", ".join(names)}')
        elif isinstance(node, ast.Name) and node.id in DYNAMIC_NAMES:
            found.append(f'dynamic import machinery: {node.id}')
        elif isinstance(node, ast.Attribute) and node.attr in DYNAMIC_ATTRS:
            found.append(f'dynamic import machinery: .{node.attr}')
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) \
                and id(node) not in docs and 'orgdb' in node.value:
            found.append(f'string naming orgdb: {node.value[:60]!r}')
    return found


class SourceScan(unittest.TestCase):
    def test_the_verifier_reaches_no_converter_code(self) -> None:
        self.assertEqual(scan(VERIFIER.read_text(encoding='utf-8')), [])

    def test_the_scan_catches_every_form(self) -> None:
        for planted in ('import orgtree.orgdb', 'import orgtree.orgdb.codec as c',
                        'from orgtree.orgdb import codec', 'from orgtree import orgdb',
                        'from orgtree.orgdb.convert import rowio', 'from .orgdb import sections',
                        'from . import mappers', 'import orgtree',
                        'from orgtree import ledger',
                        'import importlib\nimportlib.import_module("orgtree.orgdb")',
                        'm = __import__("orgtree.orgdb")',
                        'p = "engine/backend/orgtree/orgdb/codec.py"',
                        'x = exec("import os")'):
            with self.subTest(planted=planted):
                self.assertTrue(scan('"""doc names orgdb, allowed."""\n' + planted), planted)

    def test_docstrings_may_name_orgdb(self) -> None:
        self.assertEqual(scan('"""This verifier must not import orgtree.orgdb."""\nimport json\n'),
                         [])


class Completeness(unittest.TestCase):
    def test_sections_are_the_engine_registry(self) -> None:
        self.assertEqual(set(ov.SECTIONS),
                         set(ledger.NODE_KEYED_SECTIONS) | {'chain_notices', 'release'}
                         | set(ov.KEPT_LEGACY))

    def test_ignored_keys_are_the_engine_constant(self) -> None:
        # the engine's removed-feature keys, but the one the converter keeps (design rev 7.2)
        self.assertEqual(set(ov.IGNORED_DEFAULT) | set(ov.KEPT_LEGACY),
                         set(ledger.IGNORED_LEGACY_KEYS))
        self.assertTrue(set(ov.IGNORED_DEFAULT).isdisjoint(ov.KEPT_LEGACY))
        self.assertTrue(set(ov.IGNORED_DEFAULT).isdisjoint(ov.SECTIONS))
        self.assertEqual(ov.KEPT_LEGACY, ('sandbox',))

    def test_every_by_node_section_is_read_per_agent(self) -> None:
        by_node = {k for k, (_c, shape, _d) in ledger.NODE_KEYED_SECTIONS.items()
                   if shape == 'by_node'} - {'nodes'}
        self.assertTrue(by_node <= set(ov.BY_AGENT), by_node - set(ov.BY_AGENT))


_TYPES = {'text': 'text', 'bigint': 'bigint', 'integer': 'integer', 'boolean': 'boolean',
          'double precision': 'double precision', 'numeric': 'numeric', 'json': 'json',
          'jsonb': 'jsonb', 'timestamptz': 'timestamp with time zone', 'char(1)': 'character',
          'uuid': 'uuid'}


def sql_parts(text, delimiter=','):
    """Split SQL outside quoted values and nested expressions."""
    parts, start, depth, quote = [], 0, 0, None
    i = 0
    while i < len(text):
        char = text[i]
        if quote:
            if char == quote:
                if i + 1 < len(text) and text[i + 1] == quote:
                    i += 1
                else:
                    quote = None
        elif char in ('\"', "'"):
            quote = char
        elif char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
        elif char == delimiter and depth == 0:
            parts.append(text[start:i].strip())
            start = i + 1
        i += 1
    parts.append(text[start:].strip())
    return parts


def migrated_schema(texts=None):
    """Read successive literal DDL, including additions and removals after0002.

    Function bodies are excluded so runtime SQL is not mistaken for migration
    DDL. Dynamic agent presence flags are explicitly DERIVED, outside the docket
    contract; all item table/column migrations are literal and must be covered.
    """
    if texts is None:
        texts = [p.read_text(encoding='utf-8') for p in sorted(MIGRATIONS.glob('*.sql'))]
    out, references, foundation = {}, {}, set()
    for index, text in enumerate(texts):
        text = re.sub(r'\$(\w*)\$.*?\$\1\$', '', text, flags=re.S)
        text = re.sub(r'--[^\n]*', '', text)
        for statement in sql_parts(text, ';'):
            create = re.fullmatch(r'CREATE TABLE orgtree\.(\w+)\s*\((.*)\)', statement, re.S)
            alter = re.fullmatch(r'ALTER TABLE orgtree\.(\w+)\s+(.*)', statement, re.S)
            drop = re.fullmatch(r'DROP TABLE orgtree\.(\w+)', statement)
            if drop:
                out.pop(drop[1], None)
                references.pop(drop[1], None)
                continue
            if create:
                table, body = create.groups()
                out[table] = {}
                clauses = sql_parts(body)
                if index < 2:
                    foundation.add(table)
            elif alter:
                table, body = alter.groups()
                clauses = sql_parts(body)
            else:
                continue
            references.setdefault(table, set()).update(re.findall(r'REFERENCES orgtree\.(\w+)', body))
            for clause in clauses:
                deleted = re.match(r'DROP COLUMN "?(\w+)"?', clause)
                changed = re.match(r'ALTER COLUMN "?(\w+)"? TYPE (double precision|char\(1\)|\w+)', clause)
                col = re.match(r'(?:ADD COLUMN )?"?(\w+)"?\s+(double precision|char\(1\)|\w+)', clause)
                if deleted:
                    out[table].pop(deleted[1], None)
                elif changed:
                    out[table][changed[1]] = _TYPES[changed[2]]
                elif col and col[2] in _TYPES:
                    out[table][col[1]] = _TYPES[col[2]]
    return out, references, foundation


def schema():
    return migrated_schema()[0]


def unread_columns(parsed, mine=None):
    have, refs, foundation = parsed
    mine = ov.correspondence() if mine is None else mine
    item_tables = {'work_items'}
    while True:
        following = {t for t, columns in have.items() if t.startswith('work_item_')
                     or 'item_id' in columns or refs.get(t, set()) & item_tables}
        if following <= item_tables:
            break
        item_tables |= following
    checked = (foundation - ov.OUTSIDE) | set(mine) | item_tables
    return [f'{t}.{c}' for t, cols in have.items() if t in checked
            for c in cols if c not in mine.get(t, {}) and c not in ov.DERIVED.get(t, ())]


class MatchesTheSchema(unittest.TestCase):
    def setUp(self) -> None:
        self.schema = schema()
        self.mine = ov.correspondence()

    def test_the_parse_is_sane(self) -> None:
        self.assertIn('agents', self.schema)
        self.assertEqual(self.schema['agents']['created'], 'timestamp with time zone')
        self.assertEqual(self.schema['agents']['scope_is'], 'character')
        self.assertGreater(len(self.schema), 70)

    def test_every_named_column_exists_with_its_kind(self) -> None:
        wrong = []
        for table, cols in self.mine.items():
            have = self.schema.get(table)
            if have is None:
                wrong.append(f'{table}: no such table')
                continue
            for c, role in cols.items():
                if role == ov.OPT:
                    continue
                if c not in have:
                    wrong.append(f'{table}.{c}: no such column')
                elif role == ov.CODE and have[c] != 'character':
                    wrong.append(f'{table}.{c}: a code but {have[c]}')
                elif role in ov.SQL_TYPES and have[c] not in ov.SQL_TYPES[role]:
                    wrong.append(f'{table}.{c}: {role} but {have[c]}')
        self.assertEqual(wrong, [])

    def test_every_document_column_is_read(self) -> None:
        self.assertEqual(unread_columns(migrated_schema(), self.mine), [])

    def test_later_item_column_and_unexpected_child_table_cannot_be_skipped(self):
        texts = [p.read_text(encoding='utf-8') for p in sorted(MIGRATIONS.glob('*.sql'))]
        added = ('ALTER TABLE orgtree.work_item_events ADD COLUMN retained_payload text;'
                 'CREATE TABLE orgtree.future_events (id bigint, '
                 'event_id bigint REFERENCES orgtree.work_item_events(id), payload json);')
        missing = unread_columns(migrated_schema(texts + [added]))
        self.assertIn('work_item_events.retained_payload', missing)
        self.assertIn('future_events.payload', missing)

    def test_event_table_cannot_be_omitted_even_when_its_rows_are_empty(self):
        mine = dict(self.mine)
        del mine['work_item_events']
        self.assertIn('work_item_events.history_at', unread_columns(migrated_schema(), mine))

    def test_null_and_text_siblings_have_their_base_column(self) -> None:
        orphan = [f'{t}.{c}' for t, cols in self.schema.items() for c in cols
                  if (c.endswith('_null') and c[:-5] not in cols)
                  or (c.endswith('_text') and c[:-5] not in cols)]
        self.assertEqual(orphan, [])


class ValueRules(unittest.TestCase):
    def test_independent_enum_sets_and_marker_sets_equal_all_document_checks(self) -> None:
        checks = {}
        final = schema()
        for path in sorted(MIGRATIONS.glob('*.sql')):
            text = re.sub(r'\$(\w*)\$.*?\$\1\$', '', path.read_text(encoding='utf-8'), flags=re.S)
            text = re.sub(r'--[^\n]*', '', text)
            for statement in sql_parts(text, ';'):
                match = re.match(r'(?:CREATE|ALTER) TABLE orgtree\.(\w+)\s*', statement)
                if not match:
                    continue
                for column, members in re.findall(
                        r'CHECK\s*\(\s*"?(\w+)"?\s+IN\s*\(([^)]*)\)\s*\)', statement):
                    if column not in final.get(match[1], {}):
                        continue
                    values = {m.replace("''", "'") for m in re.findall(r"'((?:[^']|'')*)'", members)}
                    checks[match[1], column] = values
        # Only the documented account/side-file exclusion is outside this verifier.
        outside = {'org_accounts', 'org_account_marks', 'org_account_mark_audit'}
        expected = {key: value for key, value in checks.items()
                    if key[0] not in outside and key[0] in ov.correspondence()}
        actual = {key: set(value) for key, value in ov.enum_columns(include_markers=True).items()}
        self.assertEqual(expected, actual)
        self.assertTrue(expected)
        marker_columns = {(table, col) for table, columns in ov.correspondence().items()
                          for col, role in columns.items() if role == ov.CODE}
        self.assertEqual(marker_columns, {key for key in actual if key[1].endswith('_is')})

    def test_enum_column_rules_keep_misplaced_members_as_failures(self) -> None:
        from types import SimpleNamespace
        field = ov.Col('state', ov.TEXT, values=('live', 'archived', 'unrecoverable'))
        for value, typed, extra, expected in (
                ('live', 'live', False, []), ('zz-state', None, True, []),
                ('live', None, True, ['value its column can hold is in extra instead']),
                ('zz-state', 'zz-state', False,
                 ['value its column cannot hold exactly is in the column'])):
            checker = ov.Checker(SimpleNamespace(columns={'agents': {'state': 'text'}}))
            checker.col('nodes', 'lead.state', field, True, value, extra, value,
                        {'agents': {'state': typed}}, '', 'agents')
            self.assertEqual(expected, [p['problem'] for p in checker.problems])

    def test_json_equality_keeps_types(self) -> None:
        self.assertTrue(ov.jeq({'a': [1, 2.5, None, True]}, {'a': [1, 2.5, None, True]}))
        for a, b in ((1, 1.0), (1, True), (0, False), ([1], [1.0]), ({'a': 1}, {'a': 1, 'b': 2}),
                     (0.0, -0.0), ('1', 1), ([1, 2], [2, 1])):
            with self.subTest(a=a, b=b):
                self.assertFalse(ov.jeq(a, b))
        self.assertTrue(ov.jeq({'a': 1, 'b': 2}, {'b': 2, 'a': 1}))   # object order is free

    def test_numeric_keeps_int_versus_float(self) -> None:
        self.assertTrue(ov._num_matches(5, '5'))
        self.assertFalse(ov._num_matches(5, '5.0'))
        self.assertTrue(ov._num_matches(5.0, '5.0'))
        self.assertFalse(ov._num_matches(5.0, '5'))
        self.assertTrue(ov._num_matches(1e20, '100000000000000000000.0'))
        self.assertTrue(ov._num_matches(1e-07, '0.0000001'))
        self.assertTrue(ov._num_matches(2 ** 70, str(2 ** 70)))
        self.assertFalse(ov._num_matches(0.25, '0.26'))

    def test_what_a_column_can_hold(self) -> None:
        cases = [(ov.TEXT, 'x', 'yes'), (ov.TEXT, 'a\x00b', 'no'), (ov.TEXT, 5, 'no'),
                 (ov.TEXT, '\ud800', 'no'), (ov.INT, 5, 'yes'), (ov.INT, True, 'no'),
                 (ov.INT, 5.0, 'no'), (ov.INT, 2 ** 63, 'no'), (ov.FLOAT, 1.5, 'yes'),
                 (ov.FLOAT, 1, 'no'), (ov.NUM, 1, 'yes'), (ov.NUM, 1.5, 'yes'),
                 (ov.NUM, True, 'no'), (ov.NUM, '1', 'no'), (ov.BOOL, False, 'yes'),
                 (ov.BOOL, 0, 'no'), (ov.JSON, {'a': None}, 'yes'), (ov.JSON, 'x\x00', 'maybe')]
        for kind, v, want in cases:
            with self.subTest(kind=kind, v=v):
                self.assertEqual(ov.fit_of(kind, v), want)

    def test_timestamps_are_instants_in_three_classes(self) -> None:
        utc = dt.timezone.utc
        at = dt.datetime(2026, 10, 2, 10, 0, tzinfo=utc)
        for text, fit, instant in (
                ('2026-10-02T10:00:00.000Z', 'yes', at),
                ('2026-10-02T10:00:00Z', 'yes', at),
                ('2026-10-02T12:00:00.000+02:00', 'yes', at),
                ('2026-10-02T10:00:00.123456+00:00', 'yes', at.replace(microsecond=123456)),
                ('1969-12-31T23:59:59.999Z', 'yes',
                 dt.datetime(1969, 12, 31, 23, 59, 59, 999000, tzinfo=utc)),
                ('2026-10-02 10:00:00Z', 'maybe', at), ('2026-10-02T10:00:00z', 'maybe', at),
                ('2026-10-02T12:00:00+0200', 'maybe', at), ('2026-10-02T10:00Z', 'maybe', at),
                ('20261002T100000Z', 'maybe', at), ('2026-10-02T10:00:00,5Z', 'maybe',
                                                    at.replace(microsecond=500000)),
                ('2026-10-02T10:00:00', 'no', None), ('2026-02-30T00:00:00.000Z', 'no', None),
                ('2026-10-02T24:00:00Z', 'no', None), ('not a time', 'no', None),
                ('2026-10-02T10:00:00.000Z\x00', 'no', None)):
            with self.subTest(text=text):
                got_fit, got, _finer = ov.parse_instant(text)
                self.assertEqual(got_fit, fit)
                self.assertEqual(got, instant)
        self.assertTrue(ov._CANON.match('2026-10-02T10:00:00.000Z'))
        self.assertFalse(ov._CANON.match('2026-10-02T10:00:00Z'))

    def test_manifest_records_files_folders_and_absence(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'a').mkdir()
            (root / 'a' / 'f.txt').write_bytes(b'hello')
            (root / 'g.bin').write_bytes(b'')
            m = ov.manifest([str(root / 'a'), str(root / 'g.bin'), str(root / 'gone')])
            self.assertEqual(m[str((root / 'a').absolute())], 'dir')
            self.assertEqual(m[str((root / 'a' / 'f.txt').absolute())],
                             '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
            self.assertEqual(m[str((root / 'g.bin').absolute())],
                             'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
            self.assertEqual(m[str((root / 'gone').absolute())], 'missing')
            self.assertEqual(ov.manifest_changes(m, m), [])
            (root / 'a' / 'f.txt').write_bytes(b'hello!')
            (root / 'g.bin').unlink()
            (root / 'a' / 'new.txt').write_bytes(b'x')
            changes = {c['path']: c['change'] for c in ov.manifest_changes(
                m, ov.manifest([str(root / 'a'), str(root / 'g.bin'), str(root / 'gone')]))}
            self.assertEqual(changes, {str((root / 'a' / 'f.txt').absolute()): 'changed',
                                       str((root / 'g.bin').absolute()): 'changed',
                                       str((root / 'a' / 'new.txt').absolute()): 'added'})


if __name__ == '__main__':
    unittest.main()
