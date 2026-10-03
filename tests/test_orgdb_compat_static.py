"""Static checks of the compatibility view (orgdb/compat, design §6.2 item 3). No database.

The view answers store.py's own SQL from an org database, statement by statement
(orgdb/compat/sql.py). This module reads store.py's source and proves the registry covers it:

  * every statement store.py passes to ``execute``/``executemany`` -- rendered from its
    literal text, store's module constants and the closed set of values its variable parts
    take (``_cas``'s statements, ``_node_ids_where``'s filters, the two log tables ...) -- is
    served by the view (a handler, a pass-through, an explicitly unreachable statement or a
    pattern), unless it is on the short list below of statements this mode never issues
    (SQLite only, custody receipt rows), each with its reason; a listed function must still
    exist. The bounded window readers' guards are answered (piece A6), not declined;
  * the readers that run SQL on the raw legacy connection (``conn.raw``) refuse first with
    the storage switch on;
  * a statement the registry does not know raises (never a silent answer).

When this fails after a change to store.py: serve the new statement in orgdb/compat/sql.py,
or, if this mode can never reach it, list it here with the reason.

Run:  python tools/run-python-verification.py tests/test_orgdb_compat_static.py
"""

import ast
import itertools
import os
from pathlib import Path
import unittest

os.environ.setdefault('ORGTREE_STORE', 'postgres')

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import store  # noqa: E402
from orgtree.orgdb.compat import sql  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
STORE = REPO / 'engine' / 'backend' / 'orgtree' / 'store.py'

#: values the variable parts of store.py's statements take, by name
EXPANSIONS = {
    'table': ('log_d', 'log_l'),
    'marks': ('?',),
    'scope_sql': ('sect=? AND owner=?', 'sect BETWEEN ? AND ?'),
    'insert_sql': ('INSERT INTO log_d(sect, owner, at, val) VALUES(?,?,?,?)',
                   'INSERT INTO log_l(sect, at, val) VALUES(?,?,?)'),
    'paths': ("'$.status','$.archived_at'",),
}

#: functions whose statements this mode never issues, with the reason
NOT_IN_THIS_MODE = {
    '_open_conn': 'SQLite connection setup',
    'verify_migration': 'the JSON -> SQLite migration (SQLite only)',
    'migrate_org': 'the JSON -> SQLite migration (SQLite only)',
    'read_document_gallery': 'its SQLite branch; on PostgreSQL it returns before them',
    'reconcile_receipt_storage': 'custody receipt rows (ORGTREE_RECEIPT_ROWS, off)',
    '_receipt_view': 'custody receipt rows (ORGTREE_RECEIPT_ROWS, off)',
    'delete_org': 'refused with the switch on (landing step 3) before any statement',
}

#: statements of NOT_IN_THIS_MODE functions that ARE reached (the guards): checked served
GUARDS: set[str] = set()

#: readers that run SQL on the raw connection; each must refuse with the switch on
RAW_READERS = ('archive_identity', 'archive_statuses', 'read_work_items_rows')

VERBS = ('BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'PRAGMA')


def _sites() -> list[dict]:
    """Every ``.execute``/``.executemany`` call in store.py with its function path."""
    tree = ast.parse(STORE.read_text(encoding='utf-8'))
    out: list[dict] = []
    stack: list[str] = []

    class V(ast.NodeVisitor):
        def visit_FunctionDef(self, n):
            stack.append(n.name)
            self.generic_visit(n)
            stack.pop()

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_ClassDef(self, n):
            stack.append(n.name)
            self.generic_visit(n)
            stack.pop()

        def visit_Call(self, n):
            f = n.func
            if isinstance(f, ast.Attribute) and f.attr in ('execute', 'executemany') and n.args:
                out.append({'line': n.lineno, 'func': '.'.join(stack),
                            'recv': ast.unparse(f.value), 'expr': n.args[0]})
            self.generic_visit(n)

    V().visit(tree)
    return out


def _calls_of(fn: str, argn: int) -> list[ast.AST]:
    tree = ast.parse(STORE.read_text(encoding='utf-8'))
    return [n.args[argn] for n in ast.walk(tree)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == fn
            and len(n.args) > argn]


def _render(e: ast.AST) -> list[str]:
    """Every concrete text ``e`` can be. Raises KeyError for a part it cannot resolve."""
    if isinstance(e, ast.Constant) and isinstance(e.value, str):
        return [e.value]
    if isinstance(e, ast.JoinedStr):
        parts = [_render(v.value) if isinstance(v, ast.FormattedValue) else [v.value]
                 for v in e.values]
        return [''.join(p) for p in itertools.product(*parts)]
    if isinstance(e, ast.Name):
        if e.id in EXPANSIONS:
            return list(EXPANSIONS[e.id])
        v = getattr(store, e.id, None)
        if isinstance(v, str):
            return [v]
        raise KeyError(e.id)
    if isinstance(e, ast.BinOp) and isinstance(e.op, ast.Add):
        return [a + b for a in _render(e.left) for b in _render(e.right)]
    if isinstance(e, ast.Subscript) and ast.unparse(e.value) == '_LOG_TAIL_SQLS':
        return list(store._LOG_TAIL_SQLS.values())
    if isinstance(e, ast.Call) and ast.unparse(e.func) == "','.join":
        return ['?']
    if isinstance(e, ast.Call) and ast.unparse(e.func) == '",".join':
        return ['?']
    raise KeyError(ast.unparse(e)[:60])


def _texts(site: dict) -> list[str]:
    func, e = site['func'], site['expr']
    if func == '_cas' and isinstance(e, ast.Name) and e.id == 'sql':
        return [t for arg in _calls_of('_cas', 1) for t in _render(arg)]
    if func == '_node_ids_where' and isinstance(e, ast.JoinedStr):
        wheres = [t for arg in _calls_of('_node_ids_where', 1) for t in _render(arg)]
        return [f"SELECT id FROM nodes WHERE {w} ORDER BY ord" for w in wheres]
    if func == 'read_transcript_source.body':
        return list(sql._transcript_source_sqls())
    src = ast.unparse(e)
    if func == '_write_log_rows' and 'scope_sql' in src:
        # each table with its own scope (_write_dict_log / _write_list_log)
        out = []
        for table, scope in (('log_d', 'sect=? AND owner=?'), ('log_l', 'sect BETWEEN ? AND ?')):
            saved = EXPANSIONS['table'], EXPANSIONS['scope_sql']
            EXPANSIONS['table'], EXPANSIONS['scope_sql'] = (table,), (scope,)
            try:
                out += _render(e)
            finally:
                EXPANSIONS['table'], EXPANSIONS['scope_sql'] = saved
        return out
    return _render(e)


class StatementsServed(unittest.TestCase):
    def test_every_statement_is_served(self) -> None:
        missing: list[str] = []
        unrendered: list[str] = []
        for site in _sites():
            if site['func'] in NOT_IN_THIS_MODE and site['func'] not in GUARDS:
                continue
            if site['recv'] in ('raw', 'conn.raw', 'c'):
                continue                       # raw connections: RAW_READERS below
            try:
                texts = _texts(site)
            except KeyError as e:
                unrendered.append(f"{site['line']} {site['func']}: {e}")
                continue
            for t in texts:
                if t.strip().upper().startswith(VERBS):
                    continue
                if sql.known(t) is None:
                    if site['func'] in NOT_IN_THIS_MODE:
                        continue               # a non-guard statement of a declined reader
                    missing.append(f"{site['line']} {site['func']}: {sql.normalize(t)[:160]}")
        self.assertEqual(unrendered, [], 'statements this test cannot render')
        self.assertEqual(missing, [], 'store.py statements the compatibility view does not serve')

    def test_window_reader_guards_are_answered(self) -> None:
        # piece A6: the bounded window readers' blob guards are answered from the org's
        # sections (they used to be declined, sending every window to a whole-org load)
        for t in (store._DOCUMENT_BLOB_SQL,
                  "SELECT 1 FROM doc WHERE key IN ('events','notice_log') LIMIT 1",
                  "SELECT 1 FROM doc WHERE key IN ('mail_log','user_mail_log') LIMIT 1"):
            self.assertEqual(sql.known(t), 'handler', t)
        self.assertEqual(sql.DECLINED, set())

    def test_listed_functions_exist(self) -> None:
        funcs = {s['func'] for s in _sites()}
        self.assertEqual(sorted(set(NOT_IN_THIS_MODE) - funcs), [],
                         'NOT_IN_THIS_MODE names functions store.py no longer has')

    def test_raw_readers_refuse_first(self) -> None:
        src = STORE.read_text(encoding='utf-8')
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name in RAW_READERS:
                body = ast.get_source_segment(src, node) or ''
                raw_at = body.find('raw.execute')
                guard_at = body.find('_orgdb_on()')
                self.assertNotEqual(guard_at, -1, f'{node.name} has no orgdb guard')
                self.assertLess(guard_at, raw_at, f'{node.name} runs raw SQL before its guard')

    def test_unknown_raises(self) -> None:
        with self.assertRaises(sql.UnknownStatement):
            sql.run(object(), "SELECT val FROM doc WHERE key LIKE ?", ('x%',))


if __name__ == '__main__':
    unittest.main()
