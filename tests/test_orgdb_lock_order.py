"""Static check of the org database's lock order (design §2.4, "Lock order"; no database needed).

The revision row (orgtree.org_revision) is the last lock a writer takes: the save seam
(OrgDbConn.on_save_commit, just before COMMIT) and the deferred triggers that run at COMMIT take
it. After it a transaction may wait only for rows that are themselves locked only under it. So
two writers can never hold the revision row and another lock each while waiting for the other's.

What it proves, over every org migration and the engine's Python:
  * a deferred (commit-time) trigger function writes or locks nothing but the revision row and
    the tables locked only under it, and takes the revision row before those;
  * no other function (a statement-time trigger, a plain function) writes or locks the revision
    row or those tables;
  * the engine's Python writes or locks the revision row only in OrgDbConn.on_save_commit, and
    never writes the tables locked under it.
The controls show the check rejects the round-2 settling that deadlocked in review f7 (a
commit-time trigger locking an owner's key row and rewriting the owner's mail rows), a
statement-time revision bump, a counter row taken before the revision row, and a Python write.

Run:  python tools/run-python-verification.py tests/test_orgdb_lock_order.py
"""

import ast
from pathlib import Path
import re
import unittest

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

REPO = Path(__file__).resolve().parent.parent
ORGTREE = REPO / 'engine' / 'backend' / 'orgtree'
MIGRATIONS = ORGTREE / 'pg_migrations' / 'org'

#: the revision row: the last lock (design §2.4)
REVISION = 'org_revision'
#: tables whose rows are locked only under the revision row (the migration that keeps them)
UNDER_REVISION = {'foreground_parent_counts': '0006_agents_readers.sql',
                  'docket_counters': '0012_docket_counts.sql'}
#: (module, function) of the engine's Python allowed to write or lock the revision row
PYTHON_REVISION_WRITERS = {('orgdb/compat/conn.py', 'on_save_commit')}

_FUNC = re.compile(r'CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(orgtree\.\w+)\s*\(', re.I)
_BODY = re.compile(r'\bAS\s+(\$\w*\$)', re.I)
_TRIGGER = re.compile(r'CREATE\s+(CONSTRAINT\s+)?TRIGGER\b', re.I)
_EXECUTE = re.compile(r'EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([\w.%]+)\s*\(', re.I)
_TOUCH = [re.compile(r'\bUPDATE\s+(?:ONLY\s+)?orgtree\.(\w+|%I)', re.I),
          re.compile(r'\bINSERT\s+INTO\s+orgtree\.(\w+|%I)', re.I),
          re.compile(r'\bDELETE\s+FROM\s+orgtree\.(\w+|%I)', re.I),
          re.compile(r'\bTRUNCATE\s+(?:TABLE\s+)?orgtree\.(\w+|%I)', re.I),
          re.compile(r'\bFROM\s+orgtree\.(\w+)\b[^;]*?\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b',
                     re.I | re.S)]


def functions(text: str) -> dict[str, tuple[bool, str]]:
    """name -> (a trigger function?, body), for every function a migration text defines."""
    out = {}
    for m in _FUNC.finditer(text):
        body_at = _BODY.search(text, m.end())
        if body_at is None:
            continue
        tag = body_at.group(1)
        end = text.find(tag, body_at.end())
        if end < 0:
            continue
        head = text[m.end():body_at.start()]
        trigger = re.search(r'\bRETURNS\s+trigger\b', head, re.I) is not None
        out[m.group(1)] = (trigger, text[body_at.end():end])
    return out


def deferred_triggers(text: str) -> tuple[set[str], list[str]]:
    """(functions fired by DEFERRABLE INITIALLY DEFERRED constraint triggers, problems), for the
    triggers a migration text creates, written out or in a format() string."""
    text = re.sub(r"'\s*\n\s*'", '', text)        # adjacent string literals are one string
    starts = [m for m in _TRIGGER.finditer(text)]
    fns, problems = set(), []
    for i, m in enumerate(starts):
        stop = starts[i + 1].start() if i + 1 < len(starts) else len(text)
        ex = _EXECUTE.search(text, m.end(), stop)
        if ex is None:
            problems.append(f'a trigger with no EXECUTE FUNCTION near {text[m.start():m.start() + 80]!r}')
            continue
        span = text[m.start():ex.start()]
        if m.group(1) and re.search(r'INITIALLY\s+DEFERRED', span, re.I):
            if '%' in ex.group(1):
                problems.append(f'a deferred trigger whose function is a format() argument: '
                                f'{span[:120]!r}; name it, so its lock order can be checked')
            fns.add(ex.group(1).lower())
    return fns, problems


def touches(body: str) -> list[tuple[int, str]]:
    """(position, table) of every write or row lock in a function body."""
    found = [(m.start(), m.group(1).lower()) for rx in _TOUCH for m in rx.finditer(body)]
    return sorted(found)


def violations(texts: dict[str, str]) -> list[str]:
    """Every breach of the lock order in these migration texts (file name -> text)."""
    defs: dict[str, tuple[str, bool, str]] = {}
    deferred: set[str] = set()
    out: list[str] = []
    for name in sorted(texts):
        for fn, (trigger, body) in functions(texts[name]).items():
            defs[fn.lower()] = (name, trigger, body)       # a later definition replaces it
        fns, problems = deferred_triggers(texts[name])
        deferred |= fns
        out += [f'{name}: {p}' for p in problems]
    guarded = {REVISION} | set(UNDER_REVISION)
    for fn in sorted(defs):
        name, trigger, body = defs[fn]
        hits = touches(body)
        if fn in deferred:
            for pos, table in hits:
                if table not in guarded:
                    out.append(f'{name}: deferred {fn} writes or locks orgtree.{table} at commit: only '
                               f'the revision row and the rows locked under it may be taken then')
            first_revision = min((p for p, t in hits if t == REVISION), default=None)
            for pos, table in hits:
                if table in UNDER_REVISION and (first_revision is None or pos < first_revision):
                    out.append(f'{name}: deferred {fn} takes orgtree.{table} before the revision row')
        else:
            kind = 'statement-time trigger' if trigger else 'function'
            for pos, table in hits:
                if table in guarded:
                    out.append(f'{name}: {kind} {fn} writes or locks orgtree.{table}: the revision row '
                               f'and the rows under it are taken at commit only')
    for fn in sorted(deferred - set(defs)):
        out.append(f'deferred trigger function {fn} is not defined in the org migrations')
    return out


_PY_TOUCH = re.compile(
    r'\b(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+|DELETE\s+FROM\s+|TRUNCATE\s+(?:TABLE\s+)?)orgtree\.(\w+)'
    r'|\bFROM\s+orgtree\.(\w+)\b[^;]*?\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b', re.I | re.S)


def python_violations(sources: dict[str, str]) -> list[str]:
    """Every string in these Python sources (relative path -> text) that writes or locks the
    revision row outside PYTHON_REVISION_WRITERS, or writes or locks a table under it."""
    out = []
    for rel in sorted(sources):
        tree = ast.parse(sources[rel], filename=rel)
        stack: list[str] = []

        def visit(node: ast.AST) -> None:
            named = isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            if named:
                stack.append(node.name)                                   # type: ignore[attr-defined]
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                for m in _PY_TOUCH.finditer(node.value):
                    table = (m.group(1) or m.group(2)).lower()
                    where = stack[-1] if stack else '<module>'
                    if table == REVISION and (rel, where) not in PYTHON_REVISION_WRITERS:
                        out.append(f'{rel}: {where} writes or locks orgtree.{REVISION}: only '
                                   f'{sorted(PYTHON_REVISION_WRITERS)} may (design §2.4)')
                    elif table in UNDER_REVISION:
                        out.append(f'{rel}: {where} writes or locks orgtree.{table}, which only its '
                                   f'deferred trigger keeps, under the revision row')
            for child in ast.iter_child_nodes(node):
                visit(child)
            if named:
                stack.pop()
        visit(tree)
    return out


#: the round-2 Sent key settling of org migration 0008 (b339c20), which deadlocked in review f7
F7_SETTLE = """
CREATE FUNCTION orgtree.mail_log_owner_pos_settle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE ids text; a bigint; kept bigint; first bigint;
BEGIN
  FOR a IN SELECT DISTINCT x::bigint FROM unnest(string_to_array(ids, ',')) AS x ORDER BY 1 LOOP
    SELECT f.first_id INTO kept FROM orgtree.mail_log_first f WHERE f.agent_id = a FOR UPDATE;
    INSERT INTO orgtree.mail_log_first AS f (agent_id, first_id) VALUES (a, first)
      ON CONFLICT (agent_id) DO UPDATE SET first_id = EXCLUDED.first_id
      WHERE f.first_id <> EXCLUDED.first_id;
    UPDATE orgtree.mail_log SET owner_pos = first
      WHERE agent_id = a AND (owner_pos < first OR owner_pos > first);
  END LOOP;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER mail_log_owner_pos_settle
  AFTER INSERT OR UPDATE OF agent_id, id OR DELETE ON orgtree.mail_log
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.mail_log_owner_pos_settle();
"""


def _migrations() -> dict[str, str]:
    return {p.name: p.read_text(encoding='utf-8') for p in sorted(MIGRATIONS.glob('*.sql'))}


class Migrations(unittest.TestCase):
    def test_the_org_migrations_keep_the_lock_order(self) -> None:
        texts = _migrations()
        self.assertTrue(texts)
        self.assertEqual(violations(texts), [])

    def test_the_tables_under_the_revision_row_are_still_kept_by_their_migrations(self) -> None:
        # the list must not go stale: each table is kept by a deferred trigger of its migration
        texts = _migrations()
        for table, name in UNDER_REVISION.items():
            with self.subTest(table=table):
                self.assertIn(name, texts)
                fns, _ = deferred_triggers(texts[name])
                self.assertTrue(any(table in {t for _, t in touches(body)}
                                    for fn, (_, body) in functions(texts[name]).items()
                                    if fn.lower() in fns), table)

    def test_the_check_sees_every_deferred_trigger(self) -> None:
        # the deferred trigger functions of today, written out and in format() strings
        found: set[str] = set()
        for text in _migrations().values():
            found |= deferred_triggers(text)[0]
        self.assertEqual(found, {'orgtree.foreground_flush', 'orgtree.events_count_flush',
                                 'orgtree.docket_archive_flush'})

    def test_control_the_round_2_settling_is_rejected(self) -> None:
        texts = _migrations()
        texts['0008_windows.sql'] += F7_SETTLE
        got = [v for v in violations(texts) if 'mail_log_owner_pos_settle' in v]
        self.assertTrue(any('orgtree.mail_log_first' in v for v in got), got)
        self.assertTrue(any('orgtree.mail_log at commit' in v for v in got), got)

    def test_control_a_statement_time_revision_bump_is_rejected(self) -> None:
        texts = {'0099_x.sql': """
CREATE FUNCTION orgtree.bump() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN UPDATE orgtree.org_revision SET rev = rev + 1 WHERE singleton; RETURN NULL; END $fn$;
CREATE TRIGGER bump AFTER INSERT ON orgtree.events FOR EACH STATEMENT EXECUTE FUNCTION orgtree.bump();
"""}
        self.assertEqual(len(violations(texts)), 1, violations(texts))
        self.assertIn('statement-time trigger orgtree.bump', violations(texts)[0])

    def test_control_a_counter_row_before_the_revision_row_is_rejected(self) -> None:
        texts = {'0099_x.sql': """
CREATE FUNCTION orgtree.count_flush() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE orgtree.docket_counters SET n = n + 1 WHERE kind = 'archive';
  PERFORM 1 FROM orgtree.org_revision WHERE singleton FOR UPDATE;
  RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER count_flush AFTER INSERT ON orgtree.work_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.count_flush();
"""}
        got = violations(texts)
        self.assertEqual(got, ['0099_x.sql: deferred orgtree.count_flush takes orgtree.docket_counters '
                               'before the revision row'])

    def test_control_a_dynamic_deferred_function_must_be_named(self) -> None:
        texts = {'0099_x.sql': """
DO $d$ BEGIN
  EXECUTE format('CREATE CONSTRAINT TRIGGER x AFTER INSERT ON orgtree.%I DEFERRABLE INITIALLY '
    'DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.%I()', 'events', 'f');
END $d$;
"""}
        self.assertTrue(any('format() argument' in v for v in violations(texts)), violations(texts))


class Python(unittest.TestCase):
    def test_only_the_save_seam_writes_the_revision_row(self) -> None:
        sources = {p.relative_to(ORGTREE).as_posix(): p.read_text(encoding='utf-8')
                   for p in sorted(ORGTREE.rglob('*.py')) if '__pycache__' not in p.parts}
        self.assertIn('orgdb/compat/conn.py', sources)
        self.assertEqual(python_violations(sources), [])
        # the allowed writer still exists, so the allowance cannot go stale
        self.assertIn('UPDATE orgtree.org_revision', sources['orgdb/compat/conn.py'])

    def test_control_another_writer_is_rejected(self) -> None:
        sources = {'orgdb/x.py': (
            'def bump(c):\n'
            '    c.execute("UPDATE orgtree.org_revision SET rev = rev + 1")\n'
            'def lock(c):\n'
            '    c.execute("SELECT n FROM orgtree.docket_counters WHERE kind = %s FOR UPDATE", ("a",))\n')}
        got = python_violations(sources)
        self.assertEqual(len(got), 2, got)
        self.assertIn('orgdb/x.py: bump writes or locks orgtree.org_revision', got[0])
        self.assertIn('orgdb/x.py: lock writes or locks orgtree.docket_counters', got[1])


if __name__ == '__main__':
    unittest.main()
