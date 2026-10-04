"""Static check of the org database's lock order (design §2.4, "Lock order"; no database needed).

The revision row (orgtree.org_revision) is the last lock a writer takes: the save seam
(OrgDbConn.on_save_commit, just before COMMIT) and the deferred triggers that run at COMMIT take
it. After it a transaction may wait only for rows that are themselves locked only under it. So
two writers can never hold the revision row and another lock each while waiting for the other's.
Before it, each writer locks only the rows its own statements write, in its own order: a trigger
that wrote or locked any other row would put a lock into every writer of its table, in an order
no writer chose (review A6 f8 and f9).

What it proves, over every org migration and the engine's Python:
  * a deferred (commit-time) trigger function, with every function it calls, writes or locks
    nothing but the revision row and the tables locked only under it, and takes the revision
    row before those;
  * a statement-time trigger function, with every function it calls, writes only link rows of
    its own statement's rows (a table with a foreign key to the trigger's table), takes no row
    lock (FOR UPDATE / FOR SHARE), and never touches the revision row or the tables under it;
  * no other function writes or locks a table;
  * no function forces deferred checks (SET CONSTRAINTS ... IMMEDIATE): that runs the commit-time
    triggers early, so the revision row would be taken before the statements that follow;
  * every foreign key to agents is immediate: a commit-time KEY SHARE check would wait for
    an agent after the revision row, reversing a writer's agent-before-revision order;
  * the engine's Python writes or locks the revision row only in OrgDbConn.on_save_commit, never
    writes the tables locked under it, and never forces deferred checks.
The controls show the check rejects the round-2 settling that deadlocked in review f7 (a
commit-time trigger locking an owner's key row and rewriting the owner's mail rows), round 3's
statement-time owner keys that deadlocked in f8 and f9, a link table of another table, a writing
trigger on a table it cannot name, a writing plain function, a statement-time revision bump, a
counter row taken before the revision row, a forced check, and a Python write.

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
# Design O1 decision5: this named eager helper may lock only ancestor-path
# aggregates, between the agent and item tiers. The exception is not general.
STATS_LOCK_HELPERS = {'orgtree.graph_apply'}

_FUNC = re.compile(r'CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(orgtree\.\w+)\s*\(', re.I)
_BODY = re.compile(r'\bAS\s+(\$\w*\$)', re.I)
_TRIGGER = re.compile(r'CREATE\s+(CONSTRAINT\s+)?TRIGGER\b', re.I)
_EXECUTE = re.compile(r'EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([\w.%]+)\s*\(', re.I)
_ON = re.compile(r'\bON\s+(?:ONLY\s+)?(?:orgtree\.)?(%I|\w+)', re.I)
_TOUCH = [re.compile(r'\bUPDATE\s+(?:ONLY\s+)?orgtree\.(\w+|%I)', re.I),
          re.compile(r'\bINSERT\s+INTO\s+orgtree\.(\w+|%I)', re.I),
          re.compile(r'\bDELETE\s+FROM\s+orgtree\.(\w+|%I)', re.I),
          re.compile(r'\bTRUNCATE\s+(?:TABLE\s+)?orgtree\.(\w+|%I)', re.I),
          re.compile(r'\bFROM\s+orgtree\.(\w+)\b[^;]*?\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b',
                     re.I | re.S)]
_ROW_LOCK = re.compile(r'\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b', re.I)
_FORCED = re.compile(r'\bSET\s+CONSTRAINTS\b[^;]*?\bIMMEDIATE\b', re.I | re.S)
_CALL = re.compile(r'\b(orgtree\.\w+)\s*\(', re.I)
_TABLE = re.compile(r'\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?orgtree\.(\w+)\s*\((.*?)\)\s*;', re.I | re.S)
_ALTER = re.compile(r'\bALTER\s+TABLE\s+(?:ONLY\s+)?orgtree\.(\w+)\b([^;]*);', re.I | re.S)
_REFERENCES = re.compile(r'\bREFERENCES\s+orgtree\.(\w+)', re.I)


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


def triggers(text: str) -> tuple[list[tuple[str, str, bool]], list[str]]:
    """([(function, table, deferred)], problems) for the triggers a migration text creates,
    written out or in a format() string. ``table`` is '%I' when a format() argument names it; a
    function named by one is listed as 'orgtree.%i' (`violations` then judges every trigger
    function no trigger names as if on a table it cannot name)."""
    text = re.sub(r"'\s*\n\s*'", '', text)        # adjacent string literals are one string
    starts = [m for m in _TRIGGER.finditer(text)]
    out, problems = [], []
    for i, m in enumerate(starts):
        stop = starts[i + 1].start() if i + 1 < len(starts) else len(text)
        ex = _EXECUTE.search(text, m.end(), stop)
        if ex is None:
            problems.append(f'a trigger with no EXECUTE FUNCTION near {text[m.start():m.start() + 80]!r}')
            continue
        span = text[m.start():ex.start()]
        deferred = bool(m.group(1)) and re.search(r'INITIALLY\s+DEFERRED', span, re.I) is not None
        if '%' in ex.group(1) and deferred:
            problems.append(f'a deferred trigger whose function is a format() argument: '
                            f'{span[:120]!r}; name it, so its lock order can be checked')
        on = _ON.search(span)
        out.append((ex.group(1).lower(), on.group(1).lower() if on else '%I', deferred))
    return out, problems


def deferred_triggers(text: str) -> tuple[set[str], list[str]]:
    """(functions fired by DEFERRABLE INITIALLY DEFERRED constraint triggers, problems)."""
    found, problems = triggers(text)
    return {fn for fn, _, deferred in found if deferred}, problems


def touches(body: str) -> list[tuple[int, str]]:
    """(position, table) of every write or row lock in a function body."""
    found = [(m.start(), m.group(1).lower()) for rx in _TOUCH for m in rx.finditer(body)]
    return sorted(found)


def _code(body: str) -> str:
    """A function body without its string literals (a function named in a string is not called)."""
    return re.sub(r"'(?:[^']|'')*'", "''", body)


def links(texts: dict[str, str]) -> dict[str, set[str]]:
    """table -> the tables with a foreign key to it: the link tables a trigger on it may write."""
    out: dict[str, set[str]] = {}
    for text in texts.values():
        for rx in (_TABLE, _ALTER):
            for m in rx.finditer(text):
                for ref in _REFERENCES.finditer(m.group(2)):
                    out.setdefault(ref.group(1).lower(), set()).add(m.group(1).lower())
    return out


def _ddl_without_comments(text: str) -> str:
    """Ignore nested SQL comments without treating quoted text as comments."""
    out, i, quote = [], 0, ''
    while i < len(text):
        c = text[i]
        if quote:
            out.append(c)
            i += 1
            if c == quote:
                if i < len(text) and text[i] == quote:
                    out.append(text[i])
                    i += 1
                else:
                    quote = ''
        elif c in "'\"":
            quote = c
            out.append(c)
            i += 1
        elif text.startswith('--', i):
            end = text.find('\n', i + 2)
            i = len(text) if end < 0 else end
            out.append(' ')
        elif text.startswith('/*', i):
            depth = 1
            i += 2
            while i < len(text) and depth:
                if text.startswith('/*', i):
                    depth += 1
                    i += 2
                elif text.startswith('*/', i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            out.append(' ')
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def _ddl_parts(body: str) -> list[str]:
    """Top-level comma-separated table columns or ALTER actions, with SQL quotes."""
    parts, start, depth, quote, i = [], 0, 0, '', 0
    while i < len(body):
        c = body[i]
        if quote:
            if c == quote:
                if i + 1 < len(body) and body[i + 1] == quote:
                    i += 1
                else:
                    quote = ''
        elif c in "'\"":
            quote = c
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif c == ',' and depth == 0:
            parts.append(body[start:i])
            start = i + 1
        i += 1
    return parts + [body[start:]]


def agent_fk_violations(texts: dict[str, str]) -> list[str]:
    """C1: reject creation or later alteration of a deferrable agent foreign key.

    INITIALLY IMMEDIATE is insufficient: SET CONSTRAINTS ALL DEFERRED can move
    that check to commit. Other deferred constraints (including docket slug
    uniqueness) keep their existing behavior. Track explicit and PostgreSQL's
    ordinary generated names so a later ALTER CONSTRAINT cannot evade the check.
    """
    known, out = set(), []
    for name in sorted(texts):
        text = _ddl_without_comments(texts[name])
        statements = sorted([(m.start(), False, m) for m in _TABLE.finditer(text)]
                            + [(m.start(), True, m) for m in _ALTER.finditer(text)])
        for _, alter, m in statements:
            table = m.group(1).lower()
            for part in _ddl_parts(m.group(2)):
                part = _code(part)  # words inside CHECK string literals are not FK clauses
                ref = _REFERENCES.search(part)
                con = re.search(r'\bCONSTRAINT\s+(\w+)', part, re.I)
                agent_fk = ref is not None and ref.group(1).lower() == 'agents'
                if agent_fk:
                    if con:
                        constraint = con.group(1).lower()
                    else:
                        fk = re.search(r'\bFOREIGN\s+KEY\s*\(([^)]+)\)', part, re.I)
                        cols = (fk.group(1) if fk else re.sub(
                            r'^\s*ADD\s+(?:COLUMN\s+)?', '', part, flags=re.I).strip().split()[0])
                        constraint = table + '_' + '_'.join(
                            c.strip().strip('"').lower() for c in cols.split(',')) + '_fkey'
                    known.add((table, constraint))
                elif alter and con and (table, con.group(1).lower()) in known:
                    agent_fk = re.search(r'\bALTER\s+CONSTRAINT\b', part, re.I) is not None
                    constraint = con.group(1).lower()
                    if re.search(r'\bDROP\s+CONSTRAINT\b', part, re.I):
                        known.discard((table, constraint))
                    rename = re.search(r'\bRENAME\s+CONSTRAINT\s+\w+\s+TO\s+(\w+)', part, re.I)
                    if rename:
                        known.discard((table, constraint))
                        known.add((table, rename.group(1).lower()))
                # Keep NOT DEFERRABLE distinct from DEFERRABLE, including a
                # comment between the two words. The latter is always unsafe.
                clause = re.sub(r'\bNOT\s+DEFERRABLE\b', '', part, flags=re.I)
                if agent_fk and re.search(r'\bDEFERRABLE\b', clause, re.I):
                    out.append(f'{name}: orgtree.{table}.{constraint} references agents and is '
                               'DEFERRABLE: agent foreign keys must be immediate (C1; decision 26)')
    return out


def violations(texts: dict[str, str]) -> list[str]:
    """Every breach of the lock order in these migration texts (file name -> text)."""
    defs: dict[str, tuple[str, bool, str]] = {}
    fired: list[tuple[str, str, bool, str]] = []
    out: list[str] = agent_fk_violations(texts)
    for name in sorted(texts):
        for fn, (trigger, body) in functions(texts[name]).items():
            defs[fn.lower()] = (name, trigger, body)       # a later definition replaces it
        found, problems = triggers(texts[name])
        fired += [(fn, table, deferred, name) for fn, table, deferred in found]
        out += [f'{name}: {p}' for p in problems]
    deferred = {fn for fn, _, d, _ in fired if d}
    calls = {fn: {c.lower() for c in _CALL.findall(_code(body))} & set(defs) - {fn}
             for fn, (_, _, body) in defs.items()}

    def reach(fn: str) -> list[str]:
        seen, todo = [], [fn]
        while todo:
            f = todo.pop()
            if f not in seen and f in defs:
                seen.append(f)
                todo += sorted(calls[f])
        return seen
    guarded = {REVISION} | set(UNDER_REVISION)
    linked = links(texts)
    judged: set[str] = set()
    for fn in sorted(deferred):
        for f in reach(fn):
            judged.add(f)
            name, _, body = defs[f]
            via = '' if f == fn else f' (through {f})'
            for _, table in touches(body):
                if table not in guarded:
                    out.append(f'{name}: deferred {fn}{via} writes or locks orgtree.{table} at commit: '
                               f'only the revision row and the rows locked under it may be taken then')
        hits = touches(defs[fn][2]) if fn in defs else []
        first_revision = min((p for p, t in hits if t == REVISION), default=None)
        for pos, table in hits:
            if table in UNDER_REVISION and (first_revision is None or pos < first_revision):
                out.append(f'{defs[fn][0]}: deferred {fn} takes orgtree.{table} before the revision row')
    attached = {fn for fn, _, _, _ in fired}
    statement = ({(fn, table, where) for fn, table, d, where in fired if not d and fn in defs}
                 | {(fn, '%i', defs[fn][0]) for fn in defs if defs[fn][1] and fn not in attached})
    for fn, table, where in sorted(statement):
        for f in reach(fn):
            judged.add(f)
            name, _, body = defs[f]
            via = '' if f == fn else f' (through {f})'
            stats_only = (fn == 'orgtree.graph_maintain_stats' and table == 'agents'
                          and f in STATS_LOCK_HELPERS
                          and {t for _, t in touches(body)} <= {'agent_subtree_stats'})
            if fn == 'orgtree.graph_maintain_stats' and table == 'agents':
                for target in sorted({t for _, t in touches(body)} - {'agent_subtree_stats'}):
                    out.append(f'{name}: eager {fn}{via} touches orgtree.{target}: '
                               'the named graph exception permits only ancestor-path stats')
            if _ROW_LOCK.search(_code(body)) and not stats_only:
                out.append(f'{name}: statement-time trigger {fn}{via} on orgtree.{table} takes a row lock: '
                           'a trigger locks no row its statement did not write (review A6 f8)')
            for t in sorted({t for _, t in touches(body)}):
                if t in guarded:
                    continue                               # reported below, once per function
                if table == '%i':
                    out.append(f'{where}: statement-time trigger {fn}{via} on a table named by format() '
                               f'writes orgtree.{t}: name the table, so the link can be checked')
                elif t not in linked.get(table, set()):
                    out.append(f'{name}: statement-time trigger {fn}{via} on orgtree.{table} writes or '
                               f'locks orgtree.{t}: a trigger writes only link rows of its own '
                               f"statement's rows (a table with a foreign key to orgtree.{table}), never "
                               'rows another writer could hold (review A6 f8, f9)')
    for fn in sorted(defs):
        name, trigger, body = defs[fn]
        hits = sorted(set(t for _, t in touches(body)))
        if _FORCED.search(_code(body)) or _FORCED.search(body):
            out.append(f'{name}: {fn} forces deferred checks (SET CONSTRAINTS ... IMMEDIATE): the '
                       'commit-time triggers would take the revision row before the statements after it')
        if fn in deferred:
            continue
        kind = 'statement-time trigger' if trigger else 'function'
        for table in hits:
            if table in guarded:
                out.append(f'{name}: {kind} {fn} writes or locks orgtree.{table}: the revision row '
                           f'and the rows under it are taken at commit only')
        if fn not in judged and not trigger and [t for t in hits if t not in guarded]:
            out.append(f'{name}: function {fn} writes or locks {", ".join("orgtree." + t for t in hits)} '
                       'outside a trigger: a writer writes in its own statements, in its own row order')
    for fn in sorted(deferred - set(defs)):
        out.append(f'deferred trigger function {fn} is not defined in the org migrations')
    return out


_PY_TOUCH = re.compile(
    r'\b(?:UPDATE\s+(?:ONLY\s+)?|INSERT\s+INTO\s+|DELETE\s+FROM\s+|TRUNCATE\s+(?:TABLE\s+)?)orgtree\.(\w+)'
    r'|\bFROM\s+orgtree\.(\w+)\b[^;]*?\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b', re.I | re.S)


def python_violations(sources: dict[str, str]) -> list[str]:
    """Every string in these Python sources (relative path -> text) that writes or locks the
    revision row outside PYTHON_REVISION_WRITERS, writes or locks a table under it, or forces
    deferred checks."""
    out = []
    for rel in sorted(sources):
        tree = ast.parse(sources[rel], filename=rel)
        stack: list[str] = []

        def visit(node: ast.AST) -> None:
            named = isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            if named:
                stack.append(node.name)                                   # type: ignore[attr-defined]
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                where = stack[-1] if stack else '<module>'
                for m in _PY_TOUCH.finditer(node.value):
                    table = (m.group(1) or m.group(2)).lower()
                    if table == REVISION and (rel, where) not in PYTHON_REVISION_WRITERS:
                        out.append(f'{rel}: {where} writes or locks orgtree.{REVISION}: only '
                                   f'{sorted(PYTHON_REVISION_WRITERS)} may (design §2.4)')
                    elif table in UNDER_REVISION:
                        out.append(f'{rel}: {where} writes or locks orgtree.{table}, which only its '
                                   f'deferred trigger keeps, under the revision row')
                if _FORCED.search(node.value):
                    out.append(f'{rel}: {where} forces deferred checks (SET CONSTRAINTS ... IMMEDIATE): '
                               'that takes the revision row before the statements after it (design §2.4)')
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

#: round 3's statement-time Sent keys of org migration 0008 (4afea43), as written there: an
#: arriving row takes its owner's mail_log_first row, and the settling at each statement's end
#: locks that row and rewrites the owner's other mail rows. Review f8 (an owner row against a mail
#: row another writer edited) and f9 (the owner row against a forced revision row) deadlocked on it
R3_OWNER_KEYS = """
CREATE TABLE orgtree.mail_log_first (
  agent_id bigint PRIMARY KEY REFERENCES orgtree.agents (id) ON DELETE CASCADE,
  first_id bigint NOT NULL
);
CREATE FUNCTION orgtree.mail_log_owner_pos_arrive() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE first bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.agent_id = OLD.agent_id AND NEW.id = OLD.id THEN
    RETURN NEW;
  END IF;
  INSERT INTO orgtree.mail_log_first AS f (agent_id, first_id) VALUES (NEW.agent_id, NEW.id)
    ON CONFLICT (agent_id) DO UPDATE SET first_id = EXCLUDED.first_id
    WHERE EXCLUDED.first_id < f.first_id;
  SELECT f.first_id INTO first FROM orgtree.mail_log_first f WHERE f.agent_id = NEW.agent_id;
  NEW.owner_pos := least(first, NEW.id);
  RETURN NEW;
END
$fn$;
CREATE TRIGGER mail_log_owner_pos_insert BEFORE INSERT ON orgtree.mail_log
  FOR EACH ROW EXECUTE FUNCTION orgtree.mail_log_owner_pos_arrive();
CREATE FUNCTION orgtree.mail_log_owner_pos_settle(owners bigint[]) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE a bigint; kept bigint; first bigint;
BEGIN
  FOR a IN SELECT DISTINCT x FROM unnest(owners) AS x WHERE x IS NOT NULL ORDER BY 1 LOOP
    SELECT f.first_id INTO kept FROM orgtree.mail_log_first f WHERE f.agent_id = a FOR UPDATE;
    first := NULL;
    IF kept IS NOT NULL THEN
      SELECT m.id INTO first FROM orgtree.mail_log m WHERE m.id = kept AND m.agent_id = a;
    END IF;
    IF first IS NULL THEN
      DELETE FROM orgtree.mail_log_first WHERE agent_id = a;
      CONTINUE;
    END IF;
    INSERT INTO orgtree.mail_log_first AS f (agent_id, first_id) VALUES (a, first)
      ON CONFLICT (agent_id) DO UPDATE SET first_id = EXCLUDED.first_id
      WHERE f.first_id <> EXCLUDED.first_id;
    UPDATE orgtree.mail_log SET owner_pos = first
      WHERE agent_id = a AND (owner_pos < first OR owner_pos > first);
  END LOOP;
END
$fn$;
CREATE FUNCTION orgtree.mail_log_owner_pos_settled() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,orgtree AS $fn$
DECLARE ids bigint[];
BEGIN
  IF TG_OP = 'INSERT' THEN SELECT array_agg(DISTINCT agent_id) INTO ids FROM new_rows;
  ELSE SELECT array_agg(DISTINCT agent_id) INTO ids FROM old_rows; END IF;
  PERFORM orgtree.mail_log_owner_pos_settle(ids);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER mail_log_owner_pos_inserted AFTER INSERT ON orgtree.mail_log
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.mail_log_owner_pos_settled();
CREATE TRIGGER mail_log_owner_pos_deleted AFTER DELETE ON orgtree.mail_log
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.mail_log_owner_pos_settled();
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
                                 'orgtree.docket_archive_flush', 'orgtree.graph_final_flush'})

    def test_final_cycle_assertion_follows_revision_and_adds_no_row_lock(self) -> None:
        migration = functions((MIGRATIONS / '0016_agent_graph.sql').read_text(encoding='utf-8'))
        guard = migration['orgtree.graph_final_flush'][1]
        kernel = migration['orgtree.graph_assert_final_cycles'][1]
        self.assertLess(guard.index('FROM orgtree.org_revision'),
                        guard.index('orgtree.graph_assert_final_cycles()'))
        self.assertEqual(touches(kernel), [])
        self.assertIsNone(_ROW_LOCK.search(_code(kernel)))
        source = ast.parse((ORGTREE / 'orgdb/compat/conn.py').read_text(encoding='utf-8'))
        callback = next(n for n in ast.walk(source) if isinstance(n, ast.FunctionDef)
                        and n.name == 'on_save_commit')
        calls = [n for n in ast.walk(callback) if isinstance(n, ast.Call)]
        revision = next(n for n in calls if isinstance(n.func, ast.Attribute)
                        and n.func.attr == 'execute' and n.args
                        and any('UPDATE orgtree.org_revision' in c.value for c in ast.walk(n.args[0])
                                if isinstance(c, ast.Constant) and isinstance(c.value, str)))
        assertion = next(n for n in calls if isinstance(n.func, ast.Attribute)
                         and n.func.attr == 'assert_final_cycles')
        notify = next(n for n in calls if isinstance(n.func, ast.Attribute)
                      and n.func.attr == 'execute' and n.args
                      and any('pg_notify' in c.value for c in ast.walk(n.args[0])
                              if isinstance(c, ast.Constant) and isinstance(c.value, str)))
        self.assertLess(revision.lineno, assertion.lineno)
        self.assertLess(assertion.lineno, notify.lineno)

    def test_the_check_sees_every_writing_trigger_and_its_link_table(self) -> None:
        # the statement-time triggers of today that write: each writes the link rows of its own
        # statement's rows, a table with a foreign key to the trigger's table
        texts = _migrations()
        defs = {}
        for text in texts.values():
            defs.update({fn.lower(): body for fn, (_, body) in functions(text).items()})
        writers = set()
        for text in texts.values():
            for fn, table, deferred in triggers(text)[0]:
                if not deferred and fn in defs and touches(defs[fn]):
                    writers.add((fn, table, tuple(sorted({t for _, t in touches(defs[fn])}))))
        self.assertEqual(writers, {('orgtree.event_refs_keep', 'events', ('event_refs',)),
                                   ('orgtree.docket_questions', 'asks', ('docket_question_links',))})
        self.assertIn('event_refs', links(texts)['events'])
        self.assertIn('docket_question_links', links(texts)['asks'])

    def test_eager_graph_exception_is_named_and_refuses_upstream_locks(self) -> None:
        texts = _migrations()
        graph_file = '0016_agent_graph.sql'
        helpers = functions(texts[graph_file])
        self.assertEqual({t for _, t in touches(helpers['orgtree.graph_apply'][1])},
                         {'agent_subtree_stats'})
        self.assertIn('ORDER BY agent_id FOR UPDATE', helpers['orgtree.graph_apply'][1])
        for table in ('agents', 'work_items', 'mailboxes', 'org_revision'):
            with self.subTest(table=table):
                faulty = dict(texts)
                faulty[graph_file] = faulty[graph_file].replace(
                    "paths:=orgtree.graph_path_ids(old_image||new_image);",
                    f'PERFORM 1 FROM orgtree.{table} FOR UPDATE; '
                    'paths:=orgtree.graph_path_ids(old_image||new_image);', 1)
                self.assertTrue(any('graph_apply' in v and table in v
                                    for v in violations(faulty)), violations(faulty))

    def test_control_the_round_2_settling_is_rejected(self) -> None:
        texts = _migrations()
        texts['0008_windows.sql'] += F7_SETTLE
        got = [v for v in violations(texts) if 'mail_log_owner_pos_settle' in v]
        self.assertTrue(any('orgtree.mail_log_first' in v for v in got), got)
        self.assertTrue(any('orgtree.mail_log at commit' in v for v in got), got)

    def test_control_round_3s_statement_time_owner_keys_are_rejected(self) -> None:
        # f8 and f9's lock: an arriving row takes its owner's shared row, and the settling locks
        # it and rewrites rows other writers write; 4afea43's own 0008 fails the same way
        texts = _migrations()
        texts['0008_windows.sql'] += R3_OWNER_KEYS
        got = violations(texts)
        arrive = [v for v in got if 'mail_log_owner_pos_arrive' in v]
        self.assertTrue(any('orgtree.mail_log_first' in v for v in arrive), got)
        settled = [v for v in got if 'mail_log_owner_pos_settled' in v]
        self.assertTrue(any('takes a row lock' in v and 'mail_log_owner_pos_settle)' in v
                            for v in settled), got)
        self.assertTrue(any('writes or locks orgtree.mail_log:' in v for v in settled), got)
        self.assertTrue(any('writes or locks orgtree.mail_log_first' in v for v in settled), got)
        self.assertEqual([v for v in got if 'mail_log_owner_pos' not in v], [])

    def test_control_a_link_table_of_another_table_is_rejected(self) -> None:
        # docket_question_links follows asks, so a trigger on events may not write it
        texts = _migrations()
        texts['0099_x.sql'] = """
CREATE FUNCTION orgtree.x() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN DELETE FROM orgtree.docket_question_links WHERE item_slug = 'x'; RETURN NULL; END $fn$;
CREATE TRIGGER x AFTER INSERT ON orgtree.events FOR EACH STATEMENT EXECUTE FUNCTION orgtree.x();
"""
        got = violations(texts)
        self.assertEqual(len(got), 1, got)
        self.assertIn('statement-time trigger orgtree.x on orgtree.events writes or locks '
                      'orgtree.docket_question_links', got[0])

    def test_control_a_writing_trigger_on_a_format_table_must_name_it(self) -> None:
        texts = _migrations()
        texts['0099_x.sql'] = """
CREATE FUNCTION orgtree.x() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN INSERT INTO orgtree.event_refs (ref, win_at, event_id) VALUES ('r', '', 1); RETURN NULL; END $fn$;
DO $d$ BEGIN
  EXECUTE format('CREATE TRIGGER x AFTER INSERT ON orgtree.%I FOR EACH STATEMENT '
    'EXECUTE FUNCTION orgtree.x()', 'events');
END $d$;
"""
        got = violations(texts)
        self.assertTrue(any('on a table named by format() writes orgtree.event_refs' in v for v in got), got)

    def test_control_a_writing_plain_function_is_rejected(self) -> None:
        texts = _migrations()
        texts['0099_x.sql'] = """
CREATE FUNCTION orgtree.x(a bigint) RETURNS void LANGUAGE sql AS $fn$
 UPDATE orgtree.mail_log SET body = 'x' WHERE agent_id = a $fn$;
"""
        got = violations(texts)
        self.assertEqual(got, ['0099_x.sql: function orgtree.x writes or locks orgtree.mail_log outside a '
                               'trigger: a writer writes in its own statements, in its own row order'])

    def test_control_a_forced_check_in_a_function_is_rejected(self) -> None:
        texts = _migrations()
        texts['0099_x.sql'] = """
CREATE FUNCTION orgtree.x() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN SET CONSTRAINTS ALL IMMEDIATE; END $fn$;
"""
        got = violations(texts)
        self.assertEqual(len(got), 1, got)
        self.assertIn('orgtree.x forces deferred checks', got[0])

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


class AgentForeignKeys(unittest.TestCase):
    def test_every_agent_foreign_key_is_immediate(self) -> None:
        self.assertEqual(agent_fk_violations(_migrations()), [])

    def test_control_inline_and_table_foreign_keys_cannot_defer(self) -> None:
        for definition in (
                'holder_id bigint REFERENCES orgtree.agents(id) DEFERRABLE INITIALLY DEFERRED',
                'holder_id bigint REFERENCES orgtree.agents(id) DEFERRABLE INITIALLY IMMEDIATE',
                'holder_id bigint, CONSTRAINT holder FOREIGN KEY (holder_id) '
                'REFERENCES orgtree.agents(id) DEFERRABLE',
                'holder_id bigint, reviewer_id bigint, FOREIGN KEY (holder_id, reviewer_id) '
                'REFERENCES orgtree.agents(id, id) DEFERRABLE'):
            with self.subTest(definition=definition):
                got = violations({'0099_x.sql': f'CREATE TABLE orgtree.seats ({definition});'})
                self.assertEqual(len(got), 1, got)
                self.assertIn('agent foreign keys must be immediate', got[0])

    def test_control_added_foreign_keys_cannot_defer(self) -> None:
        for action in (
                'ADD COLUMN holder_id bigint REFERENCES orgtree.agents(id) DEFERRABLE',
                'ADD CONSTRAINT holder FOREIGN KEY (holder_id) REFERENCES orgtree.agents(id) '
                'DEFERRABLE INITIALLY IMMEDIATE'):
            with self.subTest(action=action):
                got = agent_fk_violations({'0099_x.sql': f'ALTER TABLE orgtree.seats {action};'})
                self.assertEqual(len(got), 1, got)

    def test_control_later_alter_cannot_make_an_existing_key_deferrable(self) -> None:
        for definition, constraint in (
                ('holder_id bigint REFERENCES orgtree.agents(id)', 'seats_holder_id_fkey'),
                ('holder_id bigint, CONSTRAINT holder FOREIGN KEY (holder_id) '
                 'REFERENCES orgtree.agents(id)', 'holder')):
            with self.subTest(constraint=constraint):
                got = agent_fk_violations({
                    '0001.sql': f'CREATE TABLE orgtree.seats ({definition});',
                    '0002.sql': f'ALTER TABLE orgtree.seats ALTER CONSTRAINT {constraint} '
                                'DEFERRABLE INITIALLY IMMEDIATE;'})
                self.assertEqual(len(got), 1, got)
                self.assertIn('0002.sql', got[0])

    def test_control_renaming_a_constraint_does_not_hide_its_agent_reference(self) -> None:
        got = agent_fk_violations({'0001.sql': '''
CREATE TABLE orgtree.seats (holder_id bigint REFERENCES orgtree.agents(id));
ALTER TABLE orgtree.seats RENAME CONSTRAINT seats_holder_id_fkey TO renamed;
ALTER TABLE orgtree.seats ALTER CONSTRAINT renamed DEFERRABLE;
'''})
        self.assertEqual(len(got), 1, got)
        self.assertIn('.renamed', got[0])

    def test_immediate_agent_keys_and_other_deferred_constraints_are_distinct(self) -> None:
        got = agent_fk_violations({'0001.sql': '''
CREATE TABLE orgtree.seats (
  holder_id bigint REFERENCES orgtree.agents(id) NOT DEFERRABLE,
  reviewer_id bigint REFERENCES orgtree.agents(id),
  slug text CHECK (slug <> 'DEFERRABLE, -- /* text */'),
  UNIQUE (slug) DEFERRABLE INITIALLY DEFERRED,
  item_id bigint REFERENCES orgtree.work_items(id) DEFERRABLE
);
ALTER TABLE orgtree.seats ALTER CONSTRAINT seats_holder_id_fkey NOT DEFERRABLE;
ALTER TABLE orgtree.seats ADD CONSTRAINT items FOREIGN KEY (item_id)
  REFERENCES orgtree.work_items(id) DEFERRABLE;
'''})
        self.assertEqual(got, [])

    def test_comments_cannot_add_or_hide_a_deferral_clause(self) -> None:
        texts = {'0001.sql': '''
-- REFERENCES orgtree.agents(id) DEFERRABLE
CREATE TABLE orgtree.seats (
  holder_id bigint REFERENCES /* nested /* misleading DEFERRABLE */ comment */ orgtree.agents(id)
    NOT /* DEFERRABLE */ DEFERRABLE,
  reviewer_id bigint REFERENCES orgtree.agents(id) -- immediate by default
);
''' }
        self.assertEqual(agent_fk_violations(texts), [])
        texts['0002.sql'] = '''ALTER TABLE orgtree.seats
ALTER CONSTRAINT seats_holder_id_fkey /* NOT DEFERRABLE */ DEFERRABLE;'''
        got = agent_fk_violations(texts)
        self.assertEqual(len(got), 1, got)
        self.assertIn('0002.sql', got[0])

    def test_dropping_a_key_stops_tracking_that_constraint_name(self) -> None:
        self.assertEqual(agent_fk_violations({'0001.sql': '''
CREATE TABLE orgtree.seats (holder_id bigint REFERENCES orgtree.agents(id));
ALTER TABLE orgtree.seats DROP CONSTRAINT seats_holder_id_fkey;
ALTER TABLE orgtree.seats ADD CONSTRAINT seats_holder_id_fkey
  FOREIGN KEY (item_id) REFERENCES orgtree.work_items(id) DEFERRABLE;
ALTER TABLE orgtree.seats ALTER CONSTRAINT seats_holder_id_fkey DEFERRABLE;
'''}), [])


class Python(unittest.TestCase):
    def test_bound_run_fence_precedes_the_native_action_lock_phase(self) -> None:
        tree = ast.parse((ORGTREE / 'orgdb/compat/tx.py').read_text(encoding='utf-8'))
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)
                      and n.name == 'transaction_many')
        calls = [n for n in ast.walk(method) if isinstance(n, ast.Call)]
        fence = next(n for n in calls if isinstance(n.func, ast.Attribute)
                     and n.func.attr == 'fence' and isinstance(n.func.value, ast.Name)
                     and n.func.value.id == 'turn_context')
        action = [n for n in calls if isinstance(n.func, ast.Attribute)
                  and n.func.attr == 'execute' and n.args
                  and any('pg_advisory_xact_lock' in x.value for x in ast.walk(n.args[0])
                          if isinstance(x, ast.Constant) and isinstance(x.value, str))]
        self.assertTrue(action, 'the native action lock phase disappeared')
        self.assertLess(fence.lineno, min(n.lineno for n in action))

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

    def test_control_a_forced_check_is_rejected(self) -> None:
        # review f9's first step; deferring a check again is allowed
        sources = {'orgdb/x.py': (
            'def force(c):\n'
            '    c.execute("SET CONSTRAINTS ALL IMMEDIATE")\n'
            'def defer(c):\n'
            '    c.execute("SET CONSTRAINTS orgtree.events_count_flush DEFERRED")\n')}
        got = python_violations(sources)
        self.assertEqual(len(got), 1, got)
        self.assertIn('orgdb/x.py: force forces deferred checks', got[0])


def rename_lock_violations(source: str) -> list[str]:
    """The explicit name handoff locks agents, then names, then updates names."""
    tree = ast.parse(source)
    fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
              and node.name == 'prepass')
    statements, name_locks = [], []
    for node in ast.walk(fn):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr == 'lock' and isinstance(node.func.value, ast.Name) \
                    and node.func.value.id == 'names':
                name_locks.append(node.lineno)
            if node.func.attr == 'execute' and node.args and isinstance(node.args[0], ast.Constant):
                statements.append((node.lineno, node.args[0].value))
    rows = [line for line, sql in statements if 'FOR UPDATE' in sql and 'orgtree.agents' in sql]
    updates = [line for line, sql in statements if sql.startswith('UPDATE orgtree.agents SET name=')]
    if not rows or not updates or not name_locks \
            or not min(rows) < min(name_locks) < min(updates):
        return ['native rename must lock agents before target names before its name UPDATE']
    if any('orgtree.org_revision' in sql for _, sql in statements):
        return ['native rename must stay before the revision tier']
    return []


class NativeRenameOrder(unittest.TestCase):
    def test_the_explicit_prepass_locks_before_renaming(self):
        source = (REPO / 'engine/backend/orgtree/orgdb/renames.py').read_text(encoding='utf-8')
        self.assertEqual(rename_lock_violations(source), [])

    def test_control_missing_row_or_name_lock_is_rejected(self):
        source = (REPO / 'engine/backend/orgtree/orgdb/renames.py').read_text(encoding='utf-8')
        self.assertTrue(rename_lock_violations(source.replace('FOR UPDATE', '')))
        self.assertTrue(rename_lock_violations(source.replace('names.lock(target)', 'pass')))


if __name__ == '__main__':
    unittest.main()
