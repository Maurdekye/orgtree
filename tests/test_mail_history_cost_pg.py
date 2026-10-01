"""Bounded two-sender history stress curve, explicitly requested by the owner.

Not a fleet qualification. Identical two active mailboxes and send counts with
1,000 versus 10,000 retained rows per recipient, in ABBA order. Source setup and
migration are outside the measured window. Run only with an owned PG admin URL.
"""
import json
import os
from pathlib import Path
import threading
import time
import unittest
import uuid
from unittest.mock import patch

import test_mail_archive_bounds_pg as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import ledger, mailtx, orgtx, store


@unittest.skipUnless(fixture.ADMIN and os.environ.get('ORGTREE_MAIL_COST_OUT'), 'explicit cost run only')
class MailHistoryCost(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.pgstore.migrate(os.environ['ORGTREE_PG_URL'])

    def test_equal_active_send_work_with_tenfold_history(self):
        arms = []
        for history in (1000, 10000, 10000, 1000):
            org = store.create_org('history-cost-' + uuid.uuid4().hex[:8])
            slug = org.d['slug']
            for owner in ('a', 'b'):
                org.hire(ledger.USER, None, 'luna', 0, owner)
                org.deposit_mail(owner, {'id': 'seed-' + owner, 'body': 'seed'})
                org.d['mail'][owner] = []
            store.save_org(org)
            with store._POOL.acquire(slug) as conn:
                conn.use()
                with conn.raw.cursor().copy('COPY log_d(sect,owner,at,val) FROM STDIN') as stream:
                    for owner in ('a', 'b'):
                        for seq in range(2, history + 1):
                            stream.write_row(('mail_log', owner, '2026-01-01', json.dumps({
                                'id': f'{owner}-{seq}', 'from': 'sender', 'at': '2026-01-01',
                                'body': 'x' * 512, 'recv_seq': seq, 'read': True})))
                conn.raw.commit()
            gate = threading.Barrier(3)
            lock = threading.Lock()
            elapsed, cpu, assigned, errors, loaded = [], [], [], [], []
            original = store.SectionMap._load_owner
            def observed(log, owner):
                value = original(log, owner)
                if log._sect == 'mail_log':
                    with lock: loaded.append(len(value))
                return value
            def sender(owner):
                try:
                    gate.wait(5)
                    for i in range(30):
                        wall, thread_cpu = time.perf_counter_ns(), time.thread_time_ns()
                        with orgtx.org_tx(slug, **mailtx.send_rows(owner)) as tx:
                            row = tx.org.deposit_mail(owner, {'id': f'new-{owner}-{i}', 'body': 'new'})
                        with lock:
                            elapsed.append((time.perf_counter_ns() - wall) / 1e6)
                            cpu.append((time.thread_time_ns() - thread_cpu) / 1e6)
                            assigned.append((owner, row['recv_seq']))
                except BaseException as exc:
                    errors.append(str(exc))
            threads = [threading.Thread(target=sender, args=(owner,)) for owner in ('a', 'b')]
            with patch.object(store.SectionMap, '_load_owner', observed):
                for thread in threads: thread.start()
                start_cpu, start_wall = time.process_time_ns(), time.perf_counter_ns()
                gate.wait(5)
                for thread in threads: thread.join(60)
                process_ms = (time.process_time_ns() - start_cpu) / 1e6
                wall_ms = (time.perf_counter_ns() - start_wall) / 1e6
            self.assertFalse(any(t.is_alive() for t in threads))
            self.assertEqual(errors, [])
            self.assertEqual(len(assigned), 60)
            for owner in ('a', 'b'):
                self.assertEqual(sorted(n for who, n in assigned if who == owner), list(range(history + 1, history + 31)))
            arm = dict(history_per_recipient=history, sends=len(assigned), active_recipients=2,
                       elapsed_ms=elapsed, thread_cpu_ms=cpu, process_cpu_ms=process_ms,
                       window_wall_ms=wall_ms, archive_rows_materialized=sum(loaded), archive_loads=len(loaded))
            arms.append(arm)
            store._POOL.close_all(slug)
        Path(os.environ['ORGTREE_MAIL_COST_OUT']).write_text(json.dumps(arms, indent=2), encoding='utf-8')


def tearDownModule():
    fixture.tearDownModule()


if __name__ == '__main__':
    unittest.main()
