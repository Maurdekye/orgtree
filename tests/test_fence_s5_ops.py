"""Fence-off S5, the operator ops route (`POST /api/orgs/{slug}/ops`):

  * every op `_org_op_locked` (the DOC_LOCK cycle) still handles is either
    declared on the door or named in LEGACY_OPS below with the family that
    owes its body — so no op can quietly stay on DOC_LOCK, and a stale entry
    (an op that has since been declared) fails too;
  * the operator `reallocate` runs on the door (rcdoor's body, p03-lead
    ruling 2026-09-26 13:22Z (a)): one row transaction, never waiting on
    DOC_LOCK, the same answer and grants as the legacy branch, and a refusal
    commits nothing.

Run:  python tools/run-python-verification.py tests/test_fence_s5_ops.py
"""
import ast
import inspect
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

_temp = tempfile.TemporaryDirectory(prefix='fence-s5-ops-', ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=str(Path(_temp.name)), ORGTREE_STORE='sqlite',
                  ORGTREE_PGDOOR='1', ORGTREE_STEER_HOOK='0')
os.environ.pop('ORGTREE_DESKTOP_MANAGED', None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout
from fastapi import HTTPException  # noqa: E402
from orgtree import api, ledger, orgtx, pgdoor, rcdoor, store  # noqa: E402

orgtx.TRANSITION_FENCE = False

#: ops the DOC_LOCK cycle still runs, and who owes each one's door body
#: (lead decisions 40/41 and the 13:22Z ruling on the scale parent). Remove
#: an entry in the same change that declares the op.
LEGACY_OPS = {
    "retire": "WS3b (p03-ws3b-topology), decision 40",
    "rescind": "WS3b, decision 40",
    "rehire": "WS3b, decision 40",
    "dissolve": "WS3b, decision 40",
    "delete": "WS3b, decision 40",
    "move": "WS3b, decision 40",
    "switch_model": "WS3b, decision 40",
    "reseed": "WS3b, decision 40",
    "cheap_compact": "WS3b, decision 41",
    "promote": "WS3b, lead ruling 2026-09-26 13:22Z",
    "demote": "WS3b, lead ruling 2026-09-26 13:22Z",
    "revoke_dir": "WS3b, lead ruling 2026-09-26 13:22Z",
}

U = ledger.USER
T = {'bash': False, 'web': False, 'edit': False, 'subagents': False, 'mcp': []}
REQUEST = SimpleNamespace(state=SimpleNamespace())
FREE_S = 5.0
_N = [0]


def _cycle_ops() -> set[str]:
    """Every `body.op == "<op>"` branch in `_org_op_locked`, read from its
    source (so a new branch is seen the day it is written)."""
    tree = ast.parse(inspect.getsource(api._org_op_locked).lstrip())
    ops = set()
    for n in ast.walk(tree):
        if (isinstance(n, ast.Compare) and isinstance(n.left, ast.Attribute)
                and n.left.attr == 'op' and len(n.ops) == 1
                and isinstance(n.ops[0], ast.Eq)
                and isinstance(n.comparators[0], ast.Constant)):
            ops.add(n.comparators[0].value)
    return ops


class OpsInventory(unittest.TestCase):
    def test_every_cycle_op_is_declared_or_named_with_its_owner(self):
        ops = _cycle_ops()
        self.assertGreaterEqual(len(ops), 10, ops)       # the scan really ran
        undeclared = {o for o in ops if not pgdoor.declared(o)}
        self.assertEqual(sorted(undeclared - set(LEGACY_OPS)), [],
                         'an op runs under DOC_LOCK with no named owner')

    def test_no_legacy_entry_is_already_declared(self):
        stale = sorted(o for o in LEGACY_OPS if pgdoor.declared(o))
        self.assertEqual(stale, [], 'declared ops must leave LEGACY_OPS')

    def test_the_door_ops_are_the_expected_ones(self):
        ops = _cycle_ops()
        self.assertEqual(sorted(o for o in ops if pgdoor.declared(o)),
                         ['hire', 'reallocate'])


def _org() -> str:
    _N[0] += 1
    slug = f'fs5o{_N[0]}'
    org = store.create_org(slug)
    org.hire(U, None, 'luna', 20, 'root')
    org.hire('root', 'root', 'luna', 5, 'mid', add_dirs=[], tools=T,
             org_visibility='full', charter='c')
    org.hire('mid', 'mid', 'luna', 1, 'kid', add_dirs=[], tools=T,
             org_visibility='full', charter='c')
    store.save_org(org)
    return slug


def _op(slug, **kw):
    return api.org_op(slug, api.Op(op='reallocate', **kw), REQUEST)


def _grants(slug):
    org = store.load_org(slug)
    return {n: org.node(n).get('grant') for n in ('root', 'mid', 'kid')}


class OperatorReallocate(unittest.TestCase):
    def setUp(self):
        self.p = [patch.object(api, 'hub_changed', lambda *a, **k: None)]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()

    def test_it_is_declared_and_routed(self):
        self.assertTrue(pgdoor.routed('reallocate'))
        self.assertIs(pgdoor.BODIES['reallocate'], rcdoor.op_reallocate_body)

    def test_it_never_waits_on_doc_lock_and_runs_once(self):
        slug = _org()
        self.kid0 = _grants(slug)['kid']
        runs, real = [], rcdoor.op_reallocate_body
        entered, release = threading.Event(), threading.Event()

        def hold():
            with store.DOC_LOCK:
                entered.set()
                release.wait(30)
        t = threading.Thread(target=hold, daemon=True)
        t.start()
        self.assertTrue(entered.wait(10))
        out: list = []
        try:
            with patch.dict(pgdoor.BODIES, {'reallocate':
                                            lambda tx: runs.append(1) or real(tx)}):
                w = threading.Thread(target=lambda: out.append(
                    _op(slug, node='kid', delta=2)), daemon=True)
                w.start()
                w.join(FREE_S)
                self.assertFalse(w.is_alive(), 'the reallocate op waited on DOC_LOCK')
        finally:
            release.set()
            t.join(10)
        self.assertEqual(len(runs), 1)
        self.assertEqual(_grants(slug)['kid'], self.kid0 + 2)

    def test_same_answer_and_grants_as_the_legacy_branch(self):
        door, legacy = _org(), _org()
        for actor, node, delta in ((U, 'kid', 2), ('mid', 'kid', -1), (U, 'mid', 1)):
            with self.subTest(actor=actor, node=node, delta=delta):
                a = _op(door, actor=actor, node=node, delta=delta)
                with patch.dict(os.environ, {'ORGTREE_PGDOOR': '0'}):
                    self.assertFalse(pgdoor.enabled())
                    b = _op(legacy, actor=actor, node=node, delta=delta)
                self.assertEqual(a, b)
                self.assertEqual(_grants(door), _grants(legacy))

    def test_refusals_commit_nothing(self):
        slug = _org()
        rev, before = orgtx.backend().revision(slug), _grants(slug)
        for kw, words in (({'node': 'kid'}, 'reallocate needs delta'),
                          ({'node': 'nobody', 'delta': 1}, None),
                          ({'node': 'kid', 'delta': 999}, None),
                          ({'actor': 'kid', 'node': 'mid', 'delta': 1}, None)):
            with self.subTest(**kw):
                with self.assertRaises(HTTPException) as cm:
                    _op(slug, **kw)
                self.assertEqual(cm.exception.status_code, 422)
                if words:
                    self.assertIn(words, str(cm.exception.detail))
        self.assertEqual(orgtx.backend().revision(slug), rev)
        self.assertEqual(_grants(slug), before)


if __name__ == '__main__':
    unittest.main()
