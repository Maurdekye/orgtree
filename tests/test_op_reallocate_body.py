"""The OPERATOR's reallocate (`POST /ops` op="reallocate") as a door body
(p03-lead ruling 2026-09-26 13:22Z (a): funding supplies the spec and body,
WS3a declares the op for op_tx). `rcdoor.op_reallocate_spec` /
`rcdoor.op_reallocate_body` run through `pgdoor.op_tx` exactly as the
declared op will, over PG-0's SeamBackend fake, with the transition fence
OFF (plan decision 19). The op is NOT declared here: WS3a declares it, and
pgdoor refuses a second declaration.

  * ONE ATTEMPT, OFF DOC_LOCK: the user moving credits between a parent and
    a grandchild (the chain between them locked) and an agent acting
    through the operator door are each one transaction attempt while
    another thread holds DOC_LOCK. pgdoor re-runs an under-declared
    transaction, so only the attempt count shows a missing row.
  * SAME RESULT as the DOC_LOCK branch (`_org_op_locked`): the same
    `Org.reallocate` answer and the same grants afterwards.
  * REFUSALS: no delta is "reallocate needs delta"; the ledger's own
    refusals (no authority, overdraw) commit nothing.

Run:  python tools/run-python-verification.py tests/test_op_reallocate_body.py
"""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

root = tempfile.TemporaryDirectory(prefix='v3-op-realloc-', ignore_cleanup_errors=True)
data = Path(root.name) / 'data'
data.mkdir()
home = Path(root.name) / 'home'
home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator', ORGTREE_STORE='sqlite',
                  ORGTREE_ORGTX_TEST_HOOKS='1', ORGTREE_PGDOOR='1')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401,E402  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()
from orgtree import api, ledger, orgtx, pgdoor, rcdoor, store  # noqa: E402
from orgtree.ledger import LedgerError, USER  # noqa: E402


def tearDownModule() -> None:
    orgtx.set_pause_hook(None)
    root.cleanup()


class Attempts:
    def __init__(self) -> None:
        self.attempts = 0
        self.commits = 0
        self._c = threading.Lock()

    def __call__(self, point, tx) -> None:
        with self._c:
            if point == 'before_lock':
                self.attempts += 1
            elif point == 'before_commit':
                self.commits += 1


class HeldDocLock:
    def __enter__(self):
        self.got = threading.Event()
        self.done = threading.Event()

        def hold():
            with store.DOC_LOCK:
                self.got.set()
                self.done.wait(30)
        self.t = threading.Thread(target=hold, daemon=True)
        self.t.start()
        assert self.got.wait(5), 'fixture: could not take DOC_LOCK'
        return self

    def __exit__(self, *exc):
        self.done.set()
        self.t.join(5)


class OpReallocate(unittest.TestCase):
    seq = 0

    def setUp(self) -> None:
        self.addCleanup(setattr, orgtx, 'TRANSITION_FENCE', orgtx.TRANSITION_FENCE)
        orgtx.TRANSITION_FENCE = False
        orgtx.use_backend(orgtx.SeamBackend())
        pgdoor.use_org_tx(None)
        type(self).seq += 1
        self.slug = f'opre{self.seq}'
        org = store.create_org(self.slug)
        org.hire(USER, None, 'haiku', 20, 'top')
        org.hire('top', 'top', 'haiku', 8, 'mid')
        org.hire('mid', 'mid', 'haiku', 3, 'leaf')
        org.hire('top', 'top', 'haiku', 2, 'side')
        store.save_org(org)
        pgdoor.run(self.slug, pgdoor.TxSpec(), lambda h: None)

    def tearDown(self) -> None:
        orgtx.set_pause_hook(None)

    def grants(self) -> dict:
        store._invalidate_snapshot(self.slug)
        store._POOL.close_all(self.slug)
        d = json.loads(json.dumps(store.load_org(self.slug).d))
        return {k: (n.get('grant'), n.get('free')) for k, n in d['nodes'].items()}

    def legacy(self, actor: str, node: str, delta: float) -> tuple:
        """The DOC_LOCK branch's answer, on a private copy of the document."""
        org = ledger.Org(json.loads(json.dumps(store.load_org(self.slug).d)))
        r = org.reallocate(actor, node, delta)
        return r, {k: (n.get('grant'), n.get('free')) for k, n in org.nodes.items()}

    def op(self, actor: str, node: str, delta):
        """The op through pgdoor.op_tx, under a held DOC_LOCK."""
        body = api.Op(op='reallocate', actor=actor, node=node, delta=delta)
        a = body.model_dump(exclude={'op', 'preview'}, exclude_none=True)
        spec = rcdoor.op_reallocate_spec(orgtx.org_read(self.slug), body, a)
        hook = Attempts()
        orgtx.set_pause_hook(hook)
        out: dict = {}

        def go():
            try:
                out['r'] = pgdoor.op_tx(self.slug, 'reallocate', body, a,
                                        rcdoor.op_reallocate_body, spec=spec)
            except BaseException as e:  # noqa: BLE001
                out['e'] = e
        try:
            with HeldDocLock():
                t = threading.Thread(target=go, daemon=True)
                t.start()
                t.join(20)
                self.assertFalse(t.is_alive(), 'the op waited for DOC_LOCK')
        finally:
            orgtx.set_pause_hook(None)
        return out, hook

    def test_user_moves_credits_down_a_chain_in_one_attempt(self) -> None:
        want, want_grants = self.legacy(USER, 'leaf', 2)
        out, hook = self.op(USER, 'leaf', 2)
        self.assertNotIn('e', out, out.get('e'))
        self.assertEqual((hook.attempts, hook.commits), (1, 1),
                         'the user reallocate was under-declared (it widened)')
        self.assertEqual(out['r'], want)
        self.assertEqual(self.grants(), want_grants)

    def test_agent_through_the_operator_door_in_one_attempt(self) -> None:
        want, want_grants = self.legacy('top', 'leaf', -1)
        out, hook = self.op('top', 'leaf', -1)
        self.assertNotIn('e', out, out.get('e'))
        self.assertEqual((hook.attempts, hook.commits), (1, 1),
                         'the agent-actor reallocate widened')
        self.assertEqual(out['r'], want)
        self.assertEqual(self.grants(), want_grants)

    def test_no_delta_is_refused(self) -> None:
        before = self.grants()
        out, hook = self.op(USER, 'leaf', None)
        self.assertIsInstance(out.get('e'), LedgerError)
        self.assertIn('reallocate needs delta', str(out['e']))
        self.assertEqual(hook.commits, 0)
        self.assertEqual(self.grants(), before)

    def test_ledger_refusals_commit_nothing(self) -> None:
        before = self.grants()
        for actor, node, delta in (('side', 'leaf', 1),     # no authority
                                   (USER, 'leaf', 10_000)):  # overdraw
            with self.assertRaises(LedgerError):
                self.legacy(actor, node, delta)
            out, hook = self.op(actor, node, delta)
            self.assertIsInstance(out.get('e'), LedgerError, (actor, node))
            self.assertEqual(hook.commits, 0, (actor, node))
        self.assertEqual(self.grants(), before)


if __name__ == '__main__':
    unittest.main()
