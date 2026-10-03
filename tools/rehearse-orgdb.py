"""Rehearse conversion through the real engine start, on disposable copies only.

Run under tools/p03-run.ps1 -Wait (one database stream, memory gates). Supply
--custodian and --pg-bin to provision a private cluster, or set ADMIN and RUNTIME
to YOUR disposable dev cluster and use --template. Sources are never modified.

Inputs: --template DATABASE, --dump FILE, --legacy-sql FILE, or --sqlite-orgs
FOLDER. --release 3.1.0 applies exactly legacy migrations 0001-0020 on the copy.
--side-files ROOT optionally supplies the listed machine-wide files (copied only
into the private temporary root). --fault selects one Q12 fresh-copy rehearsal.
Each invocation runs both plain and instrumented starts and compares outcomes.
Only counts, hashes, timings and outcomes leave the temporary directory; source
documents captured before mapping, converter logs and reports are deleted.
"""
from __future__ import annotations

from pathlib import Path
import sys
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
PROVENANCE = assert_repo_import(REPO)

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid

FILES = ('store-backend.json', 'accounts-registry.json', 'reply-events.sqlite3',
         'file-deliveries.db', 'pre-postgres')
FAULTS = {'none': 'active', 'unknown-section': 'unknown-report',
          'bad-enum-agent': 'active', 'bad-type-agent': 'report',
          'dup-slug': 'unavailable', 'unparseable-time': 'report', 'nul-text': 'report'}
CAPTURE_ENV = 'REHEARSAL_SOURCE_DIR'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def framed_digest(rows):
    """Streaming SHA256 with length framing: row boundaries cannot collide."""
    h = hashlib.sha256()
    count = 0
    for row in rows:
        data = row.encode('utf-8')
        h.update(len(data).to_bytes(8, 'big'))
        h.update(data)
        count += 1
    return {'count': count, 'sha256': h.hexdigest()}


def file_manifest(root):
    """Specified immutable files only; conversion reports are expected additions."""
    root = Path(root)
    paths = [root / name for name in FILES]
    paths += sorted((root / 'orgs').glob('*.pg'))
    result = {}
    for p in paths:
        key = p.relative_to(root).as_posix()
        if not p.exists():
            result[key] = None
        elif p.is_dir():
            result[key + '/'] = 'directory'
            for child in sorted(p.rglob('*')):
                require(not child.is_symlink(), 'manifest refuses symlinks')
                if child.is_file():
                    result[child.relative_to(root).as_posix()] = hashlib.sha256(child.read_bytes()).hexdigest()
        else:
            require(not p.is_symlink(), 'manifest refuses symlinks')
            result[key] = hashlib.sha256(p.read_bytes()).hexdigest()
    return result


def scrub(env):
    return {k: v for k, v in env.items() if not k.upper().startswith(
        ('ORGTREE_', 'PYTHON', 'OPENAI_', 'CLAUDE_', 'CODEX_', 'ANTHROPIC_',
         'GEMINI_', 'ADMIN', 'RUNTIME', 'REHEARSAL_'))}


def capture_command(args, tool):
    """Inject only before the converter import; every other launch is identical."""
    anchor = 'from orgtree.orgdb.convert.__main__ import main;'
    if not isinstance(args, (list, tuple)) or len(args) < 3 or args[1] != '-c' \
            or anchor not in args[2]:
        return args
    result = list(args)
    preamble = 'import runpy; runpy.run_path(' + repr(str(tool)) + ", run_name='rehearsal_capture'); "
    result[2] = result[2].replace(anchor, preamble + anchor, 1)
    return result


def install_capture():
    # Called only inside the real converter child. Capture BEFORE mapper execution.
    from orgtree.orgdb.convert import legacy
    original = legacy.load_document
    folder = Path(os.environ[CAPTURE_ENV])
    folder.mkdir(parents=True, exist_ok=True)

    def load(org):
        loaded = original(org)
        (folder / (str(int(org.org_id)) + '.json')).write_text(
            json.dumps(loaded[0], ensure_ascii=False), encoding='utf-8')
        return loaded

    legacy.load_document = load


@contextlib.contextmanager
def instrument(enabled):
    if not enabled:
        yield
        return
    original = subprocess.Popen

    def launch(args, *rest, **kwargs):
        return original(capture_command(args, Path(__file__).resolve()), *rest, **kwargs)

    subprocess.Popen = launch
    try:
        yield
    finally:
        subprocess.Popen = original


class MemorySamples:
    def __init__(self):
        self.parent_peak = self.child_peak = self.tree_peak = self.samples = 0
        self.parent_os_peak = self.child_os_peak = 0
        self.children = set()

    def add(self, parent, children):
        self.samples += 1
        self.parent_peak = max(self.parent_peak, parent)
        self.child_peak = max(self.child_peak, sum(children.values()))
        self.tree_peak = max(self.tree_peak, parent + sum(children.values()))
        self.children.update(children)

    def report(self):
        return {'parent_peak_rss_bytes': self.parent_peak,
                'children_peak_rss_bytes': self.child_peak, 'tree_peak_rss_bytes': self.tree_peak,
                'parent_process_os_peak_bytes': self.parent_os_peak,
                'largest_child_process_os_peak_bytes': self.child_os_peak,
                'samples': self.samples, 'children_observed': len(self.children), 'interval_ms': 10,
                'measurement': 'RSS sampled during startup; OS process high-water marks include earlier work'}


def free_commit():
    if os.name != 'nt':
        import psutil
        return psutil.virtual_memory().available
    import ctypes
    class Status(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [
            (name, ctypes.c_ulonglong) for name in ('total_phys', 'avail_phys', 'total_page',
                                                   'avail_page', 'total_virtual', 'avail_virtual', 'extended')]
    status = Status()
    status.length = ctypes.sizeof(status)
    require(ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)), 'memory status unavailable')
    return status.avail_page


@contextlib.contextmanager
def memory_monitor():
    import psutil
    samples, stop = MemorySamples(), threading.Event()
    parent = psutil.Process()
    errors = []

    def sample():
        while not stop.is_set():
            try:
                children = {}
                for child in parent.children(recursive=True):
                    with contextlib.suppress(psutil.NoSuchProcess):
                        info = child.memory_info()
                        children[child.pid] = info.rss
                        samples.child_os_peak = max(samples.child_os_peak, getattr(info, 'peak_wset', info.rss))
                info = parent.memory_info()
                samples.parent_os_peak = max(samples.parent_os_peak, getattr(info, 'peak_wset', info.rss))
                samples.add(info.rss, children)
                # Windows committed memory, not merely physical free RAM.
                free = free_commit()
                if free < 10 * 1024 ** 3:
                    errors.append('free commit memory fell below 10 GB')
                    for child in parent.children(recursive=True):
                        with contextlib.suppress(psutil.NoSuchProcess):
                            child.kill()
                    return
            except Exception as exc:
                errors.append(type(exc).__name__)
                return
            stop.wait(.01)

    thread = threading.Thread(target=sample, name='rehearsal-memory')
    thread.start()
    try:
        yield samples
    finally:
        stop.set()
        thread.join()
        require(not errors, 'memory monitoring failed: ' + ','.join(errors))


def with_db(base, db):
    from psycopg.conninfo import make_conninfo
    return make_conninfo(base, dbname=db)


def inventory(base, db):
    """Independent inventory of EVERY non-system legacy table, all orgs and side tables."""
    import psycopg
    from psycopg import sql
    out = {}
    with psycopg.connect(with_db(base, db)) as c:
        c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        c.execute("SET LOCAL TIME ZONE 'UTC'")
        c.execute("SET LOCAL DateStyle = 'ISO, YMD'")
        tables = c.execute("SELECT table_schema, table_name FROM information_schema.tables "
                           "WHERE table_type='BASE TABLE' AND table_schema NOT IN "
                           "('pg_catalog','information_schema') ORDER BY 1,2").fetchall()
        for i, (schema, table) in enumerate(tables):
            with c.cursor(name='rehearsal_inventory_' + str(i)) as cur:
                cur.itersize = 1000
                cur.execute(sql.SQL('SELECT row_to_json(t)::text FROM {}.{} t '
                                    'ORDER BY row_to_json(t)::text COLLATE "C"')
                            .format(sql.Identifier(schema), sql.Identifier(table)))
                out[schema + '.' + table] = framed_digest(row[0] for row in cur)
        c.rollback()
    require(out, 'legacy inventory is empty')
    return out


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


def child_env(root, prefix, admin, runtime):
    home = Path(root) / 'home'
    home.mkdir(exist_ok=True)
    env = scrub(os.environ)
    env.update(ADMIN=admin, RUNTIME=runtime, HOME=str(home), USERPROFILE=str(home),
               ORGTREE_ORGDB_PREFIX=prefix, ORGTREE_DATA=str(Path(root) / 'data'),
               PYTHONIOENCODING='utf-8', REHEARSAL_SOURCE_DIR=str(Path(root) / 'sources'))
    return env


def sqlite_copy(source, target):
    """Back up an OFFLINE copy, including committed WAL, never opening the input.

    Even mode=ro can create SQLite -shm/-wal files beside an input. Copy the
    offline database and sidecars into private storage before SQLite opens it.
    """
    source = Path(source)
    with tempfile.TemporaryDirectory(prefix='rehearsal-sqlite-read-') as folder:
        private = Path(folder) / 'input.db'
        shutil.copyfile(source, private)
        for suffix in ('-wal', '-shm'):
            if Path(str(source) + suffix).is_file():
                shutil.copyfile(str(source) + suffix, str(private) + suffix)
        with contextlib.closing(sqlite3.connect(private.resolve().as_uri() + '?mode=ro', uri=True)) as src, \
                contextlib.closing(sqlite3.connect(target)) as dest:
            with dest:
                src.backup(dest)


def import_sqlite(a, data, database):
    importer = module('rehearsal_pgimport', REPO / 'tools/pypg/pgimport.py')
    originals = {}
    for source in sorted(Path(a.sqlite_orgs).glob('*.db')):
        originals[source.name] = hashlib.sha256(source.read_bytes()).hexdigest()
        sqlite_copy(source, data / 'orgs' / source.name)
    require(originals, '--sqlite-orgs has no .db files')
    # First-launch CLI, including --hold-back and cutover/moves. Only the cluster
    # attachment is supplied by the harness; no loader/import/move is replaced.
    @contextlib.contextmanager
    def own_database(*_):
        yield with_db(os.environ['ADMIN'], database)
    original = importer.database
    importer.database = own_database
    (data / importer.PROTOTYPE_MARKER).write_text('{}', encoding='utf-8')
    try:
        code = importer.main(['import', '--root', str(data), '--custodian', str(a.custodian),
                              '--hold-back', '--cutover', '--out', str(data.parent / 'import.json')])
        require(code == 0, 'first-launch --hold-back import failed')
        imported = json.loads((data.parent / 'import.json').read_text(encoding='utf-8'))
        require(not imported.get('held_back'), 'first-launch import held back an input org')
        require(set(imported.get('orgs', {})) == {Path(name).stem for name in originals},
                'first-launch import did not cover every supplied SQLite org')
    finally:
        importer.database = original
    require(originals == {s.name: hashlib.sha256(s.read_bytes()).hexdigest()
                          for s in sorted(Path(a.sqlite_orgs).glob('*.db'))}, 'SQLite input changed')


def prepare(a, database, data):
    import psycopg
    from psycopg import sql
    admin = os.environ['ADMIN']
    with psycopg.connect(admin, autocommit=True) as c:
        statement = sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database))
        if a.template:
            statement += sql.SQL(' TEMPLATE {}').format(sql.Identifier(a.template))
        c.execute(statement)
    (data / 'orgs').mkdir(parents=True)
    if a.side_files:
        for name in FILES:
            source = Path(a.side_files) / name
            if source.is_dir():
                shutil.copytree(source, data / name)
            elif source.is_file():
                if source.suffix in ('.sqlite3', '.db'):
                    sqlite_copy(source, data / name)
                else:
                    shutil.copyfile(source, data / name)
    if a.sqlite_orgs:
        import_sqlite(a, data, database)
    elif a.dump or a.legacy_sql:
        binary = Path(a.pg_bin) / ('pg_restore.exe' if a.dump else 'psql.exe')
        argv = [str(binary), '--dbname', with_db(admin, database)]
        argv += ['--exit-on-error', '--no-owner', str(a.dump)] if a.dump \
            else ['--set', 'ON_ERROR_STOP=1', '--file', str(a.legacy_sql)]
        done = subprocess.run(argv, capture_output=True, timeout=240)
        require(done.returncode == 0, 'restore failed (private worker log has details)')
    if a.release == '3.1.0':
        from orgtree import pgstore
        with tempfile.TemporaryDirectory(prefix='rehearsal-legacy-migrations-') as folder:
            files = [p for p in pgstore.migration_files() if int(p.name[:4]) <= 20]
            require(len(files) == 20, 'expected exactly twenty published legacy migrations')
            for p in files:
                shutil.copyfile(p, Path(folder) / p.name)
            with psycopg.connect(with_db(admin, database), autocommit=True) as c:
                pgstore.migrate(c, Path(folder))
    with psycopg.connect(with_db(admin, database)) as c:
        level = c.execute('SELECT count(*) FROM public.schema_migrations').fetchone()[0]
        require(level == (19 if a.release == '3.0.9' else 20), 'legacy migration level differs from release input')
        orgs = c.execute('SELECT org_id, slug FROM public.orgs WHERE deleted_at IS NULL '
                         'ORDER BY slug COLLATE "C"').fetchall()
        require(orgs, 'no live legacy orgs')
        for org_id, slug in orgs:
            require(Path(slug).name == slug and '/' not in slug and '\\' not in slug,
                    'unsafe legacy marker slug')
            marker = data / 'orgs' / (slug + '.pg')
            if not marker.exists():
                marker.write_text(json.dumps({'org_id': org_id, 'slug': slug}), encoding='utf-8')
    return orgs


def plant(base, database, org_id, fault):
    """Return an exact-value undo function. Changes are confined to the private copy."""
    import psycopg
    from psycopg import sql
    schema = sql.Identifier('org_' + str(int(org_id)))
    source_path, expected_value = None, None
    with psycopg.connect(with_db(base, database)) as c:
        if fault == 'unknown-section':
            c.execute(sql.SQL('INSERT INTO {}.doc(key,val) VALUES (%s,%s)').format(schema),
                      ('zz_unknown_section', '{}'))
            undo_sql, undo_args = sql.SQL("DELETE FROM {}.doc WHERE key='zz_unknown_section'").format(schema), ()
            source_path, expected_value = ('zz_unknown_section',), {}
        elif fault == 'nul-text':
            old = c.execute(sql.SQL("SELECT val FROM {}.doc WHERE key='name'").format(schema)).fetchone()
            require(old is not None, "nul-text requires the org's name setting")
            c.execute(sql.SQL("UPDATE {}.doc SET val=%s WHERE key='name'").format(schema),
                      (json.dumps('rehearsal\x00name'),))
            undo_sql, undo_args = sql.SQL("UPDATE {}.doc SET val=%s WHERE key='name'").format(schema), (old[0],)
            source_path, expected_value = ('name',), 'rehearsal\x00name'
        elif fault == 'dup-slug':
            c.execute('SET LOCAL session_replication_role=replica')
            row = c.execute(sql.SQL("INSERT INTO {}.log_l(sect,at,val) SELECT sect,at,val FROM {}.log_l "
                                    "WHERE sect='work_items_archive' ORDER BY seq LIMIT 1 RETURNING seq")
                            .format(schema, schema)).fetchone()
            require(row, 'dup-slug requires an archived docket item')
            undo_sql, undo_args = sql.SQL('DELETE FROM {}.log_l WHERE seq=%s').format(schema), (row[0],)
        else:
            row = c.execute(sql.SQL('SELECT id,val FROM {}.nodes ORDER BY id LIMIT 1').format(schema)).fetchone()
            require(row, 'fault requires an agent')
            doc = json.loads(row[1])
            key, value = {'bad-enum-agent': ('state', 'zz-state'),
                          'bad-type-agent': ('grant', 'lots'),
                          'unparseable-time': ('created', 'not-a-date')}[fault]
            doc[key] = value
            source_path, expected_value = ('nodes', row[0], key), value
            c.execute(sql.SQL('UPDATE {}.nodes SET val=%s WHERE id=%s').format(schema),
                      (json.dumps(doc), row[0]))
            undo_sql, undo_args = sql.SQL('UPDATE {}.nodes SET val=%s WHERE id=%s').format(schema), (row[1], row[0])

    def undo():
        with psycopg.connect(with_db(base, database)) as c:
            c.execute('SET TRANSACTION READ WRITE')
            if fault == 'dup-slug':
                c.execute('SET LOCAL session_replication_role=replica')
            require(c.execute(undo_sql, undo_args).rowcount == 1, 'fault undo affected a different row count')
    undo.source_path, undo.expected_value = source_path, expected_value
    return undo


def receipts(base, database, org_id):
    import psycopg
    with psycopg.connect(with_db(base, database)) as c:
        rows = c.execute('SELECT op_key,fingerprint,result,at FROM public.receipts '
                         'WHERE org_id=%s ORDER BY op_key COLLATE "C"', (org_id,)).fetchall()
    return [[k, f, r, at.astimezone(timezone.utc).isoformat() if at is not None else None]
            for k, f, r, at in rows]


def summary(base, rows):
    """Comparable plain/captured outcomes, excluding IDs, timestamps and prefix names."""
    import psycopg
    out = {}
    for row in rows:
        counts, seconds = {}, []
        if row['state'] == 'active':
            with psycopg.connect(with_db(base, row['database'])) as c:
                runs = c.execute('SELECT id, extract(epoch FROM finished_at-started_at) '
                                 'FROM orgtree.conversion_runs ORDER BY id').fetchall()
                require(len(runs) == 1, 'expected exactly one conversion run per org')
                for kind, sc, dc in c.execute('SELECT kind,source_count,dest_count '
                                             'FROM orgtree.conversion_run_kinds ORDER BY kind'):
                    require(kind not in counts, 'duplicate conversion kind')
                    counts[kind] = [sc, dc]
                require(counts, 'conversion run has no kinds')
                seconds = [float(t) for _, t in runs]
        out[row['slug']] = {'state': row['state'], 'counts': counts, 'conversion_seconds': seconds}
    return out


def comparable(result):
    return {slug: {'state': org['state'], 'counts': org['counts']}
            for slug, org in result.items()}


def conversion_reports(data):
    kept = {}
    for path in sorted(Path(data).glob('conversion/**/run.json')):
        doc = json.loads(path.read_text(encoding='utf-8'))
        orgs = doc.get('orgs', []) if 'orgs' in doc else [doc]
        for org in orgs:
            if org.get('outcome') == 'active':
                kept[org['slug']] = {'kept_in_extra': org.get('kept_in_extra', {}),
                                     'unregistered_keys': org.get('unregistered_keys', [])}
    return kept


def nul_values(value):
    if isinstance(value, str):
        return int('\x00' in value)
    if isinstance(value, dict):
        return sum(nul_values(v) for v in value.values())
    if isinstance(value, list):
        return sum(nul_values(v) for v in value)
    return 0


def validate_states(orgs, rows, fault_slug=None, fault='none'):
    wanted = {slug: 'unavailable' if slug == fault_slug and FAULTS[fault] == 'unavailable'
              else 'active' for _, slug in orgs}
    got = {row['slug']: row['state'] for row in rows}
    require(len(rows) == len(orgs) and got == wanted, 'registry outcomes differ from required live-org set')
    if fault_slug and FAULTS[fault] == 'unavailable':
        require(len(wanted) > 1, 'isolation requires at least one other live org')
        row = next(r for r in rows if r['slug'] == fault_slug)
        require(row['unavailable_step'] == 'conversion', 'planted fault unavailable at wrong step')
        require(row['state_reason'] and row['report_path'] and Path(row['report_path']).is_file(),
                'unavailable org lacks a reason or on-disk report')


def verify_one(verifier, source, base, database, legacy_database, legacy_id):
    import psycopg
    report = verifier.verify_report(source, with_db(base, database))
    require(not report['problems'], 'independent destination verification rejected the org')
    require(sum(v for k, v in report['stats'].items() if k.startswith('records ')) > 0,
            'independent verification compared no records')
    wanted = {k: [len(v) if isinstance(v, (dict, list)) else 1] * 2 + [digest(v)] * 2
              for k, v in source.items() if k not in verifier.IGNORED_DEFAULT}
    original = receipts(os.environ['ADMIN'], legacy_database, legacy_id)
    wanted['tx_receipts'] = [len(original)] * 2 + [digest(original)] * 2
    with psycopg.connect(with_db(base, database)) as c:
        actual = {k: [sc, dc, sh, dh] for k, sc, dc, sh, dh in c.execute(
            'SELECT kind,source_count,dest_count,source_sha256,dest_sha256 FROM orgtree.conversion_run_kinds')}
        copied = c.execute('SELECT op_key,fingerprint,result,at FROM orgtree.tx_receipts '
                           'ORDER BY op_key COLLATE "C"').fetchall()
    require(actual == wanted, 'independent counts or checksums differ')
    require([[k, f, r, at.astimezone(timezone.utc).isoformat() if at else None]
             for k, f, r, at in copied] == original, 'copied operation receipts differ')
    return {'stats': report['stats'], 'kinds': actual, 'receipts_compared': len(original)}


def load_compare(a):
    """Fresh process: today's converted-org loader, beyond the independent SQL verifier."""
    from orgtree import store
    org = store.load_org(a.load_slug)
    d = org.d
    if hasattr(d, 'materialize_all'):
        d.materialize_all()
    actual = {}
    for key in list(d.keys()):
        value = d[key]
        if hasattr(value, 'materialize'):
            value.materialize('orgdb-rehearsal')
        actual[key] = value
    verifier = module('rehearsal_load_verifier', REPO / 'tools/orgdb_verify.py')
    source = json.loads(Path(a.load_source).read_text(encoding='utf-8'))
    expected = {k: v for k, v in source.items() if k not in verifier.IGNORED_DEFAULT}
    require(digest(expected) == digest(actual), 'converted engine load differs from captured legacy load')
    return 0


def corrupt(verifier, source, base, database):
    import psycopg
    dest = with_db(base, database)
    with psycopg.connect(dest) as c:
        row = c.execute('SELECT id,title FROM orgtree.agents WHERE NOT tombstone ORDER BY ord LIMIT 1').fetchone()
        require(row, 'corruption control requires an agent')
        count = c.execute('SELECT count(*) FROM orgtree.agents').fetchone()[0]
        changed_title = 'rehearsal-corruption-' + uuid.uuid4().hex
        require(changed_title != row[1], 'corruption value equals the original')
        require(c.execute('UPDATE orgtree.agents SET title=%s WHERE id=%s',
                          (changed_title, row[0])).rowcount == 1, 'corruption did not update one row')
    try:
        with psycopg.connect(dest) as c:
            require(c.execute('SELECT count(*) FROM orgtree.agents').fetchone()[0] == count,
                    'destination corruption changed row count')
        report = verifier.verify_report(source, dest)
        require(report['problems'], 'independent verifier accepted planted value corruption')
        return {'same_row_count': True, 'rejected': True, 'problem_count': len(report['problems'])}
    finally:
        with psycopg.connect(dest) as c:
            c.execute('UPDATE orgtree.agents SET title=%s WHERE id=%s', (row[1], row[0]))
        require(not verifier.verify_report(source, dest)['problems'], 'corruption undo did not restore verification')


def worker(a):
    import psycopg
    from psycopg import sql
    admin, runtime = os.environ['ADMIN'], os.environ['RUNTIME']
    root, database = Path(a.root), a.prefix + 'legacy'
    data = root / 'data'
    orgs = prepare(a, database, data)
    original = inventory(admin, database)
    chosen = next(((i, s) for i, s in orgs if s == a.fault_org), None) if a.fault_org else orgs[0]
    if a.fault == 'dup-slug' and not a.fault_org:
        chosen = None
        with psycopg.connect(with_db(admin, database)) as c:
            for i, s in orgs:
                if c.execute(sql.SQL("SELECT EXISTS(SELECT 1 FROM {}.log_l WHERE sect='work_items_archive')")
                             .format(sql.Identifier('org_' + str(i)))).fetchone()[0]:
                    chosen = (i, s)
                    break
    require(chosen is not None, 'selected fault org is not live')
    undo = plant(admin, database, chosen[0], a.fault) if a.fault != 'none' else None
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(sql.SQL('ALTER DATABASE {} SET default_transaction_read_only=on').format(sql.Identifier(database)))
        from orgtree.orgdb.conn import role_of
        c.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}')
                  .format(sql.Identifier(database), sql.Identifier(role_of(runtime))))
    before, files_before = inventory(admin, database), file_manifest(data)
    os.environ['ORGTREE_PG_CONNINFO'] = with_db(runtime, database)
    from orgtree.orgdb import startup, registry
    env = scrub(os.environ)
    env.update(ORGTREE_ORGDB_PREFIX=a.prefix, HOME=os.environ['HOME'], USERPROFILE=os.environ['USERPROFILE'],
               PYTHONIOENCODING='utf-8', REHEARSAL_SOURCE_DIR=str(root / 'sources'),
               ORGTREE_PG_CONNINFO=with_db(runtime, database))
    t = time.perf_counter()
    with instrument(a.capture), memory_monitor() as memory:
        first = startup.start(admin=admin, runtime=with_db(runtime, database), data_root=str(data),
                              env=env, build='rehearsal-3.2.0')
    elapsed = time.perf_counter() - t
    require(first['first_pass']['ran'], 'first start skipped conversion')
    require(memory.children, 'memory sampling never observed the converter child')
    lc = registry.lifecycle()
    rows = lc.rows()
    Path(a.worker_output).write_text(json.dumps({'passed': False,
        'observed_registry': [{'state': row['state'], 'error_class':
                              (row['state_reason'] or '').split(':', 1)[0]} for row in rows]}), encoding='utf-8')
    validate_states(orgs, rows, chosen[1] if undo else None, a.fault)
    initial = summary(runtime, rows)
    kept_reports = conversion_reports(data)
    after = inventory(admin, database)
    require(before == after, 'startup changed legacy tables')
    require(files_before == file_manifest(data), 'startup changed immutable files')
    out = {'instrumented': a.capture, 'source_capture':
           'legacy.load_document wrapped in converter child, whole result returned unchanged' if a.capture else 'none',
           'verifier_imports_converter_or_mappers': False,
           'startup_seconds': elapsed, 'startup_memory': memory.report(), 'initial_registry': initial,
           'legacy_before': before, 'legacy_after': after, 'file_manifest_before': files_before,
           'file_manifest_after': file_manifest(data), 'verified': {}, 'fault': a.fault}
    if undo and FAULTS[a.fault] == 'unavailable':
        failed = next(r for r in rows if r['slug'] == chosen[1])
        out['unavailable'] = {'reason': failed['state_reason'], 'report_present': True}
        undo()
        require(inventory(admin, database) == original, 'removing fault did not restore original legacy inventory')
        t = time.perf_counter()
        with instrument(a.capture), memory_monitor() as retry_memory:
            retried = registry.retry(failed['org_id'], data_root=str(data), env=env)
        require(retried['outcome'] == 'active', 'Retry did not recover the planted fault')
        out['retry'] = {'outcome': retried['outcome'], 'seconds': time.perf_counter() - t,
                        'memory': retry_memory.report()}
        rows = lc.rows()
        kept_reports.update(conversion_reports(data))
        validate_states(orgs, rows)
        require(inventory(admin, database) == original, 'Retry changed legacy tables')
    if a.capture:
        verifier = module('rehearsal_verifier', REPO / 'tools/orgdb_verify.py')
        for row in rows:
            source_path = root / 'sources' / (str(row['legacy_org_id']) + '.json')
            require(source_path.is_file(), 'active org source was not captured')
            source = json.loads(source_path.read_text(encoding='utf-8'))
            if row['slug'] == chosen[1] and undo and undo.source_path is not None:
                value = source
                for key in undo.source_path:
                    require(isinstance(value, dict) and key in value, 'source loader discarded planted field')
                    value = value[key]
                require(digest(value) == digest(undo.expected_value), 'source loader changed planted value')
            out['verified'][row['slug']] = verify_one(verifier, source, runtime, row['database'],
                                                     database, row['legacy_org_id'])
            if row['slug'] == chosen[1] and undo and undo.source_path is not None:
                out['verified'][row['slug']]['planted_source_value_preserved'] = True
            if row['slug'] == chosen[1] and a.fault in ('bad-enum-agent', 'bad-type-agent'):
                load_env = child_env(root, a.prefix, admin, runtime)
                load_env.update(ORGTREE_STORE='postgres', ORGTREE_STORAGE='orgdb',
                                ORGTREE_PG_CONNINFO=with_db(runtime, database))
                with (root / 'load.log').open('w', encoding='utf-8') as log:
                    code = run_worker([*worker_argv(a), '--load-worker', '--load-slug', row['slug'],
                                       '--load-source', str(source_path)], load_env, log, 180)
                require(code == 0, 'converted engine load did not equal legacy load')
                out['verified'][row['slug']]['engine_load_equal'] = True
            # Reports count values kept in extra. Export field counts, never their values.
            require(row['slug'] in kept_reports, 'converted org has no report')
            kept = kept_reports[row['slug']]['kept_in_extra']
            out['verified'][row['slug']]['kept_in_extra'] = kept
            out['verified'][row['slug']]['unregistered_keys'] = kept_reports[row['slug']]['unregistered_keys']
            if row['slug'] == chosen[1] and a.fault == 'unknown-section':
                with psycopg.connect(with_db(runtime, row['database'])) as c:
                    extra = c.execute("SELECT val FROM orgtree.org_extra WHERE key='zz_unknown_section'").fetchall()
                require(extra == [({},)], 'unknown legacy key was not kept exactly in org_extra')
                require('zz_unknown_section' in kept_reports[row['slug']]['unregistered_keys'],
                        'unknown key was not counted in conversion report')
            out['verified'][row['slug']]['source_values_with_nul'] = nul_values(source)
            if nul_values(source):
                require(sum(sum(fields.values()) for fields in kept.values()) > 0,
                        'source contains NUL but report counts no values in extra')
            if row['slug'] == chosen[1] and FAULTS[a.fault] == 'report':
                table, field = {'unparseable-time': ('agents', 'created'),
                                'nul-text': ('org_settings', 'name'),
                                'bad-type-agent': ('agents', 'grant')}[a.fault]
                require(kept.get(table, {}).get(field, 0) > 0, 'report fault was not counted')
            if 'corruption' not in out:
                out['corruption'] = corrupt(verifier, source, runtime, row['database'])
    out['final_registry'] = summary(runtime, rows)
    require(files_before == file_manifest(data), 'Retry or verification changed immutable files')
    expected_final = original if undo and FAULTS[a.fault] == 'unavailable' else before
    require(inventory(admin, database) == expected_final, 'final legacy inventory changed')
    out['final_legacy'] = expected_final
    out['passed'] = True
    Path(a.worker_output).write_text(json.dumps(out, indent=2), encoding='utf-8')
    return 0


def drop_owned(admin, prefix):
    import psycopg
    from psycopg import sql
    require(prefix.startswith('rh') and prefix.endswith('_') and len(prefix) >= 15,
            'refusing an unowned database prefix')
    with psycopg.connect(admin, autocommit=True) as c:
        names = [r[0] for r in c.execute('SELECT datname FROM pg_database') if r[0].startswith(prefix)]
        for name in names:
            c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
        require(not [r[0] for r in c.execute('SELECT datname FROM pg_database') if r[0].startswith(prefix)],
                'owned databases survived cleanup')
    return len(names)


@contextlib.contextmanager
def cluster(a, root):
    if a.template:
        require(os.environ.get('ADMIN') and os.environ.get('RUNTIME'), '--template requires ADMIN/RUNTIME dev URLs')
        yield os.environ['ADMIN'], os.environ['RUNTIME']
        return
    require(a.custodian and a.pg_bin, 'private cluster needs --custodian and --pg-bin')
    pgroot = root / 'pg'

    def pg(action):
        done = subprocess.run([str(a.custodian), action, '--root', str(pgroot), '--pg-bin', str(a.pg_bin)],
                              capture_output=True, text=True, timeout=90)
        require(done.returncode == 0, 'private cluster ' + action + ' failed')
        return json.loads(done.stdout)

    pg('init-root')
    pg('init')
    config = pgroot / 'pg/cluster/data/postgresql.conf'
    text = config.read_text(encoding='utf-8')
    anchor = "include_if_exists = 'orgtree-qual-logging.conf'"
    require(anchor in text, 'private cluster logging anchor missing')
    text = text.replace(anchor, 'fsync = off\nsynchronous_commit = off\nfull_page_writes = off\n' + anchor)
    config.write_text(text, encoding='utf-8')
    try:
        pg('start')
        urls = pg('urls')['urls']
        yield urls['P03_PG_ADMIN_URL'], urls['P03_PG_RUNTIME_URL']
    finally:
        pg('stop')


def arguments():
    p = argparse.ArgumentParser(description=__doc__)
    inputs = p.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--template')
    inputs.add_argument('--dump', type=Path)
    inputs.add_argument('--legacy-sql', type=Path)
    inputs.add_argument('--sqlite-orgs', type=Path)
    p.add_argument('--release', choices=['2.1.14', '3.0.9', '3.1.0'], required=True)
    p.add_argument('--custodian', type=Path)
    p.add_argument('--pg-bin', type=Path)
    p.add_argument('--side-files', type=Path)
    p.add_argument('--fault', choices=list(FAULTS), default='none')
    p.add_argument('--fault-org')
    p.add_argument('--json-output', type=Path, required=True)
    # Internal worker switches; every worker runs within the same P03 parent tree.
    p.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    p.add_argument('--capture', action='store_true', help=argparse.SUPPRESS)
    p.add_argument('--root', help=argparse.SUPPRESS)
    p.add_argument('--prefix', help=argparse.SUPPRESS)
    p.add_argument('--worker-output', help=argparse.SUPPRESS)
    p.add_argument('--load-worker', action='store_true', help=argparse.SUPPRESS)
    p.add_argument('--load-slug', help=argparse.SUPPRESS)
    p.add_argument('--load-source', help=argparse.SUPPRESS)
    return p.parse_args()


def worker_argv(a):
    result = [sys.executable, '-I', str(Path(__file__).resolve()), '--release', a.release,
              '--fault', a.fault, '--json-output', str(a.json_output)]
    for field in ('template', 'dump', 'legacy_sql', 'sqlite_orgs', 'custodian', 'pg_bin', 'side_files', 'fault_org'):
        value = getattr(a, field)
        if value is not None:
            result += ['--' + field.replace('_', '-'), str(value)]
    return result


def execute_report(a, report):
    require(free_commit() >= 15 * 1024 ** 3, 'rehearsal requires at least 15 GB free commit memory')
    deadline = time.monotonic() + 1100
    # Real-copy sources, captures and logs stay here until all workers exit, then disappear.
    with tempfile.TemporaryDirectory(prefix='orgdb-rehearsal-') as tmp:
        root = Path(tmp)
        with cluster(a, root) as (admin, runtime):
            template_prefix = None
            if a.dump or a.legacy_sql:
                template_prefix = 'rh' + uuid.uuid4().hex[:16] + '_'
                template_name = template_prefix + 'template'
                template_data = root / 'template-data'
                old_admin = os.environ.get('ADMIN')
                os.environ['ADMIN'] = admin
                try:
                    prepare(a, template_name, template_data)
                except BaseException:
                    drop_owned(admin, template_prefix)
                    raise
                finally:
                    if old_admin is None:
                        os.environ.pop('ADMIN', None)
                    else:
                        os.environ['ADMIN'] = old_admin
                a.template, a.dump, a.legacy_sql = template_name, None, None
            try:
                source_before = inventory(admin, a.template) if a.template else None
                run_pair(a, report, root, admin, runtime, deadline)
                if a.template:
                    source_after = inventory(admin, a.template)
                    require(source_before == source_after, 'source template changed')
                    report['template_before'], report['template_after'] = source_before, source_after
            finally:
                if template_prefix:
                    report['cleanup'].append({'template_databases_dropped': drop_owned(admin, template_prefix),
                                              'remaining': 0})
    return 0


def run_pair(a, report, root, admin, runtime, deadline):
    for capture in (False, True):
        prefix = 'rh' + uuid.uuid4().hex[:16] + '_'
        runroot = root / ('captured' if capture else 'plain')
        runroot.mkdir()
        output = runroot / 'worker.json'
        argv = [*worker_argv(a), '--worker', '--root', str(runroot),
                '--prefix', prefix, '--worker-output', str(output)]
        if capture:
            argv.append('--capture')
        try:
            with (runroot / 'worker.log').open('w', encoding='utf-8') as log:
                code = run_worker(argv, child_env(runroot, prefix, admin, runtime), log,
                                  max(1, deadline-time.monotonic()))
            if code:
                lines = (runroot / 'worker.log').read_text(encoding='utf-8').splitlines()
                report['worker_failure'] = {'exit_code': code,
                    'frames': [line.strip() for line in lines if line.lstrip().startswith('File "')],
                    'exception_class': lines[-1].split(':', 1)[0] if lines else 'no output'}
                if lines and lines[-1].startswith('RuntimeError:'):
                    report['worker_failure']['control'] = lines[-1]
                if output.is_file():
                    report['worker_failure']['partial'] = json.loads(output.read_text(encoding='utf-8'))
            require(code == 0, 'rehearsal worker failed; no data values exported')
            report['runs'].append(json.loads(output.read_text(encoding='utf-8')))
        finally:
            report['cleanup'].append({'databases_dropped': drop_owned(admin, prefix), 'remaining': 0})
    plain, captured = report['runs']
    require(comparable(plain['initial_registry']) == comparable(captured['initial_registry']),
            'source instrumentation changed initial registry states/counts')
    require(comparable(plain['final_registry']) == comparable(captured['final_registry']),
            'source instrumentation changed final registry states/counts')
    report['plain_matches_instrumented'] = True
    report['passed'] = True


def run_worker(argv, env, log, timeout):
    import psutil
    with subprocess.Popen(argv, env=env, stdout=log, stderr=log) as child:
        try:
            return child.wait(timeout=timeout)
        except BaseException:
            # Killing just the worker would leave its converter holding connections while
            # cleanup drops databases. Reap the whole private tree before cleanup starts.
            with contextlib.suppress(psutil.NoSuchProcess):
                children = psutil.Process(child.pid).children(recursive=True)
                for descendant in reversed(children):
                    with contextlib.suppress(psutil.NoSuchProcess):
                        descendant.kill()
                psutil.wait_procs(children, timeout=10)
            child.kill()
            child.wait(timeout=10)
            raise


def main():
    a = arguments()
    if a.load_worker:
        return load_compare(a)
    if a.worker:
        return worker(a)
    report = {'release': a.release, 'fault': a.fault, 'import_provenance': PROVENANCE.as_dict(),
              'passed': False, 'runs': [], 'cleanup': [], 'input_preparation':
              'pgimport.main import --hold-back --cutover; private-cluster attachment injected; offline SQLite backup'
              if a.sqlite_orgs else 'read-only clones of supplied/restored legacy template'}
    try:
        execute_report(a, report)
    finally:
        a.json_output.parent.mkdir(parents=True, exist_ok=True)
        a.json_output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'release': a.release, 'fault': a.fault,
                      'orgs': len(report['runs'][1]['verified']), 'cleanup': report['cleanup']}), flush=True)
    return 0


if __name__ == 'rehearsal_capture':
    install_capture()
elif __name__ == '__main__':
    sys.exit(main())
