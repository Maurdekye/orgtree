"""ORGTREE_TURN_LOG: a node's full turn history in the `turn_log` dict log.

The node row keeps its newest TREE_TURNS turns plus `turn_seq` and the running
sums the killed-turn estimate needs. What these prove:
  * EXACT: the running sums equal the old `sum()` over the whole ring — same
    value, same type — on random histories, on a long legacy ring converted
    and then N more turns through both paths, and so the estimate is equal;
  * ROLLBACK: converted -> an older engine appends to the ring -> roll-forward
    logs every turn once, in order (idempotent, keyed by the turn number);
  * the switch off is the old ring append;
  * PostgreSQL: the whole-load heal converts and commits the log rows; a
    turn is appended WITHOUT reading the node's history; a transaction that
    did not name the log still writes an unconverted node; the three
    supervisor writers name the log (without it their writes are refused).

Run:  python tools/run-python-verification.py tests/test_turn_log.py
"""
import contextlib
import copy
import json
import random
import threading
import unittest
import uuid
from unittest.mock import patch

import test_pgstore as f
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
from orgtree import history, ledger, orgtx, pgstore, store


def tearDownModule():
    f.tearDownModule()


def old_sums(ring):
    """supervisor._charge_killed_turn before ORGTREE_TURN_LOG, verbatim."""
    pairs = [(t.get("cost") or 0.0, t.get("toks") or 0)
             for t in ring
             if t.get("cost") and t.get("toks") and not t.get("killed")]
    return sum(c for c, _ in pairs), sum(tk for _, tk in pairs)


def estimate(sums, out_toks=1234):
    num, den = sums
    return round(out_toks * num / den, 6) if (out_toks and den) else 0.0


def turn(rnd, i):
    r = rnd.random()
    e = {"at": f"2026-09-28T00:00:{i % 60:02d}Z", "i": i,
         "toks": rnd.choice([0, 1, 57, 1200, 88000])}
    if r < 0.1:
        e["cost"] = 0
    elif r < 0.2:
        e["cost"] = rnd.randint(1, 3)                      # an int cost
    elif r < 0.25:
        e["cost"] = rnd.choice([1e16, 1e-12, 0.1])         # magnitudes that drift
    else:
        e["cost"] = round(rnd.uniform(0, 3) * 10 ** rnd.randint(-5, 1), rnd.randint(2, 9))
    if rnd.random() < 0.1:
        e["killed"] = True
    return e


def strip(rows):
    return [{k: v for k, v in r.items() if k != "n"} for r in rows]


class TurnSums(unittest.TestCase):
    def setUp(self):
        flag = patch.object(ledger, "TURN_LOG", True)
        flag.start()
        self.addCleanup(flag.stop)

    def converted(self, legacy, more):
        """A node with `legacy` un-logged ring entries, converted, then
        `more` turns through record_turn. Returns (doc, node)."""
        d = {}
        n = {"turns": copy.deepcopy(legacy)}
        ledger.convert_turns(d, "a", n)
        for e in copy.deepcopy(more):
            ledger.record_turn(d, "a", n, e)
        return d, n

    def test_running_sums_equal_the_whole_ring_sum_exactly(self):
        rnd = random.Random(20260928)
        for trial in range(400):
            hist = [turn(rnd, i) for i in range(rnd.randint(0, 60))]
            cut = rnd.randint(0, len(hist))
            d, n = self.converted(hist[:cut], hist[cut:])
            got, want = ledger.turn_estimate_sums(n), old_sums(hist)
            self.assertEqual(got, want, trial)
            self.assertEqual([type(v) for v in got], [type(v) for v in want], trial)
            self.assertEqual(strip(d.get("turn_log", {}).get("a", [])), hist, trial)
            self.assertEqual(strip(n["turns"]), hist[-ledger.TREE_TURNS:], trial)
            # a node that never had a turn stays unstamped
            self.assertEqual(n.get("turn_seq", 0), len(hist))
            self.assertEqual("turn_seq" in n, bool(hist))

    def test_a_long_ring_then_n_more_turns_through_both_paths(self):
        rnd = random.Random(7)
        legacy = [turn(rnd, i) for i in range(600)]
        more = [turn(rnd, 600 + i) for i in range(45)]
        # the old path: every turn appended to the ring, the ring summed
        with patch.object(ledger, "TURN_LOG", False):
            old = {"turns": copy.deepcopy(legacy)}
            for e in copy.deepcopy(more):
                ledger.record_turn({}, "a", old, e)
        self.assertEqual(len(old["turns"]), 645)
        self.assertNotIn("turn_seq", old)
        # converted after the long ring, before the N more
        d, n = self.converted(legacy, [])
        self.assertEqual(ledger.turn_estimate_sums(n), old_sums(legacy))
        for e in copy.deepcopy(more):
            ledger.record_turn(d, "a", n, e)
        self.assertEqual(ledger.turn_estimate_sums(n), old_sums(old["turns"]))
        self.assertEqual(estimate(ledger.turn_estimate_sums(n)), estimate(old_sums(old["turns"])))
        self.assertEqual(ledger.turn_estimate_sums(old), old_sums(old["turns"]))
        self.assertEqual(len(n["turns"]), ledger.TREE_TURNS)
        self.assertEqual([r["n"] for r in d["turn_log"]["a"]], list(range(1, 646)))

    def test_rollback_older_engine_appends_then_roll_forward(self):
        rnd = random.Random(11)
        legacy = [turn(rnd, i) for i in range(20)]
        d, n = self.converted(legacy, [turn(rnd, 20 + i) for i in range(3)])
        full = d["turn_log"]["a"] + []
        self.assertEqual(len(full), 23)
        # an older engine (no turn log) appends to the ring: no `n`, no trim
        older = [turn(rnd, 23 + i) for i in range(12)]
        n["turns"].extend(copy.deepcopy(older))
        hist = strip(full) + older
        self.assertEqual(ledger.turn_estimate_sums(n), old_sums(hist))
        self.assertEqual(strip(history._turn_log_rows_from(d, n, "a")), hist)
        # roll forward: logged once each, in order, numbered on
        self.assertTrue(ledger.convert_turns(d, "a", n))
        self.assertEqual(strip(d["turn_log"]["a"]), hist)
        self.assertEqual([r["n"] for r in d["turn_log"]["a"]], list(range(1, 36)))
        self.assertEqual(ledger.turn_estimate_sums(n), old_sums(hist))
        # idempotent: converting again changes and logs nothing
        snap = copy.deepcopy((d, n))
        self.assertFalse(ledger.convert_turns(d, "a", n))
        self.assertEqual((d, n), snap)
        # and new turns carry on from there
        e = turn(rnd, 99)
        ledger.record_turn(d, "a", n, e)
        self.assertEqual(d["turn_log"]["a"][-1]["n"], 36)
        self.assertEqual(ledger.turn_estimate_sums(n), old_sums(hist + [strip([e])[0]]))

    def test_a_new_turn_logs_the_older_engines_appends_first(self):
        rnd = random.Random(3)
        d, n = self.converted([turn(rnd, i) for i in range(10)], [])
        older = [turn(rnd, 10 + i) for i in range(2)]
        n["turns"].extend(copy.deepcopy(older))
        e = turn(rnd, 12)
        ledger.record_turn(d, "a", n, e)
        self.assertEqual([r["i"] for r in d["turn_log"]["a"]], list(range(13)))
        self.assertEqual([r["n"] for r in d["turn_log"]["a"]], list(range(1, 14)))

    def test_a_node_with_no_turns_is_left_alone_until_its_first_turn(self):
        d, n = {}, {"id": "a"}
        self.assertFalse(ledger.convert_turns(d, "a", n))
        self.assertEqual((d, n), ({}, {"id": "a"}))
        n["turns"] = []
        self.assertFalse(ledger.convert_turns(d, "a", n))
        self.assertNotIn("turn_seq", n)
        e = {"cost": 0.25, "toks": 40}
        ledger.record_turn(d, "a", n, dict(e))
        self.assertEqual(n["turn_seq"], 1)
        self.assertEqual(ledger.turn_estimate_sums(n), old_sums([e]))
        self.assertEqual(strip(d["turn_log"]["a"]), [e])

    def test_an_unconverted_nodes_entries_are_all_legacy_whatever_keys_they_carry(self):
        # `n` means "logged" only on a converted node (one with turn_seq)
        rnd = random.Random(19)
        legacy = [dict(turn(rnd, i), n=i) for i in range(20)]
        d, n = {}, {"turns": copy.deepcopy(legacy)}
        self.assertTrue(ledger.convert_turns(d, "a", n))
        self.assertEqual([r["i"] for r in d["turn_log"]["a"]], list(range(20)))
        self.assertEqual([r["n"] for r in d["turn_log"]["a"]], list(range(1, 21)))
        self.assertEqual(ledger.turn_estimate_sums(n), old_sums(legacy))

    def test_the_switch_off_is_the_old_ring_append(self):
        with patch.object(ledger, "TURN_LOG", False):
            d, n = {}, {"turns": [{"cost": 0.1, "toks": 5}] * 9}
            ledger.record_turn(d, "a", n, {"cost": 0.2, "toks": 7})
        self.assertEqual(d, {})
        self.assertEqual(len(n["turns"]), 10)
        self.assertNotIn("n", n["turns"][-1])
        self.assertNotIn("turn_seq", n)

    def test_a_non_number_raises_where_the_old_sum_raised(self):
        ring = [{"cost": 0.1, "toks": 5}, {"cost": "x", "toks": 5}]
        with self.assertRaises(TypeError):
            old_sums(ring)
        with self.assertRaises(TypeError):
            ledger.turn_estimate_sums({"turns": copy.deepcopy(ring)})
        d, n = self.converted(ring, [])
        with self.assertRaises(TypeError):
            ledger.turn_estimate_sums(n)


class SwitchDefault(unittest.TestCase):
    def test_the_turn_log_default_is_on_and_0_turns_it_off(self):
        import os
        import subprocess
        import child_python
        from pathlib import Path
        repo = Path(__file__).resolve().parents[1]
        code = 'from orgtree import ledger; print(ledger.TURN_LOG)'
        for value, want in ((None, 'True'), ('', 'True'), ('1', 'True'), ('0', 'False'),
                            ('false', 'False'), ('Off', 'False'), (' no ', 'False')):
            env = {k: v for k, v in os.environ.items() if k != 'ORGTREE_TURN_LOG'}
            if value is not None:
                env['ORGTREE_TURN_LOG'] = value
            out = subprocess.run(child_python.argv('-c', code, checkout=repo), env=env,
                                 capture_output=True, text=True, timeout=120)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual(out.stdout.strip().splitlines()[-1], want, value)


class Rename(unittest.TestCase):
    def test_a_rename_rekeys_the_turn_log(self):
        from test_authorized_review_workflow import fixture
        org, _ = fixture()
        org.d["turn_log"] = {"peer-b": [{"n": 1, "cost": 0.1}]}
        org.rename(ledger.USER, "peer-b", "peer-bb")
        self.assertEqual(org.d["turn_log"], {"peer-bb": [{"n": 1, "cost": 0.1}]})


def node(nid, **extra):
    return {'id': nid, 'name': nid, 'parent': None, 'children': [], 'payload': {'v': 1}, **extra}


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class PgTurnLog(unittest.TestCase):
    LEGACY = 30

    @classmethod
    def setUpClass(cls):
        store.claim_data_root()

    def setUp(self):
        flags = patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True, _heal_epoch_value=[])
        flags.start()
        self.addCleanup(flags.stop)
        flag = patch.object(ledger, 'TURN_LOG', True)
        flag.start()
        self.addCleanup(flag.stop)
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        rnd = random.Random(5)
        self.legacy = [turn(rnd, i) for i in range(self.LEGACY)]
        self.rnd = rnd
        with patch.object(ledger, 'TURN_LOG', False):     # stored by an engine before the log
            org = store.create_org('turnlog-' + uuid.uuid4().hex[:10])
            self.slug = org.d['slug']
            org.hire(ledger.USER, None, 'opus', 0, 'worker')
            org.node('worker')['turns'] = copy.deepcopy(self.legacy[:12])
            for i in range(6):
                org.d['nodes'][f'n{i}'] = node(f'n{i}')
            org.d['nodes']['n3']['turns'] = copy.deepcopy(self.legacy)
            store.save_org(org)
        with pgstore.connect() as raw:
            self.oid = raw.execute('SELECT org_id FROM public.orgs WHERE slug=%s',
                                   (self.slug,)).fetchone()[0]

    @contextlib.contextmanager
    def raw(self):
        with pgstore.connect() as raw:
            raw.execute('BEGIN')
            raw.execute(f'SET LOCAL search_path TO org_{self.oid},public')
            try:
                yield raw
            except BaseException:
                raw.execute('ROLLBACK')
                raise
            else:
                raw.execute('COMMIT')

    def node_row(self, nid='n3'):
        with self.raw() as raw:
            return json.loads(raw.execute('SELECT val FROM nodes WHERE id=%s', (nid,)).fetchone()[0])

    def log_rows(self, owner='n3'):
        with self.raw() as raw:
            return [json.loads(v) for (v,) in raw.execute(
                "SELECT val FROM log_d WHERE sect='turn_log' AND owner=%s ORDER BY seq",
                (owner,)).fetchall()]

    def stamp(self):
        with orgtx.org_tx(self.slug, nodes=['n0']):
            pass
        with self.raw() as raw:
            epoch = raw.execute("SELECT val FROM meta WHERE key='heal_epoch'").fetchone()
        self.assertEqual(epoch[0], store.heal_epoch())

    def test_the_whole_load_heal_converts_and_commits_the_log(self):
        self.stamp()
        n = self.node_row()
        self.assertEqual(n['turn_seq'], self.LEGACY)
        self.assertEqual(len(n['turns']), ledger.TREE_TURNS)
        self.assertEqual(strip(self.log_rows()), self.legacy)
        self.assertEqual([r['n'] for r in self.log_rows()], list(range(1, self.LEGACY + 1)))
        self.assertEqual(ledger.turn_estimate_sums(n), old_sums(self.legacy))
        # a node with no turns is not rewritten by the heal
        self.assertNotIn('turn_seq', self.node_row('n0'))
        self.stamp()                                 # a second load heals nothing more
        self.assertEqual(len(self.log_rows()), self.LEGACY)

    def test_a_turn_is_appended_without_reading_the_history(self):
        self.stamp()
        e = turn(self.rnd, 100)
        with orgtx.org_tx(self.slug, nodes=['n3'], logs=['turn_log']) as tx:
            ledger.record_turn(tx.org.d, 'n3', tx.org.node('n3'), dict(e))
            sec = dict.get(tx.org.d, 'turn_log')
            self.assertIsInstance(sec, store.SectionMap)
            self.assertFalse(dict.__contains__(sec, 'n3'), 'the history was read')
        with orgtx.org_tx(self.slug, nodes=['n3'], logs=['turn_log']) as tx:
            ledger.record_turn(tx.org.d, 'n3', tx.org.node('n3'), dict(e, i=101))
        rows = self.log_rows()
        self.assertEqual([r['n'] for r in rows], list(range(1, self.LEGACY + 3)))
        self.assertEqual(strip(rows), self.legacy + [e, dict(e, i=101)])
        self.assertEqual(ledger.turn_estimate_sums(self.node_row()), old_sums(strip(rows)))
        view = store.load_runtime_org(self.slug)
        self.assertEqual(strip(history._turn_log_rows(view, 'n3')), strip(rows))

    def test_an_older_engine_append_after_the_stamp_is_logged_once(self):
        self.stamp()
        # an older engine that never stamps an epoch appends two turns
        n = self.node_row()
        older = [turn(self.rnd, 200), turn(self.rnd, 201)]
        n['turns'] += older
        with self.raw() as raw:
            raw.execute('UPDATE nodes SET val=%s WHERE id=%s', (json.dumps(n), 'n3'))
        # a transaction that did not name the log still writes the node
        with orgtx.org_tx(self.slug, nodes=['n3']) as tx:
            tx.org.node('n3')['payload']['v'] = 2
        self.assertEqual(len(self.log_rows()), self.LEGACY)
        n = self.node_row()
        self.assertEqual(ledger.turn_estimate_sums(n), old_sums(self.legacy + older))
        e = turn(self.rnd, 202)
        with orgtx.org_tx(self.slug, nodes=['n3'], logs=['turn_log']) as tx:
            ledger.record_turn(tx.org.d, 'n3', tx.org.node('n3'), dict(e))
        rows = self.log_rows()
        self.assertEqual(strip(rows), self.legacy + older + [e])
        self.assertEqual([r['n'] for r in rows], list(range(1, self.LEGACY + 4)))

    def test_rollback_then_roll_forward_through_the_epoch(self):
        self.stamp()
        # an older engine with its own epoch loads, stamps, appends three
        n = self.node_row()
        older = [turn(self.rnd, 300 + i) for i in range(3)]
        n['turns'] += older
        with self.raw() as raw:
            raw.execute('UPDATE nodes SET val=%s WHERE id=%s', (json.dumps(n), 'n3'))
            raw.execute("UPDATE meta SET val='older-engine' WHERE key='heal_epoch'")
        self.stamp()                                 # roll-forward: whole load, heal
        rows = self.log_rows()
        self.assertEqual(strip(rows), self.legacy + older)
        self.assertEqual([r['n'] for r in rows], list(range(1, self.LEGACY + 4)))
        self.assertEqual(len(self.node_row()['turns']), ledger.TREE_TURNS)
        self.assertEqual(ledger.turn_estimate_sums(self.node_row()), old_sums(self.legacy + older))

    def test_the_supervisor_writers_log_their_turns(self):
        from orgtree import supervisor as sup
        self.stamp()
        with patch.object(sup, '_stamp_ran_as'):
            sup._charge_reported_spend(self.slug, 'n3', 0.25)
            sup._charge_killed_turn(self.slug, 'n3', 1000)
        rows = self.log_rows()
        self.assertEqual(len(rows), self.LEGACY + 2, 'a writer did not log its turn')
        killed = rows[-1]
        self.assertTrue(killed.get('killed'))
        self.assertEqual(killed.get('cost'), estimate(old_sums(strip(rows[:-1])), 1000))
        self.assertEqual(self.node_row()['turns'][-1]['n'], self.LEGACY + 2)

    def test_the_turn_end_writer_logs_its_turn(self):
        from orgtree import supervisor as sup
        self.stamp()
        self.assertEqual(len(self.log_rows('worker')), 12)
        with patch.object(sup, '_count_cli_compactions', return_value=(0, 0, [])), \
                patch.object(sup, 'session_occupancy', return_value=(None, False)), \
                patch.object(sup, 'notify'):
            org = store.load_org(self.slug)
            sup._after_turn(self.slug, 'worker', org, {'total_cost_usd': 0.05},
                            sup.state(self.slug, 'worker'))
        rows = self.log_rows('worker')
        self.assertEqual(len(rows), 13, 'the turn-end writer did not log its turn')
        self.assertEqual(rows[-1]['n'], 13)
        self.assertEqual(self.node_row('worker')['turn_seq'], 13)

    def test_switching_on_reheals_an_org_stamped_with_it_off(self):
        with patch.object(ledger, 'TURN_LOG', False), \
                patch.object(store, '_heal_epoch_value', []):
            self.stamp()
        self.assertNotIn('turn_seq', self.node_row())
        self.stamp()                        # on: a different epoch, a whole load
        self.assertEqual(self.node_row()['turn_seq'], self.LEGACY)
        self.assertEqual(len(self.log_rows()), self.LEGACY)

    def test_the_history_page_serves_every_turn(self):
        self.stamp()
        n = self.node_row()
        older = [turn(self.rnd, 400)]
        n['turns'] += older
        with self.raw() as raw:
            raw.execute('UPDATE nodes SET val=%s WHERE id=%s', (json.dumps(n), 'n3'))
        page = history.history_page(self.slug, 'turns', node='n3', limit=100)
        self.assertEqual(page['total'], self.LEGACY + 1)
        self.assertEqual(strip(list(reversed(page['items']))), self.legacy + older)

    def test_the_switch_off_writes_no_log(self):
        with patch.object(ledger, 'TURN_LOG', False), \
                patch.object(store, '_heal_epoch_value', []):
            self.stamp()
            with orgtx.org_tx(self.slug, nodes=['n3']) as tx:
                ledger.record_turn(tx.org.d, 'n3', tx.org.node('n3'), turn(self.rnd, 1))
        self.assertEqual(self.log_rows(), [])
        self.assertEqual(len(self.node_row()['turns']), self.LEGACY + 1)


@unittest.skipUnless(f.ADMIN, 'disposable PostgreSQL required: NOT RUN')
class PgFirstWrites(unittest.TestCase):
    """An org where no node has a turn yet: the dict log does not exist, and
    two FIRST writers on different nodes run at once (review 2026-09-28,
    pg-supervisor-a's probe). The first write must be a per-owner INSERT —
    a plain {} saved as a whole section deleted the other writer's rows —
    and the owner list must keep both owners."""

    setUpClass = PgTurnLog.setUpClass
    raw = PgTurnLog.raw

    def setUp(self):
        flags = patch.multiple(store, LAZY_ROWS=True, ORGTX_RESCOPE=True, _heal_epoch_value=[])
        flags.start()
        self.addCleanup(flags.stop)
        flag = patch.object(ledger, 'TURN_LOG', True)
        flag.start()
        self.addCleanup(flag.stop)
        old = orgtx.use_backend(orgtx.PgBackend())
        self.addCleanup(orgtx.use_backend, old)
        org = store.create_org('turnlog1st-' + uuid.uuid4().hex[:10])
        self.slug = org.d['slug']
        for i in range(3):
            org.d['nodes'][f'n{i}'] = node(f'n{i}')
        store.save_org(org)
        with pgstore.connect() as raw:
            self.oid = raw.execute('SELECT org_id FROM public.orgs WHERE slug=%s',
                                   (self.slug,)).fetchone()[0]
        with orgtx.org_tx(self.slug, nodes=['n0']):  # the whole-load heal, stamped
            pass
        self.assertEqual(self.owners('turn_log'), [], 'precondition: no turn_log rows')

    def owners(self, sect):
        with self.raw() as raw:
            return sorted(r[0] for r in raw.execute(
                'SELECT DISTINCT owner FROM log_d WHERE sect=%s', (sect,)).fetchall())

    def owner_meta(self, sect):
        with self.raw() as raw:
            row = raw.execute('SELECT val FROM meta WHERE key=%s',
                              ('owners:' + sect,)).fetchone()
        return sorted(json.loads(row[0])) if row else []

    def race(self, sect, write):
        """B loads first and waits; A writes and commits; then B writes."""
        loaded, go, err = threading.Event(), threading.Event(), []

        def b():
            try:
                with orgtx.org_tx(self.slug, nodes=['n2'], logs=[sect]) as tx:
                    tx.org.node('n2')
                    self.assertNotIn(sect, tx.org.d)
                    loaded.set()
                    go.wait(60)
                    write(tx, 'n2')
            except Exception as e:                          # noqa: BLE001
                err.append(repr(e)[:300])
            finally:
                loaded.set()
        t = threading.Thread(target=b)
        t.start()
        self.assertTrue(loaded.wait(60))
        with orgtx.org_tx(self.slug, nodes=['n1'], logs=[sect]) as tx:
            write(tx, 'n1')
        self.assertEqual(self.owners(sect), ['n1'])
        go.set()
        t.join(120)
        self.assertFalse(t.is_alive())
        self.assertEqual(err, [])

    @staticmethod
    def record(tx, nid):
        ledger.record_turn(tx.org.d, nid, tx.org.node(nid),
                           {'at': 't', 'cost': 1.0, 'toks': 10})

    def test_concurrent_first_turns_keep_both(self):
        self.race('turn_log', self.record)
        self.assertEqual(self.owners('turn_log'), ['n1', 'n2'])
        self.assertEqual(self.owner_meta('turn_log'), ['n1', 'n2'])
        view = store.load_runtime_org(self.slug)
        for nid in ('n1', 'n2'):
            self.assertEqual(len(history._turn_log_rows(view, nid)), 1, nid)

    def test_the_first_write_of_any_absent_dict_log_is_per_owner(self):
        # the same idiom every dict-log writer uses (supervisor steered_log)
        def steer(tx, nid):
            tx.org.d.setdefault('steered_log', {}).setdefault(nid, []).append({'at': nid})
        self.race('steered_log', steer)
        self.assertEqual(self.owners('steered_log'), ['n1', 'n2'])
        self.assertEqual(self.owner_meta('steered_log'), ['n1', 'n2'])

    def test_an_absent_dict_log_loads_as_an_empty_row_tracked_map(self):
        with orgtx.org_tx(self.slug, nodes=['n1'], logs=['turn_log']) as tx:
            sec = tx.org.d.setdefault('turn_log', {})
            self.assertIsInstance(sec, store.SectionMap)
            self.assertEqual(dict(sec.items()), {})

    def test_concurrent_new_owners_both_stay_in_the_owner_list(self):
        # Both saves read the owner list before either commits: the merge
        # must be serialized or the later upsert drops the earlier owner.
        with orgtx.org_tx(self.slug, nodes=['n0'], logs=['turn_log']) as tx:
            self.record(tx, 'n0')                   # the section exists now
        real, real_write = store._meta_get, store._write_dict_log
        a_read, b_read = threading.Event(), threading.Event()
        me = threading.local()

        def write_dict_log(*a, **kw):
            me.saving = True
            try:
                return real_write(*a, **kw)
            finally:
                me.saving = False

        def meta_get(conn, key):
            val = real(conn, key)
            if key == 'owners:turn_log' and getattr(me, 'saving', False):
                if me.who == 'a':
                    a_read.set()
                    b_read.wait(3)                  # B blocks on the lock: time out
                else:
                    b_read.set()
            return val
        err = []

        def run(who, nid):
            me.who = who
            try:
                with orgtx.org_tx(self.slug, nodes=[nid], logs=['turn_log']) as tx:
                    self.record(tx, nid)
                    if who == 'b':
                        a_read.wait(30)             # save only after A read the list
            except Exception as e:                  # noqa: BLE001
                err.append(repr(e)[:300])
        with patch.object(store, '_meta_get', meta_get), \
                patch.object(store, '_write_dict_log', write_dict_log):
            ts = [threading.Thread(target=run, args=('a', 'n1')),
                  threading.Thread(target=run, args=('b', 'n2'))]
            for t in ts:
                t.start()
            for t in ts:
                t.join(120)
        self.assertEqual(err, [])
        self.assertTrue(a_read.is_set())
        self.assertEqual(self.owners('turn_log'), ['n0', 'n1', 'n2'])
        self.assertEqual(self.owner_meta('turn_log'), ['n0', 'n1', 'n2'])


if __name__ == '__main__':
    unittest.main()
