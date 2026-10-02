"""The side files' rows through a real org database (design §5.2 step 4).

Needs a DISPOSABLE PostgreSQL (never a live one):
  ORGTREE_TEST_PG_ADMIN_URL    a superuser URL. Every database this module creates is named with
                               its own prefix t<pid>_ and dropped at the end.
  ORGTREE_TEST_PG_RUNTIME_URL  the engine's runtime role on the same server
Without both URLs every test SKIPS: a skip is not a pass.

What it proves: in a staging database the lifecycle built (the org migrations, 0003 included),
test_orgdb_mappers' document plus one org's side rows, written by COPY as the RUNTIME role,
read back exactly: reply events (a quote holding U+0000, a generation that is not an integer,
an agent no node carries, as a tombstone), file-delivery receipts (pending and completed, with
and without an agent) and the org's restricted accounts (marks, spend, unknown fields). Each
side check finds nothing, and finds a planted change. Every 0003 table has exactly the columns
and types its spec writes. After mark_filled the identity sequence continues past the
converter's ids, and the build publishes. The old SQLite files (one of them a WAL file with
frames not yet checkpointed) are byte for byte unchanged after reading, writing, publishing and
dropping the org's database.

Run:  python tools/run-python-verification.py tests/test_orgdb_sidefiles_pg.py
"""

import copy
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

ADMIN = os.environ.get('ORGTREE_TEST_PG_ADMIN_URL', '').strip()
RUNTIME = os.environ.get('ORGTREE_TEST_PG_RUNTIME_URL', '').strip()
PREFIX = f't{os.getpid()}_'
os.environ['ORGTREE_ORGDB_PREFIX'] = PREFIX

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import ledger  # noqa: E402
from orgtree.orgdb import conn, lifecycle, mappers, sections  # noqa: E402
from orgtree.orgdb.convert import accounts, rowio, sidefiles  # noqa: E402
from test_orgdb_mappers import canon, document  # noqa: E402

SQL_TYPES = {'timestamptz': 'timestamp with time zone', 'char(1)': 'character'}


def _drop_all() -> None:
    from psycopg import sql
    with conn.connect(ADMIN, 'postgres') as c:
        for (db,) in c.execute("SELECT datname FROM pg_database WHERE datname LIKE %s",
                               (PREFIX + '%',)).fetchall():
            c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(db)))


def tearDownModule() -> None:
    if ADMIN and RUNTIME:
        _drop_all()


def expected_columns(t) -> dict[str, str]:
    """{column: information_schema data_type} a sections.Table writes or declares."""
    lay = t.layout()[t.spec.table]
    out: dict[str, str] = {}
    for rc in t.record_columns:
        name, typ = rc.split()[:2]
        out[name.strip('"')] = typ
    for c, typ in lay['keys']:
        out.setdefault(c, typ)
    for c, typ in lay['columns']:
        out[c] = typ
    if lay['extra']:
        out['extra'] = 'json'
    return {c: SQL_TYPES.get(typ, typ) for c, typ in out.items()}


def sha_files(folder: Path) -> dict[str, str]:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.iterdir())
            if p.is_file()}


EVENTS = [('acme', 'boss', 0, 'reply_1', 'hello', 'o:a'),
          ('acme', 'x', 2, 'reply_2', 'quote \x00 with nul', 'o:b'),
          ('acme', 'ghost', 1, 'reply_3', 'from a deleted agent', 'o:c'),
          ('acme', 'x', 3, 'reply_4', 'é ✓ ' * 100, 'o:b'),
          ('beta', 'y', 0, 'reply_5', 'another org', 'o:d')]


@unittest.skipUnless(ADMIN and RUNTIME, 'needs ORGTREE_TEST_PG_ADMIN_URL and ORGTREE_TEST_PG_RUNTIME_URL')
class ThroughAnOrgDatabase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix='orgdb-side-pg-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.old = self.tmp / 'data'
        self.old.mkdir()
        # reply events: a WAL file whose last frames are not checkpointed (both companions left)
        live = self.tmp / 'live'
        live.mkdir()
        w = sqlite3.connect(live / sidefiles.REPLY_EVENTS_FILE)
        w.execute('PRAGMA journal_mode=WAL').close()
        w.execute('PRAGMA wal_autocheckpoint=0')
        w.execute('CREATE TABLE events (org TEXT, agent TEXT, generation INTEGER, id TEXT, text TEXT, '
                  'scope TEXT, PRIMARY KEY(org,agent,generation,id))')
        w.executemany('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)', EVENTS)
        w.execute("INSERT INTO events VALUES ('acme', 'x', 4.5, 'reply_6', 'odd generation', 'o:b')")
        w.commit()
        for p in live.iterdir():
            shutil.copy2(p, self.old / p.name)
        w.close()
        d = sqlite3.connect(self.old / sidefiles.DELIVERIES_FILE)
        d.execute('CREATE TABLE deliveries (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT)')
        d.executemany('INSERT INTO deliveries VALUES (?, ?, ?)', [
            ('a' * 64, '["c:\\\\w\\\\a.pdf", "plan"]', '{"name": "a.pdf", "bytes": 3}'),
            ('b' * 64, '["c:\\\\w\\\\b.pdf", ""]', None),
            ('c' * 64, '["c:\\\\w\\\\c.pdf", "theirs"]', None)])
        d.commit()
        d.close()

    def test_side_rows_round_trip_and_publish(self) -> None:
        _drop_all()
        before = sha_files(self.old)
        events = sidefiles.read_reply_events(self.old / sidefiles.REPLY_EVENTS_FILE)['acme']
        self.assertEqual(len(events), 5)
        receipts = sidefiles.read_deliveries(self.old / sidefiles.DELIVERIES_FILE)
        assigned = {'a' * 64: ('acme', sidefiles.SNAPSHOT, 'boss'),
                    'b' * 64: ('acme', sidefiles.KEY, 'gone-sender'),
                    'c' * 64: ('beta', sidefiles.KEY, 'y')}
        restricted = [
            {'id': 'claude-2', 'provider': 'claude', 'origin_org': 'acme', 'mode': 'apikey',
             'enabled': True, 'credential': {'kind': 'apikey', 'token_ref': 'tok'},
             'identity': {'lane': 'key', 'nul': 'a\x00b'}, 'tint_ordinal': 2,
             'created_at': 1759300000.9876543,
             'marks': {'pooled': {'until': 1759400000.125, 'window': '5h',
                                  'observed_at': 1759390000.5, 'provenance': 'observed'},
                       'fable': {'until': 1759400000.125, 'window': '5h', 'observed_at': 1759390000.5,
                                 'provenance': 'inferred', 'later': [1]}},
             'spend': {'usd_total': 3.25, 'turns': 4, 'since': 1759000000.0, 'updated_at': 1759390000.5}},
            {'id': 'claude-7', 'origin_org': 'acme', 'label': 'key \x00 label', 'marks': None,
             'spend': 'junk', 'future': {'x': 1}}]
        side = [sidefiles.ReplyEvents(events), sidefiles.FileDeliveries('acme', receipts, assigned),
                accounts.OrgAccounts({'accounts': restricted,
                                      'aliases': {'acme-key': 'claude-2'},
                                      'mark_audit': [{'at': 1.5, 'actor': 'boss', 'org': 'acme',
                                                      'account': 'claude-2', 'reason': 'private'}]})]
        secs = mappers.sections() + side
        lc = lifecycle.Lifecycle(ADMIN, runtime_role=conn.role_of(RUNTIME), prefix=PREFIX, build='test')
        lc.bootstrap()
        org_id = lc.register_org('acme', state='converting')
        build = lc.open_build(org_id, 'convert')
        doc = document()
        rows, ctx, _ = sections.encode_document(copy.deepcopy(doc), secs, ignored=mappers.ignored_keys())
        self.assertEqual(sorted(ctx.tombstones), ['ghost', 'gone-boss', 'gone-sender',
                                                  'x#orphan-abc123def456'])
        order = rowio.tables(secs)
        with conn.connect(RUNTIME, build.database, autocommit=False) as c:
            counts = rowio.write(c, rows, order=order)
            c.commit()
        self.assertEqual((counts['reply_events'], counts['file_deliveries'], counts['org_accounts'],
                          counts['org_account_marks'], counts['org_account_spend']), (5, 2, 2, 2, 1))
        with conn.connect(RUNTIME, build.database) as c:
            back = rowio.read(c, order=order)
            for t in (sidefiles.REPLY_EVENTS, sidefiles.FILE_DELIVERIES, accounts.ORG_ACCOUNTS,
                      accounts.ORG_MARKS, accounts.ORG_SPENDS, accounts.ORG_ALIASES,
                      accounts.ORG_AUDITS):
                got = dict(c.execute("SELECT column_name, data_type FROM information_schema.columns "
                                     "WHERE table_schema = 'orgtree' AND table_name = %s",
                                     (t.spec.table,)).fetchall())
                self.assertEqual(got, expected_columns(t), t.spec.table)
        self.assertEqual(sidefiles.check_reply_events(events, back), [])
        self.assertEqual(sidefiles.check_file_deliveries(receipts[:2], back), [])
        self.assertEqual(accounts.check_org_accounts(side[2].part, back), [])
        self.assertEqual(counts['org_account_aliases'], 1)
        self.assertEqual(counts['org_account_mark_audit'], 1)
        names = {r['id']: r['name'] for r in back['agents']}
        by_text = {r['text']: r for r in sidefiles.decode_reply_events(back, names)}
        self.assertEqual(by_text['quote \x00 with nul']['agent'], 'x')
        self.assertEqual(by_text['odd generation']['generation'], 4.5)
        self.assertEqual(by_text['from a deleted agent']['agent'], 'ghost')
        delivered = {r['id']: r for r in sidefiles.decode_file_deliveries(back, names)}
        self.assertEqual((delivered['b' * 64]['result'], delivered['b' * 64]['agent']), (None, 'gone-sender'))
        back_doc = sections.decode_document(back, mappers.sections(), sections.Context())
        want = {k: v for k, v in doc.items() if k not in mappers.ignored_keys()}
        self.assertEqual(canon(back_doc), canon(want))
        # a planted change is found
        planted = {**back, 'reply_events': [dict(r) for r in back['reply_events']]}
        planted['reply_events'][0]['scope'] = 'o:changed'
        self.assertEqual(len(sidefiles.check_reply_events(events, planted)), 1)
        lc.mark_filled(build)
        final = lc.publish(build)
        with conn.connect(RUNTIME, final) as c:
            boss = c.execute("SELECT id FROM agents WHERE name = 'boss' AND NOT tombstone").fetchone()[0]
            new_id = c.execute("INSERT INTO reply_events (agent_id, generation, public_id, text, scope) "
                               "VALUES (%s, 0, 'reply_new', 't', 's') RETURNING id", (boss,)).fetchone()[0]
            self.assertEqual(new_id, counts['reply_events'] + 1)
            import psycopg
            with self.assertRaises(psycopg.errors.UniqueViolation):   # the old file's key, per org
                c.execute("INSERT INTO reply_events (agent_id, generation, public_id, text, scope) "
                          "VALUES (%s, 0, 'reply_1', 'dup', 's')", (boss,))
        self.assertEqual(sha_files(self.old), before)
        _drop_all()                                # the org's database gone, as a purge drops it
        self.assertEqual(sha_files(self.old), before)
        again = sidefiles.read_reply_events(self.old / sidefiles.REPLY_EVENTS_FILE)
        self.assertEqual(sum(len(v) for v in again.values()), len(EVENTS) + 1)


if __name__ == '__main__':
    unittest.main()
