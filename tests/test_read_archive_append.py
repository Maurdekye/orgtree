"""Marking a mail read files it into the read archive WITHOUT rewriting it.

Docket v3-marking-a-mail-as-read-takes-about-half-a-sec and
v3-sending-a-reply-to-a-mail-takes-about-half-a (2026-09-30). The archive
(`user_mail_log`) must stay CHRONOLOGICAL (the reader renders by list
position; user bug 2026-08-02). It used to be kept that way with
`log.sort(...)`, and on the row store `sort()` gives up every row's identity,
so each mark-read DELETEd and re-INSERTed the whole archive: measured on a
copy of the orgtree org, ~990 statements and 125-175 ms of SQL per read,
growing by one row per mail ever read. These tests pin the replacement,
`ledger.file_read_mail`: rows that were already filed keep their stored
identity (seq), so the cost is the mails read after the one being filed,
never the size of the archive.
"""
import os
from pathlib import Path
import random
import sqlite3
import tempfile
import unittest

root = tempfile.TemporaryDirectory(prefix='v3-read-archive-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE='sqlite')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from fastapi.testclient import TestClient  # noqa: E402

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()
from orgtree import ledger, orgtx, store  # noqa: E402

orgtx.TRANSITION_FENCE = False
HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}


def tearDownModule() -> None:
    root.cleanup()


def at(i: int) -> str:
    return f'2026-09-30T{i // 3600:02d}:{i // 60 % 60:02d}:{i % 60:02d}Z'


class ReadArchive(unittest.TestCase):
    n = 0

    def setUp(self) -> None:
        ReadArchive.n += 1
        org = store.create_org(f'Archive {ReadArchive.n}')
        self.slug = org.d['slug']
        org.hire(ledger.USER, None, 'haiku', 0, 'boss')
        store.save_org(org)
        self.client = TestClient(app)

    def fill(self, times: list[int], unread: list[int]) -> list[str]:
        """An archive of read mails at `times` (in order), and unread mails
        at `unread`; returns the unread ids."""
        org = store.load_org(self.slug)
        org.d['user_mail_log'] = [{'id': f'r{t}', 'from': 'boss', 'at': at(t), 'body': f'read {t}'}
                                  for t in times]
        store.save_org(org)
        org = store.load_org(self.slug)
        ids = [org.to_user_inbox({'id': f'u{t}', 'from': 'boss', 'at': at(t), 'body': f'unread {t}'})['id']
               for t in unread]
        store.save_org(org)
        return ids

    def rows(self) -> dict[str, int]:
        """archive entry id -> its stored row identity (seq)"""
        import json
        con = sqlite3.connect(store._db_path(self.slug))
        try:
            got = con.execute("SELECT seq, val FROM log_l WHERE sect='user_mail_log' ORDER BY seq").fetchall()
        finally:
            con.close()
        return {json.loads(v)['id']: seq for seq, v in got}

    def archive(self) -> list[str]:
        return [m['id'] for m in store.load_org(self.slug).d.get('user_mail_log', [])]

    def read(self, *ids: str) -> None:
        r = self.client.post(f'/api/orgs/{self.slug}/inbox/read', headers=HEADERS, json={'ids': list(ids)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['read'], len(ids))

    def assert_chronological(self) -> None:
        ats = [m['at'] for m in store.load_org(self.slug).d['user_mail_log']]
        self.assertEqual(ats, sorted(ats), 'the archive is chronological')

    def test_reading_the_newest_mail_adds_one_row_and_keeps_every_other(self) -> None:
        (u,) = self.fill(list(range(1, 31)), [40])
        before = self.rows()
        self.assertEqual(len(before), 30, 'the fixture archive is stored as rows')
        self.read(u)
        after = self.rows()
        self.assertEqual({k: after[k] for k in before}, before, 'no filed row was rewritten')
        self.assertEqual(set(after) - set(before), {u})
        self.assert_chronological()

    def test_reading_an_older_mail_rewrites_only_the_rows_after_it(self) -> None:
        # the user read newer mail first: the archive holds even seconds
        # 2..60, and the mail being read now is from second 21
        (u,) = self.fill(list(range(2, 61, 2)), [21])
        before = self.rows()
        self.read(u)
        after = self.rows()
        older = [f'r{t}' for t in range(2, 21, 2)]
        self.assertEqual({k: after[k] for k in older}, {k: before[k] for k in older},
                         'rows older than the filed mail keep their identity')
        self.assertEqual(self.archive(), older + [u] + [f'r{t}' for t in range(22, 61, 2)])
        self.assert_chronological()

    def test_the_cost_does_not_grow_with_the_archive(self) -> None:
        changed = []
        for size in (20, 400):
            self.setUp()
            (u,) = self.fill(list(range(1, size + 1)), [size + 5])
            before = self.rows()
            self.read(u)
            after = self.rows()
            changed.append(sum(1 for k, s in after.items() if before.get(k) != s)
                           + sum(1 for k in before if k not in after))
        self.assertEqual(changed, [1, 1], 'one new row whatever the archive size')

    def test_a_notice_to_the_user_files_without_rewriting(self) -> None:
        self.fill(list(range(1, 21)), [])
        before = self.rows()
        org = store.load_org(self.slug)
        org.to_user_inbox({'id': 'n1', 'from': 'boss', 'at': at(30), 'body': 'fyi', 'kind': 'notice'})
        store.save_org(org)
        after = self.rows()
        self.assertEqual({k: after[k] for k in before}, before)
        self.assertEqual(self.archive()[-1], 'n1')
        self.assert_chronological()

    def test_mark_all_read_files_in_order_and_keeps_filed_rows(self) -> None:
        self.fill(list(range(1, 21)), [35, 25, 30])
        before = self.rows()
        r = self.client.post(f'/api/orgs/{self.slug}/inbox/clear', headers=HEADERS)
        self.assertEqual(r.status_code, 200, r.text)
        after = self.rows()
        self.assertEqual({k: after[k] for k in before}, before)
        self.assertEqual(self.archive()[-3:], ['u25', 'u30', 'u35'])
        self.assertEqual(store.load_org(self.slug).d['user_inbox'], [])
        self.assert_chronological()


class FileReadMail(unittest.TestCase):
    def test_same_result_as_the_stable_sort_it_replaces(self) -> None:
        rnd = random.Random(7)
        for _ in range(300):
            log = sorted(({'id': f'a{i}', 'at': at(rnd.randrange(20))} for i in range(rnd.randrange(12))),
                         key=lambda m: m['at'])
            new = [{'id': f'b{i}', 'at': at(rnd.randrange(20))} for i in range(rnd.randrange(5))]
            want = sorted([*log, *new], key=lambda m: m['at'])
            got = list(log)
            ledger.file_read_mail(got, new)
            self.assertEqual([m['id'] for m in got], [m['id'] for m in sorted(
                [*log, *sorted(new, key=lambda m: m['at'])], key=lambda m: m['at'])])
            self.assertEqual([m['at'] for m in got], [m['at'] for m in want])


if __name__ == '__main__':
    unittest.main()
