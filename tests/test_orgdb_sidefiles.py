"""The side files' move into each org's database (design §5.2 step 4, rev 7.1): no database.

test_orgdb_sidefiles_pg.py repeats the round trips through a real org database.

What it proves:
  * the old files are read through SQLite's backup API without writing anything: a WAL file
    with committed frames not yet checkpointed (all rows read; the db, -wal and -shm bytes and
    times unchanged), a cleanly closed WAL file (no -wal/-shm created), a WAL without its
    -shm and a hot rollback journal (both recovered on a private copy: only committed rows,
    the source untouched); an absent file or table reads as empty;
  * reply events keep generation, id, text and scope exactly: a quote holding U+0000 and a
    generation that is not an integer go to extra; an agent no node carries points at a
    tombstone that gets its agent row; the read-back digest equals the source's and a changed
    row is reported; text that is not UTF-8 is refused (ShapeError);
  * every receipt case of design §5.2 (rev 7.1), each with the retries a caller could make
    (the original fingerprint and a changed caption) before conversion (the old file) and after
    it (the calling org's rows only, option X):
      - a pending receipt before its snapshot folder exists, whose key is only in the bridge's
        lost answer: moves by its key;
      - a completed receipt whose folder is gone: stays (and the old build refuses its replay);
      - a snapshot folder copied into a second org while the original remains: stays, unless
        a key recomputes its id;
      - a row with no evidence: stays;
      - decision 20: a folder copied by hand into another org's agent scratch folder, its
        original deleted, with a private caption: moves to the copy's org, is inert there, and
        the sender's retry is a new delivery; the report names the evidence;
      - review round 4: an agent sends from another org's workspace through a grant later
        removed, and crashes before the folder exists, with no recorded key: stays, listed
        with its source path; a mutant that accepts the source path as evidence fails;
      - a key from org B's lost answer that an org-A agent also holds does not move B's row
        to A;
      - a row whose evidence names an org that is not converted now stays, and moves at that
        org's retry;
    plus links resolved, a file that no longer matches, an unreadable location, two orgs
    recomputing one id, and the transcript reader (Claude and Codex names, string and list
    answers, junk lines, keys that are not keys, other tools' answers);
  * the receipts' rows round-trip exactly (pending and completed), with agent and evidence;
  * the converter's wiring (SideFiles / side_inputs): one org's sections and its check, a
    trashed org (no reply events; a scratch root shared by two orgs of one name places no
    folder), and what stays in the old files;
  * 0003_side_files.sql has exactly the columns the specs write.

Run:  python tools/run-python-verification.py tests/test_orgdb_sidefiles.py
"""

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree.orgdb import codec, mappers, sections
from orgtree.orgdb.convert import sidefiles
from orgtree.orgdb.convert.sidefiles import KEY, SNAPSHOT, OrgEvidenceInput

MIGRATION = (Path(__file__).resolve().parent.parent / 'engine' / 'backend' / 'orgtree'
             / 'pg_migrations' / 'org' / '0003_side_files.sql')

EVENTS_DDL = ('CREATE TABLE events (org TEXT, agent TEXT, generation INTEGER, id TEXT, text TEXT, '
              'scope TEXT, PRIMARY KEY(org,agent,generation,id))')
DELIVERIES_DDL = 'CREATE TABLE deliveries (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT)'


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def receipt_id(slug: str, seat: str, key: str) -> str:
    """filedelivery.snapshot's id, written out independently of the module under test."""
    return sha(f'{slug}:{seat}:{key}'.encode())


def files_state(folder: Path) -> dict:
    """{file name: (size, mtime, sha256)} of the files directly in ``folder``."""
    return {p.name: (p.stat().st_size, p.stat().st_mtime_ns, sha(p.read_bytes()))
            for p in sorted(folder.iterdir()) if p.is_file()}


def node(seat: str, session: str = '') -> dict:
    return {'seat_id': seat, 'session_id': session, 'state': 'live', 'generation': 0}


# ---------------------------------------------------------------- reading SQLite, read-only

class ReadOnlySqlite(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix='orgdb-side-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def events_db(self, folder: Path, *, wal: bool) -> tuple[Path, sqlite3.Connection]:
        folder.mkdir(parents=True, exist_ok=True)
        db = folder / 'reply-events.sqlite3'
        w = sqlite3.connect(db)
        if wal:
            w.execute('PRAGMA journal_mode=WAL').close()
        w.execute(EVENTS_DDL)
        w.executemany('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)', [
            ('acme', 'boss', 0, 'reply_1', 'hi', 's1'), ('acme', 'x', 1, 'reply_2', 'a\x00b', 's2'),
            ('other', 'y', 0, 'reply_3', 'yo', 's3')])
        w.commit()
        return db, w

    def snapshot(self, db: Path, suffixes: tuple[str, ...]) -> Path:
        snap = self.tmp / ('snap' + str(len(list(self.tmp.iterdir()))))
        snap.mkdir()
        shutil.copy2(db, snap / db.name)
        for s in suffixes:
            side = Path(f'{db}{s}')
            if side.exists():
                shutil.copy2(side, snap / (db.name + s))
        return snap / db.name

    def test_wal_frames_not_checkpointed_are_read_and_nothing_is_written(self) -> None:
        db, w = self.events_db(self.tmp / 'live', wal=True)
        w.execute('PRAGMA wal_autocheckpoint=0')
        w.execute("INSERT INTO events VALUES ('acme', 'boss', 0, 'reply_4', 'late', 's1')")
        w.commit()
        snap = self.snapshot(db, ('-wal', '-shm'))         # a crash: both companions left
        w.close()
        before = files_state(snap.parent)
        self.assertEqual(sorted(before), [snap.name, snap.name + '-shm', snap.name + '-wal'])
        got = sidefiles.read_reply_events(snap)
        self.assertEqual(files_state(snap.parent), before)
        self.assertEqual(sorted(got), ['acme', 'other'])
        self.assertEqual([r['id'] for r in got['acme']], ['reply_1', 'reply_2', 'reply_4'])
        self.assertEqual(got['acme'][1], {'agent': 'x', 'generation': 1, 'id': 'reply_2',
                                          'text': 'a\x00b', 'scope': 's2'})

    def test_a_cleanly_closed_wal_file_gets_no_companions(self) -> None:
        db, w = self.events_db(self.tmp / 'live', wal=True)
        w.close()                                           # checkpoint + delete -wal/-shm
        before = files_state(db.parent)
        self.assertEqual(list(before), [db.name])
        got = sidefiles.read_reply_events(db)
        self.assertEqual(files_state(db.parent), before)
        self.assertEqual(sum(len(v) for v in got.values()), 3)

    def test_a_wal_without_its_shm_is_read_on_a_private_copy(self) -> None:
        db, w = self.events_db(self.tmp / 'live', wal=True)
        w.execute('PRAGMA wal_autocheckpoint=0')
        w.execute("INSERT INTO events VALUES ('acme', 'boss', 0, 'reply_4', 'late', 's1')")
        w.commit()
        snap = self.snapshot(db, ('-wal',))
        w.close()
        before = files_state(snap.parent)
        got = sidefiles.read_reply_events(snap)
        self.assertEqual(files_state(snap.parent), before)   # no -shm was created
        self.assertEqual(len(got['acme']), 3)

    def test_a_hot_journal_is_rolled_back_on_a_private_copy(self) -> None:
        live = self.tmp / 'live'
        live.mkdir()
        db = live / 'file-deliveries.db'
        w = sqlite3.connect(db)
        w.execute(DELIVERIES_DDL)
        w.execute("INSERT INTO deliveries VALUES ('a' || hex(randomblob(31)), '[\"p\", \"\"]', NULL)")
        w.commit()
        w.execute('PRAGMA cache_size=1')
        w.execute('BEGIN')
        w.execute("INSERT INTO deliveries SELECT 'pad' || hex(randomblob(500)), 'f', NULL FROM "
                  "(WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 2000) "
                  "SELECT n FROM c)")
        snap = self.snapshot(db, ('-journal',))             # a writer died mid-transaction
        w.rollback()
        w.close()
        journal = Path(f'{snap}-journal')
        if not journal.exists() or journal.read_bytes()[:8] != bytes.fromhex('d9d505f920a163d7'):
            self.skipTest('SQLite wrote no hot journal before the copy')
        before = files_state(snap.parent)
        got = sidefiles.read_deliveries(snap)
        self.assertEqual(files_state(snap.parent), before)
        self.assertEqual(len(got), 1)                       # only the committed row
        self.assertIsNone(got[0]['result'])

    def test_absent_file_or_table_reads_empty(self) -> None:
        self.assertEqual(sidefiles.read_reply_events(self.tmp / 'nope.sqlite3'), {})
        self.assertEqual(sidefiles.read_deliveries(self.tmp / 'nope.db'), [])
        empty = self.tmp / 'empty.db'
        sqlite3.connect(empty).close()
        self.assertEqual(sidefiles.read_deliveries(empty), [])
        self.assertEqual(sidefiles.read_reply_events(empty), {})

    def test_text_that_is_not_utf8_is_refused_by_its_section(self) -> None:
        db, w = self.events_db(self.tmp / 'live', wal=False)
        w.execute("INSERT INTO events VALUES ('acme', 'x', 0, 'reply_9', CAST(x'ff00fe' AS TEXT), 's')")
        w.commit()
        w.close()
        got = sidefiles.read_reply_events(db)
        self.assertEqual(got['acme'][-1]['text'], b'\xff\x00\xfe')
        doc = {'nodes': {'x': node('seat-x')}}
        with self.assertRaises(codec.ShapeError):
            sections.encode_document(doc, mappers.sections() + [sidefiles.ReplyEvents(got['acme'])],
                                     ignored=mappers.ignored_keys())


# ---------------------------------------------------------------- reply events

def encode(doc: dict, side: list) -> tuple[dict, sections.Context]:
    rows, ctx, _ = sections.encode_document(copy.deepcopy(doc), mappers.sections() + side,
                                            ignored=mappers.ignored_keys())
    return rows, ctx


class ReplyEvents(unittest.TestCase):
    ROWS = [
        {'agent': 'boss', 'generation': 0, 'id': 'reply_a', 'text': 'plain', 'scope': 'o:n'},
        {'agent': 'x', 'generation': 2, 'id': 'reply_b', 'text': 'nul \x00 inside', 'scope': 'o:m'},
        {'agent': 'gone', 'generation': 1.5, 'id': 'reply_c', 'text': '', 'scope': None},
        {'agent': 'x', 'generation': None, 'id': 'reply_d', 'text': 'é ✓', 'scope': 'o:\x00'},
        {'agent': 'x', 'generation': '3', 'id': 'reply_\x00e', 'text': 'x' * 4000, 'scope': 's'},
    ]
    DOC = {'slug': 'acme', 'nodes': {'boss': node('seat-b'), 'x': node('seat-x')}}

    def test_every_value_round_trips_and_unknown_agents_get_tombstones(self) -> None:
        sec = sidefiles.ReplyEvents(self.ROWS)
        rows, ctx = encode(self.DOC, [sec])
        self.assertEqual(ctx.tombstones, ['gone'])
        agents = {r['name']: r for r in rows['agents']}
        self.assertTrue(agents['gone']['tombstone'])
        events = rows['reply_events']
        self.assertEqual([r['id'] for r in events], [1, 2, 3, 4, 5])
        self.assertEqual(events[1]['agent_id'], agents['x']['id'])
        self.assertIsNone(events[0]['extra'])
        self.assertEqual(events[1]['extra'].obj, {'text': 'nul \x00 inside'})
        self.assertEqual(events[2]['extra'].obj, {'generation': 1.5, 'scope': None})
        self.assertEqual(events[4]['public_id'], None)
        back = sidefiles.decode_reply_events(rows, ctx.names)
        self.assertEqual(json.dumps(back, sort_keys=True), json.dumps(self.ROWS, sort_keys=True))
        self.assertEqual(sidefiles.check_reply_events(self.ROWS, rows), [])
        # the section's own decode leaves the same rows
        sections.decode_document(rows, mappers.sections() + [sec], sections.Context())
        self.assertEqual(sec.read_back, back)

    def test_a_changed_or_missing_row_is_reported(self) -> None:
        rows, _ = encode(self.DOC, [sidefiles.ReplyEvents(self.ROWS)])
        bad = copy.deepcopy(rows)
        bad['reply_events'][0]['text'] = 'changed'
        found = sidefiles.check_reply_events(self.ROWS, bad)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]['missing'], [{'agent': 'boss', 'generation': 0, 'id': 'reply_a'}])
        fewer = copy.deepcopy(rows)
        fewer['reply_events'].pop()
        self.assertEqual(sidefiles.check_reply_events(self.ROWS, fewer)[0]['got']['count'], 4)

    def test_digest_ignores_order_and_keeps_types(self) -> None:
        f = sidefiles.EVENT_FIELDS
        self.assertEqual(sidefiles.rows_digest(self.ROWS, f), sidefiles.rows_digest(self.ROWS[::-1], f))
        other = [dict(r) for r in self.ROWS]
        other[0]['generation'] = 0.0
        self.assertNotEqual(sidefiles.rows_digest(self.ROWS, f), sidefiles.rows_digest(other, f))

    def test_an_agent_name_no_text_column_holds_refuses(self) -> None:
        with self.assertRaises(codec.ShapeError):
            encode(self.DOC, [sidefiles.ReplyEvents([{**self.ROWS[0], 'agent': 'a\x00b'}])])


# ---------------------------------------------------------------- file deliveries: evidence

def call_line(tool_use_id: str, *, delivery_id: str | None = None,
              name: str = 'mcp__orgtree__orgtree_send_file') -> dict:
    args: dict = {'path': 'report.pdf'}
    if delivery_id is not None:
        args['delivery_id'] = delivery_id
    return {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
        {'type': 'tool_use', 'id': tool_use_id, 'name': name, 'input': args}]}}


def answer_line(tool_use_id: str, text: str, *, as_list: bool = True) -> dict:
    content = [{'type': 'text', 'text': text}] if as_list else text
    return {'type': 'user', 'message': {'role': 'user', 'content': [
        {'type': 'tool_result', 'tool_use_id': tool_use_id, 'content': content}]}}


def lost_answer(key: str) -> str:
    """The bridge's answer to a lost call (mcptool.call_api), carrying the key it minted."""
    return json.dumps({'error': 'timed out', 'delivery_id': key,
                       'status': 'Retry this same file with this delivery_id; do not create a '
                                 'new delivery for a lost response.'})


def retry(receipts: list, scratch: Path, slug: str, seat: str, key: str, src: str, note: str) -> str:
    """filedelivery.snapshot's answer to a call with delivery_id ``key``, decided over the
    receipts that call consults: the old file before conversion, and after it the calling
    org's file_deliveries only (option X). 'new' a new delivery; 'refused' the id belongs to
    another file or caption; 'resume' the copy continues; 'replay' the saved reply, its
    snapshot intact; 'missing' refused, the snapshot is missing or changed."""
    rid = receipt_id(slug, seat, key)
    row = {r['id']: r for r in receipts}.get(rid)
    if row is None:
        return 'new'
    if row['fingerprint'] != json.dumps([os.path.normcase(src), note]):
        return 'refused'
    if row['result'] is None:
        return 'resume'
    sent = json.loads(row['result'])
    target = scratch.joinpath(*sent['path'].split('/'))
    if target.is_file() and target.stat().st_size == sent['bytes'] and sha(target.read_bytes()) == sent['sha256']:
        return 'replay'
    return 'missing'


class Machine:
    """A synthetic machine: orgs with scratch roots, a workspace, agents with lineage tokens,
    transcripts, and the old file-deliveries.db."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.scratch = root / 'data' / 'scratch'
        self.lineage: dict[str, dict[str, str]] = {}
        self.transcripts: dict[str, list[tuple[str, str]]] = {}
        self.rows: list[dict] = []

    def org(self, slug: str, agents: dict[str, str]) -> None:
        (self.scratch / slug).mkdir(parents=True)
        for a in agents:
            (self.scratch / slug / a.split('@')[0]).mkdir(exist_ok=True)
        self.lineage[slug] = dict(agents)
        self.transcripts[slug] = []

    def agent_scratch(self, slug: str, agent: str) -> Path:
        return self.scratch / slug / agent.split('@')[0]

    def source(self, rel: str, data: bytes = b'payload') -> str:
        p = self.root / 'files' / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return str(p)

    def send(self, slug: str, agent: str, key: str, src: str, note: str, *, folder: bool = True,
             complete: bool = True) -> dict:
        """What filedelivery.snapshot leaves behind: the receipt row, and (``folder``) the
        snapshot folder in the calling agent's scratch folder with the copied file."""
        seat = self.lineage[slug][agent]
        rid = receipt_id(slug, seat, key)
        data = Path(src).read_bytes()
        safe = re.sub(r'[^\w .()+\-]', '_', Path(src).name).strip(' .') or 'file.bin'
        if folder:
            d = self.agent_scratch(slug, agent) / 'outbox' / f'delivery-{rid}'
            d.mkdir(parents=True)
            (d / safe).write_bytes(data)
        result = None
        if complete:
            result = json.dumps({'name': safe, 'path': f'outbox/delivery-{rid}/{safe}',
                                 'bytes': len(data), 'delivery_id': rid, 'sha256': sha(data)})
        row = {'id': rid, 'fingerprint': json.dumps([os.path.normcase(src), note]), 'result': result}
        self.rows.append(row)
        return row

    def folder(self, slug: str, agent: str, row: dict) -> Path:
        return self.agent_scratch(slug, agent) / 'outbox' / f'delivery-{row["id"]}'

    def transcript(self, slug: str, agent: str, lines: list[dict], *, junk: bool = True) -> str:
        p = self.root / 'transcripts' / slug / f'{agent.replace("@", "_")}-{len(self.transcripts[slug])}.jsonl'
        p.parent.mkdir(parents=True, exist_ok=True)
        text = [json.dumps(x) for x in lines]
        if junk:
            text = ['{not json orgtree_send_file', json.dumps({'type': 'summary'})] + text
        p.write_text('\n'.join(text) + '\n', encoding='utf-8')
        self.transcripts[slug].append((agent, str(p)))
        return str(p)

    def old_file(self) -> Path:
        db = self.root / 'data' / 'file-deliveries.db'
        if db.exists():
            db.unlink()
        c = sqlite3.connect(db)
        c.execute(DELIVERIES_DDL)
        c.executemany('INSERT INTO deliveries VALUES (?, ?, ?)',
                      [(r['id'], r['fingerprint'], r['result']) for r in self.rows])
        c.commit()
        c.close()
        return db

    def inputs(self, converting=None, transcripts: bool = True) -> dict[str, OrgEvidenceInput]:
        return {slug: OrgEvidenceInput(
                    scratch_roots=(str(self.scratch / slug),), lineage=self.lineage[slug],
                    transcripts=list(self.transcripts[slug]) if transcripts else (),
                    converting=converting is None or slug in converting)
                for slug in self.lineage}

    def assign(self, converting=None, **kw) -> tuple[dict, dict]:
        report: dict = {}
        rows = sidefiles.read_deliveries(self.old_file())
        return sidefiles.assign_deliveries(rows, self.inputs(converting, **kw), report=report), report

    def org_rows(self, slug: str, assigned: dict) -> list[dict]:
        """The calling org's file_deliveries after conversion, as its database holds them."""
        sec = sidefiles.FileDeliveries(slug, self.rows, assigned)
        doc = {'nodes': {a: node(s) for a, s in self.lineage[slug].items()}}
        rows, ctx = encode(doc, [sec])
        return sidefiles.decode_file_deliveries(rows, ctx.names)


class DeliveryEvidence(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix='orgdb-receipts-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.m = Machine(self.tmp)
        self.m.org('acme', {'alice': 'seat-alice', 'alice@0': 'seat-alice', 'bob': 'seat-bob'})
        self.m.org('beta', {'carol': 'seat-carol'})

    def retries(self, receipts: list, slug: str, agent: str, key: str, src: str, note: str) -> tuple:
        seat = self.m.lineage[slug][agent]
        scratch = self.m.agent_scratch(slug, agent)
        return (retry(receipts, scratch, slug, seat, key, src, note),
                retry(receipts, scratch, slug, seat, key, src, note + ' (edited)'))

    def test_pending_receipt_whose_key_is_only_in_the_lost_answer_moves_by_key(self) -> None:
        src = self.m.source('a/plan.pdf')
        key = 'k' * 32                     # minted by the bridge: not in the call's input
        row = self.m.send('acme', 'alice', key, src, 'the plan', folder=False, complete=False)
        self.m.transcript('acme', 'alice', [call_line('toolu_1'), answer_line('toolu_1', lost_answer(key))])
        assigned, report = self.m.assign()
        self.assertEqual(assigned, {row['id']: ('acme', KEY, 'alice')})
        self.assertEqual(report['moved'], {'acme': {SNAPSHOT: 0, KEY: 1}})
        self.assertEqual(report['evidence'][row['id']]['where'], self.m.transcripts['acme'][0][1])
        before = self.retries(self.m.rows, 'acme', 'alice', key, src, 'the plan')
        after = self.retries(self.m.org_rows('acme', assigned), 'acme', 'alice', key, src, 'the plan')
        self.assertEqual(before, ('resume', 'refused'))
        self.assertEqual(after, ('resume', 'refused'))

    def test_completed_receipt_whose_folder_is_gone_stays(self) -> None:
        src = self.m.source('a/chart.png')
        row = self.m.send('acme', 'bob', 'b' * 20, src, 'chart')
        shutil.rmtree(self.m.folder('acme', 'bob', row))
        assigned, report = self.m.assign()
        self.assertEqual(assigned, {})
        self.assertEqual(report['left'], [{'id': row['id'], 'why': 'no snapshot folder and no delivery key',
                                           'source': os.path.normcase(src)}])
        before = self.retries(self.m.rows, 'acme', 'bob', 'b' * 20, src, 'chart')
        after = self.retries(self.m.org_rows('acme', assigned), 'acme', 'bob', 'b' * 20, src, 'chart')
        self.assertEqual(before, ('missing', 'refused'))   # the old build refuses the replay
        self.assertEqual(after, ('new', 'new'))             # option X: no longer consulted

    def test_completed_receipt_whose_folder_is_gone_moves_on_a_recorded_key(self) -> None:
        src = self.m.source('a/chart.png')
        key = 'given-by-the-agent-1'
        row = self.m.send('acme', 'bob', key, src, 'chart')
        shutil.rmtree(self.m.folder('acme', 'bob', row))
        self.m.transcript('acme', 'bob', [call_line('toolu_9', delivery_id=key)])
        assigned, _ = self.m.assign()
        self.assertEqual(assigned, {row['id']: ('acme', KEY, 'bob')})
        after = self.retries(self.m.org_rows('acme', assigned), 'acme', 'bob', key, src, 'chart')
        self.assertEqual(after, ('missing', 'refused'))    # its snapshot is gone: refused, not resent

    def test_folder_copied_into_a_second_org_while_the_original_remains_stays(self) -> None:
        src = self.m.source('a/deck.pptx')
        key = 'c' * 24
        row = self.m.send('acme', 'alice', key, src, 'deck')
        shutil.copytree(self.m.folder('acme', 'alice', row), self.m.folder('beta', 'carol', row))
        assigned, report = self.m.assign()
        self.assertEqual(assigned, {})
        self.assertIn("more than one org's scratch root: ['acme', 'beta']", report['left'][0]['why'])
        before = self.retries(self.m.rows, 'acme', 'alice', key, src, 'deck')
        after = self.retries(self.m.org_rows('acme', assigned), 'acme', 'alice', key, src, 'deck')
        self.assertEqual(before, ('replay', 'refused'))
        self.assertEqual(after, ('new', 'new'))
        # ...unless the sender's key recomputes its id
        self.m.transcript('acme', 'alice', [call_line('toolu_2'), answer_line('toolu_2', lost_answer(key))])
        assigned, _ = self.m.assign()
        self.assertEqual(assigned, {row['id']: ('acme', KEY, 'alice')})
        after = self.retries(self.m.org_rows('acme', assigned), 'acme', 'alice', key, src, 'deck')
        self.assertEqual(after, ('replay', 'refused'))

    def test_a_row_with_no_evidence_stays(self) -> None:
        src = self.m.source('a/notes.txt')
        self.m.send('acme', 'alice', 'd' * 16, src, 'notes', folder=False, complete=False)
        self.m.transcript('acme', 'alice', [call_line('toolu_3')])    # no key anywhere
        assigned, report = self.m.assign()
        self.assertEqual(assigned, {})
        self.assertEqual(len(report['left']), 1)
        before = self.retries(self.m.rows, 'acme', 'alice', 'd' * 16, src, 'notes')
        after = self.retries(self.m.org_rows('acme', assigned), 'acme', 'alice', 'd' * 16, src, 'notes')
        self.assertEqual(before, ('resume', 'refused'))
        self.assertEqual(after, ('new', 'new'))

    def test_decision_20_a_copy_whose_original_is_deleted_moves_and_is_inert(self) -> None:
        src = self.m.source('a/salaries.xlsx', b'private numbers')
        caption = 'for Dana only: next year salaries'
        key = 'e' * 40
        row = self.m.send('acme', 'alice', key, src, caption)
        shutil.copytree(self.m.folder('acme', 'alice', row), self.m.folder('beta', 'carol', row))
        shutil.rmtree(self.m.folder('acme', 'alice', row))
        assigned, report = self.m.assign()
        self.assertEqual(assigned, {row['id']: ('beta', SNAPSHOT, 'carol')})
        self.assertEqual(report['evidence'][row['id']],
                         {'org': 'beta', 'kind': SNAPSHOT, 'agent': 'carol',
                          'where': str(self.m.folder('beta', 'carol', row))})
        held = self.m.org_rows('beta', assigned)
        self.assertEqual([(r['id'], r['fingerprint'], r['result']) for r in held],
                         [(row['id'], row['fingerprint'], row['result'])])
        self.assertIn(caption, held[0]['fingerprint'])      # the source path and caption travel
        # inert in beta: no call there can produce its id (the hash holds acme's slug)
        for seat in self.m.lineage['beta'].values():
            self.assertNotEqual(receipt_id('beta', seat, key), row['id'])
        self.assertEqual(receipt_id('acme', 'seat-alice', key), row['id'])
        # the sender's retry is a new delivery (option X), its caption changed or not
        self.assertEqual(self.retries(self.m.org_rows('acme', assigned), 'acme', 'alice', key, src,
                                      caption), ('new', 'new'))
        self.assertNotIn(caption, json.dumps(report))       # the report prints paths, never captions

    def test_review_round_4_a_removed_grant_is_not_evidence_and_the_mutant_fails(self) -> None:
        # carol (beta) sends from acme's workspace through a grant that is later removed, and
        # crashes before the snapshot folder exists; the bridge minted the key, and the lost
        # answer never reached her transcript
        workspace = self.tmp / 'data' / 'workspaces' / 'acme'
        workspace.mkdir(parents=True)
        (workspace / 'q3.csv').write_bytes(b'numbers')
        src = str(workspace / 'q3.csv')           # snapshot() records the source's real path
        row = self.m.send('beta', 'carol', 'f' * 32, src, 'q3', folder=False, complete=False)
        self.m.transcript('beta', 'carol', [call_line('toolu_4')])
        self.m.transcript('acme', 'alice', [call_line('toolu_5', delivery_id='g' * 32)])

        def moves_to_acme(assign) -> bool:
            rows = sidefiles.read_deliveries(self.m.old_file())
            return assign(rows, self.m.inputs()).get(row['id'], (None,))[0] == 'acme'

        def mutant(rows, orgs):
            """The rule rev 7 removed: a source inside an org's folders names that org."""
            out = sidefiles.assign_deliveries(rows, orgs)
            for r in rows:
                path = json.loads(r['fingerprint'])[0]
                if r['id'] not in out and path.startswith(os.path.normcase(str(workspace))):
                    out[r['id']] = ('acme', 'source path', None)
            return out

        self.assertFalse(moves_to_acme(sidefiles.assign_deliveries))
        self.assertTrue(moves_to_acme(mutant), 'the mutant must fail this test')
        assigned, report = self.m.assign()
        self.assertNotIn(row['id'], assigned)
        self.assertEqual(report['left'], [{'id': row['id'], 'why': 'no snapshot folder and no delivery key',
                                           'source': os.path.normcase(src)}])
        rows_before = files_state(self.m.root / 'data')
        sidefiles.read_deliveries(self.m.root / 'data' / 'file-deliveries.db')
        self.assertEqual(files_state(self.m.root / 'data'), rows_before)   # untouched

    def test_a_key_read_into_another_orgs_transcript_does_not_move_the_row(self) -> None:
        src = self.m.source('b/memo.md')
        key = 'h' * 30
        row = self.m.send('beta', 'carol', key, src, 'memo', folder=False, complete=False)
        self.m.transcript('beta', 'carol', [call_line('toolu_6'), answer_line('toolu_6', lost_answer(key))])
        # an acme agent holds the same key in its own send_file call and answer
        self.m.transcript('acme', 'alice', [call_line('toolu_7', delivery_id=key),
                                            answer_line('toolu_7', lost_answer(key), as_list=False)])
        assigned, report = self.m.assign(converting={'acme'})
        self.assertEqual(assigned, {})                     # never acme's
        self.assertEqual(report['waiting'], [{'id': row['id'], 'org': 'beta', 'evidence': KEY}])
        assigned, report = self.m.assign(converting={'acme'}, transcripts=False)
        self.assertEqual(assigned, {})
        self.assertEqual([x['id'] for x in report['left']], [row['id']])
        assigned, _ = self.m.assign()                       # beta converting: its own key moves it
        self.assertEqual(assigned, {row['id']: ('beta', KEY, 'carol')})

    def test_a_row_naming_an_org_not_converted_now_waits_then_moves_at_its_retry(self) -> None:
        src = self.m.source('a/pic.png')
        row = self.m.send('acme', 'alice', 'i' * 18, src, 'pic')
        assigned, report = self.m.assign(converting={'beta'})
        self.assertEqual(assigned, {})
        self.assertEqual(report['waiting'], [{'id': row['id'], 'org': 'acme', 'evidence': SNAPSHOT}])
        self.assertEqual(report['left'], [])
        assigned, _ = self.m.assign(converting={'acme'})   # acme's retry
        self.assertEqual(assigned, {row['id']: ('acme', SNAPSHOT, 'alice')})

    def test_links_are_resolved(self) -> None:
        src = self.m.source('a/linked.bin')
        row = self.m.send('acme', 'alice', 'j' * 20, src, 'linked')
        link = self.m.folder('beta', 'carol', row)
        link.parent.mkdir(parents=True, exist_ok=True)
        if not make_dir_link(self.m.folder('acme', 'alice', row), link):
            self.skipTest('no directory links on this machine')
        assigned, _ = self.m.assign()                      # one folder, seen twice: acme's
        self.assertEqual(assigned, {row['id']: ('acme', SNAPSHOT, 'alice')})
        # a folder that resolves outside every scratch root proves nothing
        src2 = self.m.source('a/outside.bin')
        row2 = self.m.send('acme', 'bob', 'k' * 20, src2, 'outside')
        outside = self.tmp / 'elsewhere' / 'delivery'
        outside.parent.mkdir()
        shutil.move(str(self.m.folder('acme', 'bob', row2)), str(outside))
        if not make_dir_link(outside, self.m.folder('acme', 'bob', row2)):
            self.skipTest('no directory links on this machine')
        assigned, report = self.m.assign()
        self.assertNotIn(row2['id'], assigned)
        self.assertIn('outside every scratch root', [x for x in report['left'] if x['id'] == row2['id']][0]['why'])

    def test_a_file_that_no_longer_matches_is_not_snapshot_evidence(self) -> None:
        src = self.m.source('a/table.csv')
        key = 'l' * 20
        row = self.m.send('acme', 'alice', key, src, 'table')
        (self.m.folder('acme', 'alice', row) / 'table.csv').write_bytes(b'paylaod')   # same size
        assigned, report = self.m.assign()
        self.assertEqual(assigned, {})
        self.assertIn('does not match the saved result', report['left'][0]['why'])
        self.m.transcript('acme', 'alice', [call_line('toolu_8', delivery_id=key)])
        assigned, _ = self.m.assign()
        self.assertEqual(assigned, {row['id']: ('acme', KEY, 'alice')})

    def test_an_unreadable_location_withholds_evidence_1(self) -> None:
        src = self.m.source('a/x.txt')
        key = 'm' * 20
        row = self.m.send('acme', 'alice', key, src, 'x')
        blocked = os.path.join(str(self.m.scratch / 'beta'), 'carol', 'outbox')
        Path(blocked).mkdir(parents=True)
        real_listdir = os.listdir

        def listdir(path):
            if os.path.normcase(str(path)) == os.path.normcase(blocked):
                raise PermissionError(13, 'denied', str(path))
            return real_listdir(path)

        with patch('os.listdir', listdir):
            assigned, report = self.m.assign()
            self.assertEqual(assigned, {})
            self.assertEqual(report['unreadable'], [blocked])
            self.m.transcript('acme', 'alice', [call_line('toolu_9', delivery_id=key)])
            assigned, _ = self.m.assign()                  # evidence 2 still works
        self.assertEqual(assigned, {row['id']: ('acme', KEY, 'alice')})

    def test_two_orgs_recomputing_one_id_place_it_nowhere(self) -> None:
        src = self.m.source('a/twin.txt')
        key = 'n' * 20
        row = self.m.send('acme', 'alice', key, src, 'twin', folder=False, complete=False)
        path = self.m.transcript('acme', 'alice', [call_line('toolu_a', delivery_id=key)])
        orgs = self.m.inputs()
        orgs['acme-restored'] = OrgEvidenceInput(lineage={'alice': 'seat-alice'}, slug='acme',
                                                 transcripts=[('alice', path)])
        report: dict = {}
        got = sidefiles.assign_deliveries(sidefiles.read_deliveries(self.m.old_file()), orgs,
                                          report=report)
        self.assertEqual(got, {})
        self.assertIn('more than one org', report['left'][0]['why'])
        self.assertEqual(row['id'], report['left'][0]['id'])

    def test_transcripts_are_read_only_when_evidence_1_leaves_rows(self) -> None:
        src = self.m.source('a/ok.txt')
        self.m.send('acme', 'alice', 'o' * 20, src, 'ok')

        def boom():
            raise AssertionError('transcripts read although evidence 1 placed every row')

        orgs = self.m.inputs()
        orgs['acme'] = OrgEvidenceInput(scratch_roots=orgs['acme'].scratch_roots,
                                        lineage=orgs['acme'].lineage, transcripts=boom)
        got = sidefiles.assign_deliveries(sidefiles.read_deliveries(self.m.old_file()), orgs)
        self.assertEqual(len(got), 1)

    def test_transcript_reader(self) -> None:
        good = ['p' * 16, 'q' * 128, 'r-s_t' * 4, 'u' * 20, 'v' * 20]
        p = self.m.transcript('acme', 'alice', [
            call_line('t1', delivery_id=good[0]),                                   # Claude
            call_line('t2', delivery_id=good[1], name='orgtree_send_file'),         # Codex
            call_line('t3', delivery_id=good[2], name='mcp__other__orgtree_send_file'),
            call_line('t4'), answer_line('t4', lost_answer(good[3]), as_list=False),
            call_line('t5'), answer_line('t5', lost_answer(good[4])),
            call_line('t6', delivery_id='short'),                                   # not a key
            call_line('t7', delivery_id='x' * 129),
            call_line('t8', delivery_id='bad key with spaces!'),
            call_line('t9', delivery_id='w' * 20, name='orgtree_message'),          # another tool
            answer_line('t9', lost_answer('y' * 20)),
            answer_line('t-unknown', lost_answer('z' * 20)),                         # no such call
            call_line('t10'), answer_line('t10', 'not json'),
        ])
        self.assertEqual(sidefiles.transcript_keys(p), set(good))
        with self.assertRaises(OSError):
            sidefiles.transcript_keys(str(self.tmp / 'missing.jsonl'))

    def test_an_unreadable_transcript_gives_no_evidence(self) -> None:
        src = self.m.source('a/y.txt')
        self.m.send('acme', 'alice', 'y' * 20, src, 'y', folder=False, complete=False)
        self.m.transcripts['acme'].append(('alice', str(self.tmp / 'gone.jsonl')))
        assigned, report = self.m.assign()
        self.assertEqual(assigned, {})
        self.assertEqual(report['transcripts']['unreadable'], [str(self.tmp / 'gone.jsonl')])


def make_dir_link(target: Path, link: Path) -> bool:
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        pass
    try:
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
        return True
    except (ImportError, OSError):
        return False


# ---------------------------------------------------------------- file deliveries: rows

class FileDeliveryRows(unittest.TestCase):
    ROWS = [
        {'id': 'a' * 64, 'fingerprint': '["c:\\\\x\\\\a.txt", "cap"]', 'result': '{"name": "a.txt"}'},
        {'id': 'b' * 64, 'fingerprint': '["c:\\\\x\\\\b.txt", ""]', 'result': None},
        {'id': 'c' * 64, 'fingerprint': 'fp \x00 nul', 'result': ''},
        {'id': 'd' * 64, 'fingerprint': None, 'result': None},
        {'id': 'e' * 64, 'fingerprint': 'not mine', 'result': None},
    ]
    ASSIGNED = {'a' * 64: ('acme', SNAPSHOT, 'alice'), 'b' * 64: ('acme', KEY, 'ghost'),
                'c' * 64: ('acme', KEY, None), 'd' * 64: ('acme', SNAPSHOT, 'alice'),
                'e' * 64: ('beta', SNAPSHOT, 'carol')}

    def test_assigned_rows_round_trip_exactly(self) -> None:
        sec = sidefiles.FileDeliveries('acme', self.ROWS, self.ASSIGNED)
        rows, ctx = encode({'nodes': {'alice': node('s')}}, [sec])
        self.assertEqual(ctx.tombstones, ['ghost'])
        by_id = {r['id']: r for r in rows['file_deliveries']}
        self.assertEqual(sorted(by_id), ['a' * 64, 'b' * 64, 'c' * 64, 'd' * 64])
        self.assertEqual(by_id['b' * 64]['result'], None)
        self.assertIsNone(by_id['b' * 64]['extra'])
        self.assertEqual(by_id['c' * 64]['extra'].obj, {'fingerprint': 'fp \x00 nul'})
        self.assertEqual(by_id['d' * 64]['extra'].obj, {'fingerprint': None})
        self.assertIsNone(by_id['c' * 64]['agent_id'])
        back = sidefiles.decode_file_deliveries(rows, ctx.names)
        self.assertEqual([(r['id'], r['fingerprint'], r['result']) for r in back],
                         [(r['id'], r['fingerprint'], r['result']) for r in self.ROWS[:4]])
        self.assertEqual([(r['evidence'], r['agent']) for r in back],
                         [(SNAPSHOT, 'alice'), (KEY, 'ghost'), (KEY, None), (SNAPSHOT, 'alice')])
        self.assertEqual(sidefiles.check_file_deliveries(self.ROWS[:4], rows), [])
        bad = copy.deepcopy(rows)
        bad['file_deliveries'][1]['result'] = '{}'
        self.assertEqual(sidefiles.check_file_deliveries(self.ROWS[:4], bad)[0]['missing'],
                         [{'id': 'b' * 64}])

    def test_a_blob_is_refused(self) -> None:
        rows = [{'id': 'a' * 64, 'fingerprint': b'\x00', 'result': None}]
        with self.assertRaises(codec.ShapeError):
            encode({}, [sidefiles.FileDeliveries('acme', rows, {'a' * 64: ('acme', KEY, None)})])


# ---------------------------------------------------------------- the converter's wiring

class ConverterWiring(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix='orgdb-sidewire-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.m = Machine(self.tmp)
        self.m.org('acme', {'alice': 'seat-alice', 'bob': 'seat-bob'})
        self.m.org('beta', {'carol': 'seat-carol'})
        self.data = self.tmp / 'data'
        (self.data / 'orgs').mkdir()
        (self.data / 'orgs' / 'acme.pg').write_text('{"org_id": 1}', encoding='utf-8')
        ev = sqlite3.connect(self.data / 'reply-events.sqlite3')
        ev.execute(EVENTS_DDL)
        ev.executemany('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)', [
            ('acme', 'alice', 0, 'reply_1', 'hi \x00', 'sc'), ('acme', 'gone', 3, 'reply_2', 'x', 'sc'),
            ('beta', 'carol', 0, 'reply_3', 'yo', 'sc'), ('lost-org', 'z', 0, 'reply_4', 'z', 'sc')])
        ev.commit()
        ev.close()
        registry = {'version': 1, 'accounts': [
            {'id': 'claude-1', 'provider': 'claude', 'credential': {'kind': 'managed',
                                                                   'path': str(self.tmp / 'profile')}},
            {'id': 'claude-2', 'provider': 'claude', 'origin_org': 'acme', 'mode': 'apikey',
             'credential': {'kind': 'apikey', 'token_ref': 'tok'}, 'spend': {'usd_total': 1.5}}],
            'aliases': {}, 'id_counters': {'claude': 2}, 'tint_counters': {'claude': 2}}
        (self.data / 'accounts-registry.json').write_text(json.dumps(registry), encoding='utf-8')
        # alice's session transcript, in the Claude account's profile store
        proj = self.tmp / 'profile' / 'projects' / 'E--work'
        proj.mkdir(parents=True)
        self.key = 'wire' * 5
        self.pending = self.m.send('acme', 'alice', self.key, self.m.source('w/a.txt'), 'a',
                                   folder=False, complete=False)
        self.snapped = self.m.send('acme', 'bob', 'snap' * 5, self.m.source('w/b.txt'), 'b')
        self.theirs = self.m.send('beta', 'carol', 'theirs' * 4, self.m.source('w/c.txt'), 'c')
        (proj / 'sess-alice.jsonl').write_text(
            json.dumps(call_line('t1')) + '\n' + json.dumps(answer_line('t1', lost_answer(self.key))) + '\n',
            encoding='utf-8')
        self.m.old_file()
        self.doc = {'slug': 'acme', 'nodes': {'alice': node('seat-alice', 'sess-alice'),
                                              'bob': node('seat-bob', 'sess-bob')}}
        self.org = types.SimpleNamespace(slug='acme', org_id=1, status='active')

    def side(self) -> sidefiles.SideFiles:
        return sidefiles.SideFiles(str(self.data), transcript_roots=[str(self.tmp / 'profile')])

    def test_one_org_converts_and_checks_exactly(self) -> None:
        before = files_state(self.data)
        sf = self.side()
        secs = sf.sections_for(self.org, self.doc)
        rows, ctx = encode(self.doc, secs)
        self.assertEqual(sf.check(self.org, rows), [])
        self.assertEqual(ctx.tombstones, ['gone'])
        self.assertEqual(sorted(r['public_id'] for r in rows['reply_events']), ['reply_1', 'reply_2'])
        by_id = {r['id']: r['evidence'] for r in rows['file_deliveries']}
        self.assertEqual(by_id, {self.pending['id']: KEY, self.snapped['id']: SNAPSHOT})
        self.assertEqual([r['id'] for r in rows['org_accounts']], ['claude-2'])
        report = sf.reports['acme#1']
        self.assertEqual(report['file_deliveries']['moved'], {'acme': {SNAPSHOT: 1, KEY: 1}})
        self.assertEqual(report['file_deliveries']['waiting'],
                         [{'id': self.theirs['id'], 'org': 'beta', 'evidence': SNAPSHOT}])
        left = sf.left_over(['acme#1'])
        self.assertEqual(left, {'reply_events': {'beta': 1, 'lost-org': 1},
                                'file_deliveries': [self.theirs['id']]})
        # a changed row is a mismatch
        bad = copy.deepcopy(rows)
        bad['reply_events'][0]['scope'] = 'changed'
        bad['org_accounts'][0]['label'] = 'changed'
        found = sf.check(self.org, bad)
        self.assertEqual([f['path'] for f in found], ['side/reply_events', 'side/org_accounts'])
        self.assertEqual(files_state(self.data), before)     # nothing under the root written

    def test_a_trashed_org_sharing_its_name_places_no_folder(self) -> None:
        (self.data / 'deleted').mkdir()
        (self.data / 'deleted' / 'acme-20260930T101500.pg').write_text('{"org_id": 7}', encoding='utf-8')
        sf = self.side()
        trashed = types.SimpleNamespace(slug='acme', org_id=7, status='trashed')
        secs = sf.sections_for(trashed, self.doc)
        rows, _ = encode(self.doc, secs)
        self.assertEqual(rows.get('reply_events', []), [])        # its events were cleared at delete
        self.assertEqual(rows.get('org_accounts', []), [])        # the live acme binds them
        self.assertEqual([r['id'] for r in rows.get('file_deliveries', [])], [self.pending['id']])
        left = {x['id']: x['why'] for x in sf.reports['acme#7']['file_deliveries']['left']}
        self.assertIn("more than one org's scratch root", left[self.snapped['id']])
        self.assertEqual(sf.check(trashed, rows), [])
        # the live org of that name is held to the same rule: a shared root places nothing
        live = sf.sections_for(self.org, self.doc)
        rows, _ = encode(self.doc, live)
        self.assertEqual([r['id'] for r in rows['file_deliveries']], [self.pending['id']])

    def test_side_inputs_is_the_converters_hook(self) -> None:
        from orgtree.orgdb.convert import run
        home = self.tmp / 'home'               # ~/.claude is one of the stores it searches
        home.mkdir()
        with patch.dict(os.environ, {'USERPROFILE': str(home), 'HOME': str(home)}):
            hook = sidefiles.side_inputs(str(self.data))
            self.assertIsInstance(hook, run.SideInputs)
            secs = hook.sections_for(self.org, self.doc)
        self.assertEqual(len(secs[1].rows), 2)                # alice's key found in her profile
        self.assertEqual([type(s).__name__ for s in secs], ['ReplyEvents', 'FileDeliveries', 'OrgAccounts'])
        # the run's report: this org's side report, and what the old files keep
        self.assertEqual(hook.report_for(self.org)['file_deliveries']['moved'],
                         {'acme': {SNAPSHOT: 1, KEY: 1}})
        self.assertEqual(hook.left_over([self.org])['file_deliveries'], [self.theirs['id']])
        self.assertEqual(hook.left_over([])['file_deliveries'],
                         [r['id'] for r in sidefiles.read_deliveries(self.data / sidefiles.DELIVERIES_FILE)])
        empty = sidefiles.side_inputs(str(self.tmp / 'no-such-root'))
        secs = empty.sections_for(self.org, self.doc)
        rows, _ = encode(self.doc, secs)
        self.assertEqual(empty.check(self.org, rows), [])


# ---------------------------------------------------------------- the migration

def migration_columns(text: str) -> dict[str, list[str]]:
    """{table: [column names]} of every CREATE TABLE in a migration file."""
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


def table_columns(t) -> dict[str, list[str]]:
    """{table: [column names]} a sections.Table writes or declares."""
    out = {}
    for name, lay in t.layout().items():
        given = [rc.split()[0].strip('"') for rc in t.record_columns] if name == t.spec.table else []
        keys = [c for c, _ in lay['keys'] if c not in given]
        out[name] = given + keys + [c for c, _ in lay['columns']] + (['extra'] if lay['extra'] else [])
    return out


class Migration(unittest.TestCase):
    def test_0003_has_exactly_the_columns_the_specs_write(self) -> None:
        from orgtree.orgdb.convert import accounts
        want: dict[str, list[str]] = {}
        for t in (sidefiles.REPLY_EVENTS, sidefiles.FILE_DELIVERIES, accounts.ORG_ACCOUNTS,
                  accounts.ORG_MARKS, accounts.ORG_SPENDS):
            want.update(table_columns(t))
        got = migration_columns(MIGRATION.read_text(encoding='utf-8'))
        self.assertEqual({k: sorted(v) for k, v in got.items()}, {k: sorted(v) for k, v in want.items()})

    def test_the_side_sections_tables_come_after_the_agents(self) -> None:
        from orgtree.orgdb.convert import accounts, rowio
        order = rowio.tables(mappers.sections() + [sidefiles.ReplyEvents(), accounts.OrgAccounts(),
                                                   sidefiles.FileDeliveries('acme', [], {})])
        for t in ('reply_events', 'file_deliveries', 'org_accounts', 'org_account_marks',
                  'org_account_spend'):
            self.assertGreater(order.index(t), order.index('agents'))
        self.assertGreater(order.index('org_account_marks'), order.index('org_accounts'))


if __name__ == '__main__':
    unittest.main()
